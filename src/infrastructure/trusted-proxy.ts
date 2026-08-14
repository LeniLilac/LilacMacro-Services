import { BlockList, isIP } from 'node:net';

type AddressFamily = 'ipv4' | 'ipv6';

export class TrustedProxyAddressResolver {
  private readonly trusted = new BlockList();

  public constructor(cidrs: readonly string[]) {
    for (const cidr of cidrs) {
      const separator = cidr.lastIndexOf('/');
      const address = normalizeAddress(cidr.slice(0, separator));
      const prefix = Number(cidr.slice(separator + 1));
      const family = addressFamily(address);
      if (!family || !Number.isInteger(prefix)) {
        throw new Error('Trusted proxy CIDR was invalid.');
      }
      this.trusted.addSubnet(address, prefix, family);
    }
  }

  public resolve(remoteAddress: string | undefined, cfConnectingIp: unknown): string {
    const remote = normalizeAddress(remoteAddress ?? '');
    const remoteFamily = addressFamily(remote);
    if (!remoteFamily) return 'unidentified-peer';
    if (!this.trusted.check(remote, remoteFamily)) return remote;
    if (typeof cfConnectingIp !== 'string') return remote;

    const visitor = normalizeAddress(cfConnectingIp.trim());
    return addressFamily(visitor) ? visitor : remote;
  }
}

function normalizeAddress(address: string): string {
  const withoutZone = address.split('%', 1)[0] ?? '';
  if (withoutZone.toLowerCase().startsWith('::ffff:')) {
    const mapped = withoutZone.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return withoutZone;
}

function addressFamily(address: string): AddressFamily | null {
  const family = isIP(address);
  if (family === 4) return 'ipv4';
  if (family === 6) return 'ipv6';
  return null;
}
