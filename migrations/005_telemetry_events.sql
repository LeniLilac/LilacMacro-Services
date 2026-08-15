CREATE TABLE telemetry_events (
  id bigserial PRIMARY KEY,
  install_pseudonym text NOT NULL CHECK (length(install_pseudonym) BETWEEN 40 AND 64),
  app_version text NOT NULL CHECK (app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  privacy_notice_version integer NOT NULL CHECK (privacy_notice_version = 1),
  kind text NOT NULL CHECK (kind IN (
    'session-started','feature-used','operation-error','expedition-reward-observed','ocr-timing'
  )),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  feature text CHECK (feature ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$'),
  outcome text CHECK (outcome ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$'),
  duration_milliseconds integer CHECK (duration_milliseconds BETWEEN 0 AND 600000),
  material text CHECK (material ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$'),
  quantity integer CHECK (quantity BETWEEN 0 AND 1000),
  operating_system text CHECK (operating_system ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$'),
  logical_processor_count integer CHECK (logical_processor_count BETWEEN 1 AND 512),
  graphics_capability text CHECK (graphics_capability IN ('cpu','gpu','gpu:0','not-observed')),
  CHECK (occurred_at >= received_at - interval '7 days'),
  CHECK (occurred_at <= received_at + interval '10 minutes'),
  CHECK (
    (kind = 'session-started' AND feature = 'macro' AND outcome = 'started'
      AND operating_system ~ '^windows-[0-9]{1,2}\.[0-9]{1,2}$'
      AND logical_processor_count IS NOT NULL AND graphics_capability = 'not-observed'
      AND duration_milliseconds IS NULL AND material IS NULL AND quantity IS NULL)
    OR
    (kind = 'feature-used' AND feature IN ('workspace','wire','challenge','game_settings','ui_scale')
      AND outcome = 'completed' AND duration_milliseconds IS NULL AND material IS NULL
      AND quantity IS NULL AND operating_system IS NULL AND logical_processor_count IS NULL
      AND graphics_capability IS NULL)
    OR
    (kind = 'operation-error' AND feature IN ('macro','application')
      AND outcome IN ('runtime_error','unhandled_exception') AND duration_milliseconds IS NULL
      AND material IS NULL AND quantity IS NULL AND operating_system IS NULL
      AND logical_processor_count IS NULL AND graphics_capability IS NULL)
    OR
    (kind = 'expedition-reward-observed' AND feature = 'route-optimizer' AND outcome = 'observed'
      AND material IN ('FuelCell','EquipmentScrap','EquipmentReroll','EquipmentLock','ExpeditionCoin')
      AND quantity IS NOT NULL AND duration_milliseconds IS NULL AND operating_system IS NULL
      AND logical_processor_count IS NULL AND graphics_capability IS NULL)
    OR
    (kind = 'ocr-timing' AND feature = 'ocr' AND outcome = 'completed'
      AND duration_milliseconds IS NOT NULL AND graphics_capability IN ('cpu','gpu','gpu:0','not-observed')
      AND material IS NULL AND quantity IS NULL AND operating_system IS NULL
      AND logical_processor_count IS NULL)
  )
);

CREATE INDEX telemetry_events_received_at_idx ON telemetry_events(received_at);
CREATE INDEX telemetry_events_summary_idx ON telemetry_events(occurred_at, kind, feature, material);

CREATE TABLE telemetry_daily_capacity (
  capacity_day date PRIMARY KEY,
  event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 100000),
  request_bytes bigint NOT NULL CHECK (request_bytes BETWEEN 0 AND 67108864)
);

CREATE TABLE telemetry_network_daily_capacity (
  capacity_day date NOT NULL,
  network_pseudonym text NOT NULL CHECK (length(network_pseudonym) BETWEEN 40 AND 64),
  event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 2048),
  request_bytes bigint NOT NULL CHECK (request_bytes BETWEEN 0 AND 4194304),
  PRIMARY KEY (capacity_day, network_pseudonym)
);

CREATE FUNCTION telemetry_reserve_capacity(
  _network_pseudonym text,
  _event_count integer,
  _request_bytes integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reserved boolean;
BEGIN
  IF length(_network_pseudonym) NOT BETWEEN 40 AND 64
     OR _event_count < 1 OR _event_count > 64
     OR _request_bytes < 1 OR _request_bytes > 65536 THEN
    RETURN false;
  END IF;
  INSERT INTO public.telemetry_daily_capacity (capacity_day, event_count, request_bytes)
  VALUES ((now() AT TIME ZONE 'UTC')::date, _event_count, _request_bytes)
  ON CONFLICT (capacity_day) DO UPDATE
    SET event_count = public.telemetry_daily_capacity.event_count + EXCLUDED.event_count,
        request_bytes = public.telemetry_daily_capacity.request_bytes + EXCLUDED.request_bytes
    WHERE public.telemetry_daily_capacity.event_count + EXCLUDED.event_count <= 100000
      AND public.telemetry_daily_capacity.request_bytes + EXCLUDED.request_bytes <= 67108864
  RETURNING true INTO reserved;
  IF NOT COALESCE(reserved, false) THEN
    RETURN false;
  END IF;
  INSERT INTO public.telemetry_network_daily_capacity
    (capacity_day, network_pseudonym, event_count, request_bytes)
  VALUES ((now() AT TIME ZONE 'UTC')::date, _network_pseudonym, _event_count, _request_bytes)
  ON CONFLICT (capacity_day, network_pseudonym) DO UPDATE
    SET event_count = public.telemetry_network_daily_capacity.event_count + EXCLUDED.event_count,
        request_bytes = public.telemetry_network_daily_capacity.request_bytes + EXCLUDED.request_bytes
    WHERE public.telemetry_network_daily_capacity.event_count + EXCLUDED.event_count <= 2048
      AND public.telemetry_network_daily_capacity.request_bytes + EXCLUDED.request_bytes <= 4194304
  RETURNING true INTO reserved;
  RETURN COALESCE(reserved, false);
END;
$$;

CREATE FUNCTION telemetry_delete_before(_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted integer;
  safe_cutoff timestamptz := LEAST(_cutoff, now() - interval '90 days');
BEGIN
  WITH expired AS (
    SELECT id
    FROM public.telemetry_events
    WHERE received_at < safe_cutoff
    ORDER BY received_at, id
    LIMIT 10000
    FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.telemetry_events AS events
    USING expired
    WHERE events.id = expired.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO deleted FROM removed;
  DELETE FROM public.telemetry_daily_capacity
  WHERE capacity_day < ((now() AT TIME ZONE 'UTC')::date - 90);
  DELETE FROM public.telemetry_network_daily_capacity
  WHERE capacity_day < ((now() AT TIME ZONE 'UTC')::date - 90);
  RETURN deleted;
END;
$$;

CREATE FUNCTION telemetry_summary(_since timestamptz)
RETURNS TABLE (
  kind text,
  feature text,
  material text,
  event_count integer,
  estimated_installations integer,
  average_duration_milliseconds double precision,
  quantity_total bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT events.kind, events.feature, events.material,
         count(*)::integer, count(DISTINCT events.install_pseudonym)::integer,
         avg(events.duration_milliseconds)::float8, sum(events.quantity)::bigint
  FROM public.telemetry_events AS events
  WHERE events.occurred_at >= GREATEST(_since, now() - interval '90 days')
    AND events.occurred_at <= now() + interval '10 minutes'
  GROUP BY events.kind, events.feature, events.material
  ORDER BY count(*) DESC, events.kind, events.feature NULLS LAST, events.material NULLS LAST
  LIMIT 250
$$;

REVOKE ALL ON FUNCTION telemetry_reserve_capacity(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry_delete_before(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry_summary(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry_reserve_capacity(text, integer, integer) TO lilacmacro_api;
GRANT EXECUTE ON FUNCTION telemetry_summary(timestamptz) TO lilacmacro_api;
GRANT EXECUTE ON FUNCTION telemetry_delete_before(timestamptz) TO lilacmacro_worker;
GRANT INSERT ON telemetry_events TO lilacmacro_api;
GRANT USAGE, SELECT ON SEQUENCE telemetry_events_id_seq TO lilacmacro_api;
