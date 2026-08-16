import { z } from 'zod';
import { readBoundedJson } from './bounded-json.js';

const publicGameDetailsSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.number().int().positive(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class RobloxPlayabilityProbe {
  public constructor(
    private readonly universeId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async current(): Promise<boolean> {
    const url = new URL('https://games.roblox.com/v1/games');
    url.searchParams.set('universeIds', this.universeId);
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': 'LilacMacro-Services/1' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Roblox playability lookup failed.');
    const result = publicGameDetailsSchema.parse(await readBoundedJson(response, 256 * 1024));
    if (result.data.length === 0) return false;
    if (result.data.some((item) => String(item.id) !== this.universeId)) {
      throw new Error('Roblox public game response returned an unexpected universe.');
    }
    return result.data.some((item) => String(item.id) === this.universeId);
  }
}
