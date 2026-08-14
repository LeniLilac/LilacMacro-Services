function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeValue(record[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON rejects non-finite numbers.');
  }
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function') {
    throw new TypeError(`Canonical JSON rejects ${typeof value}.`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
