import { rm, writeFile } from 'node:fs/promises';

export class ServiceHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(
    private readonly path: string,
    private readonly probe: () => boolean | Promise<boolean>,
    private readonly intervalMs = 10_000,
  ) {}

  public start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  public async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.probe()) {
        await writeFile(this.path, new Date().toISOString(), { mode: 0o600 });
      } else {
        await rm(this.path, { force: true });
      }
    } catch {
      await rm(this.path, { force: true }).catch(() => undefined);
    } finally {
      this.running = false;
    }
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}
