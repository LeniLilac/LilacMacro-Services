ALTER TABLE telemetry_events
  ADD COLUMN setup_stage text,
  ADD COLUMN requested_device text,
  ADD COLUMN process_exit_code integer,
  ADD COLUMN python_launcher_present boolean,
  ADD COLUMN winget_present boolean,
  ADD COLUMN existing_ocr_python_present boolean,
  ADD COLUMN runtime_marker_present boolean,
  ADD COLUMN operation text,
  ADD COLUMN failure_code text,
  ADD COLUMN configuration_mode text,
  ADD COLUMN runner_count integer,
  ADD COLUMN hardware_model text,
  ADD COLUMN display_width integer,
  ADD COLUMN display_height integer,
  ADD COLUMN input_scale_milli integer,
  ADD COLUMN rendered_scale_milli integer;

ALTER TABLE telemetry_events
  DROP CONSTRAINT telemetry_events_privacy_notice_version_check,
  DROP CONSTRAINT telemetry_events_kind_check,
  DROP CONSTRAINT telemetry_events_check2;

ALTER TABLE telemetry_events
  ADD CONSTRAINT telemetry_events_privacy_notice_version_check
    CHECK (privacy_notice_version BETWEEN 1 AND 5),
  ADD CONSTRAINT telemetry_events_kind_check
    CHECK (kind IN (
      'session-started','feature-used','operation-error','expedition-reward-observed',
      'ocr-timing','ocr-setup-failure','local-instance-failure','ui-scale-calibration'
    )),
  ADD CONSTRAINT telemetry_events_setup_stage_check
    CHECK (setup_stage IN (
      'python-bootstrap','gpu-runtime','environment','paddle','paddleocr','import-check',
      'runtime','process','setup'
    )),
  ADD CONSTRAINT telemetry_events_requested_device_check
    CHECK (requested_device IN ('cpu','gpu:0')),
  ADD CONSTRAINT telemetry_events_process_exit_code_check
    CHECK (process_exit_code BETWEEN 0 AND 65535),
  ADD CONSTRAINT telemetry_events_operation_check
    CHECK (operation IN (
      'setup','repair','remove-all','add-shared','add-isolated','remove-profile','open','refresh'
    )),
  ADD CONSTRAINT telemetry_events_failure_code_check
    CHECK (failure_code IN (
      'preflight-rejected','setup-rolled-back','helper-failed','cleanup-incomplete',
      'operation-incomplete','helper-missing','helper-start-failed','access-denied','io-failure',
      'invalid-state','windows-failure','canceled','operation-failed'
    )),
  ADD CONSTRAINT telemetry_events_configuration_mode_check
    CHECK (configuration_mode IN ('shared','isolated','not-applicable')),
  ADD CONSTRAINT telemetry_events_runner_count_check
    CHECK (runner_count BETWEEN 0 AND 16),
  ADD CONSTRAINT telemetry_events_hardware_model_check
    CHECK (char_length(hardware_model) <= 96 AND hardware_model ~
      '^(unknown|(AMD|Intel|NVIDIA|Qualcomm) [A-Za-z0-9][A-Za-z0-9 ._()+-]*)$'),
  ADD CONSTRAINT telemetry_events_display_width_check
    CHECK (display_width BETWEEN 640 AND 16384),
  ADD CONSTRAINT telemetry_events_display_height_check
    CHECK (display_height BETWEEN 480 AND 16384),
  ADD CONSTRAINT telemetry_events_input_scale_milli_check
    CHECK (input_scale_milli BETWEEN 800 AND 1200),
  ADD CONSTRAINT telemetry_events_rendered_scale_milli_check
    CHECK (rendered_scale_milli BETWEEN 500 AND 1500),
  ADD CONSTRAINT telemetry_events_kind_fields_check CHECK (
    (kind = 'session-started' AND feature = 'macro' AND outcome = 'started'
      AND operating_system ~ '^windows-[0-9]{1,2}\.[0-9]{1,2}$'
      AND logical_processor_count IS NOT NULL AND graphics_capability = 'not-observed'
      AND duration_milliseconds IS NULL AND material IS NULL AND quantity IS NULL
      AND setup_stage IS NULL AND requested_device IS NULL AND process_exit_code IS NULL
      AND python_launcher_present IS NULL AND winget_present IS NULL
      AND existing_ocr_python_present IS NULL AND runtime_marker_present IS NULL
      AND operation IS NULL AND failure_code IS NULL AND configuration_mode IS NULL
      AND runner_count IS NULL AND hardware_model IS NULL AND display_width IS NULL
      AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'feature-used'
      AND feature IN ('workspace','wire','challenge','game_settings','ui_scale')
      AND outcome = 'completed' AND duration_milliseconds IS NULL AND material IS NULL
      AND quantity IS NULL AND operating_system IS NULL AND logical_processor_count IS NULL
      AND graphics_capability IS NULL AND setup_stage IS NULL AND requested_device IS NULL
      AND process_exit_code IS NULL AND python_launcher_present IS NULL
      AND winget_present IS NULL AND existing_ocr_python_present IS NULL
      AND runtime_marker_present IS NULL AND operation IS NULL AND failure_code IS NULL
      AND configuration_mode IS NULL AND runner_count IS NULL AND hardware_model IS NULL
      AND display_width IS NULL AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'operation-error' AND feature IN ('macro','application')
      AND outcome IN ('runtime_error','unhandled_exception')
      AND duration_milliseconds IS NULL AND material IS NULL AND quantity IS NULL
      AND operating_system IS NULL AND logical_processor_count IS NULL
      AND graphics_capability IS NULL AND setup_stage IS NULL AND requested_device IS NULL
      AND process_exit_code IS NULL AND python_launcher_present IS NULL
      AND winget_present IS NULL AND existing_ocr_python_present IS NULL
      AND runtime_marker_present IS NULL AND operation IS NULL AND failure_code IS NULL
      AND configuration_mode IS NULL AND runner_count IS NULL AND hardware_model IS NULL
      AND display_width IS NULL AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'expedition-reward-observed' AND feature = 'route-optimizer'
      AND outcome = 'observed'
      AND material IN ('FuelCell','EquipmentScrap','EquipmentReroll','EquipmentLock','ExpeditionCoin')
      AND quantity IS NOT NULL AND duration_milliseconds IS NULL AND operating_system IS NULL
      AND logical_processor_count IS NULL AND graphics_capability IS NULL
      AND setup_stage IS NULL AND requested_device IS NULL AND process_exit_code IS NULL
      AND python_launcher_present IS NULL AND winget_present IS NULL
      AND existing_ocr_python_present IS NULL AND runtime_marker_present IS NULL
      AND operation IS NULL AND failure_code IS NULL AND configuration_mode IS NULL
      AND runner_count IS NULL AND hardware_model IS NULL AND display_width IS NULL
      AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'ocr-timing' AND feature = 'ocr' AND outcome = 'completed'
      AND duration_milliseconds IS NOT NULL
      AND graphics_capability IN ('cpu','gpu','gpu:0','not-observed')
      AND material IS NULL AND quantity IS NULL AND operating_system IS NULL
      AND logical_processor_count IS NULL AND setup_stage IS NULL AND requested_device IS NULL
      AND process_exit_code IS NULL AND python_launcher_present IS NULL
      AND winget_present IS NULL AND existing_ocr_python_present IS NULL
      AND runtime_marker_present IS NULL AND operation IS NULL AND failure_code IS NULL
      AND configuration_mode IS NULL AND runner_count IS NULL AND display_width IS NULL
      AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'ocr-setup-failure' AND feature = 'ocr-setup'
      AND outcome IN (
        'python312_missing','winget_unavailable','python_install_failed','python312_not_found',
        'gpu_detection_failed','gpu_runtime_invalid','venv_create_failed','pip_update_failed',
        'paddle_install_failed','paddleocr_install_failed','ocr_import_failed',
        'runtime_not_ready','setup_process_start_failed','setup_process_failed','setup_failed'
      )
      AND operating_system ~ '^windows-[0-9]{1,2}\.[0-9]{1,2}$'
      AND duration_milliseconds IS NOT NULL AND setup_stage IS NOT NULL
      AND requested_device IS NOT NULL AND python_launcher_present IS NOT NULL
      AND winget_present IS NOT NULL AND existing_ocr_python_present IS NOT NULL
      AND runtime_marker_present IS NOT NULL AND material IS NULL AND quantity IS NULL
      AND logical_processor_count IS NULL AND graphics_capability IS NULL
      AND operation IS NULL AND failure_code IS NULL AND configuration_mode IS NULL
      AND runner_count IS NULL AND hardware_model IS NULL AND display_width IS NULL
      AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'local-instance-failure' AND feature = 'local-instance'
      AND outcome IN (
        'preflight-rejected','setup-rolled-back','helper-failed','cleanup-incomplete',
        'operation-incomplete','helper-missing','helper-start-failed','access-denied','io-failure',
        'invalid-state','windows-failure','canceled','operation-failed'
      )
      AND outcome = failure_code
      AND operating_system ~ '^windows-[0-9]{1,2}\.[0-9]{1,2}$'
      AND duration_milliseconds IS NOT NULL AND operation IS NOT NULL
      AND configuration_mode IS NOT NULL AND runner_count IS NOT NULL
      AND setup_stage IS NULL AND requested_device IS NULL
      AND python_launcher_present IS NULL AND winget_present IS NULL
      AND existing_ocr_python_present IS NULL AND runtime_marker_present IS NULL
      AND material IS NULL AND quantity IS NULL AND logical_processor_count IS NULL
      AND graphics_capability IS NULL AND hardware_model IS NULL AND display_width IS NULL
      AND display_height IS NULL AND input_scale_milli IS NULL
      AND rendered_scale_milli IS NULL)
    OR
    (kind = 'ui-scale-calibration' AND feature = 'ui-scale' AND outcome = 'observed'
      AND display_width IS NOT NULL AND display_height IS NOT NULL
      AND input_scale_milli IS NOT NULL AND rendered_scale_milli IS NOT NULL
      AND duration_milliseconds IS NULL AND material IS NULL AND quantity IS NULL
      AND operating_system IS NULL AND logical_processor_count IS NULL
      AND graphics_capability IS NULL AND hardware_model IS NULL
      AND setup_stage IS NULL AND requested_device IS NULL AND process_exit_code IS NULL
      AND python_launcher_present IS NULL AND winget_present IS NULL
      AND existing_ocr_python_present IS NULL AND runtime_marker_present IS NULL
      AND operation IS NULL AND failure_code IS NULL AND configuration_mode IS NULL
      AND runner_count IS NULL)
  );

CREATE FUNCTION telemetry_summary_v2(_since timestamptz)
RETURNS TABLE (
  kind text,
  feature text,
  material text,
  graphics_capability text,
  hardware_model text,
  display_width integer,
  display_height integer,
  input_scale_milli integer,
  rendered_scale_milli integer,
  event_count integer,
  estimated_installations integer,
  average_duration_milliseconds double precision,
  quantity_total bigint,
  latest_event_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT events.kind, events.feature, events.material, events.graphics_capability,
         events.hardware_model, events.display_width, events.display_height,
         events.input_scale_milli, events.rendered_scale_milli,
         count(*)::integer, count(DISTINCT events.install_pseudonym)::integer,
         avg(events.duration_milliseconds)::float8, sum(events.quantity)::bigint,
         max(events.occurred_at)
  FROM public.telemetry_events AS events
  WHERE events.occurred_at >= GREATEST(_since, now() - interval '90 days')
    AND events.occurred_at <= now() + interval '10 minutes'
  GROUP BY events.kind, events.feature, events.material, events.graphics_capability,
           events.hardware_model, events.display_width, events.display_height,
           events.input_scale_milli, events.rendered_scale_milli
  ORDER BY count(*) DESC, events.kind, events.feature NULLS LAST, events.material NULLS LAST
  LIMIT 250
$$;

REVOKE ALL ON FUNCTION telemetry_summary_v2(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry_summary_v2(timestamptz) TO lilacmacro_api;
