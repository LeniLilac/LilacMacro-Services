import { decideUpload } from './diagnostic-policy.js';
import type { Clock } from './clock.js';
import type { Actor, DiagnosticRepository, DiagnosticUploadRecord } from './ports.js';
import type { UploadStorage } from './diagnostic-service.js';

const verificationLifetimeMilliseconds = 24 * 60 * 60 * 1000;
const verificationMaximumAttempts = 8;
const verificationMinimumDeadlineMilliseconds = 10 * 60 * 1000;
const verificationMaximumDeadlineMilliseconds = 2 * 60 * 60 * 1000;
const verificationBytesPerSecondFloor = 5 * 1024 * 1024;

export function verificationDeadlineMilliseconds(expectedBytes: number): number {
  const transferMilliseconds = Math.ceil((expectedBytes / verificationBytesPerSecondFloor) * 1000);
  return Math.min(
    verificationMaximumDeadlineMilliseconds,
    Math.max(verificationMinimumDeadlineMilliseconds, transferMilliseconds + 5 * 60 * 1000),
  );
}

export class DiagnosticMaintenanceService {
  public constructor(
    private readonly repository: DiagnosticRepository,
    private readonly storage: UploadStorage,
    private readonly clock: Clock,
    private readonly verificationDeadline: (
      expectedBytes: number,
    ) => number = verificationDeadlineMilliseconds,
  ) {}

  public async cleanup(limit = 100, signal?: AbortSignal): Promise<number> {
    const records = await this.repository.claimExpired(this.clock.now(), limit);
    for (const record of records) {
      signal?.throwIfAborted();
      try {
        await this.repository.appendAudit(record.id, {
          actor: { kind: 'system', userId: '0' },
          action: 'deletion.claimed',
          details: { reason: 'retention-or-lifecycle-deadline' },
          createdAt: this.clock.now(),
        });
        await this.storage.remove(record.objectKey, record.providerUploadId, signal);
        await this.repository.transition(record.id, ['Deleting'], 'Deleted', {
          providerUploadId: null,
          audit: {
            actor: { kind: 'system', userId: '0' },
            action: 'deletion.succeeded',
            details: { reason: 'retention-or-lifecycle-deadline' },
            createdAt: this.clock.now(),
          },
        });
      } catch {
        await scheduleDeletionRetry(this.repository, this.clock, record);
      }
    }
    return records.length;
  }

  public async requestDeletionByAdministrator(
    record: DiagnosticUploadRecord,
    actor: Actor,
  ): Promise<void> {
    if (['Deleted', 'Rejected', 'Invalid'].includes(record.status)) return;
    const deletableStatuses = [
      'Uploading',
      'Verifying',
      'Pending',
      'Accepted',
      'Failed',
      'Expired',
    ] as const;
    if (!deletableStatuses.includes(record.status as (typeof deletableStatuses)[number])) {
      throw new Error('Diagnostic upload is busy and cannot be deleted yet.');
    }
    if (
      !(await this.repository.transition(record.id, [record.status], 'Expired', {
        audit: {
          actor,
          action: 'moderation.delete',
          details: { previousStatus: record.status },
          createdAt: this.clock.now(),
        },
      }))
    ) {
      throw new Error('Diagnostic deletion conflicted with another request.');
    }
  }

  public async verifyPending(limit = 4, signal?: AbortSignal): Promise<number> {
    const now = this.clock.now();
    const records = await this.repository.claimVerification(
      now,
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
      Math.min(Math.max(limit, 1), 8),
    );
    await Promise.all(records.map((record) => this.verifyClaimed(record, signal)));
    return records.length;
  }

  public async reconcileMultipartOrphans(
    prefix: string,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<number> {
    const maximum = Math.min(Math.max(limit, 1), 500);
    const [providerUploads, referencedUploadIds] = await Promise.all([
      this.storage.listMultipartUploads(prefix, maximum, signal),
      this.repository.listProviderUploadIds(),
    ]);
    const referenced = new Set(referencedUploadIds);
    const cutoff = this.clock.now().getTime() - 12 * 60 * 60 * 1000;
    let removed = 0;
    let firstFailure: unknown;
    for (const upload of providerUploads) {
      signal?.throwIfAborted();
      if (referenced.has(upload.uploadId) || upload.initiatedAt.getTime() > cutoff) continue;
      try {
        await this.storage.abortMultipart(upload.objectKey, upload.uploadId, signal);
        removed += 1;
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
    return removed;
  }

  private async verifyClaimed(record: DiagnosticUploadRecord, signal?: AbortSignal): Promise<void> {
    try {
      await this.verifyObjectWithinDeadline(record, signal);
      const decision = decideUpload(record.request, record.createdAt);
      if (
        !(await this.repository.transition(record.id, ['VerifyingActive'], decision.status, {
          acceptanceDeadline: null,
          audit: {
            actor: { kind: 'system', userId: '0' },
            action: 'verification.succeeded',
            details: { sha256: record.request.sha256 },
            createdAt: this.clock.now(),
          },
        }))
      ) {
        throw new Error('Diagnostic verification finalization conflicted with another request.');
      }
    } catch (error) {
      if (isPermanentIntegrityFailure(error)) {
        await this.rejectInvalid(record, error, signal);
      } else {
        await this.scheduleVerificationRetry(record);
      }
    }
  }

  private async verifyObjectWithinDeadline(
    record: DiagnosticUploadRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = this.verificationDeadline(record.request.sizeBytes);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Diagnostic verification timed out.'));
      }, timeout);
    });
    const abortError = new Error('Diagnostic verification interrupted by worker shutdown.');
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abortListener = () => {
        controller.abort();
        reject(abortError);
      };
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      await Promise.race([
        this.storage.verifyObject(
          record.objectKey,
          record.request.sizeBytes,
          record.request.sha256,
          controller.signal,
        ),
        expired,
        interrupted,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      controller.abort();
    }
  }

  private async scheduleVerificationRetry(record: DiagnosticUploadRecord): Promise<void> {
    const attempt = record.verificationAttempts + 1;
    const now = this.clock.now();
    if (attempt >= verificationMaximumAttempts || verificationExpiresAt(record) <= now.getTime()) {
      if (
        !(await this.repository.transition(record.id, ['VerifyingActive'], 'Expired', {
          audit: {
            actor: { kind: 'system', userId: '0' },
            action: 'verification.failed',
            details: { reason: 'retry-budget-exhausted', attempt },
            createdAt: now,
          },
        }))
      ) {
        throw new Error('Diagnostic verification expiry conflicted with another request.');
      }
      return;
    }
    const delay = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(attempt - 1, 7));
    if (
      !(await this.repository.scheduleVerificationRetry(record.id, new Date(now.getTime() + delay)))
    ) {
      throw new Error('Diagnostic verification retry conflicted with another request.');
    }
  }

  private async rejectInvalid(
    record: DiagnosticUploadRecord,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !(await this.repository.transition(record.id, ['VerifyingActive'], 'Deleting', {
        audit: {
          actor: { kind: 'system', userId: '0' },
          action: 'verification.failed',
          details: { reason: integrityFailureReason(error) },
          createdAt: this.clock.now(),
        },
      }))
    ) {
      throw new Error('Diagnostic integrity rejection conflicted with another request.');
    }
    try {
      await this.storage.remove(record.objectKey, null, signal);
      if (
        !(await this.repository.transition(record.id, ['Deleting'], 'Invalid', {
          audit: {
            actor: { kind: 'system', userId: '0' },
            action: 'deletion.succeeded',
            details: { reason: 'integrity-failure' },
            createdAt: this.clock.now(),
          },
        }))
      ) {
        throw new Error(
          'Diagnostic integrity rejection finalization conflicted with another request.',
        );
      }
    } catch (removalError) {
      await scheduleDeletionRetry(this.repository, this.clock, record);
      throw removalError;
    }
  }
}

function verificationExpiresAt(record: DiagnosticUploadRecord): number {
  return (
    record.acceptanceDeadline?.getTime() ??
    record.createdAt.getTime() + verificationLifetimeMilliseconds
  );
}

export async function scheduleDeletionRetry(
  repository: DiagnosticRepository,
  clock: Clock,
  record: DiagnosticUploadRecord,
): Promise<void> {
  const attempt = record.deletionAttempts + 1;
  const delay = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempt - 1, 9));
  if (
    !(await repository.scheduleDeletionRetry(record.id, new Date(clock.now().getTime() + delay), {
      actor: { kind: 'system', userId: '0' },
      action: 'deletion.retry-scheduled',
      details: { attempt, delayMilliseconds: delay },
      createdAt: clock.now(),
    }))
  ) {
    throw new Error('Diagnostic deletion retry conflicted with another request.');
  }
}

function isPermanentIntegrityFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Diagnostic upload integrity ');
}

function integrityFailureReason(error: unknown): string {
  return error instanceof Error && error.message.endsWith('size mismatch.')
    ? 'size-mismatch'
    : 'sha256-mismatch';
}
