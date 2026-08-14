REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_control_command_mutation() FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO lilacmacro_api, lilacmacro_control, lilacmacro_worker',
    current_database()
  );
END;
$$;
GRANT USAGE ON SCHEMA public TO lilacmacro_api, lilacmacro_control, lilacmacro_worker;

GRANT SELECT ON control_state, control_commands, published_snapshots TO lilacmacro_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_attempts, admin_sessions TO lilacmacro_api;
GRANT SELECT, INSERT, UPDATE ON diagnostic_uploads TO lilacmacro_api;
GRANT SELECT, INSERT ON diagnostic_audit TO lilacmacro_api;
GRANT USAGE, SELECT ON SEQUENCE diagnostic_audit_id_seq TO lilacmacro_api;

GRANT SELECT, UPDATE ON control_state TO lilacmacro_control;
GRANT SELECT, INSERT ON control_commands TO lilacmacro_control;
GRANT SELECT, INSERT, UPDATE ON published_snapshots TO lilacmacro_control;

GRANT SELECT, UPDATE ON diagnostic_uploads TO lilacmacro_worker;
GRANT SELECT, INSERT ON diagnostic_audit TO lilacmacro_worker;
GRANT USAGE, SELECT ON SEQUENCE diagnostic_audit_id_seq TO lilacmacro_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
