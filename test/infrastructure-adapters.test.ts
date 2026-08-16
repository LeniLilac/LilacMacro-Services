import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto';
import test from 'node:test';
import { authCookieNames } from '../src/apps/auth-routes.js';
import { GitHubReleaseProbe } from '../src/infrastructure/github-release.js';
import {
  loadConfig,
  requireApiConfig,
  requireBotConfig,
  requireControlConfig,
  requireWorkerConfig,
} from '../src/infrastructure/config.js';
import { RobloxPlayabilityProbe } from '../src/infrastructure/roblox-playability.js';

function key(): string {
  return randomBytes(32).toString('base64');
}

function baseEnvironment(): NodeJS.ProcessEnv {
  const pair = generateKeyPairSync('ed25519');
  return {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1:3100',
    DATABASE_URL: 'postgresql://test@127.0.0.1/test',
    MACRO_ADMIN_IDS: '123,456',
    SESSION_CSRF_HMAC_KEY_BASE64: key(),
    OAUTH_STATE_ENCRYPTION_KEY_BASE64: key(),
    UPLOAD_AUTH_HMAC_KEY_BASE64: key(),
    LARGE_UPLOAD_GRANT_HMAC_KEY_BASE64: key(),
    INSTALL_PSEUDONYM_HMAC_KEY_BASE64: key(),
    NETWORK_PSEUDONYM_HMAC_KEY_BASE64: key(),
    CONTROL_SIGNING_PRIVATE_KEY_BASE64: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    CONTROL_SIGNING_PUBLIC_KEY_BASE64: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    INTERNAL_API_ORIGIN: 'http://api:3100',
    INTERNAL_CONTROL_ORIGIN: 'http://control:3101',
    INTERNAL_API_TOKEN_BASE64: key(),
    INTERNAL_BOT_TOKEN_BASE64: key(),
    INTERNAL_WORKER_TOKEN_BASE64: key(),
  };
}

test('configuration normalizes Doppler aliases and rejects ambiguous or unsafe production values', () => {
  const base = baseEnvironment();
  const config = loadConfig({
    ...base,
    BACKBLAZEBUCKETNAME: 'bucket',
    BACKBLAZES3ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
    BACKBLAZEREGION: 'us-east-005',
    BACKBLAZEBUCKETKEYID: 'key-id',
    BACKBLAZEBUCKETKEY: 'secret',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  });
  assert.equal(config.BACKBLAZE_BUCKET_NAME, 'bucket');
  assert.deepEqual(config.trustedProxyCidrs, ['127.0.0.1/32', '::1/128']);
  assert.equal(config.adminIds.has('456'), true);
  const optionalEmptyValues = loadConfig({
    ...base,
    GITHUB_TOKEN: '',
    ROBLOX_UNIVERSE_ID: '',
  });
  assert.equal(optionalEmptyValues.GITHUB_TOKEN, undefined);
  assert.equal(optionalEmptyValues.ROBLOX_UNIVERSE_ID, undefined);
  assert.throws(() => loadConfig({ ...base, MACRO_ADMIN_IDS: 'abc' }), /invalid Discord user ID/);
  const administratorless = loadConfig({
    ...base,
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://macro.invalid',
    MACRO_ADMIN_IDS: '',
  });
  assert.throws(() => requireApiConfig(administratorless), /at least one macro administrator/);
  assert.throws(
    () =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'http://macro.invalid',
      }),
    /production must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        DISCORD_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3100/wrong',
      }),
    /exactly match/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        BACKBLAZE_S3_ENDPOINT: 'https://example.invalid',
        BACKBLAZE_REGION: 'us-east-005',
      }),
    /exact official regional/,
  );
  assert.throws(
    () => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '127.0.0.1/99' }),
    /prefix was invalid/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        BACKBLAZE_BUCKET_NAME: 'one',
        BACKBLAZEBUCKETNAME: 'two',
      }),
    /conflicted/,
  );
});

test('service-specific configuration requires only secrets used by that process', () => {
  const base = {
    ...baseEnvironment(),
    BACKBLAZE_BUCKET_NAME: 'bucket',
    BACKBLAZE_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
    BACKBLAZE_REGION: 'us-east-005',
    BACKBLAZE_KEY_ID: 'key-id',
    BACKBLAZE_APPLICATION_KEY: 'secret',
  };

  const api = loadConfig({
    ...base,
    DISCORD_BOT_CLIENT_ID: '123456789012345678',
    DISCORD_BOT_CLIENT_SECRET: 'client-secret',
    DISCORD_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3100/auth/discord/callback',
  });
  requireApiConfig(api);
  assert.deepEqual(authCookieNames(api), { oauth: 'lm_oauth', session: 'lm_admin' });

  const productionApi = loadConfig({
    ...base,
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://macro.invalid',
    DISCORD_BOT_CLIENT_ID: '123456789012345678',
    DISCORD_BOT_CLIENT_SECRET: 'client-secret',
    DISCORD_OAUTH_REDIRECT_URI: 'https://macro.invalid/auth/discord/callback',
  });
  requireApiConfig(productionApi);
  assert.deepEqual(authCookieNames(productionApi), {
    oauth: '__Host-lm_oauth',
    session: '__Host-lm_admin',
  });

  const bot = loadConfig({
    ...base,
    DISCORD_BOT_TOKEN: 'bot-token',
    DISCORD_BOT_CLIENT_ID: '123456789012345678',
    SESSION_CSRF_HMAC_KEY_BASE64: undefined,
    OAUTH_STATE_ENCRYPTION_KEY_BASE64: undefined,
    UPLOAD_AUTH_HMAC_KEY_BASE64: undefined,
    LARGE_UPLOAD_GRANT_HMAC_KEY_BASE64: undefined,
    INSTALL_PSEUDONYM_HMAC_KEY_BASE64: undefined,
    NETWORK_PSEUDONYM_HMAC_KEY_BASE64: undefined,
    DATABASE_URL: undefined,
    CONTROL_SIGNING_PRIVATE_KEY_BASE64: undefined,
    BACKBLAZE_BUCKET_NAME: undefined,
    BACKBLAZE_S3_ENDPOINT: undefined,
    BACKBLAZE_REGION: undefined,
    BACKBLAZE_KEY_ID: undefined,
    BACKBLAZE_APPLICATION_KEY: undefined,
    INTERNAL_WORKER_TOKEN_BASE64: undefined,
  });
  requireBotConfig(bot);

  const control = loadConfig({
    ...base,
    SESSION_CSRF_HMAC_KEY_BASE64: undefined,
    OAUTH_STATE_ENCRYPTION_KEY_BASE64: undefined,
    UPLOAD_AUTH_HMAC_KEY_BASE64: undefined,
    LARGE_UPLOAD_GRANT_HMAC_KEY_BASE64: undefined,
    INSTALL_PSEUDONYM_HMAC_KEY_BASE64: undefined,
    NETWORK_PSEUDONYM_HMAC_KEY_BASE64: undefined,
    BACKBLAZE_BUCKET_NAME: undefined,
    BACKBLAZE_S3_ENDPOINT: undefined,
    BACKBLAZE_REGION: undefined,
    BACKBLAZE_KEY_ID: undefined,
    BACKBLAZE_APPLICATION_KEY: undefined,
  });
  requireControlConfig(control);

  const worker = loadConfig({
    ...base,
    MACRO_ADMIN_IDS: '',
    SESSION_CSRF_HMAC_KEY_BASE64: undefined,
    OAUTH_STATE_ENCRYPTION_KEY_BASE64: undefined,
    UPLOAD_AUTH_HMAC_KEY_BASE64: undefined,
    LARGE_UPLOAD_GRANT_HMAC_KEY_BASE64: undefined,
    INSTALL_PSEUDONYM_HMAC_KEY_BASE64: undefined,
    NETWORK_PSEUDONYM_HMAC_KEY_BASE64: undefined,
    CONTROL_SIGNING_PRIVATE_KEY_BASE64: undefined,
    INTERNAL_BOT_TOKEN_BASE64: undefined,
  });
  requireWorkerConfig(worker);

  assert.throws(() => {
    const duplicate = key();
    requireControlConfig(
      loadConfig({
        ...base,
        INTERNAL_API_TOKEN_BASE64: duplicate,
        INTERNAL_WORKER_TOKEN_BASE64: duplicate,
      }),
    );
  }, /must be unique/);

  assert.throws(
    () => requireApiConfig(worker),
    /API security configuration is incomplete|Backblaze configuration is incomplete/,
  );
});

test('GitHub release probe accepts the newest official stable or beta inventory', async () => {
  const pair = generateKeyPairSync('ed25519');
  const installer = Buffer.from('installer fixture');
  const installerDigest = createHash('sha256').update(installer).digest('hex');
  const manifest = Buffer.from(
    JSON.stringify({
      format: 'lilacmacro.release',
      schemaVersion: 1,
      keyId: 'test-release',
      algorithm: 'Ed25519',
      tag: 'v1.0.118',
      sourceCommit: 'b'.repeat(40),
      installer: {
        name: 'LilacMacro-Setup.exe',
        size: installer.length,
        sha256: installerDigest.toUpperCase(),
      },
    }),
  );
  const files = new Map<string, Buffer>([
    ['LilacMacro-Setup.exe', installer],
    [
      'LilacMacro-Setup.exe.sha256',
      Buffer.from(`${installerDigest.toUpperCase()}  LilacMacro-Setup.exe\n`),
    ],
    ['LilacMacro-Release.json', manifest],
    [
      'LilacMacro-Release.sig',
      Buffer.from(signBytes(null, manifest, pair.privateKey).toString('base64') + '\n'),
    ],
    ['LICENSE.md', Buffer.from('license')],
    ['NOTICE.md', Buffer.from('notice')],
  ]);
  const releaseAsset = (name: string) => {
    const contents = files.get(name)!;
    return {
      name,
      browser_download_url: `https://github.com/LeniLilac/LilacMacro/releases/download/v1.0.118/${name}`,
      size: contents.length,
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    };
  };
  const response = {
    tag_name: 'v1.0.118',
    html_url: 'https://github.com/LeniLilac/LilacMacro/releases/tag/v1.0.118',
    published_at: '2026-08-14T12:00:00Z',
    draft: false,
    prerelease: true,
    assets: [
      releaseAsset('LilacMacro-Setup.exe'),
      releaseAsset('LilacMacro-Setup.exe.sha256'),
      releaseAsset('LilacMacro-Release.json'),
      releaseAsset('LilacMacro-Release.sig'),
      releaseAsset('LICENSE.md'),
      releaseAsset('NOTICE.md'),
    ],
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/releases?')) {
      return new Response(
        JSON.stringify([
          { draft: true, tag_name: 'old-draft', published_at: null, assets: null },
          response,
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    assert.equal(init?.redirect, 'manual');
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    const contents = files.get(name);
    assert.ok(contents);
    return new Response(Uint8Array.from(contents).buffer, {
      status: 200,
      headers: { 'content-length': String(contents.length) },
    });
  };
  const release = await new GitHubReleaseProbe(
    'LeniLilac/LilacMacro',
    'token',
    fetcher,
    {
      keyId: 'test-release',
      publicKeySpkiBase64: pair.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
    },
    () => new Date('2026-08-14T12:05:00Z'),
  ).current();
  assert.equal(release.version, '1.0.118');
  assert.equal(release.installerSha256, installerDigest);
  assert.equal(release.verifiedAt, '2026-08-14T12:05:00.000Z');
  assert.equal(calls.length, 6);
  assert.match(calls[0] ?? '', /releases\?per_page=20$/);

  await assert.rejects(
    new GitHubReleaseProbe(
      'LeniLilac/LilacMacro',
      undefined,
      async () => new Response('{}', { status: 503 }),
    ).current(),
    /lookup failed/,
  );
  await assert.rejects(
    new GitHubReleaseProbe(
      'LeniLilac/LilacMacro',
      undefined,
      async () =>
        new Response(JSON.stringify([{ ...response, assets: response.assets.slice(0, -1) }])),
      {
        keyId: 'test-release',
        publicKeySpkiBase64: pair.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      },
    ).current(),
    /inventory was incomplete/,
  );
  await assert.rejects(
    new GitHubReleaseProbe(
      'LeniLilac/LilacMacro',
      undefined,
      async () => new Response(JSON.stringify([{ ...response, tag_name: 'latest' }])),
      {
        keyId: 'test-release',
        publicKeySpkiBase64: pair.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
      },
    ).current(),
    /did not expose an official semantic release/,
  );
});

test('Roblox playability probe uses the public universe listing instead of guest playability', async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.equal(String(input), 'https://games.roblox.com/v1/games?universeIds=12345');
    return new Response(JSON.stringify({ data: [{ id: 12345, name: 'Anime Expeditions' }] }));
  };
  assert.equal(await new RobloxPlayabilityProbe('12345', fetcher).current(), true);
  assert.equal(
    await new RobloxPlayabilityProbe(
      '12345',
      async () => new Response(JSON.stringify({ data: [] })),
    ).current(),
    false,
  );
  await assert.rejects(
    new RobloxPlayabilityProbe(
      '12345',
      async () => new Response(JSON.stringify({ data: [{ id: 54321 }] })),
    ).current(),
    /unexpected universe/,
  );
  await assert.rejects(
    new RobloxPlayabilityProbe('12345', async () => new Response('[]')).current(),
    /Invalid input/,
  );
  await assert.rejects(
    new RobloxPlayabilityProbe('12345', async () => new Response('{}', { status: 500 })).current(),
    /lookup failed/,
  );
});
