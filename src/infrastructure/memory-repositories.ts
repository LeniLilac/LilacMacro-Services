import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../contracts/canonical-json.js';
import type { AdminCommandEnvelope } from '../contracts/admin-commands.js';
import type { SignedControlSnapshot } from '../contracts/control-snapshot.js';
import type { MultipartPartGrant, UploadStatus } from '../contracts/diagnostics.js';
import { applyAdminCommand, type MutableControlState } from '../domain/control-state.js';
import { selectCapacityEvictions } from '../domain/diagnostic-capacity.js';
import type {
  Actor,
  ControlAuditRecord,
  ControlRepository,
  DiagnosticAuditEvent,
  DiagnosticAuditRecord,
  DiagnosticListFilters,
  DiagnosticQuotaLimits,
  DiagnosticRepository,
  DiagnosticUploadRecord,
  SnapshotSigner,
} from '../domain/ports.js';

export function defaultControlState(): MutableControlState {
  return {
    revision: 0,
    game: { operatorAvailable: true, observedPublic: null, observedAt: null, message: null },
    codes: [],
    schedules: [],
    disablements: [],
    release: null,
    releaseEvidence: null,
    releaseFloorVersion: null,
  };
}

export class MemoryControlRepository implements ControlRepository {
  private state = defaultControlState();
  private readonly published = new Map<number, SignedControlSnapshot>();
  public readonly audit: ControlAuditRecord[] = [];
  private readonly commandReplays = new Map<
    string,
    { fingerprint: string; snapshot: SignedControlSnapshot }
  >();

  public async readState(): Promise<MutableControlState> {
    return structuredClone(this.state);
  }

  public async executeAndPublish(
    actor: Actor,
    envelope: AdminCommandEnvelope,
    signer: SnapshotSigner,
    now: Date,
  ): Promise<SignedControlSnapshot> {
    const fingerprint = replayFingerprint(actor, envelope);
    const replayRecord = this.commandReplays.get(envelope.commandId);
    if (replayRecord !== undefined) {
      if (replayRecord.fingerprint !== fingerprint) {
        throw new Error('Control command replay did not match the original request.');
      }
      return structuredClone(replayRecord.snapshot);
    }
    if (envelope.expectedRevision !== this.state.revision)
      throw new Error('Control revision conflict.');
    const next = {
      ...applyAdminCommand(this.state, envelope.command),
      revision: this.state.revision + 1,
    };
    const snapshot = await signer.sign(next, now);
    this.state = next;
    this.commandReplays.set(envelope.commandId, {
      fingerprint,
      snapshot: structuredClone(snapshot),
    });
    this.audit.push({
      commandId: envelope.commandId,
      actor,
      command: structuredClone(envelope.command),
      resultingRevision: this.state.revision,
      createdAt: new Date(now),
      previousHash: null,
      entryHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    });
    this.published.set(next.revision, structuredClone(snapshot));
    return structuredClone(snapshot);
  }

  public async republish(signer: SnapshotSigner, now: Date): Promise<SignedControlSnapshot> {
    const snapshot = await signer.sign(this.state, now);
    this.published.set(snapshot.payload.revision, structuredClone(snapshot));
    return structuredClone(snapshot);
  }

  public async readPublished(): Promise<SignedControlSnapshot | null> {
    if (this.published.size === 0) return null;
    const latestRevision = Math.max(...this.published.keys());
    return structuredClone(this.published.get(latestRevision)!);
  }

  public async listAudit(limit: number): Promise<ControlAuditRecord[]> {
    return this.audit
      .slice()
      .sort((left, right) => right.resultingRevision - left.resultingRevision)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}

function replayFingerprint(actor: Actor, envelope: AdminCommandEnvelope): string {
  return canonicalJson({
    actor,
    expectedRevision: envelope.expectedRevision,
    command: envelope.command,
  });
}

export class MemoryDiagnosticRepository implements DiagnosticRepository {
  private preverificationEnabled = true;
  private readonly records = new Map<string, DiagnosticUploadRecord>();
  private readonly capacityReleased = new Set<string>();
  public readonly audit: DiagnosticAuditRecord[] = [];
  private nextAuditId = 1;

  public async insertWithinQuota(
    record: DiagnosticUploadRecord,
    since: Date,
    limits: DiagnosticQuotaLimits,
    audit: DiagnosticAuditEvent,
  ): Promise<boolean> {
    if (this.records.has(record.id)) throw new Error('Diagnostic record already exists.');
    const recent = [...this.records.values()].filter((item) => item.createdAt >= since);
    const active = recent.filter(
      (item) =>
        ['Uploading', 'Completing', 'Verifying', 'VerifyingActive', 'Deleting'].includes(
          item.status,
        ) ||
        (item.status === 'Pending' && item.acceptanceDeadline !== null),
    );
    const install = recent.filter((item) => item.installPseudonym === record.installPseudonym);
    const network = recent.filter((item) => item.networkPseudonym === record.networkPseudonym);
    const installActive = active.filter(
      (item) => item.installPseudonym === record.installPseudonym,
    );
    const networkActive = active.filter(
      (item) => item.networkPseudonym === record.networkPseudonym,
    );
    const retained = [...this.records.values()].filter(
      (item) =>
        !['Deleted', 'Rejected', 'Invalid'].includes(item.status) &&
        !this.capacityReleased.has(item.id),
    );
    if (
      install.length >= limits.installDailyUploads ||
      network.length >= limits.networkDailyUploads ||
      installActive.length >= limits.installActiveUploads ||
      networkActive.length >= limits.networkActiveUploads ||
      recent.length >= limits.globalDailyUploads ||
      active.length >= limits.globalActiveUploads ||
      install.reduce((sum, item) => sum + item.request.sizeBytes, 0) + record.request.sizeBytes >
        limits.installDailyBytes ||
      network.reduce((sum, item) => sum + item.request.sizeBytes, 0) + record.request.sizeBytes >
        limits.networkDailyBytes ||
      recent.reduce((sum, item) => sum + item.request.sizeBytes, 0) + record.request.sizeBytes >
        limits.globalDailyBytes
    ) {
      return false;
    }
    const evictionIds = selectCapacityEvictions(
      retained.map((item) => ({
        id: item.id,
        installPseudonym: item.installPseudonym,
        sizeBytes: item.request.sizeBytes,
        createdAt: item.createdAt,
        evictable: ['Pending', 'Accepted', 'Failed', 'Expired'].includes(item.status),
      })),
      record.request.sizeBytes,
      limits.globalRetainedBytes,
    );
    if (evictionIds === null) return false;
    for (const id of evictionIds) {
      const victim = this.records.get(id)!;
      victim.status = 'Expired';
      victim.updatedAt = new Date(record.createdAt);
      this.capacityReleased.add(id);
      this.recordAudit(id, {
        actor: { kind: 'system', userId: '0' },
        action: 'retention.evicted',
        details: {
          reason: 'global-storage-capacity',
          incomingSizeBytes: record.request.sizeBytes,
        },
        createdAt: record.createdAt,
      });
    }
    this.records.set(record.id, structuredClone(record));
    this.recordAudit(record.id, audit);
    return true;
  }

  public async find(id: string): Promise<DiagnosticUploadRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  public async list(
    limit: number,
    filters: DiagnosticListFilters = {},
  ): Promise<DiagnosticUploadRecord[]> {
    const installPseudonyms = new Set(filters.installPseudonyms ?? []);
    return [...this.records.values()]
      .filter(
        (record) =>
          (installPseudonyms.size === 0 || installPseudonyms.has(record.installPseudonym)) &&
          (!filters.minimumAppVersion ||
            compareVersions(record.request.appVersion, filters.minimumAppVersion) >= 0) &&
          (!filters.osVersion ||
            (record.request.osVersion ?? '')
              .toLowerCase()
              .includes(filters.osVersion.toLowerCase())) &&
          (!filters.createdAfter || record.createdAt >= filters.createdAfter) &&
          (!filters.maximumSizeBytes || record.request.sizeBytes <= filters.maximumSizeBytes),
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  public async setProviderUploadId(id: string, providerUploadId: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    if (record.status !== 'Uploading') return false;
    record.providerUploadId = providerUploadId;
    record.updatedAt = new Date();
    return true;
  }

  public async registerPartGrant(
    id: string,
    partNumber: number,
    grant: MultipartPartGrant,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    if (record.status !== 'Uploading') return false;
    const existing = record.multipartParts[partNumber];
    if (existing && (existing.sizeBytes !== grant.sizeBytes || existing.sha256 !== grant.sha256)) {
      return false;
    }
    record.multipartParts = { ...record.multipartParts, [partNumber]: structuredClone(grant) };
    record.updatedAt = new Date();
    return true;
  }

  public async transition(
    id: string,
    expectedStatuses: readonly UploadStatus[],
    status: UploadStatus,
    options: {
      expiresAt?: Date;
      acceptanceDeadline?: Date | null;
      acceptanceDeadlineAfter?: Date;
      providerUploadId?: string | null;
      audit?: DiagnosticAuditEvent;
    } = {},
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    if (!expectedStatuses.includes(record.status)) return false;
    if (
      options.acceptanceDeadlineAfter &&
      (record.acceptanceDeadline === null ||
        record.acceptanceDeadline <= options.acceptanceDeadlineAfter)
    ) {
      return false;
    }
    record.status = status;
    if (options.expiresAt) record.expiresAt = options.expiresAt;
    if (options.acceptanceDeadline !== undefined)
      record.acceptanceDeadline = options.acceptanceDeadline;
    if (options.providerUploadId !== undefined) record.providerUploadId = options.providerUploadId;
    if (options.audit) {
      this.recordAudit(id, options.audit);
    }
    record.updatedAt = new Date();
    return true;
  }

  public async appendAudit(id: string, event: DiagnosticAuditEvent): Promise<void> {
    if (!this.records.has(id)) throw new Error('Diagnostic upload was not found.');
    this.recordAudit(id, event);
  }

  public async listAudit(uploadId: string | null, limit: number): Promise<DiagnosticAuditRecord[]> {
    return this.audit
      .filter((record) => uploadId === null || record.uploadId === uploadId)
      .slice()
      .sort((left, right) => right.id - left.id)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  public async readPreverificationEnabled(): Promise<boolean> {
    return this.preverificationEnabled;
  }

  public async setPreverificationEnabled(enabled: boolean): Promise<boolean> {
    const changed = this.preverificationEnabled !== enabled;
    this.preverificationEnabled = enabled;
    return changed;
  }

  public async scheduleDeletionRetry(
    id: string,
    nextAttemptAt: Date,
    audit: DiagnosticAuditEvent,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    if (record.status !== 'Deleting') return false;
    record.status = 'Failed';
    record.deletionAttempts += 1;
    record.nextDeletionAttemptAt = new Date(nextAttemptAt);
    record.updatedAt = new Date();
    this.capacityReleased.delete(id);
    this.recordAudit(id, audit);
    return true;
  }

  public async claimVerification(
    now: Date,
    staleBefore: Date,
    limit: number,
    includeStored: boolean,
  ): Promise<DiagnosticUploadRecord[]> {
    const claimed = [...this.records.values()]
      .filter(
        (record) =>
          (includeStored && record.status === 'Pending' && record.acceptanceDeadline === null) ||
          (record.status === 'Verifying' &&
            (record.nextVerificationAttemptAt === null ||
              record.nextVerificationAttemptAt <= now)) ||
          (record.status === 'VerifyingActive' && record.updatedAt <= staleBefore),
      )
      .sort((left, right) => {
        const priority = Number(left.status === 'Pending') - Number(right.status === 'Pending');
        return priority || left.updatedAt.getTime() - right.updatedAt.getTime();
      })
      .slice(0, limit);
    for (const record of claimed) {
      record.status = 'VerifyingActive';
      record.updatedAt = new Date(now);
    }
    return claimed.map((record) => structuredClone(record));
  }

  public async scheduleVerificationRetry(id: string, nextAttemptAt: Date): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    if (record.status !== 'VerifyingActive') return false;
    record.status = 'Verifying';
    record.verificationAttempts += 1;
    record.nextVerificationAttemptAt = new Date(nextAttemptAt);
    record.updatedAt = new Date();
    return true;
  }

  public async claimExpired(now: Date, limit: number): Promise<DiagnosticUploadRecord[]> {
    const claimed = [...this.records.values()]
      .filter(
        (record) =>
          record.status !== 'Deleted' &&
          record.status !== 'Rejected' &&
          ((record.status === 'Deleting' &&
            record.updatedAt.getTime() + 15 * 60 * 1000 <= now.getTime()) ||
            (record.status === 'Accepted' && record.expiresAt <= now) ||
            (record.status === 'Pending' &&
              (record.expiresAt <= now ||
                (record.acceptanceDeadline !== null && record.acceptanceDeadline <= now))) ||
            (record.status === 'Uploading' &&
              record.createdAt.getTime() + 12 * 60 * 60 * 1000 <= now.getTime()) ||
            (record.status === 'Completing' &&
              record.updatedAt.getTime() + 12 * 60 * 60 * 1000 <= now.getTime()) ||
            (record.status === 'Verifying' &&
              ((record.acceptanceDeadline?.getTime() ??
                record.createdAt.getTime() + 24 * 60 * 60 * 1000) <= now.getTime() ||
                record.verificationAttempts >= 8)) ||
            (record.status === 'VerifyingActive' &&
              ((record.acceptanceDeadline?.getTime() ??
                record.createdAt.getTime() + 24 * 60 * 60 * 1000) <= now.getTime() ||
                record.verificationAttempts >= 8)) ||
            record.status === 'Expired' ||
            (record.status === 'Failed' &&
              (record.nextDeletionAttemptAt === null || record.nextDeletionAttemptAt <= now))),
      )
      .sort(
        (left, right) =>
          Number(this.capacityReleased.has(right.id)) -
            Number(this.capacityReleased.has(left.id)) ||
          left.expiresAt.getTime() - right.expiresAt.getTime(),
      )
      .slice(0, limit);
    for (const record of claimed) {
      record.status = 'Deleting';
      record.updatedAt = new Date(now);
    }
    return claimed.map((record) => structuredClone(record));
  }

  public async listProviderUploadIds(): Promise<readonly string[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.providerUploadId !== null &&
          !['Deleted', 'Rejected', 'Expired', 'Invalid'].includes(record.status),
      )
      .map((record) => record.providerUploadId!);
  }

  private recordAudit(uploadId: string, event: DiagnosticAuditEvent): void {
    this.audit.push({ id: this.nextAuditId++, uploadId, ...structuredClone(event) });
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
