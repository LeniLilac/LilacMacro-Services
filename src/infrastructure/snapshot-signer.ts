import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJsonBytes } from '../contracts/canonical-json.js';
import {
  signedControlSnapshotSchema,
  type ControlPayload,
  type SignedControlSnapshot,
} from '../contracts/control-snapshot.js';
import { publishPayload, type MutableControlState } from '../domain/control-state.js';
import type { SnapshotSigner } from '../domain/ports.js';

export class Ed25519SnapshotSigner implements SnapshotSigner {
  private readonly privateKey;
  private readonly publicKey;

  public constructor(
    privateDerBase64: string,
    publicDerBase64: string,
    private readonly keyId: string,
  ) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(privateDerBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    this.publicKey = createPublicKey({
      key: Buffer.from(publicDerBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    this.assertReady();
  }

  public assertReady(): void {
    const challenge = Buffer.from('LilacMacro Services signing readiness v1', 'utf8');
    const signature = sign(null, challenge, this.privateKey);
    if (!verify(null, challenge, this.publicKey, signature)) {
      throw new Error('Control signing public and private keys do not match.');
    }
  }

  public async sign(state: MutableControlState, now: Date): Promise<SignedControlSnapshot> {
    const payload = publishPayload(state, now);
    const signature = sign(null, canonicalJsonBytes(payload), this.privateKey).toString('base64');
    return signedControlSnapshotSchema.parse({
      keyId: this.keyId,
      algorithm: 'Ed25519',
      payload,
      signature,
    });
  }
}

export function verifySnapshot(snapshot: SignedControlSnapshot, publicDerBase64: string): boolean {
  const publicKey = createPublicKey({
    key: Buffer.from(publicDerBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return verify(
    null,
    canonicalJsonBytes(snapshot.payload),
    publicKey,
    Buffer.from(snapshot.signature, 'base64'),
  );
}

export function validateSnapshotFreshness(
  payload: ControlPayload,
  now: Date,
  minimumRevision: number,
  maximumLifetimeMs = 15 * 60 * 1000,
): void {
  if (!Number.isInteger(minimumRevision) || minimumRevision < 0) {
    throw new Error('Minimum control revision was invalid.');
  }
  const generatedAt = new Date(payload.generatedAt).getTime();
  const expiresAt = new Date(payload.expiresAt).getTime();
  if (payload.revision < minimumRevision) throw new Error('Control snapshot revision rolled back.');
  if (generatedAt > now.getTime() + 60_000) {
    throw new Error('Control snapshot was generated in the future.');
  }
  if (expiresAt <= generatedAt) {
    throw new Error('Control snapshot expiry did not follow generation.');
  }
  if (expiresAt - generatedAt > maximumLifetimeMs) {
    throw new Error('Control snapshot lifetime exceeded the allowed bound.');
  }
  if (expiresAt <= now.getTime()) throw new Error('Control snapshot expired.');
}

export function parseVerifyAndValidateSnapshot(
  input: unknown,
  publicKeys: Readonly<Record<string, string>>,
  now: Date,
  minimumRevision: number,
): SignedControlSnapshot {
  const snapshot = signedControlSnapshotSchema.parse(input);
  const publicKey = publicKeys[snapshot.keyId];
  if (!publicKey) throw new Error('Control snapshot key ID was not trusted.');
  if (!verifySnapshot(snapshot, publicKey)) {
    throw new Error('Control snapshot signature was invalid.');
  }
  validateSnapshotFreshness(snapshot.payload, now, minimumRevision);
  return snapshot;
}
