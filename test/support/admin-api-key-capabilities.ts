import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const allScopes = [
  'control:read',
  'control:write',
  'diagnostics:read',
  'diagnostics:download',
  'diagnostics:delete',
  'telemetry:read',
  'audit:read',
  'keys:manage',
];

export async function createFullAccessKey(
  app: FastifyInstance,
  cookie: string,
  csrf: string,
): Promise<string> {
  const fullKey = await app.inject({
    method: 'POST',
    url: '/admin/api/keys',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { name: 'Full automation', scopes: allScopes, expiresInDays: 30 },
  });
  assert.equal(fullKey.statusCode, 201);
  const token: string = fullKey.json().token;
  const authorization = `Bearer ${token}`;

  const catalog = await app.inject({
    method: 'GET',
    url: '/v1/admin-data',
    headers: { authorization },
  });
  assert.equal(catalog.statusCode, 200);
  assert.ok(
    catalog
      .json()
      .resources.some(
        (resource: { scope: string; method?: string }) =>
          resource.scope === 'diagnostics:download' && resource.method === 'POST',
      ),
  );

  const child = await app.inject({
    method: 'POST',
    url: '/v1/admin-data/keys',
    headers: { authorization },
    payload: { name: 'Key manager', scopes: ['keys:manage'], expiresInDays: 90 },
  });
  assert.equal(child.statusCode, 201);
  assert.match(child.json().createdBy, /^api-key:/);
  assert.ok(Date.parse(child.json().expiresAt) <= Date.parse(fullKey.json().expiresAt));
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/admin-data/keys',
        headers: { authorization: `Bearer ${child.json().token}` },
        payload: { name: 'Escalated reader', scopes: ['control:read'], expiresInDays: 7 },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/v1/admin-data/keys/${child.json().id}/revoke`,
        headers: { authorization },
      })
    ).statusCode,
    204,
  );
  const keys = await app.inject({
    method: 'GET',
    url: '/v1/admin-data/keys',
    headers: { authorization },
  });
  assert.equal(keys.statusCode, 200);
  assert.equal('token' in keys.json()[0], false);
  return token;
}

export async function executeFullAccessControlCommand(
  app: FastifyInstance,
  token: string,
  expectedRevision: number,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin-data/control/commands',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      commandId: randomUUID(),
      expectedRevision,
      command: { type: 'code.add', code: 'APIKEY', expiresAt: null },
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().revision, expectedRevision + 1);
}

export async function assertFullAccessTelemetry(
  app: FastifyInstance,
  token: string,
): Promise<void> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/admin-data/telemetry?days=30',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().rows[0].kind, 'ocr-timing');
}

export async function assertFullAccessDiagnosticMetadata(
  app: FastifyInstance,
  token: string,
  id: string,
): Promise<void> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/admin-data/diagnostics?limit=10',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json()[0].id, id);
  assert.equal(response.json()[0].appVersion, '1.0.115');
  assert.equal(response.json()[0].osVersion, 'Microsoft Windows NT 10.0.19045.6456');
  assert.match(response.json()[0].installationRef, /^[A-Za-z0-9_-]{12}$/);

  const filtered = await app.inject({
    method: 'POST',
    url: '/v1/admin-data/diagnostics/search',
    headers: { authorization: `Bearer ${token}` },
    payload: { minimumAppVersion: '1.0.115', osVersion: '19045.6456', limit: 10 },
  });
  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.json()[0].id, id);
}

export async function requestFullAccessDiagnosticDownload(
  app: FastifyInstance,
  token: string,
  id: string,
  expectedStatus: 200 | 202,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/admin-data/diagnostics/${id}/download`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, expectedStatus);
  assert.equal(response.json().status, expectedStatus === 200 ? 'Accepted' : 'Verifying');
  if (expectedStatus === 200) assert.equal(response.json().url, 'https://download.invalid/archive');
}

export async function deleteFullAccessDiagnostic(
  app: FastifyInstance,
  token: string,
  id: string,
  browser: { cookie: string; csrf: string },
): Promise<void> {
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/v1/admin-data/diagnostics/${id}`,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/admin/api/diagnostics/${id}/moderate`,
        headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrf },
        payload: { action: 'delete' },
      })
    ).statusCode,
    204,
  );
}

export async function assertFullAccessAudit(app: FastifyInstance, token: string): Promise<void> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/admin-data/audit?limit=20',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().diagnostics.length > 0);
}

export async function assertBrowserAudit(app: FastifyInstance, cookie: string): Promise<void> {
  const response = await app.inject({
    method: 'GET',
    url: '/admin/api/audit',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().control[0].command.type, 'code.add');
  assert.ok(
    response
      .json()
      .control.some((event: { actor: { kind: string } }) => event.actor.kind === 'api-key'),
  );
  assert.ok(
    response
      .json()
      .diagnostics.some((event: { action: string }) => event.action === 'moderation.delete'),
  );
  assert.ok(
    response
      .json()
      .diagnostics.some((event: { action: string }) => event.action === 'download.requested'),
  );
}
