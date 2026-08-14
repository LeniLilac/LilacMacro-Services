import { randomUUID } from 'node:crypto';
import type { AdminCommand } from '../contracts/admin-commands.js';
import type { Clock } from './clock.js';

export interface SystemControlClient {
  executeSystem(commandId: string, command: AdminCommand): Promise<number>;
  republish(): Promise<number>;
}

export interface ReleaseObservation {
  version: string;
  pageUrl: string;
  installerUrl: string;
  publishedAt: string;
}

export interface ReleaseProbe {
  current(): Promise<ReleaseObservation>;
}

export interface PlayabilityProbe {
  current(): Promise<boolean>;
}

export class OperationalSyncService {
  public constructor(
    private readonly clock: Clock,
    private readonly control: SystemControlClient,
    private readonly releaseProbe: ReleaseProbe,
    private readonly playabilityProbe?: PlayabilityProbe,
  ) {}

  public async sync(): Promise<void> {
    await this.syncRelease();
    await this.syncPlayability();
  }

  public async syncRelease(): Promise<void> {
    const release = await this.releaseProbe.current();
    await this.execute({ type: 'release.set', ...release });
  }

  public async syncPlayability(): Promise<void> {
    if (!this.playabilityProbe) return;
    await this.execute({
      type: 'game.observation',
      public: await this.playabilityProbe.current(),
      observedAt: this.clock.now().toISOString(),
    });
  }

  private async execute(command: AdminCommand): Promise<void> {
    await this.control.executeSystem(randomUUID(), command);
  }
}
