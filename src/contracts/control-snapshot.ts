import { z } from 'zod';

export const featureIds = [
  'mode.story',
  'mode.raid',
  'mode.challenge',
  'mode.expedition',
  'mode.event',
  'task.calendar-claim',
  'task.gold-shop',
  'task.raid-shop',
  'task.expedition-shop',
  'task.code-redeem',
  'task.gold-mine-refuel',
  'task.resource-drill-refuel',
  'feature.route-optimizer',
  'feature.team-swap',
  'feature.settings-normalizer',
] as const;

export const featureIdSchema = z.enum(featureIds);
export type FeatureId = z.infer<typeof featureIdSchema>;

export const scheduleKeys = [
  'gold-shop-reset',
  'raid-shop-reset',
  'expedition-shop-reset',
] as const;

export const scheduleKeySchema = z.enum(scheduleKeys);
export type ScheduleKey = z.infer<typeof scheduleKeySchema>;

export const redeemCodeValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const forbiddenPublicText = [
  /discord(?:app)?\.com\/api\/webhooks\//i,
  /roblox\.com\/share\?code=/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:api[_ -]?key|client[_ -]?secret|password)\s*[:=]\s*\S+/i,
];

export const publicOperationalTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => forbiddenPublicText.every((pattern) => !pattern.test(value)),
    'Public operational text looked like secret material.',
  );

export const redeemCodeSchema = z
  .object({
    code: redeemCodeValueSchema,
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();

export const scheduleSchema = z
  .object({
    key: scheduleKeySchema,
    nextAt: z.iso.datetime(),
    cadenceSeconds: z
      .number()
      .int()
      .positive()
      .max(366 * 24 * 60 * 60),
  })
  .strict();

export const disablementSchema = z
  .object({
    feature: featureIdSchema,
    reason: publicOperationalTextSchema,
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();

export const releaseSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    pageUrl: z.url().startsWith('https://github.com/LeniLilac/LilacMacro/releases/'),
    installerUrl: z.url().startsWith('https://github.com/LeniLilac/LilacMacro/releases/download/'),
    publishedAt: z.iso.datetime(),
  })
  .strict();

export const controlPayloadSchema = z
  .object({
    schema: z.literal(1),
    revision: z.number().int().nonnegative(),
    generatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    game: z
      .object({
        available: z.boolean(),
        operatorAvailable: z.boolean(),
        observedPublic: z.boolean().nullable(),
        observedAt: z.iso.datetime().nullable(),
        message: publicOperationalTextSchema.nullable(),
      })
      .strict(),
    codes: z.array(redeemCodeSchema).max(100),
    schedules: z.array(scheduleSchema).max(20),
    disablements: z.array(disablementSchema).max(featureIds.length),
    release: releaseSchema.nullable(),
  })
  .strict();

export const signedControlSnapshotSchema = z
  .object({
    keyId: z.string().regex(/^[a-z0-9-]{1,32}$/),
    algorithm: z.literal('Ed25519'),
    payload: controlPayloadSchema,
    signature: z.string().base64(),
  })
  .strict();

export type ControlPayload = z.infer<typeof controlPayloadSchema>;
export type SignedControlSnapshot = z.infer<typeof signedControlSnapshotSchema>;
