import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

const matchingInstallationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export async function assertDiagnosticAdministration(
  app: FastifyInstance,
  cookie: string,
  csrf: string,
  expectedUploadId: string,
): Promise<void> {
  const settings = await app.inject({
    method: 'GET',
    url: '/admin/api/diagnostics/settings',
    headers: { cookie },
  });
  assert.deepEqual(settings.json(), { preverifyLogs: true });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/admin/api/diagnostics/settings',
        headers: { cookie },
        payload: { preverifyLogs: false },
      })
    ).statusCode,
    403,
  );
  const changed = await app.inject({
    method: 'POST',
    url: '/admin/api/diagnostics/settings',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { preverifyLogs: false },
  });
  assert.deepEqual(changed.json(), { preverifyLogs: false });
  await app.inject({
    method: 'POST',
    url: '/admin/api/diagnostics/settings',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { preverifyLogs: true },
  });

  const withoutCsrf = await app.inject({
    method: 'POST',
    url: '/admin/api/diagnostics/search',
    headers: { cookie },
    payload: { installationId: matchingInstallationId, limit: 100 },
  });
  assert.equal(withoutCsrf.statusCode, 403);

  const matching = await app.inject({
    method: 'POST',
    url: '/admin/api/diagnostics/search',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: {
      installationId: matchingInstallationId,
      minimumAppVersion: '1.0.115',
      osVersion: '19045.6456',
      createdAfter: '2026-08-14T11:59:00.000Z',
      maximumSizeBytes: 1_024,
      limit: 100,
    },
  });
  assert.equal(matching.statusCode, 200);
  assert.deepEqual(
    matching.json().map((record: { id: string }) => record.id),
    [expectedUploadId],
  );
  assert.doesNotMatch(matching.body, new RegExp(matchingInstallationId));

  for (const payload of [
    { minimumAppVersion: '1.0.116', limit: 100 },
    { osVersion: 'Windows 11', limit: 100 },
    { createdAfter: '2026-08-14T12:01:00.000Z', limit: 100 },
    { maximumSizeBytes: 1_023, limit: 100 },
  ]) {
    const excluded = await app.inject({
      method: 'POST',
      url: '/admin/api/diagnostics/search',
      headers: { cookie, 'x-csrf-token': csrf },
      payload,
    });
    assert.equal(excluded.statusCode, 200);
    assert.deepEqual(excluded.json(), []);
  }

  const unrelated = await app.inject({
    method: 'POST',
    url: '/admin/api/diagnostics/search',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', limit: 100 },
  });
  assert.equal(unrelated.statusCode, 200);
  assert.deepEqual(unrelated.json(), []);

  const malformed = await app.inject({
    method: 'POST',
    url: '/admin/api/diagnostics/search',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { installationId: 'not-an-installation-id', limit: 100 },
  });
  assert.equal(malformed.statusCode, 400);
}
