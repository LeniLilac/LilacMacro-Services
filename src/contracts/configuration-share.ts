import { z } from 'zod';

export const shareCodeSchema = z.string().regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{20}$/);

export const createConfigurationShareSchema = z
  .object({
    payload: z
      .string()
      .min(1)
      .max(245_000)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const resolveConfigurationShareSchema = z.object({ code: shareCodeSchema }).strict();
