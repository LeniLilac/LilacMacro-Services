import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adminCommandEnvelopeSchema,
  adminCommandSchema,
  type AdminCommand,
} from '../contracts/admin-commands.js';
import type { CommandService } from '../domain/command-service.js';
import type { DiagnosticService } from '../domain/diagnostic-service.js';
import type { Actor, ControlRepository } from '../domain/ports.js';
import type { ApiServiceConfig, ControlServiceConfig } from '../infrastructure/config.js';

const apiCommandSchema = z
  .object({
    actorId: z.string().regex(/^\d+$/),
    envelope: adminCommandEnvelopeSchema,
  })
  .strict();

const botCommandSchema = z
  .object({
    commandId: z.uuid(),
    actorId: z.string().regex(/^\d+$/),
    command: adminCommandSchema,
  })
  .strict();
const systemCommandSchema = z
  .object({
    commandId: z.uuid(),
    command: adminCommandSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.command.type === 'game.observation' ||
      value.command.type === 'release.set' ||
      value.command.type === 'release.clear',
    'Internal worker command was not system-owned.',
  );
const moderationSchema = z
  .object({
    uploadId: z.uuid(),
    actorId: z.string().regex(/^\d+$/),
    action: z.literal('delete'),
  })
  .strict();

export interface InternalRouteDependencies {
  config: ControlServiceConfig;
  controlRepository: ControlRepository;
  commandService: CommandService;
}

export function registerControlInternalRoutes(
  app: FastifyInstance,
  dependencies: InternalRouteDependencies,
): void {
  app.post('/internal/bot/health', async (request, reply) => {
    requireBearer(request, dependencies.config.INTERNAL_BOT_TOKEN_BASE64);
    await dependencies.controlRepository.readState();
    return reply.code(204).send();
  });

  app.post('/internal/api/commands', async (request, reply) => {
    requireBearer(request, dependencies.config.INTERNAL_API_TOKEN_BASE64);
    const input = apiCommandSchema.parse(request.body);
    if (!dependencies.config.adminIds.has(input.actorId)) {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }
    const snapshot = await dependencies.commandService.execute(
      { kind: 'web', userId: input.actorId },
      input.envelope,
    );
    return reply.code(201).send({ revision: snapshot.payload.revision });
  });

  app.post('/internal/bot/commands', async (request, reply) => {
    requireBearer(request, dependencies.config.INTERNAL_BOT_TOKEN_BASE64);
    const input = botCommandSchema.parse(request.body);
    if (!dependencies.config.adminIds.has(input.actorId)) {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }
    if (
      input.command.type === 'game.observation' ||
      input.command.type === 'release.set' ||
      input.command.type === 'release.clear'
    ) {
      return reply.code(400).send({ error: 'Bot command was not administrator-owned.' });
    }
    const snapshot = await executeFresh(
      dependencies,
      { kind: 'discord', userId: input.actorId },
      input.commandId,
      input.command,
    );
    return reply.code(201).send({ revision: snapshot.payload.revision });
  });

  app.post('/internal/worker/commands', async (request, reply) => {
    requireBearer(request, dependencies.config.INTERNAL_WORKER_TOKEN_BASE64);
    const input = systemCommandSchema.parse(request.body);
    if (input.command.type === 'release.set') {
      const state = await dependencies.controlRepository.readState();
      if (
        state.releaseEvidence?.version === input.command.version &&
        state.releaseEvidence.tag === input.command.tag &&
        state.releaseEvidence.installerSize === input.command.installerSize &&
        state.releaseEvidence.installerSha256 === input.command.installerSha256 &&
        state.releaseEvidence.sourceCommit === input.command.sourceCommit &&
        state.releaseEvidence.verifiedAt === input.command.verifiedAt
      ) {
        return reply.code(201).send({ revision: state.revision });
      }
    }
    if (input.command.type === 'release.clear') {
      const state = await dependencies.controlRepository.readState();
      if (state.release === null) return reply.code(201).send({ revision: state.revision });
    }
    const snapshot = await executeFresh(
      dependencies,
      { kind: 'system', userId: '0' },
      input.commandId,
      input.command,
    );
    return reply.code(201).send({ revision: snapshot.payload.revision });
  });

  app.post('/internal/worker/republish', async (request, reply) => {
    requireBearer(request, dependencies.config.INTERNAL_WORKER_TOKEN_BASE64);
    const snapshot = await dependencies.commandService.republish();
    return reply.code(201).send({ revision: snapshot.payload.revision });
  });
}

export function registerDiagnosticInternalRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ApiServiceConfig;
    diagnosticService: DiagnosticService;
  },
): void {
  app.post('/internal/bot/diagnostics/moderate', async (request, reply) => {
    requireBearer(request, dependencies.config.INTERNAL_BOT_TOKEN_BASE64);
    const input = moderationSchema.parse(request.body);
    if (!dependencies.config.adminIds.has(input.actorId)) {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }
    await dependencies.diagnosticService.moderate(
      input.uploadId,
      { kind: 'discord', userId: input.actorId },
      input.action,
    );
    return reply.code(204).send();
  });
}

async function executeFresh(
  dependencies: InternalRouteDependencies,
  actor: Actor,
  commandId: string,
  command: AdminCommand,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await dependencies.controlRepository.readState();
    try {
      return await dependencies.commandService.execute(actor, {
        commandId,
        expectedRevision: state.revision,
        command,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('revision conflict') ||
        attempt > 0
      ) {
        throw error;
      }
    }
  }
  throw new Error('Control revision conflict.');
}

function requireBearer(request: FastifyRequest, expected: string): void {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length > 512) {
    throw new InternalAuthorizationError();
  }
  const suppliedHash = createHash('sha256').update(header.slice(7), 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  if (!timingSafeEqual(suppliedHash, expectedHash)) {
    throw new InternalAuthorizationError();
  }
}

export class InternalAuthorizationError extends Error {
  public constructor() {
    super('Internal service authorization failed.');
    this.name = 'InternalAuthorizationError';
  }
}
