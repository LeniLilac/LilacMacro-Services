import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export interface StoredOAuthAttempt {
  verifier: string;
  expiresAt: Date;
}

export interface AuthCleanupResult {
  attempts: number;
  sessions: number;
}

export class PostgresAuthStore {
  private readonly encryptionKey: Buffer;

  public constructor(
    private readonly pool: Pool,
    keyBase64: string,
  ) {
    this.encryptionKey = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest();
  }

  public async storeAttempt(
    state: string,
    verifier: string,
    browserBinding: string,
    expiresAt: Date,
  ): Promise<void> {
    const stateHash = hash(state);
    await this.pool.query(
      `INSERT INTO oauth_attempts(state_hash, verifier_ciphertext, browser_binding_hash, expires_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (state_hash) DO NOTHING`,
      [stateHash, this.encrypt(verifier), hash(browserBinding), expiresAt],
    );
  }

  public async consumeAttempt(
    state: string,
    browserBinding: string,
    now: Date,
  ): Promise<StoredOAuthAttempt | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ verifier_ciphertext: string; expires_at: Date }>(
        `UPDATE oauth_attempts SET consumed_at = $3
         WHERE state_hash = $1 AND browser_binding_hash = $2
           AND consumed_at IS NULL AND expires_at > $3
         RETURNING verifier_ciphertext, expires_at`,
        [hash(state), hash(browserBinding), now],
      );
      await client.query('COMMIT');
      if (!result.rowCount) return null;
      return {
        verifier: this.decrypt(result.rows[0]!.verifier_ciphertext),
        expiresAt: new Date(result.rows[0]!.expires_at),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      'INSERT INTO admin_sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)',
      [tokenHash, userId, expiresAt],
    );
  }

  public async sessionUser(tokenHash: string, now: Date): Promise<string | null> {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM admin_sessions
       WHERE token_hash = $1 AND expires_at > $2 AND revoked_at IS NULL`,
      [tokenHash, now],
    );
    return result.rows[0]?.user_id ?? null;
  }

  public async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1', [
      tokenHash,
    ]);
  }

  public async cleanupExpired(now: Date, limit = 1_000): Promise<AuthCleanupResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Auth cleanup limit was invalid.');
    }
    const stale = new Date(now.getTime() - 60 * 60_000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let attempts = 0;
      let sessions = 0;
      for (let batch = 0; batch < 100; batch += 1) {
        const attemptBatch = await client.query(
          `DELETE FROM oauth_attempts WHERE ctid IN (
             SELECT ctid FROM oauth_attempts
             WHERE expires_at <= $1 OR consumed_at <= $2
             ORDER BY expires_at ASC LIMIT $3
             FOR UPDATE SKIP LOCKED
           )`,
          [now, stale, limit],
        );
        const sessionBatch = await client.query(
          `DELETE FROM admin_sessions WHERE ctid IN (
             SELECT ctid FROM admin_sessions
             WHERE expires_at <= $1 OR revoked_at <= $2
             ORDER BY expires_at ASC LIMIT $3
             FOR UPDATE SKIP LOCKED
           )`,
          [now, stale, limit],
        );
        const attemptCount = attemptBatch.rowCount ?? 0;
        const sessionCount = sessionBatch.rowCount ?? 0;
        attempts += attemptCount;
        sessions += sessionCount;
        if (attemptCount < limit && sessionCount < limit) break;
      }
      await client.query('COMMIT');
      return { attempts, sessions };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  private decrypt(value: string): string {
    const encoded = Buffer.from(value, 'base64url');
    if (encoded.length < 29) throw new Error('OAuth verifier record is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, encoded.subarray(0, 12));
    decipher.setAuthTag(encoded.subarray(12, 28));
    return Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}
