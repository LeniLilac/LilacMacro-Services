import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adminDataQuerySchema,
  createAdminApiKeySchema,
  type AdminApiKeyScope,
} from '../contracts/admin-api-keys.js';
import { adminCommandEnvelopeSchema } from '../contracts/admin-commands.js';
import type { Clock } from '../domain/clock.js';
import type { DiagnosticService } from '../domain/diagnostic-service.js';
import type { ControlRepository, TelemetryRepository } from '../domain/ports.js';
import type {
  AdminApiKeyRecord,
  PostgresAdminApiKeyStore,
} from '../infrastructure/admin-api-key-store.js';
import type { PostgresAuthStore } from '../infrastructure/auth-store.js';
import type { ApiServiceConfig } from '../infrastructure/config.js';
import type { WebControlClient } from '../infrastructure/internal-api-client.js';
import { authorizeAdmin, csrfFor } from './auth-routes.js';

const idSchema = z.uuid();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(250).default(100) });
const moderationSchema = z
  .object({
    action: z.literal('delete'),
  })
  .strict();

const pages = new Map([
  ['/admin', 'admin.html'],
  ['/admin/codes', 'admin-codes.html'],
  ['/admin/schedules', 'admin-schedules.html'],
  ['/admin/features', 'admin-features.html'],
  ['/admin/diagnostics', 'admin-diagnostics.html'],
  ['/admin/telemetry', 'admin-telemetry.html'],
  ['/admin/audit', 'admin-audit.html'],
  ['/admin/api-keys', 'admin-api-keys.html'],
]);

export interface AdminRouteDependencies {
  config: ApiServiceConfig;
  authStore: PostgresAuthStore;
  apiKeyStore: PostgresAdminApiKeyStore;
  controlRepository: ControlRepository;
  controlClient: WebControlClient;
  clock: Clock;
  diagnosticService: DiagnosticService;
  telemetryRepository: TelemetryRepository;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies,
  publicRoot: string,
): void {
  const authDependencies = { config: dependencies.config, store: dependencies.authStore };
  for (const [route, file] of pages) {
    app.get(route, async (request, reply) => {
      const auth = await authorizeAdmin(request, reply, authDependencies, false);
      if (!auth) return;
      const html = await readFile(path.join(publicRoot, file), 'utf8');
      return reply
        .type('text/html')
        .send(html.replace('__CSRF_TOKEN__', csrfFor(auth, dependencies.config)));
    });
  }

  app.get('/admin/api/state', async (request, reply) => {
    if (!(await authorizeAdmin(request, reply, authDependencies, false))) return;
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
  registerDiagnosticAdminRoutes(app, dependencies);
  registerAuditRoute(app, dependencies);
  registerApiKeyRoutes(app, dependencies);
  registerAdminDataRoutes(app, dependencies);
}

function registerDiagnosticAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies,
): void {
  const auth = { config: dependencies.config, store: dependencies.authStore };
  app.get('/admin/api/diagnostics', async (request, reply) => {
    if (!(await authorizeAdmin(request, reply, auth, false))) return;
    return serializeDiagnostics(
      await dependencies.diagnosticService.list(listSchema.parse(request.query).limit),
    );
  });
  app.post('/admin/api/diagnostics/:id/moderate', async (request, reply) => {
    const actor = await authorizeAdmin(request, reply, auth, true);
    if (!actor) return;
    const input = moderationSchema.parse(request.body);
    await dependencies.diagnosticService.moderate(
      idSchema.parse((request.params as { id?: unknown }).id),
      { kind: 'web', userId: actor.userId },
      input.action,
    );
    return reply.code(204).send();
  });
  app.post('/admin/api/diagnostics/:id/download', async (request, reply) => {
    const actor = await authorizeAdmin(request, reply, auth, true);
    if (!actor) return;
    const result = await dependencies.diagnosticService.requestDownload(
      idSchema.parse((request.params as { id?: unknown }).id),
      { kind: 'web', userId: actor.userId },
    );
    return reply.code(result.status === 'Accepted' ? 200 : 202).send(result);
  });
}

function registerAuditRoute(app: FastifyInstance, dependencies: AdminRouteDependencies): void {
  app.get('/admin/api/audit', async (request, reply) => {
    if (
      !(await authorizeAdmin(
        request,
        reply,
        { config: dependencies.config, store: dependencies.authStore },
        false,
      ))
    )
      return;
    const limit = listSchema.parse(request.query).limit;
    return readAudit(dependencies, limit);
  });
}

function registerApiKeyRoutes(app: FastifyInstance, dependencies: AdminRouteDependencies): void {
  const auth = { config: dependencies.config, store: dependencies.authStore };
  app.get('/admin/api/keys', async (request, reply) => {
    if (!(await authorizeAdmin(request, reply, auth, false))) return;
    return serializeKeys(await dependencies.apiKeyStore.list());
  });
  app.post('/admin/api/keys', async (request, reply) => {
    const actor = await authorizeAdmin(request, reply, auth, true);
    if (!actor) return;
    const input = createAdminApiKeySchema.parse(request.body);
    const now = dependencies.clock.now();
    const created = await dependencies.apiKeyStore.create(
      actor.userId,
      input.name,
      input.scopes,
      new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1_000),
      now,
    );
    return reply.code(201).send({ ...serializeKey(created), token: created.token });
  });
  app.post('/admin/api/keys/:id/revoke', async (request, reply) => {
    const actor = await authorizeAdmin(request, reply, auth, true);
    if (!actor) return;
    const revoked = await dependencies.apiKeyStore.revoke(
      idSchema.parse((request.params as { id?: unknown }).id),
      actor.userId,
      dependencies.clock.now(),
    );
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'API key not found.' });
  });
}

function registerAdminDataRoutes(app: FastifyInstance, dependencies: AdminRouteDependencies): void {
  app.get('/v1/admin-data', { config: apiKeyRateLimit }, async (request, reply) => {
    const key = await authorizeApiKey(request, reply, dependencies, null);
    if (!key) return;
    const resourceByScope: Record<AdminApiKeyScope, string> = {
      'control:read': '/v1/admin-data/control',
      'diagnostics:read': '/v1/admin-data/diagnostics',
      'telemetry:read': '/v1/admin-data/telemetry',
      'audit:read': '/v1/admin-data/audit',
    };
    return {
      key: { name: key.name, prefix: key.prefix, expiresAt: key.expiresAt.toISOString() },
      resources: key.scopes.map((scope) => ({ scope, href: resourceByScope[scope] })),
    };
  });
  app.get('/v1/admin-data/control', { config: apiKeyRateLimit }, async (request, reply) => {
    if (!(await authorizeApiKey(request, reply, dependencies, 'control:read'))) return;
    return dependencies.controlRepository.readState();
  });
  app.get('/v1/admin-data/diagnostics', { config: apiKeyRateLimit }, async (request, reply) => {
    if (!(await authorizeApiKey(request, reply, dependencies, 'diagnostics:read'))) return;
    return serializeDiagnostics(
      await dependencies.diagnosticService.list(adminDataQuerySchema.parse(request.query).limit),
    );
  });
  app.get('/v1/admin-data/telemetry', { config: apiKeyRateLimit }, async (request, reply) => {
    if (!(await authorizeApiKey(request, reply, dependencies, 'telemetry:read'))) return;
    const days = adminDataQuerySchema.parse(request.query).days;
    const since = new Date(dependencies.clock.now().getTime() - days * 86_400_000);
    return {
      since: since.toISOString(),
      rows: await dependencies.telemetryRepository.summary(since),
    };
  });
  app.get('/v1/admin-data/audit', { config: apiKeyRateLimit }, async (request, reply) => {
    if (!(await authorizeApiKey(request, reply, dependencies, 'audit:read'))) return;
    return readAudit(dependencies, adminDataQuerySchema.parse(request.query).limit);
  });
}

const apiKeyRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

async function authorizeApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminRouteDependencies,
  scope: AdminApiKeyScope | null,
) {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') && header.length <= 256 ? header.slice(7) : '';
  const key = scope
    ? await dependencies.apiKeyStore.authorize(token, scope, dependencies.clock.now())
    : await dependencies.apiKeyStore.authorizeAny(token, dependencies.clock.now());
  if (!key) {
    await reply
      .code(401)
      .header('www-authenticate', 'Bearer')
      .send({ error: 'API key authorization failed.' });
    return null;
  }
  return key;
}

async function readAudit(dependencies: AdminRouteDependencies, limit: number) {
  const [control, diagnostics, keys] = await Promise.all([
    dependencies.controlRepository.listAudit(limit),
    dependencies.diagnosticService.audit(null, limit),
    dependencies.apiKeyStore.listAudit(limit),
  ]);
  return {
    control: control.map((record) => ({ ...record, createdAt: record.createdAt.toISOString() })),
    diagnostics: diagnostics.map((record) => ({
      ...record,
      createdAt: record.createdAt.toISOString(),
    })),
    keys: keys.map((record) => ({ ...record, createdAt: record.createdAt.toISOString() })),
  };
}

function serializeDiagnostics(records: Awaited<ReturnType<DiagnosticService['list']>>) {
  return records.map((record) => ({
    id: record.id,
    fileName: record.request.fileName,
    sizeBytes: record.request.sizeBytes,
    kind: record.request.kind,
    appVersion: record.request.appVersion,
    status:
      record.status === 'Pending' && record.acceptanceDeadline === null
        ? 'Stored'
        : record.status === 'VerifyingActive'
          ? 'Verifying'
          : record.status,
    verificationActive: record.status === 'VerifyingActive',
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  }));
}

function serializeKeys(records: readonly AdminApiKeyRecord[]) {
  return records.map(serializeKey);
}

function serializeKey(record: AdminApiKeyRecord) {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    useCount: record.useCount,
  };
}
