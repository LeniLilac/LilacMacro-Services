CREATE TABLE control_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision >= 0),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO control_state (singleton, revision, state)
VALUES (true, 0, '{"revision":0,"game":{"operatorAvailable":true,"observedPublic":null,"observedAt":null,"message":null},"codes":[],"schedules":[],"disablements":[],"release":null}');

CREATE TABLE control_commands (
  command_id uuid PRIMARY KEY,
  actor_kind text NOT NULL CHECK (actor_kind IN ('discord', 'web', 'system')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[0-9]+$'),
  command jsonb NOT NULL,
  result_snapshot jsonb NOT NULL,
  resulting_revision bigint NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  previous_hash text CHECK (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$'),
  entry_hash text NOT NULL UNIQUE CHECK (entry_hash ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION reject_control_command_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'control command audit records are append-only';
END;
$$;

CREATE TRIGGER control_commands_no_update
BEFORE UPDATE OR DELETE ON control_commands
FOR EACH ROW EXECUTE FUNCTION reject_control_command_mutation();

CREATE TABLE published_snapshots (
  revision bigint PRIMARY KEY,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_attempts (
  state_hash text PRIMARY KEY,
  verifier_ciphertext text NOT NULL,
  browser_binding_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX oauth_attempts_expiry_idx ON oauth_attempts (expires_at);
CREATE INDEX oauth_attempts_consumed_idx ON oauth_attempts (consumed_at) WHERE consumed_at IS NOT NULL;

CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL CHECK (user_id ~ '^[0-9]+$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);
CREATE INDEX admin_sessions_revoked_idx ON admin_sessions (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE diagnostic_uploads (
  id uuid PRIMARY KEY,
  object_key text NOT NULL UNIQUE CHECK (object_key !~ '\\.\\.'),
  install_pseudonym text NOT NULL,
  network_pseudonym text NOT NULL,
  request jsonb NOT NULL CHECK (NOT (request ? 'installId')),
  status text NOT NULL CHECK (status IN ('Uploading','Completing','Verifying','VerifyingActive','Pending','Accepted','Deleting','Rejected','Expired','Deleted','Invalid','Failed')),
  provider_upload_id text,
  multipart_parts jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  next_verification_attempt_at timestamptz,
  deletion_attempts integer NOT NULL DEFAULT 0 CHECK (deletion_attempts >= 0),
  next_deletion_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  acceptance_deadline timestamptz,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX diagnostic_expiry_idx ON diagnostic_uploads (expires_at) WHERE status NOT IN ('Deleted', 'Rejected');
CREATE INDEX diagnostic_abuse_idx ON diagnostic_uploads (install_pseudonym, network_pseudonym, created_at DESC);

CREATE TABLE diagnostic_audit (
  id bigserial PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES diagnostic_uploads(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('discord', 'web', 'system')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[0-9]+$'),
  action text NOT NULL CHECK (action IN ('upload.created','upload.completed','verification.succeeded','verification.failed','moderation.accept','moderation.reject','download.requested','deletion.claimed','deletion.succeeded','deletion.retry-scheduled','multipart.compensation-failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE TRIGGER diagnostic_audit_no_update
BEFORE UPDATE OR DELETE ON diagnostic_audit
FOR EACH ROW EXECUTE FUNCTION reject_control_command_mutation();
