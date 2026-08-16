CREATE TABLE admin_api_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 64),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[A-Za-z0-9_-]{43}$'),
  display_prefix text NOT NULL CHECK (display_prefix ~ '^lmk_…[A-Za-z0-9_-]{6}$'),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 4
    AND scopes <@ ARRAY['control:read','diagnostics:read','telemetry:read','audit:read']::text[]
  ),
  created_by text NOT NULL CHECK (created_by ~ '^[0-9]{1,32}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by ~ '^[0-9]{1,32}$'),
  last_used_at timestamptz,
  use_count bigint NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);

CREATE INDEX admin_api_keys_active_idx ON admin_api_keys(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE admin_api_key_audit (
  id bigserial PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES admin_api_keys(id),
  actor_id text NOT NULL CHECK (actor_id ~ '^[0-9]{1,32}$'),
  action text NOT NULL CHECK (action IN ('key.created','key.revoked')),
  created_at timestamptz NOT NULL
);

CREATE TRIGGER admin_api_key_audit_immutable
BEFORE UPDATE OR DELETE ON admin_api_key_audit
FOR EACH STATEMENT EXECUTE FUNCTION reject_control_command_mutation();

GRANT SELECT, INSERT, UPDATE ON admin_api_keys TO lilacmacro_api;
GRANT SELECT, INSERT ON admin_api_key_audit TO lilacmacro_api;
GRANT USAGE, SELECT ON SEQUENCE admin_api_key_audit_id_seq TO lilacmacro_api;
