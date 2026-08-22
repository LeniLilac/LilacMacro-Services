import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { diagnosticInstallPseudonyms } from '../src/apps/admin-routes.js';
import { RotatingPseudonymizer } from '../src/infrastructure/pseudonym.js';

test('diagnostic installation search covers current and prior monthly pseudonyms', () => {
  const key = randomBytes(32).toString('base64');
  const pseudonymizer = new RotatingPseudonymizer(key, randomBytes(32).toString('base64'));
  const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const now = new Date('2026-09-01T01:00:00.000Z');

  assert.deepEqual(diagnosticInstallPseudonyms(pseudonymizer, installationId, now), [
    pseudonymizer.forInstall(installationId, now),
    pseudonymizer.forInstall(installationId, new Date('2026-08-01T00:00:00.000Z')),
  ]);
});
