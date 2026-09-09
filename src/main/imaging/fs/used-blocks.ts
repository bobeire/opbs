import { PartitionReader } from '../image-browse';
import { parseBootSector, readNtfsBitmap } from './ntfs';

/**
 * Compute the set of block indices (0-based, `blockSize` each) within the first
 * `partitionSize` bytes of a partition whose clusters are *allocated* according
 * to the NTFS $Bitmap. Blocks that touch no allocated cluster are omitted, so
 * callers can skip reading them entirely (free space needs no backup).
 *
 * Returns null when the partition is not a readable NTFS volume or the bitmap
 * cannot be resolved; callers must then fall back to a full capture.
 */
export function readUsedBlockIndexes(
  reader: PartitionReader,
  partitionSize: number,
  blockSize: number
): Set<number> | null {
  let layout;
  try {
    layout = parseBootSector(reader);
  } catch {
    return null;
  }
  let bitmap;
  try {
    bitmap = readNtfsBitmap(reader, layout);
  } catch {
    return null;
  }
  const { clusterSize, totalClusters, bitmapBytes } = bitmap;
  if (clusterSize <= 0 || blockSize <= 0) {
    return null;
  }

  const used = new Set<number>();
  const blockCount = Math.ceil(partitionSize / blockSize);
  for (let b = 0; b < blockCount; b++) {
    const start = b * blockSize;
    const end = Math.min((b + 1) * blockSize, partitionSize);
    const clusterStart = Math.floor(start / clusterSize);
    const clusterEnd = Math.min(Math.ceil(end / clusterSize), totalClusters);
    if (clusterStart >= totalClusters) {
      continue;
    }
    let touched = false;
    for (let c = clusterStart; c < clusterEnd; c++) {
      const byteIndex = c >> 3;
      if (byteIndex < bitmapBytes.length && (bitmapBytes[byteIndex] & (1 << (c & 7))) !== 0) {
        touched = true;
        break;
      }
    }
    if (touched) {
      used.add(b);
    }
  }
  return used;
}