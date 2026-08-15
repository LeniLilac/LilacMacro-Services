import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { createPool } from '../../src/infrastructure/postgres-repositories.js';

export interface TemporaryPostgres {
  pool: Pool;
  connectionString: string;
  stop(): Promise<void>;
}

export async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
  if (process.env.TEST_DATABASE_URL) {
    return startExternalPostgres(process.env.TEST_DATABASE_URL);
  }
  const binaries = await locatePostgresBinaries();
  const root = await mkdtemp(path.join(tmpdir(), 'lilacmacro-services-pg-'));
  const data = path.join(root, 'data');
  const log = path.join(root, 'postgres.log');
  const port = await reservePort();
  let pool: Pool | undefined;
  let started = false;
  try {
    run(binaries.initdb, [
      '-D',
      data,
      '-A',
      'trust',
      '--username=postgres',
      '--encoding=UTF8',
      '--no-locale',
    ]);
    await appendFile(
      path.join(data, 'postgresql.conf'),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nfsync = off\nsynchronous_commit = off\n`,
    );
    run(binaries.pgCtl, ['-D', data, '-l', log, '-t', '15', '-w', 'start'], true);
    started = true;
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    pool = createPool(connectionString);
    await installRuntimeRoles(pool);
    await installMigrations(pool);
    const activePool = pool;
    return {
      pool: activePool,
      connectionString,
      async stop() {
        await activePool.end();
        stopProcess(binaries.pgCtl, data);
        await removeTemporaryDirectory(root);
      },
    };
  } catch (error) {
    await pool?.end();
    if (started) stopProcess(binaries.pgCtl, data);
    await removeTemporaryDirectory(root);
    throw error;
  }
}

async function removeTemporaryDirectory(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await delay(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function startExternalPostgres(baseUrl: string): Promise<TemporaryPostgres> {
  const { Pool: AdminPool } = pg;
  const database = `lilacmacro_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const admin = new AdminPool({ connectionString: baseUrl, max: 1 });
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  try {
    await installRuntimeRoles(admin);
    await admin.query(`CREATE DATABASE "${database}"`);
    const pool = createPool(url.toString());
    await installMigrations(pool);
    return {
      pool,
      connectionString: url.toString(),
      async stop() {
        await pool.end();
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.end();
      },
    };
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.end();
    throw error;
  }
}

async function installMigrations(pool: Pool): Promise<void> {
  const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const initial = await readFile(path.join(migrationsDirectory, '001_initial.sql'), 'utf8');
  await pool.query(initial);
  const remaining = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name) && name !== '001_initial.sql')
    .sort();
  for (const name of remaining) {
    await pool.query(await readFile(path.join(migrationsDirectory, name), 'utf8'));
  }
}

async function installRuntimeRoles(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [1_946_919_983]);
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lilacmacro_api') THEN
          CREATE ROLE lilacmacro_api LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lilacmacro_control') THEN
          CREATE ROLE lilacmacro_control LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lilacmacro_worker') THEN
          CREATE ROLE lilacmacro_worker LOGIN;
        END IF;
      END
    $$`);
    for (const role of ['lilacmacro_api', 'lilacmacro_control', 'lilacmacro_worker']) {
      await client.query(`ALTER ROLE ${role} PASSWORD 'test-runtime-role-password'`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function locatePostgresBinaries(): Promise<{ initdb: string; pgCtl: string }> {
  const configured = process.env.POSTGRES_BIN_DIR;
  const candidates = [
    configured,
    process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : undefined,
    ...(process.platform === 'linux' ? await linuxCandidates() : []),
  ].filter((value): value is string => Boolean(value));
  for (const directory of candidates) {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const initdb = path.join(directory, `initdb${suffix}`);
    const pgCtl = path.join(directory, `pg_ctl${suffix}`);
    try {
      execFileSync(initdb, ['--version'], { stdio: 'ignore' });
      execFileSync(pgCtl, ['--version'], { stdio: 'ignore' });
      return { initdb, pgCtl };
    } catch {
      // Continue to the next explicit installation directory.
    }
  }
  throw new Error('PostgreSQL 17 initdb and pg_ctl are required for integration tests.');
}

async function linuxCandidates(): Promise<string[]> {
  try {
    const versions = await readdir('/usr/lib/postgresql');
    return versions
      .sort()
      .reverse()
      .map((version) => `/usr/lib/postgresql/${version}/bin`);
  } catch {
    return ['/usr/bin'];
  }
}

function run(executable: string, args: string[], ignoreOutput = false): void {
  try {
    execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ignoreOutput ? 'ignore' : 'pipe',
    });
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string };
    throw new Error(
      `Temporary PostgreSQL command failed: ${detail.stderr ?? detail.stdout ?? 'no output'}`,
    );
  }
}

function stopProcess(pgCtl: string, data: string): void {
  try {
    run(pgCtl, ['-D', data, '-m', 'immediate', '-t', '15', '-w', 'stop'], true);
  } catch {
    // The temporary directory is still removed; no production process is targeted.
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a PostgreSQL test port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
