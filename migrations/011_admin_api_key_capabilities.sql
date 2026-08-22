ALTER TABLE admin_api_keys
  DROP CONSTRAINT admin_api_keys_scopes_check,
  ADD CONSTRAINT admin_api_keys_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 8
    AND scopes <@ ARRAY[
      'control:read',
      'control:write',
      'diagnostics:read',
      'diagnostics:download',
      'diagnostics:delete',
      'telemetry:read',
      'audit:read',
      'keys:manage'
    ]::text[]
  ),
  DROP CONSTRAINT admin_api_keys_created_by_check,
  ADD CONSTRAINT admin_api_keys_created_by_check CHECK (
    created_by ~ '^([0-9]{1,32}|api-key:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  ),
  DROP CONSTRAINT admin_api_keys_revoked_by_check,
  ADD CONSTRAINT admin_api_keys_revoked_by_check CHECK (
    revoked_by IS NULL OR revoked_by ~ '^([0-9]{1,32}|api-key:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  );

ALTER TABLE admin_api_key_audit
  DROP CONSTRAINT admin_api_key_audit_actor_id_check,
  ADD CONSTRAINT admin_api_key_audit_actor_id_check CHECK (
    actor_id ~ '^([0-9]{1,32}|api-key:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  );

ALTER TABLE control_commands
  DROP CONSTRAINT control_commands_actor_kind_check,
  ADD CONSTRAINT control_commands_actor_kind_check CHECK (
    actor_kind IN ('discord', 'web', 'api-key', 'system')
  ),
  DROP CONSTRAINT control_commands_actor_id_check,
  ADD CONSTRAINT control_commands_actor_id_check CHECK (
    (actor_kind IN ('discord', 'web') AND actor_id ~ '^[0-9]+$')
    OR (actor_kind = 'api-key' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (actor_kind = 'system' AND actor_id = '0')
  );

ALTER TABLE diagnostic_audit
  DROP CONSTRAINT diagnostic_audit_actor_kind_check,
  ADD CONSTRAINT diagnostic_audit_actor_kind_check CHECK (
    actor_kind IN ('discord', 'web', 'api-key', 'system')
  ),
  DROP CONSTRAINT diagnostic_audit_actor_id_check,
  ADD CONSTRAINT diagnostic_audit_actor_id_check CHECK (
    (actor_kind IN ('discord', 'web') AND actor_id ~ '^[0-9]+$')
    OR (actor_kind = 'api-key' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (actor_kind = 'system' AND actor_id = '0')
  );
