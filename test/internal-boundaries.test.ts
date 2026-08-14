import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildControlServer } from '../src/apps/control-server.js';
import { ServiceHeartbeat } from '../src/apps/service-heartbeat.js';
import { FixedClock } from '../src/domain/clock.js';
import { CommandService } from '../src/domain/command-service.js';
import { loadConfig, requireControlConfig } from '../src/infrastructure/config.js';
import { InternalApiClient } from '../src/infrastructure/internal-api-client.js';
import { MemoryControlRepository } from '../src/infrastructure/memory-repositories.js';
import { Ed25519SnapshotSigner } from '../src/infrastructure/snapshot-signer.js';

function key(): string {
  return randomBytes(32).toString('base64');
}

test('private control boundary enforces service tokens, actors, and closed command ownership', async () => {
  const signing = generateKeyPairSync('ed25519');
  const apiToken = key();
  const botToken = key();
  const workerToken = key();
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3101',
    PUBLIC_ORIGIN: 'http://127.0.0.1:3100',
    DATABASE_URL: 'postgresql://unused.invalid/test',
    MACRO_ADMIN_IDS: '123456789012345678',
    CONTROL_SIGNING_PRIVATE_KEY_BASE64: signing.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    CONTROL_SIGNING_PUBLIC_KEY_BASE64: signing.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    CONTROL_SIGNING_KEY_ID: 'test-1',
    INTERNAL_API_TOKEN_BASE64: apiToken,
    INTERNAL_BOT_TOKEN_BASE64: botToken,
    INTERNAL_WORKER_TOKEN_BASE64: workerToken,
  });
  requireControlConfig(config);
  const repository = new MemoryControlRepository();
  const signer = new Ed25519SnapshotSigner(
    config.CONTROL_SIGNING_PRIVATE_KEY_BASE64,
    config.CONTROL_SIGNING_PUBLIC_KEY_BASE64,
    config.CONTROL_SIGNING_KEY_ID,
  );
  const commandService = new CommandService(
    repository,
    signer,
    new FixedClock(new Date('2026-08-14T12:00:00.000Z')),
  );
  await commandService.republish();
  const app = await buildControlServer({
    config,
    controlRepository: repository,
    commandService,
    signer,
  });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/api/commands',
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/api/commands',
          headers: bearer(apiToken),
          payload: {
            actorId: '123456789012345678',
            envelope: {
              commandId: randomUUID(),
              expectedRevision: 0,
              command: { type: 'code.add', code: 'CONTROLTEST', expiresAt: null },
            },
          },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/bot/commands',
          headers: bearer(apiToken),
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/bot/commands',
          headers: bearer(botToken),
          payload: {
            commandId: randomUUID(),
            actorId: '9',
            command: { type: 'code.remove', code: 'CONTROLTEST' },
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/worker/commands',
          headers: bearer(workerToken),
          payload: {
            commandId: randomUUID(),
            command: { type: 'code.remove', code: 'CONTROLTEST' },
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/worker/commands',
          headers: bearer(workerToken),
          payload: {
            commandId: randomUUID(),
            command: {
              type: 'game.observation',
              public: true,
              observedAt: '2026-08-14T12:00:00.000Z',
            },
          },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/worker/republish',
          headers: bearer(workerToken),
          payload: {},
        })
      ).statusCode,
      201,
    );
  } finally {
    await app.close();
  }
});

test('internal client binds bearer token, path, response schema, and bounded failure', async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const client = new InternalApiClient(
    'http://control:3101',
    'secret-token',
    async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ revision: 7 }, { status: 201 });
    },
  );
  assert.equal(
    await client.execute('123', randomUUID(), {
      type: 'code.remove',
      code: 'TEST',
    }),
    7,
  );
  assert.equal(calls[0]?.url, 'http://control:3101/internal/bot/commands');
  assert.equal(calls[0]?.authorization, 'Bearer secret-token');
  assert.equal((calls[0]?.body as { actorId: string }).actorId, '123');

  const diagnosticCalls: Array<{ url: string; body: unknown }> = [];
  const diagnosticClient = new InternalApiClient(
    'http://api:3100',
    'bot-token',
    async (input, init) => {
      diagnosticCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(null, { status: 204 });
    },
  );
  await diagnosticClient.moderateDiagnostic(
    '123',
    '11111111-1111-4111-8111-111111111111',
    'delete',
  );
  assert.deepEqual(diagnosticCalls, [
    {
      url: 'http://api:3100/internal/bot/diagnostics/moderate',
      body: {
        actorId: '123',
        uploadId: '11111111-1111-4111-8111-111111111111',
        action: 'delete',
      },
    },
  ]);

  const unavailable = new InternalApiClient(
    'http://control:3101',
    'secret-token',
    async () => new Response(null, { status: 503 }),
  );
  assert.equal(await unavailable.ready(), false);
  await assert.rejects(unavailable.republish(), /failed \(503\)/);
});

test('service heartbeat exists only while its functional probe succeeds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lilac-heartbeat-'));
  const file = path.join(directory, 'ready');
  let ready = true;
  const heartbeat = new ServiceHeartbeat(file, () => ready);
  try {
    await heartbeat.refresh();
    await access(file);
    assert.match(await readFile(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
    ready = false;
    await heartbeat.refresh();
    await assert.rejects(access(file));
  } finally {
    await heartbeat.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
