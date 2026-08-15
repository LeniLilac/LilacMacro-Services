import { z } from 'zod';

export const telemetryKindSchema = z.enum([
  'session-started',
  'feature-used',
  'operation-error',
  'expedition-reward-observed',
  'ocr-timing',
]);

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
  })
  .strict();

export const telemetryEventSchema = z.discriminatedUnion('kind', [
  sessionStartedSchema,
  featureUsedSchema,
  operationErrorSchema,
  expeditionRewardSchema,
  ocrTimingSchema,
]);

export const telemetryBatchSchema = z
  .object({
    installId: z.uuid(),
    appVersion: z
      .string()
      .min(5)
      .max(24)
      .regex(/^\d+\.\d+\.\d+$/),
    privacyNoticeVersion: z.literal(1),
    events: z.array(telemetryEventSchema).min(1).max(64),
  })
  .strict();

export type TelemetryKind = z.infer<typeof telemetryKindSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;
