/**
 * Restore-wizard placement plumbing.
 *
 * Some Macrium images do not record where their partition lived on the source
 * disk. The restore engine deliberately refuses those images until the caller
 * supplies an explicit `targetLayout`. These helpers let the wizard build that
 * layout from plain form state and be unit-tested without a DOM renderer.
 */

export interface RestorePlacementPartition {
  index: number;
  offsetOnDisk?: number | null;
}

export interface RestorePlacementLayoutInput {
  partitions: RestorePlacementPartition[];
  targetPartitions: number[];
  /** Per-partition size override in GB (empty means keep the captured size). */
  partitionSizesGb: Record<number, string>;
  /** Per-partition explicit byte offset entered by the user. */
  placementOffsets: Record<number, string>;
}

export interface RestoreTargetLayoutEntry {
  partitionIndex: number;
  offset: number;
  size?: number;
}

/** Whether any selected partition lacks a usable captured source offset. */
export function needsExplicitPlacement(
  partitions: RestorePlacementPartition[],
  targetPartitions: number[]
): boolean {
  return targetPartitions.some((index) => {
    const partition = partitions.find((p) => p.index === index);
    // The engine uses `offset > 0` as its test too: 0/undefined means unknown.
    return !!partition && !(Number(partition.offsetOnDisk) > 0);
  });
}

/** Parse a byte offset entered in the wizard. Invalid/empty input is ignored. */
export function parseByteOffset(value: string | undefined): number | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const parsed = /^0x[0-9a-f]+$/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Build the restore layout from the wizard's size and explicit-offset fields.
 * An entry is emitted only when at least one of those was supplied, so normal
 * one-click restores keep their unchanged captured placement.
 */
export function buildRestoreTargetLayout(
  input: RestorePlacementLayoutInput
): RestoreTargetLayoutEntry[] | undefined {
  const layout: RestoreTargetLayoutEntry[] = [];
  for (const partition of input.partitions) {
    if (!input.targetPartitions.includes(partition.index)) continue;

    const explicitOffset = parseByteOffset(input.placementOffsets[partition.index]);
    const rawGb = input.partitionSizesGb[partition.index];
    const gb = rawGb === undefined || rawGb.trim() === '' ? undefined : Number(rawGb);
    const size =
      gb !== undefined && Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1024 ** 3) : undefined;

    if (explicitOffset === undefined && size === undefined) continue;
    layout.push({
      partitionIndex: partition.index,
      offset: explicitOffset ?? partition.offsetOnDisk ?? 0,
      ...(size !== undefined ? { size } : {})
    });
  }
  return layout.length > 0 ? layout : undefined;
}
