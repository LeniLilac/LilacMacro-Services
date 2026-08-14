import pg from 'pg';
import { createPostgresRoleProvisionStatement } from '../src/infrastructure/scram-verifier.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_API_PASSWORD;
const controlPassword = process.env.POSTGRES_CONTROL_PASSWORD;
const workerPassword = process.env.POSTGRES_WORKER_PASSWORD;
if (!databaseUrl || !apiPassword || !controlPassword || !workerPassword) {
  throw new Error('Database owner URL and runtime role passwords are required.');
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await provisionRole('lilacmacro_api', apiPassword);
  await provisionRole('lilacmacro_control', controlPassword);
  await provisionRole('lilacmacro_worker', workerPassword);
} finally {
  await pool.end();
}

async function provisionRole(role: string, password: string): Promise<void> {
  const exists = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [role],
  );
  await pool.query(createPostgresRoleProvisionStatement(role, password, exists.rows[0]!.exists));
}
