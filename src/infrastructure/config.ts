import { z } from 'zod';
import { isIP } from 'node:net';

const base64Key = z
  .string()
  .min(40)
  .refine((value) => {
    try {
      return Buffer.from(value, 'base64').length >= 32;
    } catch {
      return false;
    }
  }, 'Expected at least 32 bytes of base64 key material.');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  PUBLIC_ORIGIN: z.url(),
  DATABASE_URL: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  DISCORD_BOT_CLIENT_ID: z.string().regex(/^\d+$/).optional(),
  DISCORD_BOT_CLIENT_SECRET: z.string().min(1).optional(),
  DISCORD_OAUTH_REDIRECT_URI: z.url().optional(),
  MACRO_ADMIN_IDS: z.string().default(''),
  SESSION_CSRF_HMAC_KEY_BASE64: base64Key.optional(),
  OAUTH_STATE_ENCRYPTION_KEY_BASE64: base64Key.optional(),
  UPLOAD_AUTH_HMAC_KEY_BASE64: base64Key.optional(),
  INSTALL_PSEUDONYM_HMAC_KEY_BASE64: base64Key.optional(),
  NETWORK_PSEUDONYM_HMAC_KEY_BASE64: base64Key.optional(),
  CONTROL_SIGNING_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  CONTROL_SIGNING_PUBLIC_KEY_BASE64: z.string().min(1),
  CONTROL_SIGNING_KEY_ID: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .default('primary-1'),
  BACKBLAZE_BUCKET_NAME: z.string().min(1).optional(),
  BACKBLAZE_S3_ENDPOINT: z.url().optional(),
  BACKBLAZE_REGION: z.string().min(1).optional(),
  BACKBLAZE_KEY_ID: z.string().min(1).optional(),
  BACKBLAZE_APPLICATION_KEY: z.string().min(1).optional(),
  BACKBLAZE_KEY_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9/_-]+$/)
    .refine(
      (value) =>
        !value.includes('..') &&
        !value.includes('//') &&
        !value.startsWith('/') &&
        !value.endsWith('/'),
    )
    .default('diagnostics/dev'),
  GITHUB_RELEASE_REPOSITORY: z.literal('LeniLilac/LilacMacro').default('LeniLilac/LilacMacro'),
  GITHUB_TOKEN: z.string().min(1).optional(),
  ROBLOX_UNIVERSE_ID: z.string().regex(/^\d+$/).optional(),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  INTERNAL_API_ORIGIN: z.url().optional(),
  INTERNAL_CONTROL_ORIGIN: z.url().optional(),
  INTERNAL_API_TOKEN_BASE64: base64Key.optional(),
  INTERNAL_BOT_TOKEN_BASE64: base64Key.optional(),
  INTERNAL_WORKER_TOKEN_BASE64: base64Key.optional(),
});

export type ServiceConfig = z.infer<typeof configSchema> & {
  adminIds: ReadonlySet<string>;
  trustedProxyCidrs: readonly string[];
};

type RequiredConfiguration<K extends keyof ServiceConfig> = ServiceConfig & {
  [P in K]-?: Exclude<ServiceConfig[P], undefined>;
};

export type ApiServiceConfig = RequiredConfiguration<
  | 'DATABASE_URL'
  | 'DISCORD_BOT_CLIENT_ID'
  | 'DISCORD_BOT_CLIENT_SECRET'
  | 'DISCORD_OAUTH_REDIRECT_URI'
  | 'SESSION_CSRF_HMAC_KEY_BASE64'
  | 'OAUTH_STATE_ENCRYPTION_KEY_BASE64'
  | 'UPLOAD_AUTH_HMAC_KEY_BASE64'
  | 'INSTALL_PSEUDONYM_HMAC_KEY_BASE64'
  | 'NETWORK_PSEUDONYM_HMAC_KEY_BASE64'
  | 'INTERNAL_CONTROL_ORIGIN'
  | 'INTERNAL_API_TOKEN_BASE64'
  | 'INTERNAL_BOT_TOKEN_BASE64'
  | BackblazeConfigurationKey
>;

export type BotServiceConfig = RequiredConfiguration<
  | 'DISCORD_BOT_TOKEN'
  | 'DISCORD_BOT_CLIENT_ID'
  | 'INTERNAL_API_ORIGIN'
  | 'INTERNAL_CONTROL_ORIGIN'
  | 'INTERNAL_BOT_TOKEN_BASE64'
>;

export type ControlServiceConfig = RequiredConfiguration<
  | 'DATABASE_URL'
  | 'CONTROL_SIGNING_PRIVATE_KEY_BASE64'
  | 'INTERNAL_API_TOKEN_BASE64'
  | 'INTERNAL_BOT_TOKEN_BASE64'
  | 'INTERNAL_WORKER_TOKEN_BASE64'
>;

export type WorkerServiceConfig = RequiredConfiguration<
  | 'DATABASE_URL'
  | 'INTERNAL_CONTROL_ORIGIN'
  | 'INTERNAL_WORKER_TOKEN_BASE64'
  | BackblazeConfigurationKey
>;

type BackblazeConfigurationKey =
  | 'BACKBLAZE_BUCKET_NAME'
  | 'BACKBLAZE_S3_ENDPOINT'
  | 'BACKBLAZE_REGION'
  | 'BACKBLAZE_KEY_ID'
  | 'BACKBLAZE_APPLICATION_KEY';

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const parsed = configSchema.parse(normalizeEnvironment(environment));
  const adminValues = parsed.MACRO_ADMIN_IDS.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (adminValues.some((item) => !/^\d+$/.test(item))) {
    throw new Error('MACRO_ADMIN_IDS contained an invalid Discord user ID.');
  }
  const adminIds = new Set(adminValues);
  validatePublicOrigin(parsed);
  validateInternalApiOrigin(parsed);
  validateBackblazeEndpoint(parsed);
  const trustedProxyCidrs = parseTrustedProxyCidrs(parsed.TRUSTED_PROXY_CIDRS);
  return { ...parsed, adminIds, trustedProxyCidrs };
}

const environmentAliases = {
  BACKBLAZE_BUCKET_NAME: 'BACKBLAZEBUCKETNAME',
  BACKBLAZE_S3_ENDPOINT: 'BACKBLAZES3ENDPOINT',
  BACKBLAZE_REGION: 'BACKBLAZEREGION',
  BACKBLAZE_KEY_ID: 'BACKBLAZEBUCKETKEYID',
  BACKBLAZE_APPLICATION_KEY: 'BACKBLAZEBUCKETKEY',
} as const;

function normalizeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...environment };
  for (const [name, value] of Object.entries(normalized)) {
    if (value === '') delete normalized[name];
  }
  for (const [canonical, alias] of Object.entries(environmentAliases)) {
    const canonicalValue = normalized[canonical];
    const aliasValue = normalized[alias];
    if (canonicalValue && aliasValue && canonicalValue !== aliasValue) {
      throw new Error(`${canonical} conflicted with its supported Doppler alias.`);
    }
    if (!canonicalValue && aliasValue) normalized[canonical] = aliasValue;
  }
  return normalized;
}

function validatePublicOrigin(parsed: z.infer<typeof configSchema>): void {
  const origin = new URL(parsed.PUBLIC_ORIGIN);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (parsed.NODE_ENV === 'production' && origin.protocol !== 'https:')
  ) {
    throw new Error('PUBLIC_ORIGIN must be an origin-only URL and production must use HTTPS.');
  }
  if (parsed.DISCORD_OAUTH_REDIRECT_URI) {
    const expected = new URL('/auth/discord/callback', origin).toString();
    if (new URL(parsed.DISCORD_OAUTH_REDIRECT_URI).toString() !== expected) {
      throw new Error('Discord OAuth redirect must exactly match the configured callback URL.');
    }
  }
}

function validateInternalApiOrigin(parsed: z.infer<typeof configSchema>): void {
  for (const [name, value] of [
    ['API', parsed.INTERNAL_API_ORIGIN],
    ['control', parsed.INTERNAL_CONTROL_ORIGIN],
  ] as const) {
    if (!value) continue;
    const origin = new URL(value);
    if (
      origin.protocol !== 'http:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      throw new Error(`Internal ${name} origin must be an HTTP origin-only URL.`);
    }
  }
}

function validateBackblazeEndpoint(parsed: z.infer<typeof configSchema>): void {
  if (!parsed.BACKBLAZE_S3_ENDPOINT) return;
  if (!parsed.BACKBLAZE_REGION) {
    throw new Error('Backblaze endpoint requires a region.');
  }
  const endpoint = new URL(parsed.BACKBLAZE_S3_ENDPOINT);
  const expectedHost = `s3.${parsed.BACKBLAZE_REGION}.backblazeb2.com`;
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname !== expectedHost ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Backblaze endpoint must be the exact official regional S3 origin.');
  }
}

function parseTrustedProxyCidrs(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [address, prefix, extra] = item.split('/');
      const version = address ? isIP(address) : 0;
      if (!version || extra !== undefined) throw new Error('Trusted proxy CIDR was invalid.');
      if (prefix !== undefined) {
        const bits = Number(prefix);
        const maximum = version === 4 ? 32 : 128;
        if (!/^\d{1,3}$/.test(prefix) || bits < 0 || bits > maximum) {
          throw new Error('Trusted proxy CIDR prefix was invalid.');
        }
      }
      return item;
    });
}

export function requireApiConfig(config: ServiceConfig): asserts config is ApiServiceConfig {
  requireAdministrators(config);
  if (
    !config.DATABASE_URL ||
    !config.DISCORD_BOT_CLIENT_ID ||
    !config.DISCORD_BOT_CLIENT_SECRET ||
    !config.DISCORD_OAUTH_REDIRECT_URI ||
    !config.SESSION_CSRF_HMAC_KEY_BASE64 ||
    !config.OAUTH_STATE_ENCRYPTION_KEY_BASE64 ||
    !config.UPLOAD_AUTH_HMAC_KEY_BASE64 ||
    !config.INSTALL_PSEUDONYM_HMAC_KEY_BASE64 ||
    !config.NETWORK_PSEUDONYM_HMAC_KEY_BASE64 ||
    !config.INTERNAL_CONTROL_ORIGIN ||
    !config.INTERNAL_API_TOKEN_BASE64 ||
    !config.INTERNAL_BOT_TOKEN_BASE64
  ) {
    throw new Error('API security configuration is incomplete.');
  }
  requireDistinctInternalTokens([
    ['API', config.INTERNAL_API_TOKEN_BASE64],
    ['bot', config.INTERNAL_BOT_TOKEN_BASE64],
  ]);
  requireBackblazeConfig(config);
}

export function requireBotConfig(config: ServiceConfig): asserts config is BotServiceConfig {
  requireAdministrators(config);
  if (
    !config.DISCORD_BOT_TOKEN ||
    !config.DISCORD_BOT_CLIENT_ID ||
    !config.INTERNAL_API_ORIGIN ||
    !config.INTERNAL_CONTROL_ORIGIN ||
    !config.INTERNAL_BOT_TOKEN_BASE64
  ) {
    throw new Error('Discord bot configuration is incomplete.');
  }
}

export function requireControlConfig(
  config: ServiceConfig,
): asserts config is ControlServiceConfig {
  requireAdministrators(config);
  if (
    !config.DATABASE_URL ||
    !config.CONTROL_SIGNING_PRIVATE_KEY_BASE64 ||
    !config.INTERNAL_API_TOKEN_BASE64 ||
    !config.INTERNAL_BOT_TOKEN_BASE64 ||
    !config.INTERNAL_WORKER_TOKEN_BASE64
  ) {
    throw new Error('Control-service security configuration is incomplete.');
  }
  requireDistinctInternalTokens([
    ['API', config.INTERNAL_API_TOKEN_BASE64],
    ['bot', config.INTERNAL_BOT_TOKEN_BASE64],
    ['worker', config.INTERNAL_WORKER_TOKEN_BASE64],
  ]);
}

export function requireWorkerConfig(config: ServiceConfig): asserts config is WorkerServiceConfig {
  if (
    !config.DATABASE_URL ||
    !config.INTERNAL_CONTROL_ORIGIN ||
    !config.INTERNAL_WORKER_TOKEN_BASE64
  ) {
    throw new Error('Worker security configuration is incomplete.');
  }
  requireBackblazeConfig(config);
}

function requireAdministrators(config: ServiceConfig): void {
  if (config.NODE_ENV === 'production' && config.adminIds.size === 0) {
    throw new Error('Production requires at least one macro administrator.');
  }
}

function requireBackblazeConfig(
  config: ServiceConfig,
): asserts config is RequiredConfiguration<BackblazeConfigurationKey> {
  if (
    !config.BACKBLAZE_BUCKET_NAME ||
    !config.BACKBLAZE_S3_ENDPOINT ||
    !config.BACKBLAZE_REGION ||
    !config.BACKBLAZE_KEY_ID ||
    !config.BACKBLAZE_APPLICATION_KEY
  ) {
    throw new Error('Backblaze configuration is incomplete.');
  }
}

function requireDistinctInternalTokens(tokens: ReadonlyArray<readonly [string, string]>): void {
  const seen = new Set<string>();
  for (const [name, token] of tokens) {
    if (seen.has(token)) {
      throw new Error(`Internal ${name} token must be unique to that service boundary.`);
    }
    seen.add(token);
  }
}
