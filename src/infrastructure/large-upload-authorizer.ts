import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PersistedUploadRequest } from '../contracts/diagnostics.js';

export interface LargeUploadGrantPayload {
  version: 1;
  grantId: string;
  uploadId: string;
  objectKey: string;
  installPseudonym: string;
  sizeBytes: number;
  kind: PersistedUploadRequest['kind'];
  expiresAt: number;
}

export class HmacLargeUploadAuthorizer {
  private readonly key: Buffer;

  public constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length < 32) throw new Error('Large-upload authorization key is too short.');
  }

  public issue(
    payload: Omit<LargeUploadGrantPayload, 'version' | 'expiresAt'>,
    expiresAt: Date,
  ): string {
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        ...payload,
        expiresAt: expiresAt.getTime(),
      } satisfies LargeUploadGrantPayload),
    ).toString('base64url');
    return `${encoded}.${this.mac(encoded)}`;
  }

  public verify(
    token: string,
    installPseudonym: string,
    sizeBytes: number,
    kind: PersistedUploadRequest['kind'],
    now: Date,
  ): LargeUploadGrantPayload | null {
    const segments = token.split('.');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
    const expected = Buffer.from(this.mac(segments[0]), 'base64url');
    const supplied = Buffer.from(segments[1], 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(segments[0], 'base64url').toString('utf8'),
      ) as Partial<LargeUploadGrantPayload>;
      if (
        payload.version === 1 &&
        typeof payload.grantId === 'string' &&
        typeof payload.uploadId === 'string' &&
        typeof payload.objectKey === 'string' &&
        payload.installPseudonym === installPseudonym &&
        payload.sizeBytes === sizeBytes &&
        payload.kind === kind &&
        typeof payload.expiresAt === 'number' &&
        payload.expiresAt > now.getTime() &&
        payload.expiresAt <= now.getTime() + 31 * 60_000
      ) {
        return payload as LargeUploadGrantPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  private mac(value: string): string {
    return createHmac('sha256', this.key).update(value, 'utf8').digest('base64url');
  }
}
