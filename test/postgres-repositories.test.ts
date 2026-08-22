import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { multipartPartBytes } from '../src/contracts/diagnostics.js';
import { Ed25519SnapshotSigner } from '../src/infrastructure/snapshot-signer.js';
import { PostgresTelemetryRepository } from '../src/infrastructure/postgres-telemetry-repository.js';
import { PostgresConfigurationShareRepository } from '../src/infrastructure/postgres-configuration-share-repository.js';
import {
  PostgresControlRepository,
  PostgresDiagnosticRepository,
  createPool,
} from '../src/infrastructure/postgres-repositories.js';
import type { DiagnosticUploadRecord } from '../src/domain/ports.js';
import { startTemporaryPostgres, type TemporaryPostgres } from './helpers/postgres.js';

let database: TemporaryPostgres | undefined;
let pool: Pool;

before(async () => {
  database = await startTemporaryPostgres();
  pool = database.pool;
});

after(async () => database?.stop());

function signer(): Ed25519SnapshotSigner {
  const pair = generateKeyPairSync('ed25519');
  return new Ed25519SnapshotSigner(
    pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'test-1',
  );
}

test('Postgres control repository publishes exact idempotent commands and immutable audit', async () => {
  const repository = new PostgresControlRepository(pool);
  const commandId = randomUUID();
  const envelope = {
    commandId,
    expectedRevision: 0,
    command: { type: 'code.add' as const, code: 'WELCOME', expiresAt: null },
  };
  const now = new Date('2026-08-14T12:00:00.000Z');
  const first = await repository.executeAndPublish(
    { kind: 'web', userId: '123' },
    envelope,
    signer(),
    now,
  );
  assert.equal(first.payload.revision, 1);
  assert.equal((await repository.readState()).codes[0]?.code, 'WELCOME');
  assert.deepEqual(
    await repository.executeAndPublish({ kind: 'web', userId: '123' }, envelope, signer(), now),
    first,
  );
  await assert.rejects(
    repository.executeAndPublish(
      { kind: 'web', userId: '123' },
      { ...envelope, command: { ...envelope.command, code: 'DIFFERENT' } },
      signer(),
      now,
    ),
    /did not match/,
  );
  await assert.rejects(
    pool.query('DELETE FROM control_commands WHERE command_id = $1', [commandId]),
  );
  const republished = await repository.republish(signer(), new Date('2026-08-14T12:01:00.000Z'));
  assert.equal(republished.payload.revision, 1);
  assert.deepEqual(await repository.readPublished(), republished);
  assert.deepEqual(
    await repository.executeAndPublish({ kind: 'web', userId: '123' }, envelope, signer(), now),
    first,
  );
});

test('Postgres diagnostic repository enforces quotas, bound parts, audit, and retry claims', async () => {
  const repository = new PostgresDiagnosticRepository(pool);
  const now = new Date('2026-08-14T13:00:00.000Z');
  const record = diagnosticRecord(now);
  const limits = {
    installDailyBytes: 2_000,
    networkDailyBytes: 2_000,
    installDailyUploads: 2,
    networkDailyUploads: 2,
    installActiveUploads: 1,
    networkActiveUploads: 1,
    globalDailyBytes: 10_000,
    globalDailyUploads: 10,
    globalActiveUploads: 10,
    globalRetainedBytes: 100_000,
  };
  const createdAudit = {
    actor: { kind: 'system' as const, userId: '0' },
    action: 'upload.created' as const,
    details: { test: true },
    createdAt: now,
  };
  assert.equal(
    await repository.insertWithinQuota(
      record,
      new Date(now.getTime() - 86_400_000),
      limits,
      createdAudit,
    ),
    true,
  );
  assert.equal(
    await repository.insertWithinQuota(
      diagnosticRecord(now, randomUUID()),
      new Date(now.getTime() - 86_400_000),
      limits,
      createdAudit,
    ),
    false,
  );
  assert.equal(await repository.setProviderUploadId(record.id, 'provider-1'), true);
  const grant = { sizeBytes: multipartPartBytes, sha256: 'a'.repeat(64) };
  assert.equal(await repository.registerPartGrant(record.id, 1, grant), true);
  assert.equal(await repository.registerPartGrant(record.id, 1, grant), true);
  assert.equal(
    await repository.registerPartGrant(record.id, 1, { ...grant, sha256: 'b'.repeat(64) }),
    false,
  );
  assert.equal(
    await repository.transition(record.id, ['Uploading'], 'Pending', {
      acceptanceDeadline: null,
      providerUploadId: null,
    }),
    true,
  );
  assert.equal(
    await repository.insertWithinQuota(
      diagnosticRecord(now, randomUUID()),
      new Date(now.getTime() - 86_400_000),
      limits,
      createdAudit,
    ),
    true,
    'Stored Pending archives must not consume the active-upload quota.',
  );
  assert.equal(
    await repository.transition(record.id, ['Pending'], 'Pending', {
      acceptanceDeadline: new Date(now.getTime() + 1_800_000),
      audit: {
        actor: { kind: 'web', userId: '123' },
        action: 'moderation.accept',
        details: { test: true },
        createdAt: now,
      },
    }),
    true,
  );
  await repository.appendAudit(record.id, {
    actor: { kind: 'web', userId: '123' },
    action: 'verification.requested',
    details: {},
    createdAt: now,
  });
  await repository.appendAudit(record.id, {
    actor: { kind: 'discord', userId: '456' },
    action: 'download.requested',
    details: {},
    createdAt: now,
  });
  await repository.appendAudit(record.id, {
    actor: { kind: 'web', userId: '123' },
    action: 'moderation.delete',
    details: { previousStatus: 'Pending' },
    createdAt: now,
  });
  assert.equal((await repository.list(10)).length >= 1, true);
  assert.deepEqual(
    (await repository.list(10, { installPseudonyms: [record.installPseudonym] }))
      .map((item) => item.id)
      .sort(),
    (await repository.list(10)).map((item) => item.id).sort(),
  );
  assert.deepEqual(
    await repository.list(10, { installPseudonyms: ['unrelated-installation'] }),
    [],
  );
  assert.equal(
    (
      await repository.list(10, {
        minimumAppVersion: '1.0.111',
        osVersion: '19045.6456',
        createdAfter: new Date(now.getTime() - 1),
        maximumSizeBytes: 1_000,
      })
    ).some((item) => item.id === record.id),
    true,
  );
  assert.deepEqual(await repository.list(10, { minimumAppVersion: '1.0.112' }), []);
  assert.deepEqual(await repository.list(10, { osVersion: 'Windows 11' }), []);
  assert.equal(
    (await repository.listAudit(record.id, 10)).some(
      (event) => event.action === 'moderation.delete',
    ),
    true,
  );
  assert.equal((await repository.find(record.id))?.multipartParts[1]?.sha256, 'a'.repeat(64));
  await assert.rejects(
    pool.query('DELETE FROM diagnostic_audit WHERE upload_id = $1', [record.id]),
  );

  assert.equal(await repository.transition(record.id, ['Pending'], 'Deleting'), true);
  assert.equal(
    await repository.scheduleDeletionRetry(record.id, new Date(now.getTime() + 60_000), {
      actor: { kind: 'system', userId: '0' },
      action: 'deletion.retry-scheduled',
      details: { attempt: 1 },
      createdAt: now,
    }),
    true,
  );
  assert.equal((await repository.claimExpired(now, 10)).length, 0);
  const claimed = await repository.claimExpired(new Date(now.getTime() + 60_001), 10);
  assert.equal(claimed[0]?.id, record.id);
  assert.equal(claimed[0]?.deletionAttempts, 1);
  await pool.query('UPDATE diagnostic_uploads SET updated_at = $2 WHERE id = $1', [
    record.id,
    new Date(now.getTime() - 16 * 60_000),
  ]);
  const reclaimed = await repository.claimExpired(now, 10);
  assert.equal(reclaimed[0]?.id, record.id);

  await pool.query(
    "UPDATE diagnostic_uploads SET status = 'Pending', acceptance_deadline = $2 WHERE id = $1",
    [record.id, new Date(now.getTime() - 1)],
  );
  assert.equal(
    await repository.transition(record.id, ['Pending'], 'Accepted', {
      acceptanceDeadlineAfter: now,
    }),
    false,
  );

  await pool.query("UPDATE diagnostic_uploads SET status = 'Expired' WHERE id = $1", [record.id]);
  const retainedOnlyLimits = {
    ...limits,
    installDailyBytes: 1_000_000,
    networkDailyBytes: 1_000_000,
    installDailyUploads: 1_000,
    networkDailyUploads: 1_000,
    installActiveUploads: 1_000,
    networkActiveUploads: 1_000,
    globalDailyBytes: 1_000_000,
    globalDailyUploads: 1_000,
    globalActiveUploads: 1_000,
    globalRetainedBytes: 2_000,
  };
  assert.equal(
    await repository.insertWithinQuota(
      diagnosticRecord(now, randomUUID()),
      new Date(now.getTime() - 86_400_000),
      retainedOnlyLimits,
      createdAudit,
    ),
    true,
    'The oldest archive from the fullest installation should be queued for capacity deletion.',
  );
  assert.deepEqual(
    (
      await pool.query('SELECT status, capacity_released FROM diagnostic_uploads WHERE id = $1', [
        record.id,
      ])
    ).rows[0],
    { status: 'Expired', capacity_released: true },
  );
  assert.equal(
    (await repository.listAudit(record.id, 10)).some(
      (event) => event.action === 'retention.evicted',
    ),
    true,
  );
  assert.equal((await repository.claimExpired(now, 1))[0]?.id, record.id);
  assert.equal(
    await repository.scheduleDeletionRetry(record.id, new Date(now.getTime() + 60_000), {
      actor: { kind: 'system', userId: '0' },
      action: 'deletion.retry-scheduled',
      details: { attempt: 1 },
      createdAt: now,
    }),
    true,
  );
  assert.equal(
    (
      await pool.query('SELECT capacity_released FROM diagnostic_uploads WHERE id = $1', [
        record.id,
      ])
    ).rows[0]?.capacity_released,
    false,
    'A provider deletion failure must restore the archive to retained-capacity accounting.',
  );
});

test('Postgres runtime roles enforce the control and diagnostic authority split', async () => {
  const api = createPool(runtimeRoleUrl('lilacmacro_api'));
  const control = createPool(runtimeRoleUrl('lilacmacro_control'));
  const worker = createPool(runtimeRoleUrl('lilacmacro_worker'));
  try {
    assert.equal((await api.query('SELECT revision FROM control_state')).rowCount, 1);
    await assert.rejects(api.query('SELECT id FROM telemetry_events'));
    assert.ok(
      (await api.query("SELECT * FROM telemetry_summary(now() - interval '30 days')")).rowCount !==
        null,
    );
    assert.ok(
      (await api.query("SELECT * FROM telemetry_summary_v2(now() - interval '30 days')"))
        .rowCount !== null,
    );
    await assert.rejects(api.query('DELETE FROM telemetry_events'));
    await assert.rejects(api.query('SELECT code_hash FROM shared_configurations'));
    await assert.rejects(
      api.query(
        `INSERT INTO shared_configurations
          (code_hash,payload,payload_sha256,created_at,expires_at)
         VALUES (repeat('a',64),'payload',repeat('b',64),now(),now()+interval '1 day')`,
      ),
    );
    assert.ok(
      (await api.query("SELECT * FROM configuration_share_find(repeat('a',64), now())"))
        .rowCount !== null,
    );
    await assert.rejects(api.query('DELETE FROM shared_configurations'));
    await assert.rejects(api.query('UPDATE control_state SET updated_at = updated_at'));
    await assert.rejects(api.query('INSERT INTO control_commands DEFAULT VALUES'));

    assert.equal(
      (await control.query('UPDATE control_state SET updated_at = updated_at')).rowCount,
      1,
    );
    await assert.rejects(control.query('SELECT * FROM diagnostic_uploads'));
    await assert.rejects(control.query('SELECT * FROM telemetry_events'));
    await assert.rejects(control.query('SELECT * FROM shared_configurations'));
    await assert.rejects(control.query('DELETE FROM control_commands'));

    assert.ok(((await worker.query('SELECT id FROM diagnostic_uploads')).rowCount ?? 0) >= 1);
    await assert.rejects(worker.query('SELECT * FROM diagnostic_large_upload_grants'));
    await assert.rejects(worker.query('SELECT revision FROM control_state'));
    await assert.rejects(worker.query('SELECT * FROM telemetry_events'));
    await assert.rejects(worker.query('DELETE FROM telemetry_events'));
    await assert.rejects(worker.query('SELECT * FROM shared_configurations'));
    assert.ok(
      (await worker.query('SELECT configuration_share_delete_expired(now())')).rowCount !== null,
    );
    assert.equal(
      (
        await worker.query<{ deleted: number }>(
          "SELECT telemetry_delete_before(now() - interval '90 days') AS deleted",
        )
      ).rows[0]?.deleted,
      0,
    );
    await assert.rejects(worker.query('DELETE FROM diagnostic_uploads'));
  } finally {
    await Promise.all([api.end(), control.end(), worker.end()]);
  }
});

test('Postgres configuration shares expire and enforce a network daily budget', async () => {
  const repository = new PostgresConfigurationShareRepository(pool);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
  const created = await repository.create('Opaque_bundle_123', 's'.repeat(43), now, expiresAt);
  assert.ok(created);
  assert.match(created.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{20}$/);
  assert.equal((await repository.find(created.code, now))?.payload, 'Opaque_bundle_123');
  assert.equal(
    (
      await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM shared_configurations WHERE code_hash = $1',
        [createHash('sha256').update(created.code).digest('hex')],
      )
    ).rows[0]?.count,
    1,
  );
  await pool.query(
    `UPDATE shared_configurations
     SET created_at = $2, expires_at = $3
     WHERE code_hash = $1`,
    [
      createHash('sha256').update(created.code).digest('hex'),
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000),
      new Date(now.getTime() - 1_000),
    ],
  );
  assert.equal(await repository.find(created.code, now), null);
  assert.equal(await repository.deleteExpired(now), 1);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < 20; index += 1) {
      assert.equal(
        (
          await client.query<{ reserved: boolean }>(
            'SELECT configuration_share_reserve_capacity($1, $2) AS reserved',
            ['q'.repeat(43), 128],
          )
        ).rows[0]?.reserved,
        true,
      );
    }
    assert.equal(
      (
        await client.query<{ reserved: boolean }>(
          'SELECT configuration_share_reserve_capacity($1, $2) AS reserved',
          ['q'.repeat(43), 128],
        )
      ).rows[0]?.reserved,
      false,
    );
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('Postgres telemetry repository stores fixed pseudonymous events, summarizes, and expires them', async () => {
  const repository = new PostgresTelemetryRepository(pool);
  const now = new Date('2026-08-14T14:00:00.000Z');
  const pseudonym = 'p'.repeat(43);
  await repository.insertBatch(
    pseudonym,
    'n'.repeat(43),
    '1.2.3',
    5,
    [
      {
        kind: 'ocr-timing',
        occurredAtUtc: new Date('2026-08-14T13:59:30.000Z'),
        feature: 'ocr',
        outcome: 'completed',
        durationMilliseconds: 40,
        graphicsCapability: 'gpu:0',
        hardwareModel: 'NVIDIA GeForce RTX 4070',
      },
      {
        kind: 'ocr-setup-failure',
        occurredAtUtc: new Date('2026-08-14T13:59:40.000Z'),
        feature: 'ocr-setup',
        outcome: 'gpu_runtime_invalid',
        durationMilliseconds: 1200,
        operatingSystem: 'windows-10.0',
        setupStage: 'gpu-runtime',
        requestedDevice: 'gpu:0',
        processExitCode: 1,
        pythonLauncherPresent: true,
        wingetPresent: true,
        existingOcrPythonPresent: true,
        runtimeMarkerPresent: false,
      },
      {
        kind: 'local-instance-failure',
        occurredAtUtc: new Date('2026-08-14T13:59:50.000Z'),
        feature: 'local-instance',
        outcome: 'helper-failed',
        durationMilliseconds: 250,
        operatingSystem: 'windows-10.0',
        processExitCode: 2,
        operation: 'add-shared',
        failureCode: 'helper-failed',
        configurationMode: 'shared',
        runnerCount: 2,
      },
      {
        kind: 'ui-scale-calibration',
        occurredAtUtc: new Date('2026-08-14T13:59:55.000Z'),
        feature: 'ui-scale',
        outcome: 'observed',
        displayWidth: 1920,
        displayHeight: 1080,
        inputScaleMilli: 1000,
        renderedScaleMilli: 997,
      },
    ],
    now,
    512,
  );

  const rows = await repository.summary(new Date('2026-08-14T00:00:00.000Z'));
  const ocr = rows.find((row) => row.kind === 'ocr-timing');
  assert.equal(ocr?.eventCount, 1);
  assert.equal(ocr?.estimatedInstallations, 1);
  assert.equal(ocr?.averageDurationMilliseconds, 40);
  assert.equal(ocr?.graphicsCapability, 'gpu:0');
  assert.equal(ocr?.hardwareModel, 'NVIDIA GeForce RTX 4070');
  assert.equal(ocr?.latestEventAt.toISOString(), '2026-08-14T13:59:30.000Z');
  const calibration = rows.find((row) => row.kind === 'ui-scale-calibration');
  assert.equal(calibration?.displayWidth, 1920);
  assert.equal(calibration?.displayHeight, 1080);
  assert.equal(calibration?.inputScaleMilli, 1000);
  assert.equal(calibration?.renderedScaleMilli, 997);
  assert.equal(
    (
      await pool.query('SELECT install_pseudonym FROM telemetry_events WHERE kind = $1', [
        'ocr-timing',
      ])
    ).rows[0]?.install_pseudonym,
    pseudonym,
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT setup_stage, requested_device, process_exit_code, runtime_marker_present
         FROM telemetry_events WHERE kind = 'ocr-setup-failure'`,
      )
    ).rows[0],
    {
      setup_stage: 'gpu-runtime',
      requested_device: 'gpu:0',
      process_exit_code: 1,
      runtime_marker_present: false,
    },
  );
  await repository.insertBatch(
    pseudonym,
    'n'.repeat(43),
    '1.2.3',
    1,
    [
      {
        kind: 'feature-used',
        occurredAtUtc: new Date('2026-04-14T13:59:30.000Z'),
        feature: 'workspace',
        outcome: 'completed',
      },
    ],
    new Date('2026-04-14T14:00:00.000Z'),
    512,
  );
  assert.equal(await repository.deleteBefore(new Date('2026-08-15T00:00:00.000Z')), 1);
});

test('Postgres telemetry admission applies independent network event and byte budgets', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < 32; index += 1) {
      assert.equal(
        (
          await client.query<{ reserved: boolean }>(
            'SELECT telemetry_reserve_capacity($1, $2, $3) AS reserved',
            ['e'.repeat(43), 64, 512],
          )
        ).rows[0]?.reserved,
        true,
      );
    }
    assert.equal(
      (
        await client.query<{ reserved: boolean }>(
          'SELECT telemetry_reserve_capacity($1, $2, $3) AS reserved',
          ['e'.repeat(43), 1, 512],
        )
      ).rows[0]?.reserved,
      false,
    );
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    for (let index = 0; index < 64; index += 1) {
      assert.equal(
        (
          await client.query<{ reserved: boolean }>(
            'SELECT telemetry_reserve_capacity($1, $2, $3) AS reserved',
            ['b'.repeat(43), 1, 65_536],
          )
        ).rows[0]?.reserved,
        true,
      );
    }
    assert.equal(
      (
        await client.query<{ reserved: boolean }>(
          'SELECT telemetry_reserve_capacity($1, $2, $3) AS reserved',
          ['b'.repeat(43), 1, 1],
        )
      ).rows[0]?.reserved,
      false,
    );
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

function runtimeRoleUrl(role: string): string {
  if (!database) throw new Error('Temporary PostgreSQL was not initialized.');
  const url = new URL(database.connectionString);
  url.username = role;
  url.password = 'test-runtime-role-password';
  return url.toString();
}

function diagnosticRecord(now: Date, id = randomUUID()): DiagnosticUploadRecord {
  return {
    id,
    objectKey: `diagnostics/test/2026/08/${id}.zip`,
    installPseudonym: 'install-1',
    networkPseudonym: 'network-1',
    request: {
      fileName: 'diagnostic.zip',
      sizeBytes: 1_000,
      sha256: 'c'.repeat(64),
      kind: 'deep-debug',
      explicitConsent: true,
      appVersion: '1.0.111',
      osVersion: 'Microsoft Windows NT 10.0.19045.6456',
    },
    status: 'Uploading',
    createdAt: now,
    acceptanceDeadline: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
    providerUploadId: null,
    multipartParts: {},
    verificationAttempts: 0,
    nextVerificationAttemptAt: null,
    deletionAttempts: 0,
    nextDeletionAttemptAt: null,
    updatedAt: now,
  };
}
