import type { FastifyInstance } from 'fastify';
import {
  createConfigurationShareSchema,
  resolveConfigurationShareSchema,
} from '../contracts/configuration-share.js';
import type { Clock } from '../domain/clock.js';
import type { ConfigurationShareRepository } from '../domain/ports.js';
import type { RotatingPseudonymizer } from '../infrastructure/pseudonym.js';
import type { TrustedProxyAddressResolver } from '../infrastructure/trusted-proxy.js';

interface ConfigurationShareDependencies {
  clock: Clock;
  pseudonymizer: RotatingPseudonymizer;
  configurationShares: ConfigurationShareRepository;
  configurationSharingEnabled: boolean;
}

export function registerConfigurationShareRoutes(
  app: FastifyInstance,
  dependencies: ConfigurationShareDependencies,
  clientAddresses: TrustedProxyAddressResolver,
): void {
  app.post(
    '/v1/shares',
    {
      bodyLimit: 256 * 1024,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      if (!dependencies.configurationSharingEnabled)
        return reply.code(503).send({ error: 'Configuration sharing is not available yet.' });
      if (!isJson(request.headers['content-type']))
        return reply.code(415).send({ error: 'Configuration sharing requires JSON.' });
      const input = createConfigurationShareSchema.parse(request.body);
      const now = dependencies.clock.now();
      const record = await dependencies.configurationShares.create(
        input.payload,
        dependencies.pseudonymizer.forShareNetwork(
          clientAddresses.resolve(
            request.socket.remoteAddress,
            request.headers['cf-connecting-ip'],
          ),
          now,
        ),
        now,
        new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      );
      if (!record)
        return reply.code(429).send({ error: 'Configuration sharing capacity reached.' });
      return reply.code(201).send({ code: record.code, expiresAt: record.expiresAt.toISOString() });
    },
  );

  app.post(
    '/v1/shares/resolve',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!dependencies.configurationSharingEnabled)
        return reply.code(503).send({ error: 'Configuration sharing is not available yet.' });
      if (!isJson(request.headers['content-type']))
        return reply.code(415).send({ error: 'Configuration sharing requires JSON.' });
      const input = resolveConfigurationShareSchema.parse(request.body);
      const record = await dependencies.configurationShares.find(
        input.code,
        dependencies.clock.now(),
      );
      if (!record) return reply.code(404).send({ error: 'Configuration share not found.' });
      return { payload: record.payload, expiresAt: record.expiresAt.toISOString() };
    },
  );
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}
