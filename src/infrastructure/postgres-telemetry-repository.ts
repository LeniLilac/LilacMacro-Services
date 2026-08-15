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
      `SELECT kind, feature, material, event_count, estimated_installations,
              average_duration_milliseconds, quantity_total
       FROM telemetry_summary($1)`,
      [since],
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      feature: row.feature ?? null,
      material: row.material ?? null,
      eventCount: Number(row.event_count),
      estimatedInstallations: Number(row.estimated_installations),
      averageDurationMilliseconds:
        row.average_duration_milliseconds === null
          ? null
          : Number(row.average_duration_milliseconds),
      quantityTotal: row.quantity_total === null ? null : Number(row.quantity_total),
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
  }));
  await client.query(
    `INSERT INTO telemetry_events
     (install_pseudonym, app_version, privacy_notice_version, kind, occurred_at, received_at,
      feature, outcome, duration_milliseconds, material, quantity, operating_system,
      logical_processor_count, graphics_capability)
     SELECT $1, $2, $3, event.kind, event."occurredAtUtc", $4, event.feature, event.outcome,
            event."durationMilliseconds", event.material, event.quantity, event."operatingSystem",
            event."logicalProcessorCount", event."graphicsCapability"
     FROM jsonb_to_recordset($5::jsonb) AS event(
       kind text, "occurredAtUtc" timestamptz, feature text, outcome text,
       "durationMilliseconds" integer, material text, quantity integer, "operatingSystem" text,
       "logicalProcessorCount" integer, "graphicsCapability" text
     )`,
    [installPseudonym, appVersion, privacyNoticeVersion, receivedAt, JSON.stringify(encoded)],
  );
}

function valueOf(event: PersistedTelemetryEvent, key: PropertyKey): unknown {
  return key in event ? Reflect.get(event, key) : null;
}
