import { z } from 'zod';

const playabilitySchema = z.array(
  z
    .object({
      universeId: z.number().int().positive(),
      isPlayable: z.boolean(),
      playabilityStatus: z.string().min(1),
    })
    .passthrough(),
);

export class RobloxPlayabilityProbe {
  public constructor(
    private readonly universeId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async current(): Promise<boolean> {
    const url = new URL('https://games.roblox.com/v1/games/multiget-playability-status');
    url.searchParams.set('universeIds', this.universeId);
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': 'LilacMacro-Services/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Roblox playability lookup failed.');
    const result = playabilitySchema.parse(await response.json());
    const match = result.find((item) => String(item.universeId) === this.universeId);
    if (!match) throw new Error('Roblox playability response omitted the configured universe.');
    return match.isPlayable;
  }
}
