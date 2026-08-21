import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  botCommands,
  commandFromInteraction,
  handleBotInteraction,
} from '../src/apps/bot-commands.js';
import { PostgresAuthStore } from '../src/infrastructure/auth-store.js';
import { BackblazeStorage } from '../src/infrastructure/backblaze-storage.js';
import { authorizationUrl, exchangeDiscordCode } from '../src/infrastructure/discord-oauth.js';
import { startTemporaryPostgres } from './helpers/postgres.js';

interface InteractionValues {
  readonly strings?: Readonly<Record<string, string | null>>;
  readonly booleans?: Readonly<Record<string, boolean>>;
  readonly integers?: Readonly<Record<string, number>>;
}

function interaction(commandName: string, values: InteractionValues = {}) {
  return {
    commandName,
    user: { id: '123456789012345678' },
    options: {
      getString: (name: string, required?: boolean) => {
        const value = values.strings?.[name] ?? null;
        if (required && value === null) throw new Error(`Missing ${name}.`);
        return value;
      },
      getBoolean: (name: string, required?: boolean) => {
        const value = values.booleans?.[name] ?? null;
        if (required && value === null) throw new Error(`Missing ${name}.`);
        return value;
      },
      getInteger: (name: string, required?: boolean) => {
        const value = values.integers?.[name] ?? null;
        if (required && value === null) throw new Error(`Missing ${name}.`);
        return value;
      },
    },
  } as unknown as ChatInputCommandInteraction;
}

test('bot command mapping covers every closed control operation', () => {
  assert.deepEqual(
    commandFromInteraction(
      interaction('macro-game', {
        booleans: { available: false },
        strings: { message: 'Updating' },
      }),
    ),
    { type: 'game.availability', available: false, message: 'Updating' },
  );
  assert.deepEqual(
    commandFromInteraction(
      interaction('macro-code', {
        strings: { action: 'add', code: 'NEWCODE', 'expires-at': null },
      }),
    ),
    { type: 'code.add', code: 'NEWCODE', expiresAt: null },
  );
  assert.deepEqual(
    commandFromInteraction(
      interaction('macro-code', { strings: { action: 'remove', code: 'OLDCODE' } }),
    ),
    { type: 'code.remove', code: 'OLDCODE' },
  );
  assert.deepEqual(
    commandFromInteraction(
      interaction('macro-feature', {
        strings: {
          action: 'disable',
          feature: 'task.expedition-shop',
          reason: null,
          'expires-at': null,
        },
      }),
    ),
    {
      type: 'feature.disable',
      feature: 'task.expedition-shop',
      reason: 'Temporarily disabled by an administrator.',
      expiresAt: null,
    },
  );
  assert.deepEqual(
    commandFromInteraction(
      interaction('macro-feature', {
        strings: { action: 'enable', feature: 'mode.raid' },
      }),
    ),
    { type: 'feature.enable', feature: 'mode.raid' },
  );
  assert.deepEqual(
    commandFromInteraction(
      interaction('macro-schedule', {
        strings: {
          key: 'expedition-shop-reset',
          'next-at': '2026-08-15T00:00:00.000Z',
        },
        integers: { 'cadence-seconds': 172_800 },
      }),
    ),
    {
      type: 'schedule.set',
      key: 'expedition-shop-reset',
      nextAt: '2026-08-15T00:00:00.000Z',
      cadenceSeconds: 172_800,
    },
  );
  assert.throws(
    () =>
      commandFromInteraction(
        interaction('macro-feature', {
          strings: { action: 'enable', feature: 'task.not-real' },
        }),
      ),
    /Unknown feature ID/,
  );
  assert.throws(() => commandFromInteraction(interaction('not-a-command')), /Unknown bot command/);
});

test('bot boundary denies non-admins and redacts unexpected command errors', async () => {
  const replies: unknown[] = [];
  const denied = {
    ...interaction('macro-game'),
    user: { id: '9' },
    reply: async (value: unknown) => replies.push(value),
  } as unknown as ChatInputCommandInteraction;
  await handleBotInteraction(denied, {
    adminIds: new Set(['1']),
    control: {} as never,
    diagnostics: {} as never,
  });
  assert.deepEqual(replies, [{ content: 'Administrator access required.', ephemeral: true }]);

  let edited = '';
  const broken = {
    ...interaction('not-a-command'),
    deferReply: async () => undefined,
    editReply: async (value: string) => {
      edited = value;
      return undefined as never;
    },
  } as unknown as ChatInputCommandInteraction;
  await handleBotInteraction(broken, {
    adminIds: new Set(['123456789012345678']),
    control: {} as never,
    diagnostics: {} as never,
  });
  assert.equal(edited, 'Command failed. Check service logs.');
});

test('bot diagnostic delete is administrator-only and forwarded to the private API', async () => {
  const diagnosticCommand = botCommands.find((command) => command.name === 'macro-diagnostic');
  assert.ok(diagnosticCommand);
  assert.equal(
    diagnosticCommand.options?.some((option) => option.name === 'action'),
    false,
  );

  let forwarded: unknown = null;
  let edited = '';
  const request = {
    ...interaction('macro-diagnostic', {
      strings: { 'upload-id': '11111111-1111-4111-8111-111111111111' },
    }),
    deferReply: async () => undefined,
    editReply: async (value: string) => {
      edited = value;
      return undefined as never;
    },
  } as unknown as ChatInputCommandInteraction;
  await handleBotInteraction(request, {
    adminIds: new Set(['123456789012345678']),
    control: {} as never,
    diagnostics: {
      async moderateDiagnostic(actorId, uploadId, action) {
        forwarded = { actorId, uploadId, action };
      },
    },
  });

  assert.deepEqual(forwarded, {
    actorId: '123456789012345678',
    uploadId: '11111111-1111-4111-8111-111111111111',
    action: 'delete',
  });
  assert.equal(edited, 'Diagnostic delete completed.');
});

test('Postgres auth attempts are encrypted, browser-bound, expiring, and one-time', async () => {
  const postgres = await startTemporaryPostgres();
  const store = new PostgresAuthStore(postgres.pool, Buffer.alloc(32, 7).toString('base64'));
  const expiry = new Date('2026-08-14T13:00:00.000Z');
  try {
    await store.storeAttempt('state', 'verifier-secret', 'browser-a', expiry);
    const raw = await postgres.pool.query<{ verifier_ciphertext: string }>(
      'SELECT verifier_ciphertext FROM oauth_attempts',
    );
    assert.equal(raw.rowCount, 1);
    assert.doesNotMatch(raw.rows[0]!.verifier_ciphertext, /verifier-secret/);
    assert.equal(
      await store.consumeAttempt('state', 'browser-b', new Date('2026-08-14T12:00:00.000Z')),
      null,
    );
    assert.deepEqual(
      await store.consumeAttempt('state', 'browser-a', new Date('2026-08-14T12:00:00.000Z')),
      { verifier: 'verifier-secret', expiresAt: expiry },
    );
    assert.equal(
      await store.consumeAttempt('state', 'browser-a', new Date('2026-08-14T12:00:01.000Z')),
      null,
    );

    await store.createSession('token-hash', '42', expiry);
    assert.equal(await store.sessionUser('token-hash', new Date('2026-08-14T12:00:00.000Z')), '42');
    await store.revokeSession('token-hash');
    assert.equal(await store.sessionUser('token-hash', new Date('2026-08-14T12:00:00.000Z')), null);

    await postgres.pool.query(
      `INSERT INTO oauth_attempts(state_hash, verifier_ciphertext, browser_binding_hash, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [
        createHash('sha256').update('bad-state').digest('base64url'),
        'short',
        createHash('sha256').update('browser-a').digest('base64url'),
        expiry,
      ],
    );
    await assert.rejects(
      store.consumeAttempt('bad-state', 'browser-a', new Date('2026-08-14T12:00:00.000Z')),
      /OAuth verifier record is invalid/,
    );
    assert.deepEqual(await store.cleanupExpired(new Date('2026-08-14T14:00:00.000Z')), {
      attempts: 2,
      sessions: 1,
    });
    assert.equal((await postgres.pool.query('SELECT 1 FROM oauth_attempts')).rowCount, 0);
    assert.equal((await postgres.pool.query('SELECT 1 FROM admin_sessions')).rowCount, 0);
    await assert.rejects(store.cleanupExpired(new Date(), 0), /limit was invalid/);
  } finally {
    await postgres.stop();
  }
});

test('Discord OAuth uses PKCE and validates both provider responses', async () => {
  const options = {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://macro.example/auth/discord/callback',
  };
  const authorize = new URL(authorizationUrl(options, 'state', 'challenge'));
  assert.equal(authorize.hostname, 'discord.com');
  assert.equal(authorize.searchParams.get('scope'), 'identify');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      return requests.length === 1
        ? Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 300 })
        : Response.json({ id: '123456789012345678', username: 'admin' });
    }) as typeof fetch;
    assert.deepEqual(await exchangeDiscordCode(options, 'code', 'verifier'), {
      id: '123456789012345678',
      username: 'admin',
    });
    assert.equal(requests.length, 2);
    assert.match(String(requests[1]!.init?.headers && (requests[1]!.init!.headers as object)), /./);

    globalThis.fetch = (async () => new Response('no', { status: 401 })) as typeof fetch;
    await assert.rejects(exchangeDiscordCode(options, 'code', 'verifier'), /token exchange failed/);

    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return call === 1
        ? Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 300 })
        : new Response('no', { status: 403 });
    }) as typeof fetch;
    await assert.rejects(
      exchangeDiscordCode(options, 'code', 'verifier'),
      /identity lookup failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Backblaze adapter constrains keys and verifies the complete object stream', async () => {
  const storage = new BackblazeStorage({
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    bucket: 'test-bucket',
    keyId: 'key-id',
    applicationKey: 'application-key',
    keyPrefix: 'diagnostics',
  });
  const sent: unknown[] = [];
  const operationSignals: AbortSignal[] = [];
  const content = Buffer.from('verified diagnostic');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const partUrl = new URL(
    await storage.presignPart('diagnostics/presigned.zip', 'upload-1', 1, {
      sizeBytes: content.length,
      sha256,
    }),
  );
  assert.match(partUrl.searchParams.get('X-Amz-SignedHeaders') ?? '', /x-amz-checksum-sha256/);
  assert.equal(partUrl.searchParams.get('X-Amz-Expires'), '3600');
  assert.equal(partUrl.searchParams.has('x-amz-checksum-sha256'), false);
  const client = (
    storage as unknown as {
      client: {
        send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
      };
    }
  ).client;
  let versionListCount = 0;
  client.send = async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
    sent.push(command);
    if (options?.abortSignal) operationSignals.push(options.abortSignal);
    const name = (command as { constructor: { name: string } }).constructor.name;
    if (name === 'CreateMultipartUploadCommand') return { UploadId: 'upload-1' };
    if (name === 'HeadObjectCommand') return { ContentLength: content.length };
    if (name === 'GetObjectCommand') {
      return {
        Body: (async function* () {
          yield content.subarray(0, 5);
          yield content.subarray(5);
        })(),
      };
    }
    if (name === 'ListObjectVersionsCommand') {
      versionListCount += 1;
      return versionListCount === 1
        ? {
            Versions: [{ Key: 'diagnostics/a.zip', VersionId: 'version-1' }],
            DeleteMarkers: [{ Key: 'diagnostics/a.zip', VersionId: 'marker-1' }],
          }
        : {};
    }
    return {};
  };

  assert.equal(await storage.beginMultipart('diagnostics/a.zip', 'application/zip'), 'upload-1');
  await storage.completeMultipart('diagnostics/a.zip', 'upload-1', [
    { partNumber: 1, etag: 'etag', checksumSha256: 'a'.repeat(64) },
  ]);
  await storage.verifySize('diagnostics/a.zip', content.length);
  await storage.verifyObject('diagnostics/a.zip', content.length, sha256);
  await storage.remove('diagnostics/a.zip', 'upload-1');
  assert.ok(sent.length >= 8);
  assert.equal(operationSignals.length, sent.length);
  assert.ok(operationSignals.every((signal) => signal instanceof AbortSignal));

  await assert.rejects(storage.verifySize('diagnostics/a.zip', content.length + 1), /size/);
  await assert.rejects(
    storage.verifyObject('diagnostics/a.zip', content.length, '0'.repeat(64)),
    /SHA-256/,
  );
  await assert.rejects(storage.beginMultipart('../outside.zip', 'application/zip'), /outside/);

  client.send = async () => ({});
  await assert.rejects(
    storage.beginMultipart('diagnostics/missing.zip', 'application/zip'),
    /multipart upload ID/,
  );
});
