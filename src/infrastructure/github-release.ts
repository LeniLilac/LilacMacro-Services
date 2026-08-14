import { z } from 'zod';
import type { ReleaseObservation } from '../domain/operational-sync.js';

const releaseResponseSchema = z
  .object({
    tag_name: z.string(),
    html_url: z.url(),
    published_at: z.iso.datetime(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(
      z
        .object({
          name: z.string(),
          browser_download_url: z.url(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class GitHubReleaseProbe {
  public constructor(
    private readonly repository: 'LeniLilac/LilacMacro',
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async current(): Promise<ReleaseObservation> {
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.repository}/releases/latest`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'LilacMacro-Services/1',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error('GitHub release lookup failed.');
    const release = releaseResponseSchema.parse(await response.json());
    if (release.draft || release.prerelease)
      throw new Error('GitHub latest release was not stable.');
    const version = release.tag_name.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('GitHub release tag was not semantic.');
    const installer = release.assets.find((asset) => asset.name === 'LilacMacro-Setup.exe');
    const releasePrefix = `https://github.com/${this.repository}/releases/`;
    const downloadPrefix = `https://github.com/${this.repository}/releases/download/`;
    if (
      !installer ||
      !release.html_url.startsWith(releasePrefix) ||
      !installer.browser_download_url.startsWith(downloadPrefix)
    ) {
      throw new Error('GitHub release installer inventory was incomplete.');
    }
    return {
      version,
      pageUrl: release.html_url,
      installerUrl: installer.browser_download_url,
      publishedAt: release.published_at,
    };
  }
}
