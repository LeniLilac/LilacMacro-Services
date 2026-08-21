import type { Pool, PoolClient } from 'pg';
import type {
  PersistedTelemetryEvent,
  TelemetryRepository,
  TelemetrySummaryRow,
} from '../domain/ports.js';

export class PostgresTelemetryRepository implements TelemetryRepository {
  public constructor(private readonly pool: Pool) {}

  public async insertBatch(
    installPseudonym: string,
    networkPseudonym: string,
    appVersion: string,
    privacyNoticeVersion: number,
    events: readonly PersistedTelemetryEvent[],
    receivedAt: Date,
    requestBytes: number,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const capacity = await client.query<{ reserved: boolean }>(
        'SELECT telemetry_reserve_capacity($1, $2, $3) AS reserved',
        [networkPseudonym, events.length, requestBytes],
      );
      if (capacity.rows[0]?.reserved !== true) {
        await client.query('ROLLBACK');
        return false;
      }
      await insertEvents(
        client,
        installPseudonym,
        appVersion,
        privacyNoticeVersion,
        events,
        receivedAt,
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async summary(since: Date): Promise<readonly TelemetrySummaryRow[]> {
    const result = await this.pool.query(
      `SELECT kind, feature, material, graphics_capability, hardware_model,
              display_width, display_height, input_scale_milli, rendered_scale_milli,
              event_count, estimated_installations, average_duration_milliseconds,
              quantity_total, latest_event_at
       FROM telemetry_summary_v2($1)`,
      [since],
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      feature: row.feature ?? null,
      material: row.material ?? null,
      graphicsCapability: row.graphics_capability ?? null,
      hardwareModel: row.hardware_model ?? null,
      displayWidth: row.display_width === null ? null : Number(row.display_width),
      displayHeight: row.display_height === null ? null : Number(row.display_height),
      inputScaleMilli: row.input_scale_milli === null ? null : Number(row.input_scale_milli),
      renderedScaleMilli:
        row.rendered_scale_milli === null ? null : Number(row.rendered_scale_milli),
      eventCount: Number(row.event_count),
      estimatedInstallations: Number(row.estimated_installations),
      averageDurationMilliseconds:
        row.average_duration_milliseconds === null
          ? null
          : Number(row.average_duration_milliseconds),
      quantityTotal: row.quantity_total === null ? null : Number(row.quantity_total),
      latestEventAt: new Date(row.latest_event_at),
    }));
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query<{ deleted: number }>(
      'SELECT telemetry_delete_before($1) AS deleted',
      [cutoff],
    );
    return Number(result.rows[0]?.deleted ?? 0);
  }
}

async function insertEvents(
  client: PoolClient,
  installPseudonym: string,
  appVersion: string,
  privacyNoticeVersion: number,
  events: readonly PersistedTelemetryEvent[],
  receivedAt: Date,
): Promise<void> {
  const encoded = events.map((event) => ({
    kind: event.kind,
    occurredAtUtc: event.occurredAtUtc.toISOString(),
    feature: valueOf(event, 'feature'),
    outcome: valueOf(event, 'outcome'),
    durationMilliseconds: valueOf(event, 'durationMilliseconds'),
    material: valueOf(event, 'material'),
    quantity: valueOf(event, 'quantity'),
    operatingSystem: valueOf(event, 'operatingSystem'),
    logicalProcessorCount: valueOf(event, 'logicalProcessorCount'),
    graphicsCapability: valueOf(event, 'graphicsCapability'),
    setupStage: valueOf(event, 'setupStage'),
    requestedDevice: valueOf(event, 'requestedDevice'),
    processExitCode: valueOf(event, 'processExitCode'),
    pythonLauncherPresent: valueOf(event, 'pythonLauncherPresent'),
    wingetPresent: valueOf(event, 'wingetPresent'),
    existingOcrPythonPresent: valueOf(event, 'existingOcrPythonPresent'),
    runtimeMarkerPresent: valueOf(event, 'runtimeMarkerPresent'),
    operation: valueOf(event, 'operation'),
    failureCode: valueOf(event, 'failureCode'),
    configurationMode: valueOf(event, 'configurationMode'),
    runnerCount: valueOf(event, 'runnerCount'),
    hardwareModel: valueOf(event, 'hardwareModel'),
    displayWidth: valueOf(event, 'displayWidth'),
    displayHeight: valueOf(event, 'displayHeight'),
    inputScaleMilli: valueOf(event, 'inputScaleMilli'),
    renderedScaleMilli: valueOf(event, 'renderedScaleMilli'),
  }));
  await client.query(
    `INSERT INTO telemetry_events
     (install_pseudonym, app_version, privacy_notice_version, kind, occurred_at, received_at,
      feature, outcome, duration_milliseconds, material, quantity, operating_system,
      logical_processor_count, graphics_capability, setup_stage, requested_device,
      process_exit_code, python_launcher_present, winget_present, existing_ocr_python_present,
      runtime_marker_present, operation, failure_code, configuration_mode, runner_count,
      hardware_model, display_width, display_height, input_scale_milli, rendered_scale_milli)
     SELECT $1, $2, $3, event.kind, event."occurredAtUtc", $4, event.feature, event.outcome,
            event."durationMilliseconds", event.material, event.quantity, event."operatingSystem",
            event."logicalProcessorCount", event."graphicsCapability", event."setupStage",
            event."requestedDevice", event."processExitCode", event."pythonLauncherPresent",
            event."wingetPresent", event."existingOcrPythonPresent", event."runtimeMarkerPresent",
            event.operation, event."failureCode", event."configurationMode", event."runnerCount",
            event."hardwareModel", event."displayWidth", event."displayHeight",
            event."inputScaleMilli", event."renderedScaleMilli"
     FROM jsonb_to_recordset($5::jsonb) AS event(
       kind text, "occurredAtUtc" timestamptz, feature text, outcome text,
       "durationMilliseconds" integer, material text, quantity integer, "operatingSystem" text,
       "logicalProcessorCount" integer, "graphicsCapability" text, "setupStage" text,
       "requestedDevice" text, "processExitCode" integer, "pythonLauncherPresent" boolean,
       "wingetPresent" boolean, "existingOcrPythonPresent" boolean,
       "runtimeMarkerPresent" boolean, operation text, "failureCode" text,
       "configurationMode" text, "runnerCount" integer, "hardwareModel" text,
       "displayWidth" integer, "displayHeight" integer, "inputScaleMilli" integer,
       "renderedScaleMilli" integer
     )`,
    [installPseudonym, appVersion, privacyNoticeVersion, receivedAt, JSON.stringify(encoded)],
  );
}

function valueOf(event: PersistedTelemetryEvent, key: PropertyKey): unknown {
  return key in event ? Reflect.get(event, key) : null;
}
