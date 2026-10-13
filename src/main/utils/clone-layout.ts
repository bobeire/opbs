export interface CloneLayoutPartition {
  partitionIndex: number;
  /** Source offset on the original disk (informational). */
  offset: number;
  /** Source size (bytes). */
  size: number;
  label?: string;
  /** GPT/MBR type GUID / type id. */
  type?: number;
  /** Minimum allowed size when auto-scaling down (defaults to 1 MiB). Used to
   *  keep a shrunken filesystem above its used-space floor. */
  minSize?: number;
  /** Refuse to scale this partition down (e.g. a filesystem whose shrink is
   *  not supported). The planner errors instead of emitting a smaller size. */
  noShrink?: boolean;
}

export interface TargetPlacement {
  partitionIndex: number;
  offset: number;
  size: number;
}

export interface CloneLayoutPlan {
  ok: boolean;
  /** Authoritative target placements (only when ok). */
  targets: TargetPlacement[];
  /** Sum of all partition sizes after optional grow. */
  totalBytes: number;
  /** Remaining bytes on the target disk after placement. */
  freeBytes: number;
  /** Delta applied to the last partition via grow-to-fill (positive when grown,
   *  negative when the last partition was scaled down by shrink-to-fit). */
  growBytes: number;
  /** True when shrink-to-fit scaled at least one partition down. */
  shrunk?: boolean;
  error?: string;
}

/** Minimum reserve (bytes) left at the tail of a target disk for GPT backup / safety. */
const FOOTER_RESERVE = 2 * 1024 * 1024;

/** Default alignment: 1 MiB (sector-aligned for all common sector sizes). */
const ALIGN_BYTES = 1024 * 1024;

/**
 * Auto-sequential partition placement planner.
 *
 * Lays out partitions in drop order on a target disk at 1 MiB–aligned offsets.
 * When `growLast` is true the last partition is expanded to consume all remaining
 * budget; when false every partition keeps its original size.
 *
 * When `shrinkToFit` is true and the partitions do not fit at their source sizes,
 * scalable partitions are scaled down proportionally (1 MiB–aligned, never below
 * `minSize`) so the set fits the target. Partitions flagged `noShrink` keep their
 * source size and the plan errors if the remaining partitions cannot absorb the
 * overflow — the planner never silently drops or truncates a partition.
 *
 * Errors an error plan (ok:false) when the target disk is too small.
 */
export function planTargetLayout(
  partitions: CloneLayoutPartition[],
  targetSizeBytes: number,
  opts?: { growLast?: boolean; shrinkToFit?: boolean }
): CloneLayoutPlan {
  if (!partitions.length) {
    return { ok: true, targets: [], totalBytes: 0, freeBytes: targetSizeBytes, growBytes: 0 };
  }

  if (targetSizeBytes < ALIGN_BYTES * 3) {
    return { ok: false, targets: [], totalBytes: 0, freeBytes: 0, growBytes: 0, error: 'Target disk is too small' };
  }

  const budget = targetSizeBytes - FOOTER_RESERVE;
  const growLast = opts?.growLast === true;
  const shrinkToFit = opts?.shrinkToFit === true;

  // Decide each partition's effective size before placement. With every size
  // 1 MiB–aligned the sequential layout has no inter-partition gaps, so the
  // usable budget for sizes is the headroom (1 MiB) below the footer reserve.
  const sourceSizes = partitions.map((p) => Math.max(p.size, ALIGN_BYTES));
  const available = budget - ALIGN_BYTES;
  let sizes = sourceSizes;
  let shrunk = false;

  if (shrinkToFit) {
    const totalSource = sourceSizes.reduce((sum, s) => sum + s, 0);
    if (totalSource > available) {
      // Partitions flagged noShrink keep their source size. The rest are scaled
      // down into the remaining budget, never below their per-partition floor
      // (minSize, or 1 MiB by default). Budget above the floors is shared out
      // proportionally to each partition's headroom, 1 MiB-aligned.
      const floors = partitions.map((p, i) => {
        if (p.noShrink) return sourceSizes[i];
        const aligned = Math.ceil(Math.max(p.minSize ?? ALIGN_BYTES, ALIGN_BYTES) / ALIGN_BYTES) * ALIGN_BYTES;
        return Math.min(sourceSizes[i], aligned);
      });
      const fixedTotal = partitions.reduce((sum, p, i) => sum + (p.noShrink ? sourceSizes[i] : 0), 0);
      const scalableFloorsTotal = floors.reduce((sum, f, i) => sum + (partitions[i].noShrink ? 0 : f), 0);

      if (fixedTotal + scalableFloorsTotal > available) {
        const noShrinkIdx = partitions.findIndex((p) => p.noShrink);
        if (noShrinkIdx >= 0) {
          const part = partitions[noShrinkIdx];
          return {
            ok: false,
            targets: [],
            totalBytes: 0,
            freeBytes: 0,
            growBytes: 0,
            error:
              `Partition ${part.partitionIndex} (${part.label ?? 'P' + part.partitionIndex}) cannot be scaled ` +
              `down (unsupported filesystem) but needs ${fmtBytes(sourceSizes[noShrinkIdx])} and only ` +
              `${fmtBytes(available)} fit on the target disk`
          };
        }
        const idx = partitions.findIndex((p) => !p.noShrink);
        const part = partitions[idx];
        return {
          ok: false,
          targets: [],
          totalBytes: 0,
          freeBytes: 0,
          growBytes: 0,
          error:
            `Partition ${part.partitionIndex} (${part.label ?? 'P' + part.partitionIndex}) cannot shrink below ` +
            `${fmtBytes(floors[idx])}; the partitions do not fit on the target disk`
        };
      }

      const slack = available - fixedTotal - scalableFloorsTotal;
      const totalExtra = floors.reduce((sum, f, i) => sum + (partitions[i].noShrink ? 0 : sourceSizes[i] - f), 0);
      sizes = partitions.map((p, i) => {
        if (p.noShrink) return sourceSizes[i];
        const extra = sourceSizes[i] - floors[i];
        const share = totalExtra > 0 ? Math.floor((extra * slack) / totalExtra / ALIGN_BYTES) * ALIGN_BYTES : 0;
        return floors[i] + share;
      });
      shrunk = true;
    }
  }

  // Place sequentially at 1 MiB–aligned offsets.
  let cursor = ALIGN_BYTES;
  const targets: TargetPlacement[] = [];
  let totalBytes = 0;

  for (let i = 0; i < partitions.length; i++) {
    const part = partitions[i];
    const alignedOffset = Math.ceil(cursor / ALIGN_BYTES) * ALIGN_BYTES;
    const effectiveSize = sizes[i];
    const fit = budget - alignedOffset;

    if (fit < effectiveSize && (!growLast || i === partitions.length - 1)) {
      return {
        ok: false,
        targets: [],
        totalBytes: 0,
        freeBytes: 0,
        growBytes: 0,
        error:
          `Partition ${part.partitionIndex} (${part.label ?? 'P' + part.partitionIndex}) needs ` +
          `${fmtBytes(effectiveSize)} but only ${fmtBytes(fit)} remain on the target disk`
      };
    }

    const isLast = i === partitions.length - 1;
    const size = isLast && growLast ? fit : effectiveSize;

    targets.push({ partitionIndex: part.partitionIndex, offset: alignedOffset, size });
    cursor = alignedOffset + size;
    totalBytes += size;
  }

  return {
    ok: true,
    targets,
    totalBytes,
    freeBytes: Math.max(0, budget - cursor),
    growBytes:
      growLast && targets.length > 0
        ? targets[targets.length - 1].size - partitions[partitions.length - 1].size
        : 0,
    ...(shrunk ? { shrunk: true } : {})
  };
}

function fmtBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
