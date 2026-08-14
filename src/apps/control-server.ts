import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { CommandService } from '../domain/command-service.js';
import type { ControlRepository, SnapshotSigner } from '../domain/ports.js';
import type { ControlServiceConfig } from '../infrastructure/config.js';
import { registerControlInternalRoutes } from './internal-routes.js';
import { InternalAuthorizationError } from './internal-routes.js';

export interface ControlServerDependencies {
  config: ControlServiceConfig;
  controlRepository: ControlRepository;
  commandService: CommandService;
  signer: SnapshotSigner;
}

export async function buildControlServer(
  dependencies: ControlServerDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.config.NODE_ENV === 'test' ? false : { level: 'info' },
    bodyLimit: 128 * 1024,
    requestTimeout: 15_000,
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Request validation failed.' });
    }
    if (error instanceof InternalAuthorizationError) {
      return reply.code(401).send({ error: 'Internal service authorization failed.' });
    }
    request.log.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'control request failed',
    );
    return reply.code(500).send({ error: 'Control request failed.' });
  });
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      dependencies.signer.assertReady();
      await dependencies.controlRepository.readState();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  registerControlInternalRoutes(app, dependencies);
  return app;
}
