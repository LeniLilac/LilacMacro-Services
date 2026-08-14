import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [0x4c696c61634d6163n]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir('migrations')).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(path.join('migrations', name), 'utf8');
    const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex');
    const exists = await client.query<{ sha256: string }>(
      'SELECT sha256 FROM schema_migrations WHERE name = $1',
      [name],
    );
    if (exists.rowCount) {
      if (exists.rows[0]!.sha256 !== sha256) {
        throw new Error(`Applied migration ${name} no longer matched its recorded checksum.`);
      }
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name, sha256) VALUES ($1,$2)', [
        name,
        sha256,
      ]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [0x4c696c61634d6163n]).catch(() => undefined);
  client.release();
  await pool.end();
}
