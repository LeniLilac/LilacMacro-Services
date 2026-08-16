import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AdminCommand } from '../src/contracts/admin-commands.js';
import { featureIds, scheduleKeys } from '../src/contracts/control-snapshot.js';
import { FixedClock } from '../src/domain/clock.js';
import { CommandService } from '../src/domain/command-service.js';
import {
  applyAdminCommand,
  publishPayload,
  type MutableControlState,
} from '../src/domain/control-state.js';
import { OperationalSyncService, type ReleaseObservation } from '../src/domain/operational-sync.js';
import {
  MemoryControlRepository,
  defaultControlState,
} from '../src/infrastructure/memory-repositories.js';
import { Ed25519SnapshotSigner } from '../src/infrastructure/snapshot-signer.js';

function signer(): Ed25519SnapshotSigner {
  const pair = generateKeyPairSync('ed25519');
  return new Ed25519SnapshotSigner(
    pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'test-1',
  );
}

function apply(state: MutableControlState, command: AdminCommand): MutableControlState {
  return applyAdminCommand(state, command);
}

function releaseObservation(version = '1.0.118'): ReleaseObservation {
  const tag = `v${version}`;
  return {
    version,
    tag,
    pageUrl: `https://github.com/LeniLilac/LilacMacro/releases/tag/${tag}`,
    installerUrl: `https://github.com/LeniLilac/LilacMacro/releases/download/${tag}/LilacMacro-Setup.exe`,
    installerSize: 10_000_000,
    installerSha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    publishedAt: '2026-08-14T11:00:00Z',
    verifiedAt: '2026-08-14T12:00:00Z',
  };
}

function releaseCommand(version = '1.0.118'): Extract<AdminCommand, { type: 'release.set' }> {
  return { type: 'release.set', ...releaseObservation(version) };
}

test('control state applies every closed command without mutating the input', () => {
  assert.deepEqual(scheduleKeys, ['gold-shop-reset', 'raid-shop-reset', 'expedition-shop-reset']);
  const original = defaultControlState();
  let state = apply(original, { type: 'code.add', code: 'FIRST', expiresAt: null });
  state = apply(state, { type: 'code.add', code: 'first', expiresAt: '2026-08-15T00:00:00Z' });
  assert.deepEqual(original.codes, []);
  assert.equal(state.codes.length, 1);
  assert.equal(state.codes[0]?.code, 'first');
  state = apply(state, { type: 'code.remove', code: 'FIRST' });
  assert.deepEqual(state.codes, []);

  state = apply(state, { type: 'game.availability', available: false, message: 'Updating' });
  assert.equal(state.game.operatorAvailable, false);
  state = apply(state, {
    type: 'game.observation',
    public: true,
    observedAt: '2026-08-14T12:00:00Z',
  });
  assert.equal(state.game.observedPublic, true);

  state = apply(state, {
    type: 'feature.disable',
    feature: featureIds[0],
    reason: 'Temporarily unavailable',
    expiresAt: null,
  });
  state = apply(state, {
    type: 'feature.disable',
    feature: featureIds[0],
    reason: 'Updated reason',
    expiresAt: '2026-08-15T00:00:00Z',
  });
  assert.equal(state.disablements.length, 1);
  state = apply(state, { type: 'feature.enable', feature: featureIds[0] });
  assert.deepEqual(state.disablements, []);

  for (const key of scheduleKeys) {
    state = apply(state, {
      type: 'schedule.set',
      key,
      nextAt: '2026-08-15T00:00:00Z',
      cadenceSeconds: 86_400,
    });
  }
  assert.equal(state.schedules.length, scheduleKeys.length);
  state = apply(state, releaseCommand('1.2.3'));
  assert.equal(state.release?.version, '1.2.3');
  state = apply(state, { type: 'release.clear' });
  assert.equal(state.release, null);
  assert.equal(state.releaseFloorVersion, '1.2.3');
  assert.throws(() => apply(state, releaseCommand('1.2.2')), /rollback was rejected/);
  assert.throws(
    () =>
      apply(state, {
        ...releaseCommand('1.2.3'),
        installerSha256: 'c'.repeat(64),
      }),
    /assets changed/,
  );
});

test('published payload filters expired entries and combines availability fail closed', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  const state: MutableControlState = {
    ...defaultControlState(),
    revision: 9,
    game: {
      operatorAvailable: true,
      observedPublic: false,
      observedAt: now.toISOString(),
      message: 'Game update',
    },
    codes: [
      { code: 'LIVE', expiresAt: null },
      { code: 'OLD', expiresAt: '2026-08-14T11:59:59Z' },
    ],
    disablements: [
      { feature: 'mode.raid', reason: 'Live', expiresAt: null },
      {
        feature: 'mode.story',
        reason: 'Old',
        expiresAt: '2026-08-14T11:59:59Z',
      },
    ],
  };
  const payload = publishPayload(state, now, 5);
  assert.equal(payload.game.available, false);
  assert.deepEqual(
    payload.codes.map((item) => item.code),
    ['LIVE'],
  );
  assert.deepEqual(
    payload.disablements.map((item) => item.feature),
    ['mode.raid'],
  );
  assert.equal(payload.expiresAt, '2026-08-14T12:05:00.000Z');
});

test('command service enforces actor ownership for system and administrator commands', async () => {
  const service = new CommandService(
    new MemoryControlRepository(),
    signer(),
    new FixedClock(new Date('2026-08-14T12:00:00Z')),
  );
  await assert.rejects(
    service.execute(
      { kind: 'web', userId: '123' },
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'game.observation', public: true, observedAt: '2026-08-14T12:00:00Z' },
      },
    ),
    /not authorized/,
  );
  await assert.rejects(
    service.execute(
      { kind: 'system', userId: '1' },
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'game.observation', public: true, observedAt: '2026-08-14T12:00:00Z' },
      },
    ),
    /System actor identity/,
  );
  await assert.rejects(
    service.execute(
      { kind: 'discord', userId: 'not-a-user' },
      {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'code.add', code: 'CODE', expiresAt: null },
      },
    ),
    /actor identity/,
  );
});

test('operational sync publishes changed release and current Roblox playability', async () => {
  const repository = new MemoryControlRepository();
  const clock = new FixedClock(new Date('2026-08-14T12:00:00Z'));
  const commands = new CommandService(repository, signer(), clock);
  const control = {
    async executeSystem(commandId: string, command: AdminCommand) {
      const state = await repository.readState();
      return (
        await commands.execute(
          { kind: 'system' as const, userId: '0' },
          { commandId, expectedRevision: state.revision, command },
        )
      ).payload.revision;
    },
    async republish() {
      return (await commands.republish()).payload.revision;
    },
  };
  const sync = new OperationalSyncService(
    clock,
    control,
    {
      async current() {
        return releaseObservation();
      },
    },
    {
      async current() {
        return false;
      },
    },
  );
  await sync.sync();
  const state = await repository.readState();
  assert.equal(state.release?.version, '1.0.118');
  assert.equal(state.game.observedPublic, false);
  assert.equal(state.revision, 2);
  await sync.sync();
  assert.equal((await repository.readState()).revision, 4);
});

test('operational vendor probes remain independently callable after either failure', async () => {
  const calls: string[] = [];
  const control = {
    async executeSystem(_commandId: string, command: AdminCommand) {
      calls.push(command.type);
      return calls.length;
    },
    async republish() {
      return 0;
    },
  };
  const releaseFailure = new OperationalSyncService(
    new FixedClock(new Date('2026-08-14T12:00:00Z')),
    control,
    {
      async current() {
        throw new Error('GitHub unavailable');
      },
    },
    {
      async current() {
        return true;
      },
    },
  );
  await assert.rejects(releaseFailure.syncRelease(), /GitHub unavailable/);
  await releaseFailure.syncPlayability();
  assert.deepEqual(calls, ['game.observation']);

  const playabilityFailure = new OperationalSyncService(
    new FixedClock(new Date('2026-08-14T12:00:00Z')),
    control,
    {
      async current() {
        return releaseObservation();
      },
    },
    {
      async current() {
        throw new Error('Roblox unavailable');
      },
    },
  );
  await playabilityFailure.syncRelease();
  await assert.rejects(playabilityFailure.syncPlayability(), /Roblox unavailable/);
  assert.deepEqual(calls, ['game.observation', 'release.set']);
});
