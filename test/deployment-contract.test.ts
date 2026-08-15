import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production deployment waits for PostgreSQL and gates each database phase', async () => {
  const deploy = await readFile('ops/deploy.sh', 'utf8');
  const databaseStart = deploy.indexOf('up -d --wait --wait-timeout 120 postgres');
  const provision = deploy.indexOf('migrator node dist/scripts/provision-db-roles.js');
  const migrate = deploy.indexOf('migrator node dist/scripts/migrate.js');
  const runtimeStart = deploy.indexOf('up -d --remove-orphans control api bot worker cloudflared');

  assert.ok(databaseStart >= 0, 'PostgreSQL startup must wait for health');
  assert.ok(databaseStart < provision, 'role provisioning must follow database health');
  assert.ok(provision < migrate, 'roles must exist before migrations execute');
  assert.ok(migrate < runtimeStart, 'runtime services must start only after migrations');

  const databasePhases = deploy.slice(databaseStart, runtimeStart);
  assert.doesNotMatch(
    databasePhases,
    /bash\s+-c/,
    'database phases must inherit the outer fail-fast shell independently',
  );
});

test('runtime promotion verifies the signed control contract before public readiness', async () => {
  const verification = await readFile('ops/verify-runtime.sh', 'utf8');
  const signedContract = verification.indexOf(
    'exec -T api node dist/scripts/verify-control-snapshot.js',
  );
  const publicReadiness = verification.indexOf('"${origin}/health/ready"');

  assert.ok(signedContract >= 0, 'runtime verification must validate the signed control contract');
  assert.ok(publicReadiness >= 0, 'runtime verification must retain the public readiness check');
  assert.ok(
    signedContract < publicReadiness,
    'signed control verification must pass before public promotion succeeds',
  );
});

test('staging allows the complete worker heartbeat failure window', async () => {
  const staging = await readFile('ops/verify-staging.sh', 'utf8');

  assert.match(staging, /local deadline=\$\(\(SECONDS \+ 130\)\)/);
  assert.match(staging, /wait_for_unhealthy worker/);
});
