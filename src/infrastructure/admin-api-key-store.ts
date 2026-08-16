import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { AdminApiKeyScope } from '../contracts/admin-api-keys.js';

const tokenPattern = /^lmk_live_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;

export interface AdminApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: readonly AdminApiKeyScope[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
}

export interface CreatedAdminApiKey extends AdminApiKeyRecord {
  token: string;
}

export interface AdminApiKeyAuditRecord {
  id: number;
  keyId: string;
  actorId: string;
  action: 'key.created' | 'key.revoked';
  createdAt: Date;
}

export class PostgresAdminApiKeyStore {
  public constructor(private readonly pool: Pool) {}

  public async create(
    actorId: string,
    name: string,
    scopes: readonly AdminApiKeyScope[],
    expiresAt: Date,
    now: Date,
  ): Promise<CreatedAdminApiKey> {
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const prefix = `lmk_…${secret.slice(-6)}`;
    const uniqueScopes = [...new Set(scopes)].sort() as AdminApiKeyScope[];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO admin_api_keys
          (id, name, secret_hash, display_prefix, scopes, created_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, name, hash(secret), prefix, uniqueScopes, actorId, now, expiresAt],
      );
      await client.query(
        `INSERT INTO admin_api_key_audit(key_id, actor_id, action, created_at)
         VALUES ($1,$2,'key.created',$3)`,
        [id, actorId, now],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return {
      id,
      name,
      prefix,
      scopes: uniqueScopes,
      createdBy: actorId,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      useCount: 0,
      token: `lmk_live_${id}_${secret}`,
    };
  }

  public async list(limit = 100): Promise<AdminApiKeyRecord[]> {
    const result = await this.pool.query<StoredKeyRow>(
      `SELECT id, name, display_prefix, scopes, created_by, created_at, expires_at,
              revoked_at, last_used_at, use_count
       FROM admin_api_keys ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toRecord);
  }

  public async revoke(id: string, actorId: string, now: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE admin_api_keys SET revoked_at = $3, revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [id, actorId, now],
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO admin_api_key_audit(key_id, actor_id, action, created_at)
         VALUES ($1,$2,'key.revoked',$3)`,
        [id, actorId, now],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async authorize(
    token: string,
    scope: AdminApiKeyScope,
    now: Date,
  ): Promise<AdminApiKeyRecord | null> {
    return this.authorizeToken(token, scope, now);
  }

  public async authorizeAny(token: string, now: Date): Promise<AdminApiKeyRecord | null> {
    return this.authorizeToken(token, null, now);
  }

  private async authorizeToken(
    token: string,
    scope: AdminApiKeyScope | null,
    now: Date,
  ): Promise<AdminApiKeyRecord | null> {
    const parsed = tokenPattern.exec(token);
    if (!parsed) return null;
    const result = await this.pool.query<StoredKeyRow & { secret_hash: string }>(
      `SELECT id, name, display_prefix, scopes, created_by, created_at, expires_at,
              revoked_at, last_used_at, use_count, secret_hash
       FROM admin_api_keys WHERE id = $1`,
      [parsed[1]],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.revoked_at ||
      new Date(row.expires_at) <= now ||
      (scope !== null && !row.scopes.includes(scope))
    ) {
      return null;
    }
    const supplied = Buffer.from(hash(parsed[2]!), 'base64url');
    const expected = Buffer.from(row.secret_hash, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    await this.pool.query(
      'UPDATE admin_api_keys SET last_used_at = $2, use_count = use_count + 1 WHERE id = $1',
      [row.id, now],
    );
    return { ...toRecord(row), lastUsedAt: now, useCount: row.use_count + 1 };
  }

  public async listAudit(limit = 100): Promise<AdminApiKeyAuditRecord[]> {
    const result = await this.pool.query<{
      id: number;
      key_id: string;
      actor_id: string;
      action: AdminApiKeyAuditRecord['action'];
      created_at: Date;
    }>(
      `SELECT id, key_id, actor_id, action, created_at
       FROM admin_api_key_audit ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      keyId: row.key_id,
      actorId: row.actor_id,
      action: row.action,
      createdAt: new Date(row.created_at),
    }));
  }
}

interface StoredKeyRow {
  id: string;
  name: string;
  display_prefix: string;
  scopes: AdminApiKeyScope[];
  created_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  use_count: number;
}

function toRecord(row: StoredKeyRow): AdminApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.display_prefix,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    useCount: Number(row.use_count),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}
