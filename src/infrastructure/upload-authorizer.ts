import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UploadAuthorizer } from '../domain/diagnostic-service.js';

interface TokenPayload {
  version: 1;
  id: string;
  objectKey: string;
  expiresAt: number;
}

export class HmacUploadAuthorizer implements UploadAuthorizer {
  private readonly key: Buffer;

  public constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length < 32) throw new Error('Upload authorization key is too short.');
  }

  public issue(id: string, objectKey: string, expiresAt: Date): string {
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        id,
        objectKey,
        expiresAt: expiresAt.getTime(),
      } satisfies TokenPayload),
    ).toString('base64url');
    return `${encoded}.${this.mac(encoded)}`;
  }

  public verify(token: string, id: string, objectKey: string, now: Date): boolean {
    const segments = token.split('.');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return false;
    const expected = Buffer.from(this.mac(segments[0]));
    const supplied = Buffer.from(segments[1]);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    try {
      const payload = JSON.parse(
        Buffer.from(segments[0], 'base64url').toString('utf8'),
      ) as Partial<TokenPayload>;
      return (
        payload.version === 1 &&
        payload.id === id &&
        payload.objectKey === objectKey &&
        typeof payload.expiresAt === 'number' &&
        payload.expiresAt > now.getTime() &&
        payload.expiresAt <= now.getTime() + 13 * 60 * 60 * 1000
      );
    } catch {
      return false;
    }
  }

  private mac(value: string): string {
    return createHmac('sha256', this.key).update(value, 'utf8').digest('base64url');
  }
}
