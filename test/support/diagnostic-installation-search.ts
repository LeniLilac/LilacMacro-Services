import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

const matchingInstallationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export async function assertDiagnosticInstallationSearch(
  app: FastifyInstance,
  cookie: string,
  csrf: string,
  expectedUploadId: string,
): Promise<void> {
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
    payload: { installationId: matchingInstallationId, limit: 100 },
  });
  assert.equal(matching.statusCode, 200);
  assert.deepEqual(
    matching.json().map((record: { id: string }) => record.id),
    [expectedUploadId],
  );
  assert.doesNotMatch(matching.body, new RegExp(matchingInstallationId));

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
