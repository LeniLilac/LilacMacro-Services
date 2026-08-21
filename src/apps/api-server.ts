import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { createUploadRequestSchema } from '../contracts/diagnostics.js';
import type { Clock } from '../domain/clock.js';
import { checksumHeaderValue, type DiagnosticService } from '../domain/diagnostic-service.js';
import type {
  ConfigurationShareRepository,
  ControlRepository,
  TelemetryRepository,
} from '../domain/ports.js';
import type { PostgresAdminApiKeyStore } from '../infrastructure/admin-api-key-store.js';
import type { PostgresAuthStore } from '../infrastructure/auth-store.js';
import type { ApiServiceConfig } from '../infrastructure/config.js';
import type { RotatingPseudonymizer } from '../infrastructure/pseudonym.js';
import type { WebControlClient } from '../infrastructure/internal-api-client.js';
import { parseVerifyAndValidateSnapshot } from '../infrastructure/snapshot-signer.js';
import { TrustedProxyAddressResolver } from '../infrastructure/trusted-proxy.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerDiagnosticInternalRoutes } from './internal-routes.js';
import { registerPublicRoutes } from './public-routes.js';
import { registerTelemetryRoutes } from './telemetry-routes.js';
import { registerConfigurationShareRoutes } from './configuration-share-routes.js';

const completionSchema = z
  .object({
    parts: z
      .array(z.object({ partNumber: z.number().int(), etag: z.string().max(128) }).strict())
      .max(240),
  })
  .strict();
const partSchema = z.object({ partNumber: z.coerce.number().int().positive() }).strict();
const partGrantSchema = z
  .object({
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();
const idSchema = z.uuid();

export interface ApiDependencies {
  config: ApiServiceConfig;
  authStore: PostgresAuthStore;
  apiKeyStore: PostgresAdminApiKeyStore;
  controlRepository: ControlRepository;
  controlClient: WebControlClient;
  clock: Clock;
  diagnosticService: DiagnosticService;
  pseudonymizer: RotatingPseudonymizer;
  telemetryRepository: TelemetryRepository;
  configurationShares: ConfigurationShareRepository;
  configurationSharingEnabled: boolean;
}

export async function buildApi(dependencies: ApiDependencies): Promise<FastifyInstance> {
  const publicRoot = path.resolve('dist/public');
  const clientAddresses = new TrustedProxyAddressResolver(dependencies.config.trustedProxyCidrs);
  const app = Fastify({
    logger: {
      level: dependencies.config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: redactions,
      serializers: {
        req(request: FastifyRequest) {
          return {
            id: request.id,
            method: request.method,
            path: safeRequestPath(request.url),
          };
        },
      },
    },
    trustProxy: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: createRateLimitKeyGenerator(
      clientAddresses,
      dependencies.pseudonymizer,
      dependencies.clock,
    ),
  });
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: '/assets/',
    index: false,
    maxAge: '1h',
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const requestPath = request.url.split('?', 1)[0] ?? '/';
    if (
      requestPath.startsWith('/auth/') ||
      requestPath.startsWith('/admin') ||
      requestPath.startsWith('/internal/') ||
      requestPath.startsWith('/health/') ||
      requestPath.startsWith('/v1/admin-data') ||
      requestPath.startsWith('/v1/diagnostics/') ||
      requestPath.startsWith('/v1/telemetry/') ||
      requestPath.startsWith('/v1/shares')
    ) {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
    } else if (requestPath.startsWith('/assets/')) {
      reply.header('cache-control', 'public, max-age=3600');
    } else if (
      requestPath === '/' ||
      requestPath === '/downloads' ||
      requestPath === '/privacy' ||
      requestPath === '/terms'
    ) {
      reply.header('cache-control', 'public, max-age=60, must-revalidate');
    }
    return payload;
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: 'Request validation failed.', issues: error.issues.map(safeIssue) });
    }
    request.log.error(safeLoggedError(error), 'request failed');
    const message =
      error instanceof Error && isSafeError(error.message) ? error.message : 'Request failed.';
    return reply.code(statusFor(error)).send({ error: message });
  });

  await registerPublicRoutes(app, dependencies, publicRoot);
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const [state, snapshot] = await Promise.all([
        dependencies.controlRepository.readState(),
        dependencies.controlRepository.readPublished(),
      ]);
      if (!snapshot) throw new Error('Control snapshot is unavailable.');
      const verified = parseVerifyAndValidateSnapshot(
        snapshot,
        {
          [dependencies.config.CONTROL_SIGNING_KEY_ID]:
            dependencies.config.CONTROL_SIGNING_PUBLIC_KEY_BASE64,
        },
        dependencies.clock.now(),
        state.revision,
      );
      if (verified.payload.revision !== state.revision) {
        throw new Error('Published control revision did not match stored state.');
      }
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get(
    '/v1/control',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const snapshot = await dependencies.controlRepository.readPublished();
      if (!snapshot)
        return reply
          .code(503)
          .header('retry-after', '30')
          .send({ error: 'Control snapshot is initializing.' });
      return reply.header('cache-control', 'public, max-age=30, stale-if-error=300').send(snapshot);
    },
  );

  await registerAuthRoutes(app, { config: dependencies.config, store: dependencies.authStore });
  registerAdminRoutes(app, dependencies, publicRoot);
  registerDiagnosticRoutes(app, dependencies, clientAddresses);
  registerTelemetryRoutes(app, dependencies, clientAddresses);
  registerConfigurationShareRoutes(app, dependencies, clientAddresses);
  registerDiagnosticInternalRoutes(app, dependencies);
  return app;
}

export function safeRequestPath(rawUrl: string): string {
  const requestPath = rawUrl.split('?', 1)[0] ?? '/';
  return requestPath.startsWith('/v1/shares/') && requestPath !== '/v1/shares/resolve'
    ? '/v1/shares/:secret'
    : requestPath;
}

function registerDiagnosticRoutes(
  app: FastifyInstance,
  dependencies: ApiDependencies,
  clientAddresses: TrustedProxyAddressResolver,
): void {
  app.post(
    '/v1/diagnostics/uploads',
    { config: { rateLimit: { max: 8, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const input = createUploadRequestSchema.parse(request.body);
      const { installId, ...uploadRequest } = input;
      const now = dependencies.clock.now();
      const installPseudonym = dependencies.pseudonymizer.forInstall(installId, now);
      const grant = await dependencies.diagnosticService.create(
        {
          installPseudonym,
          networkPseudonym: dependencies.pseudonymizer.forNetwork(
            clientAddresses.resolve(
              request.socket.remoteAddress,
              request.headers['cf-connecting-ip'],
            ),
            now,
          ),
        },
        uploadRequest,
      );
      return reply.code(201).send(grant);
    },
  );
  app.get('/v1/diagnostics/uploads/:id', async (request) => {
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    return dependencies.diagnosticService.status(id, bearerToken(request.headers.authorization));
  });
  app.post('/v1/diagnostics/uploads/:id/parts/:partNumber', async (request) => {
    const params = request.params as { id?: unknown; partNumber?: unknown };
    const grant = partGrantSchema.parse(request.body);
    return {
      url: await dependencies.diagnosticService.partUrl(
        idSchema.parse(params.id),
        partSchema.parse({ partNumber: params.partNumber }).partNumber,
        grant,
        bearerToken(request.headers.authorization),
      ),
      requiredHeaders: {
        'x-amz-checksum-sha256': checksumHeaderValue(grant.sha256),
      },
    };
  });
  app.post('/v1/diagnostics/uploads/:id/complete', async (request, reply) => {
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    const input = completionSchema.parse(request.body);
    const status = await dependencies.diagnosticService.complete(
      id,
      input.parts,
      bearerToken(request.headers.authorization),
    );
    return reply.code(202).send({ status });
  });
}

export function createRateLimitKeyGenerator(
  addresses: TrustedProxyAddressResolver,
  pseudonymizer: RotatingPseudonymizer,
  clock: Clock,
): (request: FastifyRequest) => string {
  return (request) =>
    pseudonymizer.forNetwork(
      addresses.resolve(request.socket.remoteAddress, request.headers['cf-connecting-ip']),
      clock.now(),
    );
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ') || header.length > 2_048) {
    throw new Error('Diagnostic upload authorization failed.');
  }
  return header.slice(7);
}

const redactions = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-csrf-token',
  'res.headers.set-cookie',
  '*.url',
  '*.signature',
  '*.token',
];

function safeIssue(issue: z.core.$ZodIssue): { path: string; code: string } {
  return { path: issue.path.join('.'), code: issue.code };
}

function statusFor(error: unknown): number {
  const explicit = (error as { statusCode?: unknown } | null)?.statusCode;
  if (
    typeof explicit === 'number' &&
    Number.isInteger(explicit) &&
    explicit >= 400 &&
    explicit < 500
  )
    return explicit;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('authorization failed')) return 401;
  if (message.includes('conflict')) return 409;
  if (message.includes('not found')) return 404;
  if (message.includes('outside') || message.includes('requires') || message.includes('malformed'))
    return 400;
  return 500;
}

function isSafeError(message: string): boolean {
  return /^(Control revision conflict|Diagnostic upload|Archives over|Accepted diagnostics|Multipart|Object key)/.test(
    message,
  );
}

function safeLoggedError(error: unknown): { errorName: string; errorCode?: string } {
  if (!(error instanceof Error)) return { errorName: 'UnknownError' };
  const code = (error as Error & { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { errorCode: code } : {}),
  };
}
