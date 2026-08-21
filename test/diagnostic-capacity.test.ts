import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectCapacityEvictions,
  type RetainedDiagnosticArchive,
} from '../src/domain/diagnostic-capacity.js';

function archive(
  id: string,
  installPseudonym: string,
  age: number,
  evictable = true,
): RetainedDiagnosticArchive {
  return {
    id,
    installPseudonym,
    sizeBytes: 100,
    createdAt: new Date(Date.UTC(2026, 7, 21, 0, 0, age)),
    evictable,
  };
}

test('capacity eviction repeatedly chooses the fullest installation and resolves ties by age', () => {
  const retained = [
    ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id, index) => archive(id, 'a', index + 10)),
    ...['b1', 'b2', 'b3', 'b4'].map((id, index) => archive(id, 'b', index + 20)),
    ...['c1', 'c2', 'c3'].map((id, index) => archive(id, 'c', index + 30)),
    archive('d1', 'd', 1),
    archive('e1', 'e', 2),
  ];

  assert.deepEqual(selectCapacityEvictions(retained, 300, 1_400), ['a1', 'a2', 'b1']);
});

test('capacity eviction chooses the oldest archive globally when all users have equal counts', () => {
  const retained = [archive('new-a', 'a', 30), archive('old-b', 'b', 10)];
  assert.deepEqual(selectCapacityEvictions(retained, 100, 200), ['old-b']);
});

test('capacity admission fails closed when active archives prevent sufficient eviction', () => {
  const retained = [archive('stored', 'a', 1), archive('active', 'b', 2, false)];
  assert.equal(selectCapacityEvictions(retained, 200, 200), null);
});

test('capacity admission does not evict when the incoming archive fits exactly', () => {
  assert.deepEqual(selectCapacityEvictions([archive('stored', 'a', 1)], 100, 200), []);
});
