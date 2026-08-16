import { z } from 'zod';
import {
  featureIdSchema,
  publicOperationalTextSchema,
  redeemCodeValueSchema,
  scheduleKeySchema,
} from './control-snapshot.js';

const optionalExpiry = z.iso.datetime().nullable().default(null);

export const adminCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('code.add'),
      code: redeemCodeValueSchema,
      expiresAt: optionalExpiry,
    })
    .strict(),
  z.object({ type: z.literal('code.remove'), code: redeemCodeValueSchema }).strict(),
  z
    .object({
      type: z.literal('game.availability'),
      available: z.boolean(),
      message: publicOperationalTextSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('game.observation'),
      public: z.boolean(),
      observedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      type: z.literal('feature.disable'),
      feature: featureIdSchema,
      reason: publicOperationalTextSchema,
      expiresAt: optionalExpiry,
    })
    .strict(),
  z.object({ type: z.literal('feature.enable'), feature: featureIdSchema }).strict(),
  z
    .object({
      type: z.literal('schedule.set'),
      key: scheduleKeySchema,
      nextAt: z.iso.datetime(),
      cadenceSeconds: z
        .number()
        .int()
        .positive()
        .max(366 * 24 * 60 * 60),
    })
    .strict(),
  z
    .object({
      type: z.literal('release.set'),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
      pageUrl: z.url().startsWith('https://github.com/LeniLilac/LilacMacro/releases/'),
      installerUrl: z
        .url()
        .startsWith('https://github.com/LeniLilac/LilacMacro/releases/download/'),
      installerSize: z.number().int().positive(),
      installerSha256: z.string().regex(/^[0-9a-f]{64}$/),
      sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
      publishedAt: z.iso.datetime(),
      verifiedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      type: z.literal('release.clear'),
    })
    .strict(),
]);

export type AdminCommand = z.infer<typeof adminCommandSchema>;

export const adminCommandEnvelopeSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    command: adminCommandSchema,
  })
  .strict();

export type AdminCommandEnvelope = z.infer<typeof adminCommandEnvelopeSchema>;
