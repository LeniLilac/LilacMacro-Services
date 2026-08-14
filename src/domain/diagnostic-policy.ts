import {
  absoluteLimitBytes,
  multipartPartBytes,
  oneGiB,
  routineLimitBytes,
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
  globalRetainedBytes: 900 * oneGiB,
} as const;

const hour = 60 * 60 * 1000;

export function decideUpload(
  request: PersistedUploadRequest,
  now: Date,
  largeUploadAuthorized = false,
): UploadDecision {
  if (request.sizeBytes > absoluteLimitBytes) throw new Error('Diagnostic archive exceeds 30 GiB.');
  if (request.sizeBytes > routineLimitBytes && !largeUploadAuthorized) {
    throw new Error('Archives over 3 GiB require a server-issued manual upload grant.');
  }

  const large = request.sizeBytes > routineLimitBytes;
  return {
    status: large ? 'Pending' : 'Accepted',
    partSizeBytes: multipartPartBytes,
    partCount: Math.ceil(request.sizeBytes / multipartPartBytes),
    acceptanceDeadline: large ? new Date(now.getTime() + 30 * 60 * 1000) : null,
    expiresAt: new Date(now.getTime() + 72 * hour),
  };
}

export function extendRetention(now: Date, requestedUntil: Date): Date {
  const maximum = new Date(now.getTime() + 7 * 24 * hour);
  if (requestedUntil <= now || requestedUntil > maximum) {
    throw new Error('Accepted diagnostics may be retained for at most seven days.');
  }
  return requestedUntil;
}
