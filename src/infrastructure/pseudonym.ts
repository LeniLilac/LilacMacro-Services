import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

function digest(key: Buffer, epoch: string, kind: string, value: string): string {
  return createHmac('sha256', key)
    .update(`${epoch}\0${kind}\0${value}`, 'utf8')
    .digest('base64url');
}

export class RotatingPseudonymizer {
  private readonly installKey: Buffer;
  private readonly networkKey: Buffer;

  public constructor(installKeyBase64: string, networkKeyBase64: string) {
    this.installKey = Buffer.from(installKeyBase64, 'base64');
    this.networkKey = Buffer.from(networkKeyBase64, 'base64');
    if (this.installKey.length < 32 || this.networkKey.length < 32) {
      throw new Error('Pseudonym HMAC key is too short.');
    }
    if (this.installKey.equals(this.networkKey)) {
      throw new Error('Install and network pseudonym keys must be independent.');
    }
  }

  public forInstall(installId: string, now: Date): string {
    return digest(this.installKey, this.epoch(now), 'install', installId.toLowerCase());
  }

  public forTelemetryInstall(installId: string, now: Date): string {
    return digest(this.installKey, this.epoch(now), 'telemetry-install', installId.toLowerCase());
  }

  public forNetwork(address: string, now: Date): string {
    return digest(this.networkKey, this.epoch(now), 'network', normalizeAddress(address));
  }

  public forTelemetryNetwork(address: string, now: Date): string {
    return digest(this.networkKey, this.epoch(now), 'telemetry-network', normalizeAddress(address));
  }

  public forShareNetwork(address: string, now: Date): string {
    return digest(this.networkKey, this.epoch(now), 'share-network', normalizeAddress(address));
  }

  private epoch(now: Date): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}

function normalizeAddress(address: string): string {
  const value = address.trim().toLowerCase();
  if (value === 'unidentified-peer') return value;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6 || value.includes('%')) throw new Error('Source address was not valid.');
  const groups = expandIpv6(value);
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

function expandIpv6(value: string): number[] {
  const halves = value.split('::');
  if (halves.length > 2) throw new Error('Source address was not valid.');
  const left = parseIpv6Groups(halves[0] ?? '');
  const right = parseIpv6Groups(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error('Source address was not valid.');
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Groups(value: string): number[] {
  if (!value) return [];
  return value.split(':').map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error('Source address was not valid.');
    return Number.parseInt(group, 16);
  });
}
