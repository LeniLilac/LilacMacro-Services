import type { PoolClient } from 'pg';
import {
  multipartPartGrantSchema,
  persistedUploadRequestSchema,
  uploadStatusSchema,
  type MultipartPartGrant,
} from '../contracts/diagnostics.js';
import type { DiagnosticAuditEvent, DiagnosticUploadRecord } from '../domain/ports.js';

export function mapDiagnostic(row: Record<string, unknown>): DiagnosticUploadRecord {
  return {
    id: String(row.id),
    objectKey: String(row.object_key),
    installPseudonym: String(row.install_pseudonym),
    networkPseudonym: String(row.network_pseudonym),
    request: persistedUploadRequestSchema.parse(row.request),
    status: uploadStatusSchema.parse(row.status),
    createdAt: new Date(String(row.created_at)),
    acceptanceDeadline: row.acceptance_deadline ? new Date(String(row.acceptance_deadline)) : null,
    expiresAt: new Date(String(row.expires_at)),
    providerUploadId: row.provider_upload_id ? String(row.provider_upload_id) : null,
    multipartParts: parseMultipartParts(row.multipart_parts),
    verificationAttempts: Number(row.verification_attempts ?? 0),
    nextVerificationAttemptAt: row.next_verification_attempt_at
      ? new Date(String(row.next_verification_attempt_at))
      : null,
    deletionAttempts: Number(row.deletion_attempts ?? 0),
    nextDeletionAttemptAt: row.next_deletion_attempt_at
      ? new Date(String(row.next_deletion_attempt_at))
      : null,
    updatedAt: new Date(String(row.updated_at)),
  };
}

export async function insertDiagnosticAudit(
  client: PoolClient,
  uploadId: string,
  event: DiagnosticAuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO diagnostic_audit
     (upload_id, actor_kind, actor_id, action, details, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      uploadId,
      event.actor.kind,
      event.actor.userId,
      event.action,
      JSON.stringify(event.details),
      event.createdAt,
    ],
  );
}

function parseMultipartParts(value: unknown): Readonly<Record<number, MultipartPartGrant>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<number, MultipartPartGrant> = {};
  for (const [key, grant] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) throw new Error('Stored multipart part number was invalid.');
    result[Number(key)] = multipartPartGrantSchema.parse(grant);
  }
  return result;
}
