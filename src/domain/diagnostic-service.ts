import { randomUUID } from 'node:crypto';
import {
  multipartPartGrantSchema,
  persistedUploadRequestSchema,
  type MultipartPartGrant,
  type PersistedUploadRequest,
} from '../contracts/diagnostics.js';
import type { Clock } from './clock.js';
import {
  DiagnosticMaintenanceService,
  verificationDeadlineMilliseconds,
} from './diagnostic-maintenance.js';
import { decideUpload, diagnosticQuotaLimits } from './diagnostic-policy.js';
import type {
  Actor,
  DiagnosticAuditRecord,
  DiagnosticRepository,
  DiagnosticUploadRecord,
} from './ports.js';

export interface UploadStorage {
  beginMultipart(objectKey: string, contentType: string): Promise<string>;
  presignPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    grant: MultipartPartGrant,
  ): Promise<string>;
  completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string; checksumSha256: string }>,
  ): Promise<void>;
  remove(objectKey: string, uploadId: string | null, signal?: AbortSignal): Promise<void>;
  presignDownload(objectKey: string, fileName: string): Promise<string>;
  verifySize(objectKey: string, expectedBytes: number): Promise<void>;
  verifyObject(
    objectKey: string,
    expectedBytes: number,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void>;
  listMultipartUploads(
    prefix: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<{ objectKey: string; uploadId: string; initiatedAt: Date }>>;
  abortMultipart(objectKey: string, uploadId: string, signal?: AbortSignal): Promise<void>;
}

export { verificationDeadlineMilliseconds } from './diagnostic-maintenance.js';

export interface AbuseIdentity {
  installPseudonym: string;
  networkPseudonym: string;
}

export interface UploadGrant {
  id: string;
  authorizationToken: string;
  status: string;
  expiresAt: string;
  upload: { kind: 'multipart'; uploadId: string; partSizeBytes: number; partCount: number };
}

export interface UploadStatusView {
  id: string;
  status: DiagnosticUploadRecord['status'];
  expiresAt: string;
}

export type DiagnosticModerationAction = 'delete';

export interface UploadAuthorizer {
  issue(id: string, objectKey: string, expiresAt: Date): string;
  verify(token: string, id: string, objectKey: string, now: Date): boolean;
}

export class DiagnosticService {
  private readonly maintenance: DiagnosticMaintenanceService;

  public constructor(
    private readonly repository: DiagnosticRepository,
    private readonly storage: UploadStorage,
    private readonly clock: Clock,
    private readonly prefix: string,
    private readonly authorizer: UploadAuthorizer | null,
    private readonly verificationDeadline: (
      expectedBytes: number,
    ) => number = verificationDeadlineMilliseconds,
  ) {
    this.maintenance = new DiagnosticMaintenanceService(
      repository,
      storage,
      clock,
      verificationDeadline,
    );
  }

  public async create(identity: AbuseIdentity, input: unknown): Promise<UploadGrant> {
    const request: PersistedUploadRequest = persistedUploadRequestSchema.parse(input);
    const now = this.clock.now();
    const decision = decideUpload(request, now);
    const id = randomUUID();
    const objectKey = this.objectKey(id, now);
    const record: DiagnosticUploadRecord = {
      id,
      objectKey,
      ...identity,
      request,
      status: 'Uploading',
      createdAt: now,
      acceptanceDeadline: null,
      expiresAt: decision.expiresAt,
      providerUploadId: null,
      multipartParts: {},
      verificationAttempts: 0,
      nextVerificationAttemptAt: null,
      deletionAttempts: 0,
      nextDeletionAttemptAt: null,
      updatedAt: now,
    };
    const reserved = await this.repository.insertWithinQuota(
      record,
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
      diagnosticQuotaLimits,
      {
        actor: { kind: 'system', userId: '0' },
        action: 'upload.created',
        details: {
          kind: request.kind,
          sizeBytes: request.sizeBytes,
        },
        createdAt: now,
      },
    );
    if (!reserved) {
      throw new Error('Diagnostic upload quota was exceeded.');
    }

    let providerUploadId: string | null = null;
    try {
      providerUploadId = await this.storage.beginMultipart(objectKey, 'application/zip');
      if (!(await this.repository.setProviderUploadId(id, providerUploadId))) {
        throw new Error('Diagnostic upload lifecycle changed during creation.');
      }
    } catch (error) {
      if (providerUploadId) {
        try {
          await this.storage.abortMultipart(objectKey, providerUploadId);
        } catch {
          await this.repository
            .appendAudit(id, {
              actor: { kind: 'system', userId: '0' },
              action: 'multipart.compensation-failed',
              details: { reason: 'provider-abort-failed' },
              createdAt: this.clock.now(),
            })
            .catch(() => undefined);
        }
      }
      await this.repository.transition(id, ['Uploading'], 'Failed');
      throw error;
    }
    const authorizationToken = this.requireAuthorizer().issue(
      id,
      objectKey,
      new Date(now.getTime() + 12 * 60 * 60 * 1000),
    );

    return {
      id,
      authorizationToken,
      status: 'Uploading',
      expiresAt: decision.expiresAt.toISOString(),
      upload: {
        kind: 'multipart',
        uploadId: providerUploadId,
        partSizeBytes: decision.partSizeBytes,
        partCount: decision.partCount,
      },
    };
  }

  public async partUrl(
    id: string,
    partNumber: number,
    grantInput: unknown,
    token: string,
  ): Promise<string> {
    const record = await this.requireUploading(id);
    this.authorize(record, token);
    const decision = decideUpload(record.request, record.createdAt);
    if (
      !decision.partSizeBytes ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > decision.partCount
    ) {
      throw new Error('Multipart part number is outside the declared archive.');
    }
    if (!record.providerUploadId) throw new Error('Upload is not multipart.');
    const grant = multipartPartGrantSchema.parse(grantInput);
    const precedingBytes = (partNumber - 1) * decision.partSizeBytes;
    const expectedBytes = Math.min(
      decision.partSizeBytes,
      record.request.sizeBytes - precedingBytes,
    );
    if (grant.sizeBytes !== expectedBytes) {
      throw new Error('Multipart part length did not match the declared archive.');
    }
    if (!(await this.repository.registerPartGrant(id, partNumber, grant))) {
      throw new Error('Multipart part grant conflicted with the upload lifecycle.');
    }
    return this.storage.presignPart(record.objectKey, record.providerUploadId, partNumber, grant);
  }

  public async complete(
    id: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>,
    token: string,
  ): Promise<'Verifying'> {
    const record = await this.requireUploading(id);
    this.authorize(record, token);
    if (!(await this.repository.transition(id, ['Uploading'], 'Completing'))) {
      throw new Error('Diagnostic upload completion conflicted with another request.');
    }
    try {
      if (!record.providerUploadId) throw new Error('Multipart upload ID was unavailable.');
      const completedParts = validateParts(parts, record);
      await this.storage.completeMultipart(
        record.objectKey,
        record.providerUploadId,
        completedParts,
      );
      await this.storage.verifySize(record.objectKey, record.request.sizeBytes);
      if (
        !(await this.repository.transition(id, ['Completing'], 'Verifying', {
          providerUploadId: null,
          audit: {
            actor: { kind: 'system', userId: '0' },
            action: 'upload.completed',
            details: { multipart: record.providerUploadId !== null, parts: parts.length },
            createdAt: this.clock.now(),
          },
        }))
      ) {
        throw new Error('Diagnostic upload finalization conflicted with another request.');
      }
      return 'Verifying';
    } catch (error) {
      await this.repository.transition(id, ['Completing'], 'Failed');
      throw error;
    }
  }

  public async moderate(
    id: string,
    actor: Actor,
    action: DiagnosticModerationAction,
  ): Promise<void> {
    const record = await this.repository.find(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    if (action !== 'delete') throw new Error('Diagnostic moderation action is unsupported.');
    await this.maintenance.requestDeletionByAdministrator(record, actor);
  }

  public async list(limit = 100): Promise<DiagnosticUploadRecord[]> {
    return this.repository.list(Math.min(Math.max(limit, 1), 250));
  }

  public async status(id: string, token: string): Promise<UploadStatusView> {
    const record = await this.repository.find(id);
    if (!record) throw new Error('Diagnostic upload was not found.');
    this.authorize(record, token);
    return {
      id: record.id,
      status: record.status,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  public async audit(uploadId: string | null, limit = 100): Promise<DiagnosticAuditRecord[]> {
    return this.repository.listAudit(uploadId, Math.min(Math.max(limit, 1), 250));
  }

  public async downloadUrl(id: string, actor: Actor): Promise<string> {
    const record = await this.repository.find(id);
    if (!record || record.status !== 'Accepted' || record.expiresAt <= this.clock.now()) {
      throw new Error('Diagnostic upload is not accepted.');
    }
    const url = await this.storage.presignDownload(record.objectKey, record.request.fileName);
    await this.repository.appendAudit(id, {
      actor,
      action: 'download.requested',
      details: {},
      createdAt: this.clock.now(),
    });
    return url;
  }

  public async cleanup(limit = 100, signal?: AbortSignal): Promise<number> {
    return this.maintenance.cleanup(limit, signal);
  }

  public async verifyPending(limit = 4, signal?: AbortSignal): Promise<number> {
    return this.maintenance.verifyPending(limit, signal);
  }

  public async reconcileMultipartOrphans(limit = 100, signal?: AbortSignal): Promise<number> {
    return this.maintenance.reconcileMultipartOrphans(this.prefix, limit, signal);
  }

  private async requireUploading(id: string): Promise<DiagnosticUploadRecord> {
    const record = await this.repository.find(id);
    if (
      !record ||
      record.status !== 'Uploading' ||
      record.createdAt.getTime() + 12 * 60 * 60 * 1000 <= this.clock.now().getTime()
    )
      throw new Error('Diagnostic upload is not active.');
    return record;
  }

  private objectKey(id: string, now: Date): string {
    return `${this.prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.zip`;
  }

  private authorize(record: DiagnosticUploadRecord, token: string): void {
    if (!this.requireAuthorizer().verify(token, record.id, record.objectKey, this.clock.now())) {
      throw new Error('Diagnostic upload authorization failed.');
    }
  }

  private requireAuthorizer(): UploadAuthorizer {
    if (!this.authorizer) {
      throw new Error('Diagnostic upload authorization is unavailable in this process.');
    }
    return this.authorizer;
  }
}

export function checksumHeaderValue(sha256: string): string {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Diagnostic SHA-256 was invalid.');
  return Buffer.from(sha256, 'hex').toString('base64');
}

function validateParts(
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  record: DiagnosticUploadRecord,
): ReadonlyArray<{ partNumber: number; etag: string; checksumSha256: string }> {
  const decision = decideUpload(record.request, record.createdAt);
  const expected = decision.partCount;
  if (parts.length !== expected)
    throw new Error('Multipart completion did not include every declared part.');
  const numbers = parts.map((part) => part.partNumber).sort((left, right) => left - right);
  if (numbers.some((part, index) => part !== index + 1))
    throw new Error('Multipart parts are incomplete or duplicated.');
  if (parts.some((part) => !/^\"?[a-f0-9-]{16,80}\"?$/i.test(part.etag)))
    throw new Error('Multipart ETag was malformed.');
  return parts.map((part) => {
    const grant = record.multipartParts[part.partNumber];
    if (!grant) throw new Error('Multipart completion used a part without a bound grant.');
    return { ...part, checksumSha256: grant.sha256 };
  });
}
