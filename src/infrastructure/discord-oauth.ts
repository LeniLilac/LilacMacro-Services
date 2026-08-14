import { z } from 'zod';

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().positive(),
  })
  .passthrough();
const userSchema = z
  .object({ id: z.string().regex(/^\d+$/), username: z.string().min(1) })
  .passthrough();

export interface DiscordOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function authorizationUrl(
  options: DiscordOAuthOptions,
  state: string,
  challenge: string,
): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeDiscordCode(
  options: DiscordOAuthOptions,
  code: string,
  verifier: string,
): Promise<{ id: string; username: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code,
    code_verifier: verifier,
  });
  const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw new Error('Discord OAuth token exchange failed.');
  const token = tokenResponseSchema.parse(await tokenResponse.json());
  const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userResponse.ok) throw new Error('Discord identity lookup failed.');
  const user = userSchema.parse(await userResponse.json());
  return { id: user.id, username: user.username };
}
