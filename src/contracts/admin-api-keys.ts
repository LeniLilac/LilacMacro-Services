import { z } from 'zod';

export const adminApiKeyScopeSchema = z.enum([
  'control:read',
  'control:write',
  'diagnostics:read',
  'diagnostics:download',
  'diagnostics:delete',
  'telemetry:read',
  'audit:read',
  'keys:manage',
]);

export type AdminApiKeyScope = z.infer<typeof adminApiKeyScopeSchema>;

export const createAdminApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    scopes: z.array(adminApiKeyScopeSchema).min(1).max(8),
    expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  })
  .strict();

export const adminDataQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  days: z.coerce.number().int().min(1).max(90).default(30),
});
