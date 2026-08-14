import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionToken {
  raw: string;
  hash: string;
}

export function issueSessionToken(): SessionToken {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashSessionToken(raw) };
}

export function hashSessionToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}

export function issueCsrfToken(sessionRaw: string, keyBase64: string): string {
  return createHmac('sha256', Buffer.from(keyBase64, 'base64'))
    .update(`csrf\0${sessionRaw}`, 'utf8')
    .digest('base64url');
}

export function verifyCsrfToken(sessionRaw: string, supplied: string, keyBase64: string): boolean {
  const expected = Buffer.from(issueCsrfToken(sessionRaw, keyBase64));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
