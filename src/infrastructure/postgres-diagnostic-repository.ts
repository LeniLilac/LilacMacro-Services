import type { Pool } from 'pg';
import {
  multipartPartGrantSchema,
  uploadStatusSchema,
  type MultipartPartGrant,
  type UploadStatus,
} from '../contracts/diagnostics.js';
import type {
  Actor,
  DiagnosticAuditEvent,
  DiagnosticAuditRecord,
  DiagnosticQuotaLimits,
  DiagnosticRepository,
  DiagnosticUploadRecord,
} from '../domain/ports.js';
import { selectCapacityEvictions } from '../domain/diagnostic-capacity.js';
import { insertDiagnosticAudit, mapDiagnostic } from './postgres-diagnostic-mappers.js';

export class PostgresDiagnosticRepository implements DiagnosticRepository {
  public constructor(private readonly pool: Pool) {}

  public async insertWithinQuota(
    record: DiagnosticUploadRecord,
    since: Date,
    limits: DiagnosticQuotaLimits,
    audit: DiagnosticAuditEvent,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0)),
                pg_advisory_xact_lock(hashtextextended($2, 1)),
                pg_advisory_xact_lock(hashtextextended('diagnostics:global', 2))`,
        [`install:${record.installPseudonym}`, `network:${record.networkPseudonym}`],
      );
      const usage = await client.query<{
        install_count: string;
        network_count: string;
        install_active: string;
        network_active: string;
        install_bytes: string;
        network_bytes: string;
        global_count: string;
        global_active: string;
        global_bytes: string;
      }>(
        `SELECT
          count(*) FILTER (WHERE install_pseudonym = $1) AS install_count,
          count(*) FILTER (WHERE network_pseudonym = $2) AS network_count,
            count(*) FILTER (WHERE install_pseudonym = $1 AND
              (status IN ('Uploading','Completing','Verifying','VerifyingActive','Deleting') OR
               (status = 'Pending' AND acceptance_deadline IS NOT NULL))) AS install_active,
            count(*) FILTER (WHERE network_pseudonym = $2 AND
              (status IN ('Uploading','Completing','Verifying','VerifyingActive','Deleting') OR
               (status = 'Pending' AND acceptance_deadline IS NOT NULL))) AS network_active,
          COALESCE(sum((request->>'sizeBytes')::bigint) FILTER (WHERE install_pseudonym = $1), 0) AS install_bytes,
          COALESCE(sum((request->>'sizeBytes')::bigint) FILTER (WHERE network_pseudonym = $2), 0) AS network_bytes,
          count(*) AS global_count,
          count(*) FILTER (WHERE status IN ('Uploading','Completing','Verifying','VerifyingActive','Deleting') OR
            (status = 'Pending' AND acceptance_deadline IS NOT NULL)) AS global_active,
          COALESCE(sum((request->>'sizeBytes')::bigint), 0) AS global_bytes
         FROM diagnostic_uploads WHERE created_at >= $3`,
        [record.installPseudonym, record.networkPseudonym, since],
      );
      const row = usage.rows[0]!;
      if (
        Number(row.install_count) >= limits.installDailyUploads ||
        Number(row.network_count) >= limits.networkDailyUploads ||
        Number(row.install_active) >= limits.installActiveUploads ||
        Number(row.network_active) >= limits.networkActiveUploads ||
        Number(row.global_count) >= limits.globalDailyUploads ||
        Number(row.global_active) >= limits.globalActiveUploads ||
        Number(row.install_bytes) + record.request.sizeBytes > limits.installDailyBytes ||
        Number(row.network_bytes) + record.request.sizeBytes > limits.networkDailyBytes ||
        Number(row.global_bytes) + record.request.sizeBytes > limits.globalDailyBytes
      ) {
        await client.query('ROLLBACK');
        return false;
      }

      const retained = await client.query<{
        id: string;
        install_pseudonym: string;
        size_bytes: string;
        created_at: Date;
        status: UploadStatus;
      }>(
        `SELECT id, install_pseudonym, (request->>'sizeBytes')::bigint AS size_bytes,
                created_at, status
           FROM diagnostic_uploads
          WHERE status NOT IN ('Deleted','Rejected','Invalid')
            AND NOT capacity_released
          ORDER BY created_at, id
          FOR UPDATE`,
      );
      const evictionIds = selectCapacityEvictions(
        retained.rows.map((item) => ({
          id: item.id,
          installPseudonym: item.install_pseudonym,
          sizeBytes: Number(item.size_bytes),
          createdAt: new Date(item.created_at),
          evictable: ['Pending', 'Accepted', 'Failed', 'Expired'].includes(item.status),
        })),
        record.request.sizeBytes,
        limits.globalRetainedBytes,
      );
      if (evictionIds === null) {
        await client.query('ROLLBACK');
        return false;
      }
      if (evictionIds.length > 0) {
        const evicted = await client.query<{ id: string }>(
          `UPDATE diagnostic_uploads
              SET status = 'Expired', capacity_released = true, updated_at = $2
            WHERE id = ANY($1::uuid[])
              AND status IN ('Pending','Accepted','Failed','Expired')
              AND NOT capacity_released
          RETURNING id`,
          [evictionIds, record.createdAt],
        );
        if (evicted.rowCount !== evictionIds.length) {
          throw new Error('Diagnostic capacity eviction conflicted with another lifecycle owner.');
        }
        for (const victim of evicted.rows) {
          await insertDiagnosticAudit(client, victim.id, {
            actor: { kind: 'system', userId: '0' },
            action: 'retention.evicted',
            details: {
              reason: 'global-storage-capacity',
              incomingSizeBytes: record.request.sizeBytes,
            },
            createdAt: record.createdAt,
          });
        }
      }
      await client.query(
        `INSERT INTO diagnostic_uploads
         (id, object_key, install_pseudonym, network_pseudonym, request, status, provider_upload_id,
          created_at, acceptance_deadline, expires_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
        [
          record.id,
          record.objectKey,
          record.installPseudonym,
          record.networkPseudonym,
          JSON.stringify(record.request),
          record.status,
          record.providerUploadId,
          record.createdAt,
          record.acceptanceDeadline,
          record.expiresAt,
        ],
      );
      await insertDiagnosticAudit(client, record.id, audit);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async find(id: string): Promise<DiagnosticUploadRecord | null> {
    const result = await this.pool.query('SELECT * FROM diagnostic_uploads WHERE id = $1', [id]);
    return result.rowCount ? mapDiagnostic(result.rows[0]) : null;
  }

  public async list(
    limit: number,
    installPseudonyms: readonly string[] = [],
  ): Promise<DiagnosticUploadRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM diagnostic_uploads
       WHERE cardinality($2::text[]) = 0 OR install_pseudonym = ANY($2::text[])
       ORDER BY created_at DESC LIMIT $1`,
      [limit, installPseudonyms],
    );
    return result.rows.map(mapDiagnostic);
  }

  public async setProviderUploadId(id: string, providerUploadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE diagnostic_uploads SET provider_upload_id = $2, updated_at = now()
       WHERE id = $1 AND status = 'Uploading'`,
      [id, providerUploadId],
    );
    return result.rowCount === 1;
  }

  public async registerPartGrant(
    id: string,
    partNumber: number,
    grantInput: MultipartPartGrant,
  ): Promise<boolean> {
    const grant = multipartPartGrantSchema.parse(grantInput);
    const result = await this.pool.query(
      `UPDATE diagnostic_uploads
       SET multipart_parts = jsonb_set(multipart_parts, ARRAY[$2::text], $3::jsonb, true),
           updated_at = now()
       WHERE id = $1 AND status = 'Uploading'
         AND (NOT multipart_parts ? $2::text OR multipart_parts -> $2::text = $3::jsonb)`,
      [id, partNumber, JSON.stringify(grant)],
    );
    return result.rowCount === 1;
  }

  public async transition(
    id: string,
    expectedStatuses: readonly UploadStatus[],
    statusInput: UploadStatus,
    options: {
      expiresAt?: Date;
      acceptanceDeadline?: Date | null;
      acceptanceDeadlineAfter?: Date;
      providerUploadId?: string | null;
      audit?: DiagnosticAuditEvent;
    } = {},
  ): Promise<boolean> {
    const status = uploadStatusSchema.parse(statusInput);
    const expected = expectedStatuses.map((item) => uploadStatusSchema.parse(item));
    if (expected.length === 0) throw new Error('Diagnostic transition requires a source state.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE diagnostic_uploads SET status = $2, expires_at = COALESCE($3, expires_at),
         acceptance_deadline = CASE WHEN $4::boolean THEN $5 ELSE acceptance_deadline END,
         provider_upload_id = CASE WHEN $6::boolean THEN $7 ELSE provider_upload_id END,
         updated_at = now()
         WHERE id = $1 AND status = ANY($8::text[])
           AND (NOT $9::boolean OR acceptance_deadline > $10)`,
        [
          id,
          status,
          options.expiresAt ?? null,
          options.acceptanceDeadline !== undefined,
          options.acceptanceDeadline ?? null,
          options.providerUploadId !== undefined,
          options.providerUploadId ?? null,
          expected,
          options.acceptanceDeadlineAfter !== undefined,
          options.acceptanceDeadlineAfter ?? null,
        ],
      );
      if (result.rowCount === 1 && options.audit) {
        await insertDiagnosticAudit(client, id, options.audit);
      }
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async appendAudit(id: string, event: DiagnosticAuditEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await insertDiagnosticAudit(client, id, event);
    } finally {
      client.release();
    }
  }

  public async listAudit(uploadId: string | null, limit: number): Promise<DiagnosticAuditRecord[]> {
    const result = await this.pool.query(
      `SELECT id, upload_id, actor_kind, actor_id, action, details, created_at
       FROM diagnostic_audit WHERE ($1::uuid IS NULL OR upload_id = $1)
       ORDER BY id DESC LIMIT $2`,
      [uploadId, limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      uploadId: String(row.upload_id),
      actor: { kind: row.actor_kind as Actor['kind'], userId: String(row.actor_id) },
      action: row.action as DiagnosticAuditEvent['action'],
      details: row.details as DiagnosticAuditRecord['details'],
      createdAt: new Date(String(row.created_at)),
    }));
  }

  public async scheduleDeletionRetry(
    id: string,
    nextAttemptAt: Date,
    audit: DiagnosticAuditEvent,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE diagnostic_uploads
         SET status = 'Failed', deletion_attempts = deletion_attempts + 1,
             next_deletion_attempt_at = $2, capacity_released = false, updated_at = now()
         WHERE id = $1 AND status = 'Deleting'`,
        [id, nextAttemptAt],
      );
      if (result.rowCount === 1) await insertDiagnosticAudit(client, id, audit);
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimVerification(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<DiagnosticUploadRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH claimed AS (
           SELECT id FROM diagnostic_uploads
           WHERE (status = 'Verifying' AND
                    (next_verification_attempt_at IS NULL OR next_verification_attempt_at <= $1))
              OR (status = 'VerifyingActive' AND updated_at <= $2)
           ORDER BY updated_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $3
         )
         UPDATE diagnostic_uploads AS uploads
         SET status = 'VerifyingActive', updated_at = $1
         FROM claimed WHERE uploads.id = claimed.id
         RETURNING uploads.*`,
        [now, staleBefore, limit],
      );
      await client.query('COMMIT');
      return result.rows.map(mapDiagnostic);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async scheduleVerificationRetry(id: string, nextAttemptAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE diagnostic_uploads
       SET status = 'Verifying', verification_attempts = verification_attempts + 1,
           next_verification_attempt_at = $2, updated_at = now()
       WHERE id = $1 AND status = 'VerifyingActive'`,
      [id, nextAttemptAt],
    );
    return result.rowCount === 1;
  }

  public async claimExpired(now: Date, limit: number): Promise<DiagnosticUploadRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH claimed AS (
           SELECT id FROM diagnostic_uploads
           WHERE status NOT IN ('Deleted','Rejected')
             AND ((status = 'Deleting' AND updated_at <= $1::timestamptz - interval '15 minutes')
                  OR (status = 'Accepted' AND expires_at <= $1)
                  OR (status = 'Pending' AND
                      (expires_at <= $1 OR acceptance_deadline <= $1))
                  OR (status = 'Uploading' AND created_at <= $1 - interval '12 hours')
                  OR (status = 'Completing' AND updated_at <= $1 - interval '12 hours')
                  OR (status IN ('Verifying','VerifyingActive') AND
                      (COALESCE(acceptance_deadline, created_at + interval '24 hours') <= $1 OR
                       verification_attempts >= 8))
                  OR status = 'Expired'
                  OR (status = 'Failed' AND
                      (next_deletion_attempt_at IS NULL OR next_deletion_attempt_at <= $1)))
           ORDER BY capacity_released DESC, expires_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE diagnostic_uploads AS uploads
         SET status = 'Deleting', updated_at = $1
         FROM claimed WHERE uploads.id = claimed.id
         RETURNING uploads.*`,
        [now, limit],
      );
      await client.query('COMMIT');
      return result.rows.map(mapDiagnostic);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listProviderUploadIds(): Promise<readonly string[]> {
    const result = await this.pool.query<{ provider_upload_id: string }>(
      `SELECT provider_upload_id FROM diagnostic_uploads
       WHERE provider_upload_id IS NOT NULL
         AND status NOT IN ('Deleted','Rejected','Expired','Invalid')`,
    );
    return result.rows.map((row) => row.provider_upload_id);
  }
}
