import { PartitionReader } from './image-browse';
import { parseBootSector, readFileRecords } from './fs/ntfs';
import { NativeImagingApi } from './imaging-job';

/**
 * Map NTFS USN journal change records to the block indices they touch, so an
 * incremental backup can read only changed clusters instead of scanning the
 * whole volume.
 *
 * Returns a `Set<number>` of source block indices (within a partition) that may
 * have changed, or `null` when USN tracking cannot be used (in which case the
 * caller must fall back to a full scan). It never returns an incomplete set:
 * any uncertainty returns `null`.
 */
export function computeChangedBlockIndices(options: {
  native: NativeImagingApi;
  /** Volume device path whose USN journal to query (e.g. `\\?\C:`). */
  volumePath: string;
  /** Device used to read the volume (snapshot or physical drive path). */
  device: string;
  /** Offset of the partition start within `device`. */
  baseOffset: bigint;
  partitionSize: number;
  blockSize: number;
  /** USN to start reading from (the last backup's journal position). */
  lastUsn: number;
}): Set<number> | null {
  const { native, volumePath, device, baseOffset, partitionSize, blockSize, lastUsn } = options;
  if (!native.queryUsnJournal) return null;

  let changes: Array<{ usn: bigint; fileReference: bigint; reason: number; fileName: string }>;
  try {
    changes = native.queryUsnJournal(volumePath, lastUsn);
  } catch {
    // Journal read failed (e.g. no elevation or disabled journal): full scan.
    return null;
  }
  if (changes.length === 0) return null;

  const reader: PartitionReader = {
    size: partitionSize,
    read: (offset: number, length: number) => native.readBlocks(device, baseOffset + BigInt(offset), BigInt(length))
  };

  let layout;
  let records;
  try {
    layout = parseBootSector(reader);
    records = readFileRecords(reader, layout);
  } catch {
    // MFT unreadable: fall back to a full scan.
    return null;
  }

  const byRecord = new Map<number, (typeof records)[number]>();
  for (const rec of records) byRecord.set(rec.recordNumber, rec);

  const changedBlocks = new Set<number>();
  for (const change of changes) {
    const file = byRecord.get(Number(change.fileReference));
    if (!file) continue;
    for (const run of file.dataRuns) {
      const startByte = run.startLcn * layout.clusterSize;
      const endByte = startByte + run.runLength * layout.clusterSize;
      const startBlock = Math.floor(startByte / blockSize);
      const endBlock = Math.ceil(endByte / blockSize);
      for (let b = startBlock; b < endBlock; b++) changedBlocks.add(b);
    }
  }

  return changedBlocks;
}
