import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import type { ReleaseObservation } from '../domain/operational-sync.js';
import { readBoundedJson } from './bounded-json.js';
import { officialReleaseTrust, type ReleaseTrust } from './release-trust.js';

const versionPart = '(?:0|[1-9]\\d{0,8})';
const semanticTagPattern = new RegExp(`^v${versionPart}\\.${versionPart}\\.${versionPart}$`);
const maximumInstallerBytes = 512 * 1024 * 1024;

const releaseAssetSchema = z
  .object({
    name: z.string(),
    browser_download_url: z.url(),
    size: z.number().int().positive().max(maximumInstallerBytes),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  })
  .passthrough();

const releaseResponseSchema = z
  .object({
    tag_name: z.string().regex(semanticTagPattern),
    html_url: z.url(),
    published_at: z.iso.datetime(),
    draft: z.literal(false),
    prerelease: z.boolean(),
    assets: z.array(releaseAssetSchema).max(12),
  })
  .passthrough();

const releaseListSchema = z.array(z.unknown()).max(20);
const releaseManifestSchema = z
  .object({
    format: z.literal('lilacmacro.release'),
    schemaVersion: z.literal(1),
    keyId: z.string().regex(/^[a-z0-9-]{1,32}$/),
    algorithm: z.literal('Ed25519'),
    tag: z.string().regex(semanticTagPattern),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    installer: z
      .object({
        name: z.literal('LilacMacro-Setup.exe'),
        size: z.number().int().positive().max(maximumInstallerBytes),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
      })
      .strict(),
  })
  .strict();

const requiredAssetNames = [
  'LilacMacro-Setup.exe',
  'LilacMacro-Setup.exe.sha256',
  'LilacMacro-Release.json',
  'LilacMacro-Release.sig',
  'LICENSE.md',
  'NOTICE.md',
] as const;
const requiredAssetSet = new Set<string>(requiredAssetNames);
const fetchedAssetLimits: Readonly<Record<string, number>> = {
  'LilacMacro-Setup.exe.sha256': 256,
  'LilacMacro-Release.json': 4096,
  'LilacMacro-Release.sig': 256,
  'LICENSE.md': 128 * 1024,
  'NOTICE.md': 256 * 1024,
};
const trustedRedirectHosts = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

type ReleaseAsset = z.infer<typeof releaseAssetSchema>;

export class GitHubReleaseProbe {
  public constructor(
    private readonly repository: 'LeniLilac/LilacMacro',
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly trust: ReleaseTrust = officialReleaseTrust,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async current(): Promise<ReleaseObservation> {
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.repository}/releases?per_page=20`,
      {
        headers: this.headers(true),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error('GitHub release lookup failed.');
    const listed = releaseListSchema.parse(await readBoundedJson(response, 4 * 1024 * 1024));
    const eligible = listed
      .filter(isSemanticPublishedRelease)
      .sort((left, right) =>
        compareVersions(String(record(right).tag_name), String(record(left).tag_name)),
      );
    if (!eligible.length) throw new Error('GitHub did not expose an official semantic release.');
    const release = releaseResponseSchema.parse(eligible[0]);
    const assets = validateInventory(this.repository, release);

    const [checksumBytes, manifestBytes, signatureBytes] = await Promise.all([
      this.fetchVerifiedAsset(assets.get('LilacMacro-Setup.exe.sha256')!),
      this.fetchVerifiedAsset(assets.get('LilacMacro-Release.json')!),
      this.fetchVerifiedAsset(assets.get('LilacMacro-Release.sig')!),
      this.fetchVerifiedAsset(assets.get('LICENSE.md')!),
      this.fetchVerifiedAsset(assets.get('NOTICE.md')!),
    ]);
    const signature = parseSignature(signatureBytes);
    const publicKey = createPublicKey({
      key: Buffer.from(this.trust.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, manifestBytes, publicKey, signature)) {
      throw new Error('GitHub release project signature was invalid.');
    }
    const manifest = releaseManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    const installer = assets.get('LilacMacro-Setup.exe')!;
    const installerDigest = digestValue(installer);
    if (
      manifest.keyId !== this.trust.keyId ||
      manifest.tag !== release.tag_name ||
      manifest.installer.size !== installer.size ||
      manifest.installer.sha256.toLowerCase() !== installerDigest
    ) {
      throw new Error('GitHub release manifest did not bind the installer asset.');
    }
    const expectedChecksum = `${manifest.installer.sha256.toUpperCase()}  LilacMacro-Setup.exe`;
    if (checksumBytes.toString('utf8').trimEnd() !== expectedChecksum) {
      throw new Error('GitHub release checksum did not bind the installer asset.');
    }

    return {
      version: release.tag_name.slice(1),
      tag: release.tag_name,
      pageUrl: release.html_url,
      installerUrl: installer.browser_download_url,
      installerSize: installer.size,
      installerSha256: installerDigest,
      sourceCommit: manifest.sourceCommit,
      publishedAt: release.published_at,
      verifiedAt: this.now().toISOString(),
    };
  }

  private async fetchVerifiedAsset(asset: ReleaseAsset): Promise<Buffer> {
    const maximum = fetchedAssetLimits[asset.name];
    if (!maximum || asset.size > maximum) throw new Error('GitHub release asset size was invalid.');
    let current = new URL(asset.browser_download_url);
    let redirected = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      validateAssetUrl(current, redirected);
      const response = await this.fetcher(current, {
        headers: this.headers(!redirected),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('GitHub release redirect was incomplete.');
        current = new URL(location, current);
        redirected = true;
        continue;
      }
      if (!response.ok) throw new Error('GitHub release asset lookup failed.');
      const bytes = await readExactBytes(response, asset.size, maximum);
      const actualDigest = createHash('sha256').update(bytes).digest('hex');
      if (actualDigest !== digestValue(asset)) {
        throw new Error('GitHub release asset digest was invalid.');
      }
      return bytes;
    }
    throw new Error('GitHub release asset redirects exceeded the limit.');
  }

  private headers(includeAuthorization: boolean): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'LilacMacro-Services/1',
      ...(includeAuthorization && this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }
}

function validateInventory(
  repository: 'LeniLilac/LilacMacro',
  release: z.infer<typeof releaseResponseSchema>,
): Map<string, ReleaseAsset> {
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const expectedReleaseUrl = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
  if (
    release.assets.length !== requiredAssetSet.size ||
    assets.size !== requiredAssetSet.size ||
    !requiredAssetNames.every((name) => assets.has(name)) ||
    release.html_url !== expectedReleaseUrl ||
    release.assets.some(
      (asset) =>
        asset.browser_download_url !==
        `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}`,
    )
  ) {
    throw new Error('GitHub release installer inventory was incomplete.');
  }
  return assets;
}

function isSemanticPublishedRelease(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = record(value);
  return candidate.draft === false && semanticTagPattern.test(String(candidate.tag_name ?? ''));
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function digestValue(asset: ReleaseAsset): string {
  return asset.digest.slice('sha256:'.length).toLowerCase();
}

function parseSignature(bytes: Buffer): Buffer {
  const encoded = bytes.toString('ascii').trim();
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== encoded) {
    throw new Error('GitHub release signature encoding was invalid.');
  }
  return signature;
}

async function readExactBytes(
  response: Response,
  expectedBytes: number,
  maximumBytes: number,
): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) !== expectedBytes) {
    throw new Error('GitHub release asset length was invalid.');
  }
  if (!response.body) throw new Error('GitHub release asset body was missing.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > expectedBytes || length > maximumBytes) {
      await reader.cancel();
      throw new Error('GitHub release asset exceeded its declared size.');
    }
    chunks.push(Buffer.from(next.value));
  }
  if (length !== expectedBytes) throw new Error('GitHub release asset length was invalid.');
  return Buffer.concat(chunks, length);
}

function validateAssetUrl(url: URL, redirected: boolean): void {
  const allowedHost = redirected
    ? trustedRedirectHosts.has(url.hostname)
    : url.hostname === 'github.com';
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !allowedHost
  ) {
    throw new Error('GitHub release asset URL was not trusted.');
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function compareVersions(leftTag: string, rightTag: string): number {
  const left = leftTag.slice(1).split('.').map(Number);
  const right = rightTag.slice(1).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const comparison = (left[index] ?? 0) - (right[index] ?? 0);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
