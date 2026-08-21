export interface RetainedDiagnosticArchive {
  id: string;
  installPseudonym: string;
  sizeBytes: number;
  createdAt: Date;
  evictable: boolean;
}

/**
 * Selects the minimum whole-archive eviction set needed for an incoming archive.
 * The install with the most retained archives loses its oldest evictable archive;
 * equal archive counts are resolved by the oldest archive globally.
 */
export function selectCapacityEvictions(
  retained: readonly RetainedDiagnosticArchive[],
  incomingBytes: number,
  maximumRetainedBytes: number,
): readonly string[] | null {
  const retainedBytes = retained.reduce((total, archive) => total + archive.sizeBytes, 0);
  let bytesToRelease = retainedBytes + incomingBytes - maximumRetainedBytes;
  if (bytesToRelease <= 0) return [];

  const counts = new Map<string, number>();
  const candidates = new Map<string, RetainedDiagnosticArchive[]>();
  for (const archive of retained) {
    counts.set(archive.installPseudonym, (counts.get(archive.installPseudonym) ?? 0) + 1);
    if (!archive.evictable) continue;
    const installCandidates = candidates.get(archive.installPseudonym) ?? [];
    installCandidates.push(archive);
    candidates.set(archive.installPseudonym, installCandidates);
  }
  for (const installCandidates of candidates.values()) {
    installCandidates.sort(compareOldest);
  }

  const selected: string[] = [];
  while (bytesToRelease > 0) {
    let selectedInstall: string | null = null;
    let selectedArchive: RetainedDiagnosticArchive | null = null;
    let selectedCount = -1;
    for (const [install, installCandidates] of candidates) {
      const candidate = installCandidates[0];
      if (!candidate) continue;
      const count = counts.get(install) ?? 0;
      if (
        count > selectedCount ||
        (count === selectedCount &&
          selectedArchive !== null &&
          compareOldest(candidate, selectedArchive) < 0) ||
        (count === selectedCount && selectedArchive === null)
      ) {
        selectedInstall = install;
        selectedArchive = candidate;
        selectedCount = count;
      }
    }
    if (!selectedInstall || !selectedArchive) return null;

    candidates.get(selectedInstall)!.shift();
    counts.set(selectedInstall, selectedCount - 1);
    selected.push(selectedArchive.id);
    bytesToRelease -= selectedArchive.sizeBytes;
  }
  return selected;
}

function compareOldest(left: RetainedDiagnosticArchive, right: RetainedDiagnosticArchive): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}
