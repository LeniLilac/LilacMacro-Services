import { execFileSync } from 'node:child_process';

const image = process.argv[2];
if (!image || !/^lilacmacro-services:[a-f0-9-]{1,64}$/.test(image)) {
  throw new Error('A bounded LilacMacro Services image tag is required.');
}

const encodedKey = Buffer.alloc(32, 7).toString('base64');
const composeEnvironment = {
  ...process.env,
  RELEASE_SHA: 'container-check',
  PUBLIC_ORIGIN: 'https://macro.example.test',
  CONTROL_SIGNING_PUBLIC_KEY_BASE64: encodedKey,
  CONTROL_SIGNING_PRIVATE_KEY_BASE64: encodedKey,
  POSTGRES_PASSWORD: 'owner-password',
  POSTGRES_API_PASSWORD: 'api-password',
  POSTGRES_CONTROL_PASSWORD: 'control-password',
  POSTGRES_WORKER_PASSWORD: 'worker-password',
  INTERNAL_API_TOKEN_BASE64: Buffer.alloc(32, 1).toString('base64'),
  INTERNAL_BOT_TOKEN_BASE64: Buffer.alloc(32, 2).toString('base64'),
  INTERNAL_WORKER_TOKEN_BASE64: Buffer.alloc(32, 3).toString('base64'),
  BACKBLAZEBUCKETNAME: 'test-bucket',
  BACKBLAZES3ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  BACKBLAZEREGION: 'us-west-004',
  BACKBLAZE_API_KEY_ID: 'api-key-id',
  BACKBLAZE_API_APPLICATION_KEY: 'api-application-key',
  BACKBLAZE_WORKER_KEY_ID: 'worker-key-id',
  BACKBLAZE_WORKER_APPLICATION_KEY: 'worker-application-key',
  BACKBLAZE_KEY_PREFIX: 'diagnostics/test',
  DISCORD_BOT_TOKEN: 'discord-token',
  DISCORD_BOT_CLIENT_ID: '123456789012345678',
  DISCORD_BOT_CLIENT_SECRET: 'discord-client-secret',
  DISCORD_OAUTH_REDIRECT_URI: 'https://macro.example.test/auth/discord/callback',
  MACRO_ADMIN_IDS: '123456789012345678',
  SESSION_CSRF_HMAC_KEY_BASE64: encodedKey,
  OAUTH_STATE_ENCRYPTION_KEY_BASE64: encodedKey,
  UPLOAD_AUTH_HMAC_KEY_BASE64: encodedKey,
  INSTALL_PSEUDONYM_HMAC_KEY_BASE64: encodedKey,
  NETWORK_PSEUDONYM_HMAC_KEY_BASE64: encodedKey,
  CLOUDFLARE_TUNNEL_TOKEN: 'container-check-not-connected',
};

const rendered = JSON.parse(
  execFileSync(
    'docker',
    ['compose', '--profile', 'tools', '-f', 'compose.yml', 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      env: composeEnvironment,
    },
  ),
);
const services = rendered.services;
for (const name of ['api', 'control', 'bot', 'worker', 'migrator', 'postgres', 'cloudflared']) {
  if (!services?.[name]) throw new Error(`Rendered Compose omitted ${name}.`);
}

for (const name of ['api', 'control', 'bot', 'worker', 'migrator']) {
  if (services[name].image !== 'lilacmacro-services:container-check') {
    throw new Error(`${name} did not reuse the one immutable application image.`);
  }
  if (services[name].build) {
    throw new Error(`${name} unexpectedly defined a per-service image build.`);
  }
}

const environmentOf = (name) => services[name].environment ?? {};
const mustHave = (name, key) => {
  if (!environmentOf(name)[key]) throw new Error(`${name} omitted ${key}.`);
};
const mustNotHave = (name, key) => {
  if (key in environmentOf(name)) throw new Error(`${name} unexpectedly received ${key}.`);
};

mustHave('control', 'CONTROL_SIGNING_PRIVATE_KEY_BASE64');
for (const name of ['api', 'bot', 'worker']) {
  mustNotHave(name, 'CONTROL_SIGNING_PRIVATE_KEY_BASE64');
}
mustHave('api', 'INTERNAL_API_TOKEN_BASE64');
mustHave('bot', 'INTERNAL_BOT_TOKEN_BASE64');
mustHave('worker', 'INTERNAL_WORKER_TOKEN_BASE64');
mustNotHave('api', 'INTERNAL_WORKER_TOKEN_BASE64');
mustNotHave('bot', 'DATABASE_URL');
mustNotHave('bot', 'BACKBLAZE_APPLICATION_KEY');
mustNotHave('control', 'BACKBLAZE_APPLICATION_KEY');
mustNotHave('worker', 'DISCORD_BOT_TOKEN');
mustNotHave('worker', 'MACRO_ADMIN_IDS');
mustHave('migrator', 'DATABASE_URL');
for (const key of [
  'CONTROL_SIGNING_PRIVATE_KEY_BASE64',
  'CONTROL_SIGNING_PUBLIC_KEY_BASE64',
  'INTERNAL_API_TOKEN_BASE64',
  'INTERNAL_BOT_TOKEN_BASE64',
  'INTERNAL_WORKER_TOKEN_BASE64',
  'BACKBLAZE_APPLICATION_KEY',
  'DISCORD_BOT_TOKEN',
]) {
  mustNotHave('migrator', key);
}
if (environmentOf('api').BACKBLAZE_KEY_ID === environmentOf('worker').BACKBLAZE_KEY_ID) {
  throw new Error('API and worker rendered with the same Backblaze key.');
}
if (environmentOf('api').TRUSTED_PROXY_CIDRS !== '10.250.254.3/32') {
  throw new Error('API did not trust only the dedicated tunnel peer.');
}
if (environmentOf('cloudflared').TUNNEL_TOKEN !== 'container-check-not-connected') {
  throw new Error('Tunnel token was not isolated to cloudflared.');
}
for (const name of ['api', 'control', 'bot', 'worker', 'postgres']) {
  mustNotHave(name, 'TUNNEL_TOKEN');
}
for (const name of ['api', 'control', 'bot', 'worker', 'migrator', 'postgres', 'cloudflared']) {
  for (const key of [
    'BACKBLAZE_OWNER_KEY_ID',
    'BACKBLAZE_OWNER_APPLICATION_KEY',
    'BACKBLAZEMASTERKEYID',
    'BACKBLAZEMASTERKEYTOKEN',
    'BACKBLAZEBUCKETKEYID',
    'BACKBLAZEBUCKETKEY',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_TOKEN_DOMAIN',
  ]) {
    mustNotHave(name, key);
  }
}
if (
  services.api.networks?.edge?.ipv4_address !== '10.250.254.2' ||
  services.cloudflared.networks?.edge?.ipv4_address !== '10.250.254.3'
) {
  throw new Error('Tunnel and API did not render on their fixed isolated edge identities.');
}
const expectedTunnelImage =
  'cloudflare/cloudflared:2026.8.2@sha256:0aa26e284f05e6c77ae375b8c9c11d9eb6a448fb7bcd8d40f31cb6176189eb38';
if (services.cloudflared.image !== expectedTunnelImage) {
  throw new Error('Cloudflared did not render from the reviewed immutable image digest.');
}
if (services.cloudflared.user !== '65532:65532' || services.cloudflared.read_only !== true) {
  throw new Error('Cloudflared did not render as the read-only unprivileged account.');
}
if (!services.cloudflared.cap_drop?.includes('ALL')) {
  throw new Error('Cloudflared retained Linux capabilities.');
}
if (!services.cloudflared.security_opt?.includes('no-new-privileges:true')) {
  throw new Error('Cloudflared omitted no-new-privileges.');
}
if (Object.keys(services.cloudflared.networks ?? {}).join(',') !== 'edge') {
  throw new Error('Cloudflared was attached outside the dedicated edge network.');
}
if (!rendered.networks?.backend?.internal) {
  throw new Error('Backend network did not deny external routing.');
}
if (rendered.networks?.egress?.internal) {
  throw new Error('Egress network unexpectedly denied required provider access.');
}
const networkNames = (name) =>
  Object.keys(services[name].networks ?? {})
    .sort()
    .join(',');
for (const name of ['control', 'migrator', 'postgres']) {
  if (networkNames(name) !== 'backend') {
    throw new Error(`${name} was attached outside the isolated backend network.`);
  }
}
if (networkNames('api') !== 'backend,edge,egress') {
  throw new Error('API did not render with backend, provider egress, and edge networks.');
}
for (const name of ['bot', 'worker']) {
  if (networkNames(name) !== 'backend,egress') {
    throw new Error(`${name} did not render with only backend and provider egress.`);
  }
}

const runtimeCheck = String.raw`
const fs = require('node:fs');
const required = [
  'dist/src/apps/api.js',
  'dist/src/apps/control.js',
  'dist/src/apps/bot.js',
  'dist/src/apps/worker.js',
  'dist/scripts/migrate.js',
  'dist/scripts/provision-db-roles.js',
  'dist/scripts/verify-control-snapshot.js',
  'dist/public/index.html',
  'dist/public/admin.html',
  'scripts/check-heartbeat.mjs',
  'migrations/001_initial.sql',
  'migrations/002_runtime_roles.sql',
  'migrations/003_diagnostic_delete_audit.sql'
];
for (const file of required) fs.accessSync(file, fs.constants.R_OK);
if (process.getuid?.() !== 1000) throw new Error('Runtime image is not using uid 1000.');
for (const file of required) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    throw new Error('Runtime artifact is writable: ' + file);
  } catch (error) {
    if (error?.message?.startsWith('Runtime artifact is writable:')) throw error;
  }
}
`;
execFileSync('docker', ['run', '--rm', '--entrypoint', 'node', image, '-e', runtimeCheck], {
  stdio: 'inherit',
});
console.log('Built container and rendered Compose authority checks passed.');
