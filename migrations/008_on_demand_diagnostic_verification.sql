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
    'deletion.claimed',
    'deletion.succeeded',
    'deletion.retry-scheduled',
    'multipart.compensation-failed'
  ));
