import { createHash, randomBytes } from 'node:crypto';

export interface OAuthAttempt {
  state: string;
  verifier: string;
  challenge: string;
  browserBinding: string;
  expiresAt: Date;
}

export function createOAuthAttempt(now: Date): OAuthAttempt {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  const browserBinding = randomBytes(32).toString('base64url');
  return {
    state,
    verifier,
    challenge,
    browserBinding,
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
  };
}
