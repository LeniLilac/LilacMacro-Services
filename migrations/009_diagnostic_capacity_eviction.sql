ALTER TABLE diagnostic_uploads
  ADD COLUMN capacity_released boolean NOT NULL DEFAULT false;

CREATE INDEX diagnostic_retained_capacity_idx
  ON diagnostic_uploads (install_pseudonym, created_at, id)
  WHERE status NOT IN ('Deleted', 'Rejected', 'Invalid') AND NOT capacity_released;

ALTER TABLE diagnostic_audit
  DROP CONSTRAINT diagnostic_audit_action_check;

ALTER TABLE diagnostic_audit
  ADD CONSTRAINT diagnostic_audit_action_check
  CHECK (action IN (
    'upload.created',
    'upload.completed',
    'verification.requested',
    'verification.succeeded',
    'verification.failed',
    'moderation.accept',
    'moderation.reject',
    'moderation.delete',
    'download.requested',
    'retention.evicted',
    'deletion.claimed',
    'deletion.succeeded',
    'deletion.retry-scheduled',
    'multipart.compensation-failed'
  ));
