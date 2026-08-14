import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../contracts/canonical-json.js';
import type { AdminCommandEnvelope } from '../contracts/admin-commands.js';
import type { SignedControlSnapshot } from '../contracts/control-snapshot.js';
import type { MultipartPartGrant, UploadStatus } from '../contracts/diagnostics.js';
import { applyAdminCommand, type MutableControlState } from '../domain/control-state.js';
import type {
  Actor,
  ControlAuditRecord,
  ControlRepository,
  DiagnosticAuditEvent,
  DiagnosticAuditRecord,
  DiagnosticQuotaLimits,
  DiagnosticRepository,
  DiagnosticUploadRecord,
  LargeUploadGrantRecord,
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
  private readonly records = new Map<string, DiagnosticUploadRecord>();
  public readonly largeUploadGrants = new Map<string, LargeUploadGrantRecord>();
  public readonly audit: DiagnosticAuditRecord[] = [];
  private nextAuditId = 1;

  public async insertWithinQuota(
    record: DiagnosticUploadRecord,
    since: Date,
    limits: DiagnosticQuotaLimits,
    audit: DiagnosticAuditEvent,
    largeUploadGrantId?: string,
  ): Promise<boolean> {
    if (this.records.has(record.id)) throw new Error('Diagnostic record already exists.');
    const recent = [...this.records.values()].filter((item) => item.createdAt >= since);
    const active = recent.filter((item) =>
      ['Uploading', 'Completing', 'Verifying', 'VerifyingActive', 'Pending', 'Deleting'].includes(
        item.status,
      ),
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
      (item) => !['Deleted', 'Rejected', 'Invalid'].includes(item.status),
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
        limits.globalDailyBytes ||
      retained.reduce((sum, item) => sum + item.request.sizeBytes, 0) + record.request.sizeBytes >
        limits.globalRetainedBytes
    ) {
      return false;
    }
    if (largeUploadGrantId) {
      const grant = this.largeUploadGrants.get(largeUploadGrantId);
      if (
        !grant ||
        grant.consumedAt !== null ||
        grant.expiresAt <= record.createdAt ||
        grant.uploadId !== record.id ||
        grant.objectKey !== record.objectKey ||
        grant.installPseudonym !== record.installPseudonym ||
        grant.sizeBytes !== record.request.sizeBytes ||
        grant.kind !== record.request.kind
      ) {
        return false;
      }
      grant.consumedAt = new Date(record.createdAt);
    }
    this.records.set(record.id, structuredClone(record));
    this.recordAudit(record.id, audit);
    return true;
  }

  public async issueLargeUploadGrant(record: LargeUploadGrantRecord): Promise<void> {
    if (this.largeUploadGrants.has(record.id)) {
      throw new Error('Large-upload grant already exists.');
    }
    this.largeUploadGrants.set(record.id, structuredClone(record));
  }

  public async find(id: string): Promise<DiagnosticUploadRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  public async list(limit: number): Promise<DiagnosticUploadRecord[]> {
    return [...this.records.values()]
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
    this.recordAudit(id, audit);
    return true;
  }

  public async claimVerification(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<DiagnosticUploadRecord[]> {
    const claimed = [...this.records.values()]
      .filter(
        (record) =>
          (record.status === 'Verifying' &&
            (record.nextVerificationAttemptAt === null ||
              record.nextVerificationAttemptAt <= now)) ||
          (record.status === 'VerifyingActive' && record.updatedAt <= staleBefore),
      )
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
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
              (record.createdAt.getTime() + 24 * 60 * 60 * 1000 <= now.getTime() ||
                record.verificationAttempts >= 8)) ||
            (record.status === 'VerifyingActive' &&
              (record.createdAt.getTime() + 24 * 60 * 60 * 1000 <= now.getTime() ||
                record.verificationAttempts >= 8)) ||
            record.status === 'Expired' ||
            (record.status === 'Failed' &&
              (record.nextDeletionAttemptAt === null || record.nextDeletionAttemptAt <= now))),
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
