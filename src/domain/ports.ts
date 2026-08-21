import type { AdminCommand, AdminCommandEnvelope } from '../contracts/admin-commands.js';
import type { SignedControlSnapshot } from '../contracts/control-snapshot.js';
import type {
  MultipartPartGrant,
  PersistedUploadRequest,
  UploadStatus,
} from '../contracts/diagnostics.js';
import type { MutableControlState } from './control-state.js';
import type { TelemetryEvent, TelemetryKind } from '../contracts/telemetry.js';

export interface Actor {
  kind: 'discord' | 'web' | 'system';
  userId: string;
}

export interface ControlAuditRecord {
  commandId: string;
  actor: Actor;
  command: AdminCommand;
  resultingRevision: number;
  createdAt: Date;
  previousHash: string | null;
  entryHash: string;
}

export interface ControlRepository {
  readState(): Promise<MutableControlState>;
  executeAndPublish(
    actor: Actor,
    envelope: AdminCommandEnvelope,
    signer: SnapshotSigner,
    now: Date,
  ): Promise<SignedControlSnapshot>;
  republish(signer: SnapshotSigner, now: Date): Promise<SignedControlSnapshot>;
  readPublished(): Promise<SignedControlSnapshot | null>;
  listAudit(limit: number): Promise<ControlAuditRecord[]>;
}

export interface SnapshotSigner {
  sign(payload: MutableControlState, now: Date): Promise<SignedControlSnapshot>;
  assertReady(): void;
}

export interface DiagnosticUploadRecord {
  id: string;
  objectKey: string;
  installPseudonym: string;
  networkPseudonym: string;
  request: PersistedUploadRequest;
  status: UploadStatus;
  createdAt: Date;
  acceptanceDeadline: Date | null;
  expiresAt: Date;
  providerUploadId: string | null;
  multipartParts: Readonly<Record<number, MultipartPartGrant>>;
  verificationAttempts: number;
  nextVerificationAttemptAt: Date | null;
  deletionAttempts: number;
  nextDeletionAttemptAt: Date | null;
  updatedAt: Date;
}

export interface DiagnosticAuditEvent {
  actor: Actor;
  action:
    | 'upload.created'
    | 'upload.completed'
    | 'verification.requested'
    | 'verification.succeeded'
    | 'verification.failed'
    | 'moderation.accept'
    | 'moderation.reject'
    | 'moderation.delete'
    | 'download.requested'
    | 'retention.evicted'
    | 'deletion.claimed'
    | 'deletion.succeeded'
    | 'deletion.retry-scheduled'
    | 'multipart.compensation-failed';
  details: Readonly<Record<string, string | number | boolean | null>>;
  createdAt: Date;
}

export interface DiagnosticAuditRecord extends DiagnosticAuditEvent {
  id: number;
  uploadId: string;
}

export interface DiagnosticQuotaLimits {
  installDailyBytes: number;
  networkDailyBytes: number;
  installDailyUploads: number;
  networkDailyUploads: number;
  installActiveUploads: number;
  networkActiveUploads: number;
  globalDailyBytes: number;
  globalDailyUploads: number;
  globalActiveUploads: number;
  globalRetainedBytes: number;
}

export interface DiagnosticRepository {
  insertWithinQuota(
    record: DiagnosticUploadRecord,
    since: Date,
    limits: DiagnosticQuotaLimits,
    audit: DiagnosticAuditEvent,
  ): Promise<boolean>;
  find(id: string): Promise<DiagnosticUploadRecord | null>;
  list(limit: number): Promise<DiagnosticUploadRecord[]>;
  setProviderUploadId(id: string, providerUploadId: string): Promise<boolean>;
  registerPartGrant(id: string, partNumber: number, grant: MultipartPartGrant): Promise<boolean>;
  transition(
    id: string,
    expectedStatuses: readonly UploadStatus[],
    status: UploadStatus,
    options?: {
      expiresAt?: Date;
      acceptanceDeadline?: Date | null;
      acceptanceDeadlineAfter?: Date;
      providerUploadId?: string | null;
      audit?: DiagnosticAuditEvent;
    },
  ): Promise<boolean>;
  appendAudit(id: string, event: DiagnosticAuditEvent): Promise<void>;
  listAudit(uploadId: string | null, limit: number): Promise<DiagnosticAuditRecord[]>;
  scheduleDeletionRetry(
    id: string,
    nextAttemptAt: Date,
    audit: DiagnosticAuditEvent,
  ): Promise<boolean>;
  claimVerification(now: Date, staleBefore: Date, limit: number): Promise<DiagnosticUploadRecord[]>;
  scheduleVerificationRetry(id: string, nextAttemptAt: Date): Promise<boolean>;
  claimExpired(now: Date, limit: number): Promise<DiagnosticUploadRecord[]>;
  listProviderUploadIds(): Promise<readonly string[]>;
}

export type PersistedTelemetryEvent = TelemetryEvent extends infer Event
  ? Event extends TelemetryEvent
    ? Omit<Event, 'occurredAtUtc'> & { occurredAtUtc: Date }
    : never
  : never;

export interface TelemetrySummaryRow {
  kind: TelemetryKind;
  feature: string | null;
  material: string | null;
  graphicsCapability: string | null;
  hardwareModel: string | null;
  displayWidth: number | null;
  displayHeight: number | null;
  inputScaleMilli: number | null;
  renderedScaleMilli: number | null;
  eventCount: number;
  estimatedInstallations: number;
  averageDurationMilliseconds: number | null;
  quantityTotal: number | null;
  latestEventAt: Date;
}

export interface TelemetryRepository {
  insertBatch(
    installPseudonym: string,
    networkPseudonym: string,
    appVersion: string,
    privacyNoticeVersion: number,
    events: readonly PersistedTelemetryEvent[],
    receivedAt: Date,
    requestBytes: number,
  ): Promise<boolean>;
  summary(since: Date): Promise<readonly TelemetrySummaryRow[]>;
  deleteBefore(cutoff: Date): Promise<number>;
}

export interface SharedConfiguration {
  code: string;
  payload: string;
  expiresAt: Date;
}

export interface ConfigurationShareRepository {
  create(
    payload: string,
    networkPseudonym: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<SharedConfiguration | null>;
  find(code: string, now: Date): Promise<SharedConfiguration | null>;
  deleteExpired(now: Date): Promise<number>;
}
