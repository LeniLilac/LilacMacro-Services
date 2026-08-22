import { z } from 'zod';
import { diagnosticVersionSchema, maximumArchiveBytes } from '../contracts/diagnostics.js';
import type { DiagnosticListFilters } from '../domain/ports.js';
import type { RotatingPseudonymizer } from '../infrastructure/pseudonym.js';

export const diagnosticSearchSchema = z
  .object({
    installationId: z.uuid().optional(),
    minimumAppVersion: diagnosticVersionSchema.optional(),
    osVersion: z.string().trim().min(1).max(160).optional(),
    createdAfter: z.iso.datetime({ offset: true }).optional(),
    maximumSizeBytes: z.number().int().positive().max(maximumArchiveBytes).optional(),
    limit: z.number().int().min(1).max(250).default(100),
  })
  .strict();

export type DiagnosticSearch = z.infer<typeof diagnosticSearchSchema>;

export function diagnosticListFilters(
  input: DiagnosticSearch,
  pseudonymizer: RotatingPseudonymizer,
  now: Date,
): DiagnosticListFilters {
  return {
    installPseudonyms: input.installationId
      ? diagnosticInstallPseudonyms(pseudonymizer, input.installationId, now)
      : [],
    ...(input.minimumAppVersion ? { minimumAppVersion: input.minimumAppVersion } : {}),
    ...(input.osVersion ? { osVersion: input.osVersion } : {}),
    ...(input.createdAfter ? { createdAfter: new Date(input.createdAfter) } : {}),
    ...(input.maximumSizeBytes ? { maximumSizeBytes: input.maximumSizeBytes } : {}),
  };
}

export function diagnosticInstallPseudonyms(
  pseudonymizer: RotatingPseudonymizer,
  installationId: string,
  now: Date,
): readonly string[] {
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [
    pseudonymizer.forInstall(installationId, now),
    pseudonymizer.forInstall(installationId, previousMonth),
  ];
}
