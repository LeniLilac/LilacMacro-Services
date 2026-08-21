import { z } from 'zod';

export const telemetryKindSchema = z.enum([
  'session-started',
  'feature-used',
  'operation-error',
  'expedition-reward-observed',
  'ocr-timing',
  'ocr-setup-failure',
  'local-instance-failure',
  'ui-scale-calibration',
]);

export const currentPrivacyNoticeVersion = 5;
const hardwareModelSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^(?:unknown|(?:AMD|Intel|NVIDIA|Qualcomm) [A-Za-z0-9][A-Za-z0-9 ._()+-]*)$/);

const eventTime = { occurredAtUtc: z.iso.datetime({ offset: true }) };
const sessionStartedSchema = z
  .object({
    kind: z.literal('session-started'),
    ...eventTime,
    feature: z.literal('macro'),
    outcome: z.literal('started'),
    operatingSystem: z.string().regex(/^windows-\d{1,2}\.\d{1,2}$/),
    logicalProcessorCount: z.number().int().min(1).max(512),
    graphicsCapability: z.literal('not-observed'),
  })
  .strict();
const featureUsedSchema = z
  .object({
    kind: z.literal('feature-used'),
    ...eventTime,
    feature: z.enum(['workspace', 'wire', 'challenge', 'game_settings', 'ui_scale']),
    outcome: z.literal('completed'),
  })
  .strict();
const operationErrorSchema = z
  .object({
    kind: z.literal('operation-error'),
    ...eventTime,
    feature: z.enum(['macro', 'application']),
    outcome: z.enum(['runtime_error', 'unhandled_exception']),
  })
  .strict();
const expeditionRewardSchema = z
  .object({
    kind: z.literal('expedition-reward-observed'),
    ...eventTime,
    feature: z.literal('route-optimizer'),
    outcome: z.literal('observed'),
    material: z.enum([
      'FuelCell',
      'EquipmentScrap',
      'EquipmentReroll',
      'EquipmentLock',
      'ExpeditionCoin',
    ]),
    quantity: z.number().int().min(0).max(1_000),
  })
  .strict();
const ocrTimingSchema = z
  .object({
    kind: z.literal('ocr-timing'),
    ...eventTime,
    feature: z.literal('ocr'),
    outcome: z.literal('completed'),
    durationMilliseconds: z.number().int().min(0).max(600_000),
    graphicsCapability: z.enum(['cpu', 'gpu', 'gpu:0', 'not-observed']),
    hardwareModel: hardwareModelSchema.optional(),
  })
  .strict();
const ocrSetupFailureCodes = [
  'python312_missing',
  'winget_unavailable',
  'python_install_failed',
  'python312_not_found',
  'gpu_detection_failed',
  'gpu_runtime_invalid',
  'venv_create_failed',
  'pip_update_failed',
  'paddle_install_failed',
  'paddleocr_install_failed',
  'ocr_import_failed',
  'runtime_not_ready',
  'setup_process_start_failed',
  'setup_process_failed',
  'setup_failed',
] as const;
const ocrSetupFailureSchema = z
  .object({
    kind: z.literal('ocr-setup-failure'),
    ...eventTime,
    feature: z.literal('ocr-setup'),
    outcome: z.enum(ocrSetupFailureCodes),
    durationMilliseconds: z.number().int().min(0).max(600_000),
    operatingSystem: z.string().regex(/^windows-\d{1,2}\.\d{1,2}$/),
    setupStage: z.enum([
      'python-bootstrap',
      'gpu-runtime',
      'environment',
      'paddle',
      'paddleocr',
      'import-check',
      'runtime',
      'process',
      'setup',
    ]),
    requestedDevice: z.enum(['cpu', 'gpu:0']),
    processExitCode: z.number().int().min(0).max(65_535).optional(),
    pythonLauncherPresent: z.boolean(),
    wingetPresent: z.boolean(),
    existingOcrPythonPresent: z.boolean(),
    runtimeMarkerPresent: z.boolean(),
  })
  .strict();
const localInstanceFailureCodes = [
  'preflight-rejected',
  'setup-rolled-back',
  'helper-failed',
  'cleanup-incomplete',
  'operation-incomplete',
  'helper-missing',
  'helper-start-failed',
  'access-denied',
  'io-failure',
  'invalid-state',
  'windows-failure',
  'canceled',
  'operation-failed',
] as const;
const localInstanceFailureSchema = z
  .object({
    kind: z.literal('local-instance-failure'),
    ...eventTime,
    feature: z.literal('local-instance'),
    outcome: z.enum(localInstanceFailureCodes),
    durationMilliseconds: z.number().int().min(0).max(600_000),
    operatingSystem: z.string().regex(/^windows-\d{1,2}\.\d{1,2}$/),
    processExitCode: z.number().int().min(0).max(65_535).optional(),
    operation: z.enum([
      'setup',
      'repair',
      'remove-all',
      'add-shared',
      'add-isolated',
      'remove-profile',
      'open',
      'refresh',
    ]),
    failureCode: z.enum(localInstanceFailureCodes),
    configurationMode: z.enum(['shared', 'isolated', 'not-applicable']),
    runnerCount: z.number().int().min(0).max(16),
  })
  .strict()
  .refine((event) => event.outcome === event.failureCode, {
    message: 'Failure outcome and code must match.',
  });
const uiScaleCalibrationSchema = z
  .object({
    kind: z.literal('ui-scale-calibration'),
    ...eventTime,
    feature: z.literal('ui-scale'),
    outcome: z.literal('observed'),
    displayWidth: z.number().int().min(640).max(16_384),
    displayHeight: z.number().int().min(480).max(16_384),
    inputScaleMilli: z.number().int().min(800).max(1_200),
    renderedScaleMilli: z.number().int().min(500).max(1_500),
  })
  .strict();

export const telemetryEventSchema = z.discriminatedUnion('kind', [
  sessionStartedSchema,
  featureUsedSchema,
  operationErrorSchema,
  expeditionRewardSchema,
  ocrTimingSchema,
  ocrSetupFailureSchema,
  localInstanceFailureSchema,
  uiScaleCalibrationSchema,
]);

export const telemetryBatchSchema = z
  .object({
    installId: z.uuid(),
    appVersion: z
      .string()
      .min(5)
      .max(24)
      .regex(/^\d+\.\d+\.\d+$/),
    privacyNoticeVersion: z.number().int().min(1).max(currentPrivacyNoticeVersion),
    events: z.array(telemetryEventSchema).min(1).max(64),
  })
  .strict();

export type TelemetryKind = z.infer<typeof telemetryKindSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;
