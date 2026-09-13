export interface CloneLayoutPartition {
  partitionIndex: number;
  /** Source offset on the original disk (informational). */
  offset: number;
  /** Source size (bytes). */
  size: number;
  label?: string;
  /** GPT/MBR type GUID / type id. */
  type?: number;
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
  /** Bytes added to the last partition via grow-to-fill. */
  growBytes: number;
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
 * Throws an error plan (ok:false) when the target disk is too small.
 */
export function planTargetLayout(
  partitions: CloneLayoutPartition[],
  targetSizeBytes: number,
  opts?: { growLast?: boolean }
): CloneLayoutPlan {
  if (!partitions.length) {
    return { ok: true, targets: [], totalBytes: 0, freeBytes: targetSizeBytes, growBytes: 0 };
  }

  if (targetSizeBytes < ALIGN_BYTES * 3) {
    return { ok: false, targets: [], totalBytes: 0, freeBytes: 0, growBytes: 0, error: 'Target disk is too small' };
  }

  const budget = targetSizeBytes - FOOTER_RESERVE;
  const growLast = opts?.growLast === true;

  let cursor = ALIGN_BYTES;
  const targets: TargetPlacement[] = [];
  let totalBytes = 0;

  for (const part of partitions) {
    const alignedOffset = Math.ceil(cursor / ALIGN_BYTES) * ALIGN_BYTES;
    const originalSize = Math.max(part.size, ALIGN_BYTES);
    const fit = budget - alignedOffset;

    if (fit < originalSize && (!growLast || targets.length === partitions.length - 1)) {
      return {
        ok: false,
        targets: [],
        totalBytes: 0,
        freeBytes: 0,
        growBytes: 0,
        error:
          `Partition ${part.partitionIndex} (${part.label ?? 'P' + part.partitionIndex}) needs ` +
          `${fmtBytes(originalSize)} but only ${fmtBytes(fit)} remain on the target disk`
      };
    }

    const isLast = targets.length === partitions.length - 1;
    const size = isLast && growLast ? fit : originalSize;

    targets.push({ partitionIndex: part.partitionIndex, offset: alignedOffset, size });
    cursor = alignedOffset + size;
    totalBytes += size;
  }

  return {
    ok: true,
    targets,
    totalBytes,
    freeBytes: Math.max(0, targetSizeBytes - FOOTER_RESERVE - cursor),
    growBytes: growLast && targets.length > 0 ? targets[targets.length - 1].size - partitions[partitions.length - 1].size : 0
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
