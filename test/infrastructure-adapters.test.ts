import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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

test('GitHub release probe accepts only the official stable installer inventory', async () => {
  const response = {
    tag_name: 'v1.0.118',
    html_url: 'https://github.com/LeniLilac/LilacMacro/releases/tag/v1.0.118',
    published_at: '2026-08-14T12:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'LilacMacro-Setup.exe',
        browser_download_url:
          'https://github.com/LeniLilac/LilacMacro/releases/download/v1.0.118/LilacMacro-Setup.exe',
      },
    ],
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const release = await new GitHubReleaseProbe('LeniLilac/LilacMacro', 'token', fetcher).current();
  assert.equal(release.version, '1.0.118');
  assert.equal(calls.length, 1);

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
      async () => new Response(JSON.stringify({ ...response, prerelease: true })),
    ).current(),
    /not stable/,
  );
  await assert.rejects(
    new GitHubReleaseProbe(
      'LeniLilac/LilacMacro',
      undefined,
      async () => new Response(JSON.stringify({ ...response, tag_name: 'latest' })),
    ).current(),
    /not semantic/,
  );
});

test('Roblox playability probe binds the configured universe and rejects incomplete responses', async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.match(String(input), /universeIds=12345/);
    return new Response(
      JSON.stringify([{ universeId: 12345, isPlayable: true, playabilityStatus: 'Playable' }]),
    );
  };
  assert.equal(await new RobloxPlayabilityProbe('12345', fetcher).current(), true);
  await assert.rejects(
    new RobloxPlayabilityProbe('12345', async () => new Response('[]')).current(),
    /omitted/,
  );
  await assert.rejects(
    new RobloxPlayabilityProbe('12345', async () => new Response('{}', { status: 500 })).current(),
    /lookup failed/,
  );
});
