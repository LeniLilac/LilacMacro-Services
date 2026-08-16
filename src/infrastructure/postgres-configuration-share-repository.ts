import { createHash, randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import type { ConfigurationShareRepository, SharedConfiguration } from '../domain/ports.js';

const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const codeLength = 20;

export class PostgresConfigurationShareRepository implements ConfigurationShareRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(
    payload: string,
    networkPseudonym: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<SharedConfiguration | null> {
    const payloadHash = sha256(payload);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = Array.from(
        { length: codeLength },
        () => alphabet[randomInt(alphabet.length)],
      ).join('');
      const result = await this.pool.query<{ outcome: string }>(
        'SELECT configuration_share_create($1,$2,$3,$4,$5,$6) AS outcome',
        [sha256(code), payload, payloadHash, networkPseudonym, createdAt, expiresAt],
      );
      const outcome = result.rows[0]?.outcome;
      if (outcome === 'created') return { code, payload, expiresAt };
      if (outcome === 'capacity') return null;
      if (outcome !== 'collision')
        throw new Error('Configuration share storage rejected a validated request.');
    }
    throw new Error('Configuration share code allocation failed.');
  }

  public async find(code: string, now: Date): Promise<SharedConfiguration | null> {
    const result = await this.pool.query<{
      payload: string;
      payload_sha256: string;
      expires_at: Date;
    }>('SELECT * FROM configuration_share_find($1,$2)', [sha256(code), now]);
    const row = result.rows[0];
    if (!row) return null;
    const payload = String(row.payload);
    const expiresAt = new Date(row.expires_at);
    if (
      payload.length < 1 ||
      payload.length > 245_000 ||
      !/^[A-Za-z0-9_-]+$/.test(payload) ||
      String(row.payload_sha256) !== sha256(payload) ||
      Number.isNaN(expiresAt.getTime())
    ) {
      throw new Error('Configuration share storage was malformed.');
    }
    return { code, payload, expiresAt };
  }

  public async deleteExpired(now: Date): Promise<number> {
    const result = await this.pool.query<{ deleted: number }>(
      'SELECT configuration_share_delete_expired($1) AS deleted',
      [now],
    );
    return Number(result.rows[0]?.deleted ?? 0);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
