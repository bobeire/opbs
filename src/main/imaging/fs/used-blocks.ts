import { PartitionReader } from '../image-browse';
import { parseBootSector, readNtfsBitmap } from './ntfs';
import { detectFatType, readFat32UsedBlocks } from './fat32';
import { detectExfat, readExfatUsedBlocks } from './exfat';
import { logger } from '../../utils/logger';

/**
 * Compute the set of block indices (0-based, `blockSize` each) within the first
 * `partitionSize` bytes of a partition whose clusters are *allocated* according
 * to the filesystem's allocation map (NTFS $Bitmap, FAT32 FAT, exFAT allocation
 * bitmap). Blocks that touch no allocated cluster are omitted, so callers can
 * skip reading them entirely (free space needs no backup).
 *
 * Returns null when the partition is not a readable volume of a supported
 * filesystem or its allocation map cannot be resolved; callers must then fall
 * back to a full capture.
 */
export function readUsedBlockIndexes(
  reader: PartitionReader,
  partitionSize: number,
  blockSize: number
): Set<number> | null {
  let bpb: Buffer;
  try {
    bpb = reader.read(0, 512);
  } catch (e) {
    logger.warn(`used-blocks: boot sector read failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  const oem = bpb.length >= 11 ? bpb.toString('ascii', 3, 11) : '';
  logger.info(`used-blocks: boot sector OEM="${oem}" length=${bpb.length}`);
  if (bpb.length >= 11 && oem === 'NTFS    ') {
    return readNtfsUsedBlocks(reader, partitionSize, blockSize);
  }
  if (detectFatType(bpb) === 'FAT32') {
    return readFat32UsedBlocks(reader, partitionSize, blockSize);
  }
  if (detectExfat(bpb)) {
    return readExfatUsedBlocks(reader, partitionSize, blockSize);
  }
  logger.warn(`used-blocks: unrecognised filesystem (OEM="${oem}")`);
  return null;
}

/** NTFS: blocks touching an allocated cluster per the $Bitmap. */
function readNtfsUsedBlocks(
  reader: PartitionReader,
  partitionSize: number,
  blockSize: number
): Set<number> | null {
  let layout;
  try {
    layout = parseBootSector(reader);
  } catch (e) {
    logger.warn(`used-blocks: NTFS boot sector parse failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  let bitmap;
  try {
    bitmap = readNtfsBitmap(reader, layout);
  } catch (e) {
    logger.warn(`used-blocks: NTFS $Bitmap read failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  const { clusterSize, totalClusters, bitmapBytes } = bitmap;
  if (clusterSize <= 0 || blockSize <= 0) {
    return null;
  }
  // Prefer the boot-sector volume size when $Bitmap claims fewer clusters
  // (truncated bitmap) so high clusters are scanned and the out-of-range
  // bits below mark them allocated instead of silently dropping them.
  let scanTo = totalClusters;
  try {
    const bpb = reader.read(0, 512);
    const totalSectors = Number(bpb.readBigUInt64LE(0x28));
    const spc = bpb.readUInt8(0x0d);
    if (totalSectors > 0 && spc > 0) {
      scanTo = Math.max(scanTo, Math.floor(totalSectors / spc));
    }
  } catch {
    // keep $Bitmap-derived totalClusters
  }

  const used = new Set<number>();
  const blockCount = Math.ceil(partitionSize / blockSize);
  for (let b = 0; b < blockCount; b++) {
    const start = b * blockSize;
    const end = Math.min((b + 1) * blockSize, partitionSize);
    const clusterStart = Math.floor(start / clusterSize);
    const clusterEnd = Math.min(Math.ceil(end / clusterSize), scanTo);
    if (clusterStart >= scanTo) {
      continue;
    }
    let touched = false;
    for (let c = clusterStart; c < clusterEnd; c++) {
      const byteIndex = c >> 3;
      // Bits past a short/truncated $Bitmap are unknown — capture those
      // blocks rather than silently dropping them (browse would 404 later).
      if (byteIndex >= bitmapBytes.length || (bitmapBytes[byteIndex] & (1 << (c & 7))) !== 0) {
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