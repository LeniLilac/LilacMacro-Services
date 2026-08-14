import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOAuthAttempt } from '../src/infrastructure/oauth-state.js';
import { RotatingPseudonymizer } from '../src/infrastructure/pseudonym.js';
import {
  issueCsrfToken,
  issueSessionToken,
  verifyCsrfToken,
} from '../src/infrastructure/session-codec.js';
import { HmacUploadAuthorizer } from '../src/infrastructure/upload-authorizer.js';
import { HmacLargeUploadAuthorizer } from '../src/infrastructure/large-upload-authorizer.js';
import { createPostgresRoleProvisionStatement } from '../src/infrastructure/scram-verifier.js';

test('OAuth PKCE attempt has bounded one-time material', () => {
  const now = new Date('2026-08-14T12:00:00.000Z');
  const attempt = createOAuthAttempt(now);
  assert.match(attempt.state, /^[A-Za-z0-9_-]+$/);
  assert.match(attempt.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(attempt.challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(attempt.expiresAt.toISOString(), '2026-08-14T12:05:00.000Z');
});

test('session CSRF token is bound to the session and secret', () => {
  const secret = randomBytes(32).toString('base64');
  const session = issueSessionToken();
  const token = issueCsrfToken(session.raw, secret);
  assert.equal(verifyCsrfToken(session.raw, token, secret), true);
  assert.equal(verifyCsrfToken(`${session.raw}x`, token, secret), false);
  assert.equal(verifyCsrfToken(session.raw, `${token}x`, secret), false);
});

test('upload token binds id, key, and expiry', () => {
  const authorizer = new HmacUploadAuthorizer(randomBytes(32).toString('base64'));
  const now = new Date('2026-08-14T12:00:00.000Z');
  const id = randomUUID();
  const key = `diagnostics/test/${id}.zip`;
  const token = authorizer.issue(id, key, new Date(now.getTime() + 60_000));
  assert.equal(authorizer.verify(token, id, key, now), true);
  assert.equal(authorizer.verify(token, randomUUID(), key, now), false);
  assert.equal(authorizer.verify(token, id, `${key}x`, now), false);
  assert.equal(authorizer.verify(token, id, key, new Date(now.getTime() + 60_001)), false);
});

test('large-upload grant binds installation, size, kind, and a short expiry', () => {
  const authorizer = new HmacLargeUploadAuthorizer(randomBytes(32).toString('base64'));
  const now = new Date('2026-08-14T12:00:00.000Z');
  const payload = {
    grantId: randomUUID(),
    uploadId: randomUUID(),
    objectKey: `diagnostics/test/${randomUUID()}.zip`,
    installPseudonym: 'install-pseudonym',
    sizeBytes: 4_000_000_000,
    kind: 'live-debug' as const,
  };
  const token = authorizer.issue(payload, new Date(now.getTime() + 60_000));
  assert.equal(
    authorizer.verify(token, payload.installPseudonym, payload.sizeBytes, payload.kind, now)
      ?.grantId,
    payload.grantId,
  );
  assert.equal(authorizer.verify(token, 'another', payload.sizeBytes, payload.kind, now), null);
  assert.equal(
    authorizer.verify(token, payload.installPseudonym, payload.sizeBytes + 1, payload.kind, now),
    null,
  );
  assert.equal(
    authorizer.verify(token, payload.installPseudonym, payload.sizeBytes, 'deep-debug', now),
    null,
  );
  assert.equal(
    authorizer.verify(
      token,
      payload.installPseudonym,
      payload.sizeBytes,
      payload.kind,
      new Date(now.getTime() + 60_001),
    ),
    null,
  );
});

test('pseudonyms rotate monthly and never expose source identifiers', () => {
  const pseudonymizer = new RotatingPseudonymizer(
    randomBytes(32).toString('base64'),
    randomBytes(32).toString('base64'),
  );
  const installId = randomUUID();
  const august = pseudonymizer.forInstall(installId, new Date('2026-08-14T00:00:00Z'));
  const september = pseudonymizer.forInstall(installId, new Date('2026-09-01T00:00:00Z'));
  assert.notEqual(august, installId);
  assert.notEqual(august, september);
  assert.equal(
    pseudonymizer.forNetwork('::ffff:127.0.0.1', new Date('2026-08-14T00:00:00Z')),
    pseudonymizer.forNetwork('127.0.0.1', new Date('2026-08-14T00:00:00Z')),
  );
  assert.equal(
    pseudonymizer.forNetwork('2001:db8:abcd:1234::1', new Date('2026-08-14T00:00:00Z')),
    pseudonymizer.forNetwork('2001:0db8:abcd:1234:ffff::9', new Date('2026-08-14T00:00:00Z')),
  );
  assert.notEqual(
    pseudonymizer.forNetwork('2001:db8:abcd:1234::1', new Date('2026-08-14T00:00:00Z')),
    pseudonymizer.forNetwork('2001:db8:abcd:1235::1', new Date('2026-08-14T00:00:00Z')),
  );
  assert.throws(() => pseudonymizer.forNetwork('not an address', new Date()), /not valid/);
});

test('database role provisioning transmits only a SCRAM verifier', () => {
  const password = 'runtime-password-that-must-never-enter-postgres-logs';
  const statement = createPostgresRoleProvisionStatement('lilacmacro_api', password, true);
  assert.doesNotMatch(statement, new RegExp(password));
  assert.match(statement, /PASSWORD 'SCRAM-SHA-256\$4096:/);
  assert.throws(
    () => createPostgresRoleProvisionStatement('postgres', password, false),
    /role was invalid/,
  );
});
