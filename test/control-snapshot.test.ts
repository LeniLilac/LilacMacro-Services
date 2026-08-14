import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/contracts/canonical-json.js';
import { CommandService } from '../src/domain/command-service.js';
import { FixedClock } from '../src/domain/clock.js';
import { MemoryControlRepository } from '../src/infrastructure/memory-repositories.js';
import {
  Ed25519SnapshotSigner,
  parseVerifyAndValidateSnapshot,
  validateSnapshotFreshness,
  verifySnapshot,
} from '../src/infrastructure/snapshot-signer.js';

function signingFixture() {
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { signer: new Ed25519SnapshotSigner(privateKey, publicKey, 'test-1'), publicKey };
}

test('canonical JSON recursively orders object keys', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ q: 1, a: 2 }] }),
    '{"a":{"b":3,"y":2},"list":[{"a":2,"q":1}],"z":1}',
  );
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ invalid: undefined }), /undefined/);
});

test('command service signs, publishes, audits, and deduplicates commands', async () => {
  const repository = new MemoryControlRepository();
  const { signer, publicKey } = signingFixture();
  const now = new Date('2026-08-14T12:00:00.000Z');
  const service = new CommandService(repository, signer, new FixedClock(now));
  const commandId = randomUUID();
  const envelope = {
    commandId,
    expectedRevision: 0,
    command: { type: 'code.add' as const, code: 'WELCOME', expiresAt: null },
  };

  const first = await service.execute({ kind: 'web', userId: '123' }, envelope);
  assert.equal(first.payload.revision, 1);
  assert.equal(first.payload.codes[0]?.code, 'WELCOME');
  assert.equal(verifySnapshot(first, publicKey), true);
  validateSnapshotFreshness(first.payload, now, 1);

  const replay = await service.execute({ kind: 'web', userId: '123' }, envelope);
  assert.equal(replay.payload.revision, 1);
  assert.equal(repository.audit.length, 1);
  assert.deepEqual(await repository.readPublished(), replay);
  await assert.rejects(
    service.execute(
      { kind: 'web', userId: '123' },
      { ...envelope, command: { ...envelope.command, code: 'DIFFERENT' } },
    ),
    /did not match the original request/,
  );
  await assert.rejects(
    service.execute({ kind: 'discord', userId: '456' }, envelope),
    /did not match the original request/,
  );
  await assert.rejects(
    service.execute(
      { kind: 'discord', userId: '456' },
      { ...envelope, commandId: randomUUID(), expectedRevision: 0 },
    ),
    /revision conflict/,
  );
});

test('command contracts reject snapshot-poisoning codes and public secret material', async () => {
  const repository = new MemoryControlRepository();
  const { signer } = signingFixture();
  const service = new CommandService(
    repository,
    signer,
    new FixedClock(new Date('2026-08-14T12:00:00.000Z')),
  );
  await assert.rejects(
    service.execute(
      { kind: 'web', userId: '123' },
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'code.add', code: 'NOT VALID', expiresAt: null },
      },
    ),
  );
  await assert.rejects(
    service.execute(
      { kind: 'web', userId: '123' },
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: {
          type: 'game.availability',
          available: false,
          message: ['Discord webhook https://discord.com', 'api', 'webhooks', '123', 'secret'].join(
            '/',
          ),
        },
      },
    ),
  );
});

test('snapshot freshness rejects rollback, future generation, and expiry', async () => {
  const repository = new MemoryControlRepository();
  const { signer } = signingFixture();
  const now = new Date('2026-08-14T12:00:00.000Z');
  const snapshot = await signer.sign(await repository.readState(), now);
  assert.throws(() => validateSnapshotFreshness(snapshot.payload, now, 1), /rolled back/);
  assert.throws(
    () =>
      validateSnapshotFreshness(
        { ...snapshot.payload, generatedAt: '2026-08-14T12:02:00.000Z' },
        now,
        0,
      ),
    /future/,
  );
  assert.throws(
    () =>
      validateSnapshotFreshness(
        {
          ...snapshot.payload,
          generatedAt: '2026-08-14T11:50:00.000Z',
          expiresAt: '2026-08-14T11:59:59.000Z',
        },
        now,
        0,
      ),
    /expired/,
  );
  assert.throws(
    () =>
      validateSnapshotFreshness(
        {
          ...snapshot.payload,
          generatedAt: '2026-08-14T12:00:00.000Z',
          expiresAt: '2026-08-14T11:59:59.000Z',
        },
        now,
        0,
      ),
    /did not follow generation/,
  );
  assert.throws(
    () =>
      validateSnapshotFreshness(
        { ...snapshot.payload, expiresAt: '2026-08-14T12:16:00.000Z' },
        now,
        0,
      ),
    /lifetime exceeded/,
  );
});

test('combined snapshot verification rejects unknown keys and tampering', async () => {
  const repository = new MemoryControlRepository();
  const { signer, publicKey } = signingFixture();
  const now = new Date('2026-08-14T12:00:00.000Z');
  const snapshot = await signer.sign(await repository.readState(), now);
  assert.deepEqual(
    parseVerifyAndValidateSnapshot(snapshot, { 'test-1': publicKey }, now, 0),
    snapshot,
  );
  assert.throws(
    () => parseVerifyAndValidateSnapshot(snapshot, {}, now, 0),
    /key ID was not trusted/,
  );
  assert.throws(
    () =>
      parseVerifyAndValidateSnapshot(
        { ...snapshot, payload: { ...snapshot.payload, revision: 1 } },
        { 'test-1': publicKey },
        now,
        0,
      ),
    /signature was invalid/,
  );
});
