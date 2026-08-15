import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { telemetryBatchSchema } from '../contracts/telemetry.js';
import type { Clock } from '../domain/clock.js';
import type { PersistedTelemetryEvent, TelemetryRepository } from '../domain/ports.js';
import type { PostgresAuthStore } from '../infrastructure/auth-store.js';
import type { ApiServiceConfig } from '../infrastructure/config.js';
import type { RotatingPseudonymizer } from '../infrastructure/pseudonym.js';
import type { TrustedProxyAddressResolver } from '../infrastructure/trusted-proxy.js';
import { authorizeAdmin } from './auth-routes.js';

const summaryQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
const maximumPastAgeMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const maximumFutureSkewMilliseconds = 10 * 60 * 1_000;

interface TelemetryRouteDependencies {
  config: ApiServiceConfig;
  authStore: PostgresAuthStore;
  clock: Clock;
  pseudonymizer: RotatingPseudonymizer;
  telemetryRepository: TelemetryRepository;
}

export function registerTelemetryRoutes(
  app: FastifyInstance,
  dependencies: TelemetryRouteDependencies,
  clientAddresses: TrustedProxyAddressResolver,
): void {
  app.post(
    '/v1/telemetry/events',
    {
      bodyLimit: 64 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const input = telemetryBatchSchema.parse(request.body);
      const now = dependencies.clock.now();
      const events: PersistedTelemetryEvent[] = input.events.map((event) => ({
        ...event,
        occurredAtUtc: new Date(event.occurredAtUtc),
      }));
      if (
        events.some(
          (event) =>
            event.occurredAtUtc.getTime() < now.getTime() - maximumPastAgeMilliseconds ||
            event.occurredAtUtc.getTime() > now.getTime() + maximumFutureSkewMilliseconds,
        )
      ) {
        return reply.code(400).send({ error: 'Telemetry event time was outside its bound.' });
      }
      const stored = await dependencies.telemetryRepository.insertBatch(
        dependencies.pseudonymizer.forTelemetryInstall(input.installId, now),
        dependencies.pseudonymizer.forTelemetryNetwork(
          clientAddresses.resolve(
            request.socket.remoteAddress,
            request.headers['cf-connecting-ip'],
          ),
          now,
        ),
        input.appVersion,
        input.privacyNoticeVersion,
        events,
        now,
        Buffer.byteLength(JSON.stringify(request.body), 'utf8'),
      );
      if (!stored) return reply.code(429).send({ error: 'Telemetry capacity reached.' });
      return reply.code(202).send({ accepted: events.length });
    },
  );

  app.get('/admin/api/telemetry/summary', async (request, reply) => {
    const auth = await authorizeAdmin(
      request,
      reply,
      { config: dependencies.config, store: dependencies.authStore },
      false,
    );
    if (!auth) return;
    const query = summaryQuerySchema.parse(request.query);
    const since = new Date(dependencies.clock.now().getTime() - query.days * 24 * 60 * 60 * 1_000);
    return {
      since: since.toISOString(),
      rows: await dependencies.telemetryRepository.summary(since),
    };
  });
}
