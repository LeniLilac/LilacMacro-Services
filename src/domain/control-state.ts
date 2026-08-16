import type { AdminCommand } from '../contracts/admin-commands.js';
import type { ControlPayload } from '../contracts/control-snapshot.js';

export interface MutableControlState {
  revision: number;
  game: {
    operatorAvailable: boolean;
    observedPublic: boolean | null;
    observedAt: string | null;
    message: string | null;
  };
  codes: ControlPayload['codes'];
  schedules: ControlPayload['schedules'];
  disablements: ControlPayload['disablements'];
  release: ControlPayload['release'];
  releaseEvidence: ReleaseEvidence | null;
  releaseFloorVersion: string | null;
}

export type ReleaseEvidence = Omit<
  Extract<AdminCommand, { type: 'release.set' }>,
  'type' | 'pageUrl' | 'installerUrl' | 'publishedAt'
>;

export function applyAdminCommand(
  state: MutableControlState,
  command: AdminCommand,
): MutableControlState {
  switch (command.type) {
    case 'code.add':
      return {
        ...state,
        codes: [
          ...state.codes.filter((item) => item.code.toLowerCase() !== command.code.toLowerCase()),
          { code: command.code, expiresAt: command.expiresAt },
        ],
      };
    case 'code.remove':
      return {
        ...state,
        codes: state.codes.filter((item) => item.code.toLowerCase() !== command.code.toLowerCase()),
      };
    case 'game.availability':
      return {
        ...state,
        game: { ...state.game, operatorAvailable: command.available, message: command.message },
      };
    case 'game.observation':
      return {
        ...state,
        game: {
          ...state.game,
          observedPublic: command.public,
          observedAt: command.observedAt,
        },
      };
    case 'feature.disable':
      return {
        ...state,
        disablements: [
          ...state.disablements.filter((item) => item.feature !== command.feature),
          { feature: command.feature, reason: command.reason, expiresAt: command.expiresAt },
        ],
      };
    case 'feature.enable':
      return {
        ...state,
        disablements: state.disablements.filter((item) => item.feature !== command.feature),
      };
    case 'schedule.set':
      return {
        ...state,
        schedules: [
          ...state.schedules.filter((item) => item.key !== command.key),
          { key: command.key, nextAt: command.nextAt, cadenceSeconds: command.cadenceSeconds },
        ],
      };
    case 'release.set':
      assertReleaseProgression(state, command);
      return {
        ...state,
        release: {
          version: command.version,
          pageUrl: command.pageUrl,
          installerUrl: command.installerUrl,
          publishedAt: command.publishedAt,
        },
        releaseEvidence: {
          version: command.version,
          tag: command.tag,
          installerSize: command.installerSize,
          installerSha256: command.installerSha256,
          sourceCommit: command.sourceCommit,
          verifiedAt: command.verifiedAt,
        },
        releaseFloorVersion: command.version,
      };
    case 'release.clear':
      return {
        ...state,
        release: null,
        releaseFloorVersion:
          state.releaseFloorVersion ??
          state.releaseEvidence?.version ??
          state.release?.version ??
          null,
      };
  }
}

function assertReleaseProgression(
  state: MutableControlState,
  command: Extract<AdminCommand, { type: 'release.set' }>,
): void {
  const floor =
    state.releaseFloorVersion ?? state.releaseEvidence?.version ?? state.release?.version;
  if (floor && compareVersions(command.version, floor) < 0) {
    throw new Error('Automatic release rollback was rejected.');
  }
  const previous = state.releaseEvidence;
  if (
    previous?.version === command.version &&
    (previous.tag !== command.tag ||
      previous.installerSize !== command.installerSize ||
      previous.installerSha256 !== command.installerSha256 ||
      previous.sourceCommit !== command.sourceCommit)
  ) {
    throw new Error('Published release assets changed without a new version.');
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const comparison = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function publishPayload(
  state: MutableControlState,
  now: Date,
  lifetimeMinutes = 10,
): ControlPayload {
  const activeCodes = state.codes.filter(
    (item) => item.expiresAt === null || new Date(item.expiresAt) > now,
  );
  const activeDisablements = state.disablements.filter(
    (item) => item.expiresAt === null || new Date(item.expiresAt) > now,
  );
  return {
    schema: 1,
    revision: state.revision,
    game: {
      available: state.game.operatorAvailable && state.game.observedPublic !== false,
      operatorAvailable: state.game.operatorAvailable,
      observedPublic: state.game.observedPublic,
      observedAt: state.game.observedAt,
      message: state.game.message,
    },
    schedules: state.schedules,
    release: state.release,
    codes: activeCodes,
    disablements: activeDisablements,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + lifetimeMinutes * 60 * 1000).toISOString(),
  };
}
