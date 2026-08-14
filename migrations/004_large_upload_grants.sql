CREATE TABLE diagnostic_large_upload_grants (
  id uuid PRIMARY KEY,
  upload_id uuid NOT NULL UNIQUE,
  object_key text NOT NULL UNIQUE CHECK (object_key !~ '\\.\\.'),
  install_pseudonym text NOT NULL,
  key_epoch text NOT NULL CHECK (key_epoch ~ '^[0-9]{4}-[0-9]{2}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  kind text NOT NULL CHECK (kind IN ('deep-debug','runtime-log','installer-log','live-debug')),
  issuer_kind text NOT NULL CHECK (issuer_kind IN ('discord','web')),
  issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9]+$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE diagnostic_large_upload_grant_audit (
  id bigserial PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES diagnostic_large_upload_grants(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('discord','web','system')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[0-9]+$'),
  action text NOT NULL CHECK (action IN ('grant.issued','grant.consumed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE TRIGGER diagnostic_large_upload_grant_audit_no_update
BEFORE UPDATE OR DELETE ON diagnostic_large_upload_grant_audit
FOR EACH ROW EXECUTE FUNCTION reject_control_command_mutation();

GRANT SELECT, INSERT ON diagnostic_large_upload_grants TO lilacmacro_api;
GRANT UPDATE (consumed_at) ON diagnostic_large_upload_grants TO lilacmacro_api;
GRANT SELECT, INSERT ON diagnostic_large_upload_grant_audit TO lilacmacro_api;
GRANT USAGE, SELECT ON SEQUENCE diagnostic_large_upload_grant_audit_id_seq TO lilacmacro_api;
