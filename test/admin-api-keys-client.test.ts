import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('API key submission retains its form across asynchronous work', async () => {
  const source = await readFile('public/admin-api-keys.js', 'utf8');

  assert.match(source, /const submittedForm = event\.currentTarget;/);
  assert.match(source, /const form = new FormData\(submittedForm\);/);
  assert.match(source, /submittedForm\.reset\(\);/);
  assert.doesNotMatch(source, /event\.currentTarget\.reset\(\);/);
  assert.match(source, /allApiScopes\.onchange/);
  assert.match(source, /apiScopeInputs\.every\(\(scope\) => scope\.checked\)/);
  assert.match(source, /Select at least one API capability\./);
});
