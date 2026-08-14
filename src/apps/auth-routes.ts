import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createOAuthAttempt } from '../infrastructure/oauth-state.js';
import { authorizationUrl, exchangeDiscordCode } from '../infrastructure/discord-oauth.js';
import {
  hashSessionToken,
  issueCsrfToken,
  issueSessionToken,
  verifyCsrfToken,
} from '../infrastructure/session-codec.js';
import type { PostgresAuthStore } from '../infrastructure/auth-store.js';
import type { ApiServiceConfig } from '../infrastructure/config.js';

const callbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(20).max(256),
});

export interface AuthDependencies {
  config: ApiServiceConfig;
  store: PostgresAuthStore;
}

export interface AuthorizedRequest {
  userId: string;
  sessionRaw: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthDependencies,
): Promise<void> {
  const { config, store } = dependencies;
  const oauthOptions = requireOAuthConfig(config);
  const cookies = authCookieNames(config);

  app.get(
    '/auth/discord',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (_request, reply) => {
      const attempt = createOAuthAttempt(new Date());
      await store.storeAttempt(
        attempt.state,
        attempt.verifier,
        attempt.browserBinding,
        attempt.expiresAt,
      );
      reply.setCookie(cookies.oauth, attempt.browserBinding, cookieOptions(config, 5 * 60));
      return reply.redirect(authorizationUrl(oauthOptions, attempt.state, attempt.challenge));
    },
  );

  app.get('/auth/discord/callback', async (request, reply) => {
    const query = callbackSchema.parse(request.query);
    const browserBinding = request.cookies[cookies.oauth];
    reply.clearCookie(cookies.oauth, cookieOptions(config));
    if (!browserBinding || browserBinding.length > 128) {
      return reply.code(400).send({ error: 'OAuth browser binding was missing.' });
    }
    const attempt = await store.consumeAttempt(query.state, browserBinding, new Date());
    if (!attempt)
      return reply.code(400).send({ error: 'OAuth attempt expired or was already used.' });
    const user = await exchangeDiscordCode(oauthOptions, query.code, attempt.verifier);
    if (!config.adminIds.has(user.id))
      return reply.code(403).send({ error: 'Administrator access required.' });
    const token = issueSessionToken();
    await store.createSession(token.hash, user.id, new Date(Date.now() + 8 * 60 * 60 * 1000));
    reply.setCookie(cookies.session, token.raw, cookieOptions(config, 8 * 60 * 60));
    return reply.redirect('/admin');
  });

  app.post('/auth/logout', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, dependencies, true);
    if (!auth) return;
    await store.revokeSession(hashSessionToken(auth.sessionRaw));
    reply.clearCookie(cookies.session, cookieOptions(config));
    return reply.code(204).send();
  });
}

export async function authorizeAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AuthDependencies,
  csrfRequired: boolean,
): Promise<AuthorizedRequest | null> {
  const raw = request.cookies[authCookieNames(dependencies.config).session];
  if (!raw || raw.length > 128) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  const userId = await dependencies.store.sessionUser(hashSessionToken(raw), new Date());
  if (!userId || !dependencies.config.adminIds.has(userId)) {
    await reply.code(403).send({ error: 'Administrator access required.' });
    return null;
  }
  if (csrfRequired) {
    const supplied = request.headers['x-csrf-token'];
    if (
      typeof supplied !== 'string' ||
      !verifyCsrfToken(raw, supplied, dependencies.config.SESSION_CSRF_HMAC_KEY_BASE64)
    ) {
      await reply.code(403).send({ error: 'CSRF validation failed.' });
      return null;
    }
  }
  return { userId, sessionRaw: raw };
}

export function csrfFor(auth: AuthorizedRequest, config: ApiServiceConfig): string {
  return issueCsrfToken(auth.sessionRaw, config.SESSION_CSRF_HMAC_KEY_BASE64);
}

function requireOAuthConfig(config: ApiServiceConfig) {
  if (
    !config.DISCORD_BOT_CLIENT_ID ||
    !config.DISCORD_BOT_CLIENT_SECRET ||
    !config.DISCORD_OAUTH_REDIRECT_URI
  ) {
    throw new Error('Discord OAuth configuration is incomplete.');
  }
  return {
    clientId: config.DISCORD_BOT_CLIENT_ID,
    clientSecret: config.DISCORD_BOT_CLIENT_SECRET,
    redirectUri: config.DISCORD_OAUTH_REDIRECT_URI,
  };
}

export function authCookieNames(config: ApiServiceConfig): { oauth: string; session: string } {
  return config.NODE_ENV === 'production'
    ? { oauth: '__Host-lm_oauth', session: '__Host-lm_admin' }
    : { oauth: 'lm_oauth', session: 'lm_admin' };
}

function cookieOptions(config: ApiServiceConfig, maxAge?: number) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}
