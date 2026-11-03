import { NtfsLayout, parseBootSector, readNtfsBitmap } from './fs/ntfs';
import type { PartitionReader } from './image-browse';

/**
 * Detect a capture that is not a point in time.
 *
 * A backup that reads a live disk while Windows writes to it produces an image
 * with no single moment in it: the allocation bitmap and the file records come
 * from different times, and restoring one gives a filesystem chkdsk reports as
 * corrupt. Every block still passes its checksum, so block verification never
 * notices (field report 2026-11-03).
 *
 * The cheapest decisive signal is the volume's own allocation map. It is a few
 * megabytes, it changes whenever anything is written, and it cannot change
 * under a frozen shadow copy. So: read it before the capture and again after.
 * If the two differ, the volume moved underneath us and the image is a smear.
 *
 * Deliberately not a full filesystem check. Comparing the bitmap against every
 * file's runlist is what chkdsk does and costs a full MFT parse; this catches
 * the actual failure mode for a fraction of that, and the deeper check belongs
 * to verification, not to every backup.
 */
export interface AllocationMap {
  clusterSize: number;
  totalClusters: number;
  bitmapBytes: Buffer;
}

/** Read a volume's allocation map. Returns null for a non-NTFS volume. */
export function readAllocationMap(reader: PartitionReader): AllocationMap | null {
  try {
    const bpb = reader.read(0, 512);
    if (bpb.toString('ascii', 3, 11) !== 'NTFS    ') return null;
    const layout: NtfsLayout = parseBootSector(reader);
    const bitmap = readNtfsBitmap(reader, layout);
    return {
      clusterSize: bitmap.clusterSize,
      totalClusters: bitmap.totalClusters,
      bitmapBytes: bitmap.bitmapBytes
    };
  } catch {
    // An unreadable map is not a clean bill of health — it is simply not
    // something we can check, and callers treat it as "no verdict".
    return null;
  }
}

export interface AllocationChange {
  changed: boolean;
  /** How many clusters flipped between the two reads. */
  clustersChanged: number;
}

/**
 * Compare two allocation maps taken before and after a capture. Different
 * lengths count as a change too: the volume geometry itself moved.
 */
export function allocationChanged(before: AllocationMap, after: AllocationMap): AllocationChange {
  if (before.totalClusters !== after.totalClusters || before.clusterSize !== after.clusterSize) {
    return { changed: true, clustersChanged: Number.MAX_SAFE_INTEGER };
  }
  const a = before.bitmapBytes;
  const b = after.bitmapBytes;
  const len = Math.max(a.length, b.length);
  let clustersChanged = 0;
  for (let i = 0; i < len; i++) {
    const x = i < a.length ? a[i] : 0;
    const y = i < b.length ? b[i] : 0;
    if (x !== y) {
      let diff = x ^ y;
      while (diff !== 0) {
        clustersChanged += diff & 1;
        diff >>= 1;
      }
    }
  }
  return { changed: clustersChanged > 0, clustersChanged };
}

/**
 * The refusal / warning wording, shared by every caller so the consequence is
 * always said the same way.
 */
export function captureChangedMessage(label: string, clustersChanged: number): string {
  return (
    `${label}: the volume changed while it was being captured (${clustersChanged} allocation ` +
    `cluster${clustersChanged === 1 ? '' : 's'} flipped mid-run). The image has no single point in ` +
    `time - its allocation map and its file records came from different moments - and restoring it ` +
    `can produce a filesystem that looks corrupt even though every block verifies. Close applications, ` +
    `or use a shadow copy (fix VSS if one cannot be taken).`
  );
}
