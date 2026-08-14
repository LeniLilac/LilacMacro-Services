import { z } from 'zod';

export const oneGiB = 1024 ** 3;
export const routineLimitBytes = 3 * oneGiB;
export const absoluteLimitBytes = 30 * oneGiB;
export const multipartPartBytes = 128 * 1024 ** 2;

export const diagnosticKindSchema = z.enum([
  'deep-debug',
  'runtime-log',
  'installer-log',
  'live-debug',
]);

export const createUploadRequestSchema = z
  .object({
    installId: z.uuid(),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*\.zip$/i),
    sizeBytes: z.number().int().positive().max(absoluteLimitBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    kind: diagnosticKindSchema,
    explicitConsent: z.literal(true),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();

export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const persistedUploadRequestSchema = createUploadRequestSchema.omit({ installId: true });

export type PersistedUploadRequest = z.infer<typeof persistedUploadRequestSchema>;

export const uploadStatusSchema = z.enum([
  'Uploading',
  'Completing',
  'Verifying',
  'VerifyingActive',
  'Pending',
  'Accepted',
  'Deleting',
  'Rejected',
  'Expired',
  'Deleted',
  'Invalid',
  'Failed',
]);

export const multipartPartGrantSchema = z
  .object({
    sizeBytes: z.number().int().positive().max(multipartPartBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export type MultipartPartGrant = z.infer<typeof multipartPartGrantSchema>;

export type UploadStatus = z.infer<typeof uploadStatusSchema>;
