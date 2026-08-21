import assert from 'node:assert/strict';
import test from 'node:test';
import { telemetryBatchSchema } from '../src/contracts/telemetry.js';

const base = {
  installId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  appVersion: '1.0.153',
};

test('telemetry accepts current notice and bounded setup failure events', () => {
  const parsed = telemetryBatchSchema.parse({
    ...base,
    privacyNoticeVersion: 5,
    events: [
      {
        kind: 'ocr-setup-failure',
        occurredAtUtc: '2026-08-21T10:00:00.000Z',
        feature: 'ocr-setup',
        outcome: 'gpu_runtime_invalid',
        durationMilliseconds: 1234,
        operatingSystem: 'windows-10.0',
        setupStage: 'gpu-runtime',
        requestedDevice: 'gpu:0',
        processExitCode: 1,
        pythonLauncherPresent: true,
        wingetPresent: true,
        existingOcrPythonPresent: true,
        runtimeMarkerPresent: false,
      },
      {
        kind: 'local-instance-failure',
        occurredAtUtc: '2026-08-21T10:00:01.000Z',
        feature: 'local-instance',
        outcome: 'helper-failed',
        durationMilliseconds: 250,
        operatingSystem: 'windows-10.0',
        processExitCode: 2,
        operation: 'add-shared',
        failureCode: 'helper-failed',
        configurationMode: 'shared',
        runnerCount: 2,
      },
    ],
  });

  assert.equal(parsed.privacyNoticeVersion, 5);
  assert.equal(parsed.events.length, 2);
});

test('telemetry preserves older consent versions and rejects unknown future notices', () => {
  const session = {
    kind: 'session-started',
    occurredAtUtc: '2026-08-21T10:00:00.000Z',
    feature: 'macro',
    outcome: 'started',
    operatingSystem: 'windows-10.0',
    logicalProcessorCount: 8,
    graphicsCapability: 'not-observed',
  };

  assert.doesNotThrow(() =>
    telemetryBatchSchema.parse({ ...base, privacyNoticeVersion: 1, events: [session] }),
  );
  assert.throws(() =>
    telemetryBatchSchema.parse({ ...base, privacyNoticeVersion: 6, events: [session] }),
  );
});

test('local-instance failure outcome must match its closed failure code', () => {
  assert.throws(() =>
    telemetryBatchSchema.parse({
      ...base,
      privacyNoticeVersion: 5,
      events: [
        {
          kind: 'local-instance-failure',
          occurredAtUtc: '2026-08-21T10:00:00.000Z',
          feature: 'local-instance',
          outcome: 'helper-failed',
          durationMilliseconds: 250,
          operatingSystem: 'windows-10.0',
          operation: 'repair',
          failureCode: 'access-denied',
          configurationMode: 'shared',
          runnerCount: 1,
        },
      ],
    }),
  );
});

test('telemetry accepts bounded model timing and display scale pairs', () => {
  const parsed = telemetryBatchSchema.parse({
    ...base,
    privacyNoticeVersion: 5,
    events: [
      {
        kind: 'ocr-timing',
        occurredAtUtc: '2026-08-21T10:00:00.000Z',
        feature: 'ocr',
        outcome: 'completed',
        durationMilliseconds: 68,
        graphicsCapability: 'gpu:0',
        hardwareModel: 'NVIDIA GeForce RTX 4070',
      },
      {
        kind: 'ui-scale-calibration',
        occurredAtUtc: '2026-08-21T10:00:01.000Z',
        feature: 'ui-scale',
        outcome: 'observed',
        displayWidth: 1920,
        displayHeight: 1080,
        inputScaleMilli: 1000,
        renderedScaleMilli: 997,
      },
    ],
  });

  assert.equal(parsed.events.length, 2);
  assert.throws(() =>
    telemetryBatchSchema.parse({
      ...base,
      privacyNoticeVersion: 5,
      events: [
        {
          kind: 'ocr-timing',
          occurredAtUtc: '2026-08-21T10:00:00.000Z',
          feature: 'ocr',
          outcome: 'completed',
          durationMilliseconds: 68,
          graphicsCapability: 'cpu',
          hardwareModel: 'unbounded attacker label',
        },
      ],
    }),
  );
});
