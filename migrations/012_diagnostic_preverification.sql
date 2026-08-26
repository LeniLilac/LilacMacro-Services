CREATE TABLE diagnostic_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  preverify_new_uploads boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_kind text NOT NULL DEFAULT 'system'
    CHECK (updated_by_kind IN ('web', 'system')),
  updated_by_id text NOT NULL DEFAULT '0'
    CHECK (
      (updated_by_kind = 'web' AND updated_by_id ~ '^[0-9]+$')
      OR (updated_by_kind = 'system' AND updated_by_id = '0')
    )
);

CREATE TABLE diagnostic_settings_audit (
  id bigserial PRIMARY KEY,
  preverify_new_uploads boolean NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind = 'web'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[0-9]+$'),
  created_at timestamptz NOT NULL
);

INSERT INTO diagnostic_settings (singleton) VALUES (true);

CREATE FUNCTION diagnostic_preverification_set(
  requested_enabled boolean,
  requested_actor_id text,
  requested_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_count integer;
BEGIN
  IF requested_actor_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Invalid diagnostic settings actor.';
  END IF;

  UPDATE public.diagnostic_settings
     SET preverify_new_uploads = requested_enabled,
         updated_at = requested_at,
         updated_by_kind = 'web',
         updated_by_id = requested_actor_id
   WHERE singleton = true
     AND preverify_new_uploads <> requested_enabled;
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  IF changed_count = 1 THEN
    INSERT INTO public.diagnostic_settings_audit
      (preverify_new_uploads, actor_kind, actor_id, created_at)
    VALUES (requested_enabled, 'web', requested_actor_id, requested_at);
  END IF;

  RETURN changed_count = 1;
END;
$$;

REVOKE ALL ON diagnostic_settings, diagnostic_settings_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE diagnostic_settings_audit_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION diagnostic_preverification_set(boolean, text, timestamptz) FROM PUBLIC;
GRANT SELECT ON diagnostic_settings TO lilacmacro_api;
GRANT SELECT ON diagnostic_settings TO lilacmacro_worker;
GRANT EXECUTE ON FUNCTION diagnostic_preverification_set(boolean, text, timestamptz)
  TO lilacmacro_api;
