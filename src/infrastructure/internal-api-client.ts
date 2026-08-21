import { z } from 'zod';
import type { AdminCommand } from '../contracts/admin-commands.js';
import type { AdminCommandEnvelope } from '../contracts/admin-commands.js';
import type { SystemControlClient } from '../domain/operational-sync.js';

const revisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();

export interface BotControlClient {
  ready(): Promise<boolean>;
  execute(actorId: string, commandId: string, command: AdminCommand): Promise<number>;
}

export interface BotDiagnosticClient {
  moderateDiagnostic(actorId: string, uploadId: string, action: 'delete'): Promise<void>;
}

export interface WebControlClient {
  executeWeb(actorId: string, envelope: AdminCommandEnvelope): Promise<number>;
}

export class InternalApiClient implements BotControlClient, SystemControlClient {
  public constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async ready(): Promise<boolean> {
    try {
      await this.request('/internal/bot/health', {}, 204);
      return true;
    } catch {
      return false;
    }
  }

  public async execute(actorId: string, commandId: string, command: AdminCommand): Promise<number> {
    return this.revision('/internal/bot/commands', { actorId, commandId, command });
  }

  public async executeWeb(actorId: string, envelope: AdminCommandEnvelope): Promise<number> {
    return this.revision('/internal/api/commands', { actorId, envelope });
  }

  public async moderateDiagnostic(
    actorId: string,
    uploadId: string,
    action: 'delete',
  ): Promise<void> {
    await this.request('/internal/bot/diagnostics/moderate', { actorId, uploadId, action }, 204);
  }

  public async executeSystem(commandId: string, command: AdminCommand): Promise<number> {
    return this.revision('/internal/worker/commands', { commandId, command });
  }

  public async republish(): Promise<number> {
    return this.revision('/internal/worker/republish', {});
  }

  private async revision(path: string, body: unknown): Promise<number> {
    const response = await this.request(path, body, 201);
    return revisionSchema.parse(await response.json()).revision;
  }

  private async request(path: string, body: unknown, expectedStatus: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(new URL(path, this.origin), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status !== expectedStatus) {
        throw new Error(`Internal API request failed (${response.status}).`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
