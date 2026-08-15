import type {
  PersistedTelemetryEvent,
  TelemetryRepository,
  TelemetrySummaryRow,
} from '../domain/ports.js';

type StoredTelemetryEvent = PersistedTelemetryEvent & {
  installPseudonym: string;
  appVersion: string;
  privacyNoticeVersion: number;
  receivedAt: Date;
};

export class MemoryTelemetryRepository implements TelemetryRepository {
  public readonly events: StoredTelemetryEvent[] = [];

  public constructor(private readonly maximumStoredEvents = Number.POSITIVE_INFINITY) {}

  public async insertBatch(
    installPseudonym: string,
    _networkPseudonym: string,
    appVersion: string,
    privacyNoticeVersion: number,
    events: readonly PersistedTelemetryEvent[],
    receivedAt: Date,
    _requestBytes: number,
  ): Promise<boolean> {
    if (this.events.length + events.length > this.maximumStoredEvents) return false;
    this.events.push(
      ...events.map((event) => ({
        ...structuredClone(event),
        installPseudonym,
        appVersion,
        privacyNoticeVersion,
        receivedAt: new Date(receivedAt),
      })),
    );
    return true;
  }

  public async summary(since: Date): Promise<readonly TelemetrySummaryRow[]> {
    const groups = new Map<string, StoredTelemetryEvent[]>();
    for (const event of this.events.filter((item) => item.occurredAtUtc >= since)) {
      const key = `${event.kind}\0${valueOf(event, 'feature') ?? ''}\0${valueOf(event, 'material') ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    return [...groups.values()].map((items) => {
      const durations = items.flatMap((item) =>
        valueOf(item, 'durationMilliseconds') === null
          ? []
          : [Number(valueOf(item, 'durationMilliseconds'))],
      );
      const quantities = items.flatMap((item) =>
        valueOf(item, 'quantity') === null ? [] : [Number(valueOf(item, 'quantity'))],
      );
      return {
        kind: items[0]!.kind,
        feature: String(valueOf(items[0]!, 'feature') ?? '') || null,
        material: String(valueOf(items[0]!, 'material') ?? '') || null,
        eventCount: items.length,
        estimatedInstallations: new Set(items.map((item) => item.installPseudonym)).size,
        averageDurationMilliseconds:
          durations.length === 0
            ? null
            : durations.reduce((sum, value) => sum + value, 0) / durations.length,
        quantityTotal:
          quantities.length === 0 ? null : quantities.reduce((sum, value) => sum + value, 0),
      };
    });
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    const retained = this.events.filter((event) => event.receivedAt >= cutoff);
    const deleted = this.events.length - retained.length;
    this.events.splice(0, this.events.length, ...retained);
    return deleted;
  }
}

function valueOf(event: PersistedTelemetryEvent, key: PropertyKey): unknown {
  return key in event ? Reflect.get(event, key) : null;
}
