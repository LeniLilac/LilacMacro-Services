import path from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { adminCommandEnvelopeSchema } from '../contracts/admin-commands.js';
import {
  absoluteLimitBytes,
  createUploadRequestSchema,
  diagnosticKindSchema,
  routineLimitBytes,
} from '../contracts/diagnostics.js';
import type { Clock } from '../domain/clock.js';
import { checksumHeaderValue, type DiagnosticService } from '../domain/diagnostic-service.js';
import type { ControlRepository } from '../domain/ports.js';
import type { PostgresAuthStore } from '../infrastructure/auth-store.js';
import type { ApiServiceConfig } from '../infrastructure/config.js';
import type { RotatingPseudonymizer } from '../infrastructure/pseudonym.js';
import type { HmacLargeUploadAuthorizer } from '../infrastructure/large-upload-authorizer.js';
import type { WebControlClient } from '../infrastructure/internal-api-client.js';
import { parseVerifyAndValidateSnapshot } from '../infrastructure/snapshot-signer.js';
import { TrustedProxyAddressResolver } from '../infrastructure/trusted-proxy.js';
import { authorizeAdmin, csrfFor, registerAuthRoutes } from './auth-routes.js';
import { registerDiagnosticInternalRoutes } from './internal-routes.js';

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
const moderationSchema = z
  .object({
    action: z.enum(['accept', 'reject', 'delete']),
    retainUntil: z.iso.datetime().optional(),
  })
  .strict();
const diagnosticListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
});
const largeUploadRequestSchema = createUploadRequestSchema.extend({
  largeUploadGrant: z.string().min(20).max(2_048).optional(),
});
const largeUploadGrantSchema = z
  .object({
    installId: z.uuid(),
    sizeBytes: z
      .number()
      .int()
      .min(routineLimitBytes + 1)
      .max(absoluteLimitBytes),
    kind: diagnosticKindSchema,
  })
  .strict();

export interface ApiDependencies {
  config: ApiServiceConfig;
  authStore: PostgresAuthStore;
  controlRepository: ControlRepository;
  controlClient: WebControlClient;
  clock: Clock;
  diagnosticService: DiagnosticService;
  pseudonymizer: RotatingPseudonymizer;
  largeUploadAuthorizer: HmacLargeUploadAuthorizer;
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
          const rawUrl = request.url;
          return {
            id: request.id,
            method: request.method,
            path: rawUrl.split('?', 1)[0],
          };
        },
      },
    },
    trustProxy: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
  });
  await app.register(cookie);
  await app.register(formbody);
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
      requestPath.startsWith('/v1/diagnostics/')
    ) {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
    } else if (requestPath.startsWith('/assets/')) {
      reply.header('cache-control', 'public, max-age=3600, stale-if-error=86400');
    } else if (requestPath === '/' || requestPath === '/privacy') {
      reply.header('cache-control', 'public, max-age=300, stale-if-error=3600');
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

  app.get('/', async (_request, reply) =>
    reply.type('text/html').sendFile('index.html', publicRoot),
  );
  app.get('/privacy', async (_request, reply) =>
    reply.type('text/html').sendFile('privacy.html', publicRoot),
  );
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
  registerAdminRoutes(app, dependencies);
  registerDiagnosticRoutes(app, dependencies, clientAddresses);
  registerDiagnosticInternalRoutes(app, dependencies);
  return app;
}

function registerAdminRoutes(app: FastifyInstance, dependencies: ApiDependencies): void {
  const authDependencies = { config: dependencies.config, store: dependencies.authStore };
  app.get('/admin', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, false);
    if (!auth) return;
    const html = (await import('node:fs/promises')).readFile(
      path.resolve('dist/public/admin.html'),
      'utf8',
    );
    return reply
      .type('text/html')
      .send((await html).replace('__CSRF_TOKEN__', csrfFor(auth, dependencies.config)));
  });
  app.get('/admin/api/state', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, false);
    if (!auth) return;
    return dependencies.controlRepository.readState();
  });
  app.post('/admin/api/commands', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, true);
    if (!auth) return;
    const revision = await dependencies.controlClient.executeWeb(
      auth.userId,
      adminCommandEnvelopeSchema.parse(request.body),
    );
    return reply.code(201).send({ revision });
  });
  app.post('/admin/api/diagnostics/:id/moderate', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, true);
    if (!auth) return;
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    const input = moderationSchema.parse(request.body);
    await dependencies.diagnosticService.moderate(
      id,
      { kind: 'web', userId: auth.userId },
      input.action,
      input.retainUntil ? new Date(input.retainUntil) : undefined,
    );
    return reply.code(204).send();
  });
  app.get('/admin/api/diagnostics', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, false);
    if (!auth) return;
    const query = diagnosticListSchema.parse(request.query);
    const records = await dependencies.diagnosticService.list(query.limit);
    return records.map((record) => ({
      id: record.id,
      fileName: record.request.fileName,
      sizeBytes: record.request.sizeBytes,
      sha256: record.request.sha256,
      kind: record.request.kind,
      appVersion: record.request.appVersion,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      acceptanceDeadline: record.acceptanceDeadline?.toISOString() ?? null,
      expiresAt: record.expiresAt.toISOString(),
    }));
  });
  app.post('/admin/api/diagnostics/large-upload-grants', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, true);
    if (!auth) return;
    const input = largeUploadGrantSchema.parse(request.body);
    const now = dependencies.clock.now();
    const grantRecord = await dependencies.diagnosticService.issueLargeUploadGrant(
      { kind: 'web', userId: auth.userId },
      dependencies.pseudonymizer.forInstall(input.installId, now),
      pseudonymEpoch(now),
      input.sizeBytes,
      input.kind,
    );
    return reply.code(201).send({
      grant: dependencies.largeUploadAuthorizer.issue(
        {
          grantId: grantRecord.id,
          uploadId: grantRecord.uploadId,
          objectKey: grantRecord.objectKey,
          installPseudonym: grantRecord.installPseudonym,
          sizeBytes: grantRecord.sizeBytes,
          kind: grantRecord.kind,
        },
        grantRecord.expiresAt,
      ),
      expiresAt: grantRecord.expiresAt.toISOString(),
    });
  });
  app.get('/admin/api/audit', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, false);
    if (!auth) return;
    const query = diagnosticListSchema.parse(request.query);
    const [control, diagnostics] = await Promise.all([
      dependencies.controlRepository.listAudit(query.limit),
      dependencies.diagnosticService.audit(null, query.limit),
    ]);
    return {
      control: control.map((record) => ({
        ...record,
        createdAt: record.createdAt.toISOString(),
      })),
      diagnostics: diagnostics.map((record) => ({
        ...record,
        createdAt: record.createdAt.toISOString(),
      })),
    };
  });
  app.post('/admin/api/diagnostics/:id/download', async (request, reply) => {
    const auth = await authorizeAdmin(request, reply, authDependencies, true);
    if (!auth) return;
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    return {
      url: await dependencies.diagnosticService.downloadUrl(id, {
        kind: 'web',
        userId: auth.userId,
      }),
    };
  });
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
      const input = largeUploadRequestSchema.parse(request.body);
      const { largeUploadGrant, installId, ...uploadRequest } = input;
      const now = dependencies.clock.now();
      const installPseudonym = dependencies.pseudonymizer.forInstall(installId, now);
      const largeUploadAuthorization =
        input.sizeBytes <= routineLimitBytes || largeUploadGrant === undefined
          ? null
          : dependencies.largeUploadAuthorizer.verify(
              largeUploadGrant,
              installPseudonym,
              input.sizeBytes,
              input.kind,
              now,
            );
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
        largeUploadAuthorization,
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

function pseudonymEpoch(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
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
