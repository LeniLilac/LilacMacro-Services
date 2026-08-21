import {
  maximumArchiveBytes,
  multipartPartBytes,
  oneGiB,
  type PersistedUploadRequest,
  type UploadStatus,
} from '../contracts/diagnostics.js';

export interface UploadDecision {
  status: UploadStatus;
  partSizeBytes: number;
  partCount: number;
  acceptanceDeadline: Date | null;
  expiresAt: Date;
}

export const diagnosticQuotaLimits = {
  installDailyBytes: 40 * oneGiB,
  networkDailyBytes: 120 * oneGiB,
  installDailyUploads: 8,
  networkDailyUploads: 40,
  installActiveUploads: 2,
  networkActiveUploads: 8,
  globalDailyBytes: 500 * oneGiB,
  globalDailyUploads: 1_000,
  globalActiveUploads: 32,
  globalRetainedBytes: 1_000_000_000_000,
} as const;

const hour = 60 * 60 * 1000;

export function decideUpload(request: PersistedUploadRequest, now: Date): UploadDecision {
  if (request.sizeBytes > maximumArchiveBytes) throw new Error('Diagnostic archive exceeds 3 GiB.');
  return {
    status: 'Accepted',
    partSizeBytes: multipartPartBytes,
    partCount: Math.ceil(request.sizeBytes / multipartPartBytes),
    acceptanceDeadline: null,
    expiresAt: new Date(now.getTime() + 72 * hour),
  };
}
