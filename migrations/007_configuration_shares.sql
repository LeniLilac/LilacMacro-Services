CREATE TABLE shared_configurations (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  payload text NOT NULL CHECK (
    length(payload) BETWEEN 1 AND 245000
    AND payload ~ '^[A-Za-z0-9_-]+$'
  ),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX shared_configurations_expiry_idx ON shared_configurations(expires_at);

CREATE TABLE configuration_share_daily_capacity (
  capacity_day date PRIMARY KEY,
  share_count integer NOT NULL CHECK (share_count BETWEEN 0 AND 1000),
  payload_bytes bigint NOT NULL CHECK (payload_bytes BETWEEN 0 AND 134217728)
);

CREATE TABLE configuration_share_network_daily_capacity (
  capacity_day date NOT NULL,
  network_pseudonym text NOT NULL CHECK (length(network_pseudonym) BETWEEN 40 AND 64),
  share_count integer NOT NULL CHECK (share_count BETWEEN 0 AND 20),
  payload_bytes bigint NOT NULL CHECK (payload_bytes BETWEEN 0 AND 5242880),
  PRIMARY KEY (capacity_day, network_pseudonym)
);

CREATE FUNCTION configuration_share_reserve_capacity(
  _network_pseudonym text,
  _payload_bytes integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reserved boolean;
BEGIN
  IF length(_network_pseudonym) NOT BETWEEN 40 AND 64
     OR _payload_bytes < 1 OR _payload_bytes > 245000 THEN
    RETURN false;
  END IF;
  INSERT INTO public.configuration_share_daily_capacity
    (capacity_day, share_count, payload_bytes)
  VALUES ((now() AT TIME ZONE 'UTC')::date, 1, _payload_bytes)
  ON CONFLICT (capacity_day) DO UPDATE
    SET share_count = public.configuration_share_daily_capacity.share_count + 1,
        payload_bytes = public.configuration_share_daily_capacity.payload_bytes + EXCLUDED.payload_bytes
    WHERE public.configuration_share_daily_capacity.share_count + 1 <= 1000
      AND public.configuration_share_daily_capacity.payload_bytes + EXCLUDED.payload_bytes <= 134217728
  RETURNING true INTO reserved;
  IF NOT COALESCE(reserved, false) THEN RETURN false; END IF;

  INSERT INTO public.configuration_share_network_daily_capacity
    (capacity_day, network_pseudonym, share_count, payload_bytes)
  VALUES ((now() AT TIME ZONE 'UTC')::date, _network_pseudonym, 1, _payload_bytes)
  ON CONFLICT (capacity_day, network_pseudonym) DO UPDATE
    SET share_count = public.configuration_share_network_daily_capacity.share_count + 1,
        payload_bytes = public.configuration_share_network_daily_capacity.payload_bytes + EXCLUDED.payload_bytes
    WHERE public.configuration_share_network_daily_capacity.share_count + 1 <= 20
      AND public.configuration_share_network_daily_capacity.payload_bytes + EXCLUDED.payload_bytes <= 5242880
  RETURNING true INTO reserved;
  IF NOT COALESCE(reserved, false) THEN
    UPDATE public.configuration_share_daily_capacity
    SET share_count = share_count - 1,
        payload_bytes = payload_bytes - _payload_bytes
    WHERE capacity_day = (now() AT TIME ZONE 'UTC')::date;
    DELETE FROM public.configuration_share_daily_capacity
    WHERE capacity_day = (now() AT TIME ZONE 'UTC')::date AND share_count = 0;
  END IF;
  RETURN COALESCE(reserved, false);
END;
$$;

CREATE FUNCTION configuration_share_create(
  _code_hash text,
  _payload text,
  _payload_sha256 text,
  _network_pseudonym text,
  _created_at timestamptz,
  _expires_at timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted integer;
  reserved boolean;
BEGIN
  IF _code_hash !~ '^[a-f0-9]{64}$'
     OR length(_payload) NOT BETWEEN 1 AND 245000
     OR _payload !~ '^[A-Za-z0-9_-]+$'
     OR _payload_sha256 !~ '^[a-f0-9]{64}$'
     OR length(_network_pseudonym) NOT BETWEEN 40 AND 64
     OR _created_at > now() + interval '1 minute'
     OR _expires_at <= GREATEST(_created_at, now())
     OR _expires_at > _created_at + interval '30 days'
     OR _expires_at > now() + interval '30 days' THEN
    RETURN 'invalid';
  END IF;

  INSERT INTO public.shared_configurations
    (code_hash, payload, payload_sha256, created_at, expires_at)
  VALUES (_code_hash, _payload, _payload_sha256, _created_at, _expires_at)
  ON CONFLICT (code_hash) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN 'collision'; END IF;

  SELECT public.configuration_share_reserve_capacity(
    _network_pseudonym, octet_length(_payload)) INTO reserved;
  IF NOT COALESCE(reserved, false) THEN
    DELETE FROM public.shared_configurations WHERE code_hash = _code_hash;
    RETURN 'capacity';
  END IF;
  RETURN 'created';
END;
$$;

CREATE FUNCTION configuration_share_find(_code_hash text, _now timestamptz)
RETURNS TABLE(payload text, payload_sha256 text, expires_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT shares.payload, shares.payload_sha256, shares.expires_at
  FROM public.shared_configurations AS shares
  WHERE shares.code_hash = _code_hash
    AND shares.expires_at > GREATEST(_now, now())
$$;

CREATE FUNCTION configuration_share_delete_expired(_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted integer;
BEGIN
  WITH expired AS (
    SELECT code_hash
    FROM public.shared_configurations
    WHERE expires_at <= LEAST(_now, now())
    ORDER BY expires_at, code_hash
    LIMIT 1000
    FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.shared_configurations AS shares
    USING expired
    WHERE shares.code_hash = expired.code_hash
    RETURNING 1
  )
  SELECT count(*)::integer INTO deleted FROM removed;
  DELETE FROM public.configuration_share_daily_capacity
  WHERE capacity_day < ((now() AT TIME ZONE 'UTC')::date - 31);
  DELETE FROM public.configuration_share_network_daily_capacity
  WHERE capacity_day < ((now() AT TIME ZONE 'UTC')::date - 31);
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION configuration_share_reserve_capacity(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION configuration_share_create(text, text, text, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION configuration_share_find(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION configuration_share_delete_expired(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION configuration_share_create(text, text, text, text, timestamptz, timestamptz) TO lilacmacro_api;
GRANT EXECUTE ON FUNCTION configuration_share_find(text, timestamptz) TO lilacmacro_api;
GRANT EXECUTE ON FUNCTION configuration_share_delete_expired(timestamptz) TO lilacmacro_worker;
