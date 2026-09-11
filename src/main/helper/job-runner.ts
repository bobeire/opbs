import * as fs from 'fs';
import * as path from 'path';
import { loadNative } from '../utils/native-loader';
import {
  ImageHeader,
  PartitionEntryMeta,
  BlockRecord,
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  encodeBlockFrame,
  verifyImage,
  readImageInfo,
  readBlockDataFromImage,
  readFrameFromImage,
  IMAGE_VERSION,
  DEFAULT_BLOCK_SIZE,
  getCompressionId,
  compressionTypeOf,
  compressBlock,
  COMPRESSION_NONE,
  COMPRESSION_ZSTD,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_VERIFIED,
  FLAG_INCREMENTAL,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  crc32,
  ImageCipher,
  CIPHER_NONE,
  cipherFromMetadata
} from '../imaging/image-format';
import { CompressionPool } from '../imaging/compression-pool';
import { validateRestoredFilesystem, FsValidation } from '../imaging/drill-validation';
import { computeChangedBlockIndices } from '../imaging/usn-tracking';
import { planNtfsGrow, MAX_METADATA_BYTES } from '../imaging/fs/ntfs-resize';
import { readUsedBlockIndexes } from '../imaging/fs/used-blocks';
import { mountImage, winfspAvailable } from '../imaging/mount-manager';
import {
  ImagingJob,
  JobProgress,
  JobResult,
  RestoreJob,
  RestoreJobProgress,
  RestoreJobResult,
  CloneJob,
  CloneJobPhase,
  CloneJobProgress,
  CloneJobResult,
  NativeImagingApi
} from '../imaging/imaging-job';

interface SnapshotHandle {
  id: string;
  devicePath: string;
}

const SECTOR_SIZE = 512;

/**
 * Backs up a disk to a .opbs image. Runs in the elevated helper process.
 *
 * `nativeApi` is optional and injectable for testing.
 */
export async function runBackupJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  nativeApi?: NativeImagingApi
): Promise<void> {
  const start = Date.now();
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as ImagingJob;
  const native: NativeImagingApi = nativeApi ?? loadNative<NativeImagingApi>();

  const warnings: string[] = [];
  const blockSize = job.blockSize > 0 ? job.blockSize : DEFAULT_BLOCK_SIZE;
  const compressionId = getCompressionId(job.compressionLevel, job.compressionType);
  const cipher: ImageCipher | null = job.encryption ? cipherFromMetadata(job.encryption) : null;
  const totalBytes = job.partitions.reduce((sum, p) => sum + p.size, 0);

  // Multithreaded compression pool. Only used when compression is enabled and
  // the job asks for more than one thread; otherwise the synchronous path runs.
  const usePool =
    compressionId !== COMPRESSION_NONE &&
    typeof job.compressionThreads === 'number' &&
    job.compressionThreads > 1;
  const pool = usePool
    ? new CompressionPool(job.compressionThreads!, job.compressionLevel, compressionTypeOf(compressionId))
    : null;

  let bytesWritten = 0;
  let blocksWritten = 0;
  let snapshotsCreated = 0;
  let verifiedBlocks = 0;
  let skippedBlocks = 0;

  // For incrementals: map (partitionIndex, blockIndex) -> raw CRC so unchanged
  // blocks can be skipped. Delta-on-delta: union the CRCs of the *whole*
  // ancestor chain (full image + every intermediate delta), not just the
  // immediate parent, so a delta never rewrites a block a grandparent already
  // holds.
  const baseCrcs = new Map<string, number>();
  if (job.baseImagePath) {
    let chain: string[];
    try {
      chain = resolveBaseChain(job.baseImagePath);
    } catch (error) {
      throw new Error(`Cannot resolve base chain for incremental backup: ${errorMessage(error)}`, { cause: error });
    }
    for (const image of chain) {
      const info = readImageInfo(image);
      for (const block of info.blocks) {
        baseCrcs.set(`${block.partitionIndex}:${block.blockIndex}`, block.rawCrc32);
      }
    }
  }

  const progress: JobProgress = {
    phase: 'snapshotting',
    percent: 0,
    bytesDone: 0,
    totalBytes,
    speed: 0,
    currentPartition: job.partitions[0]?.label ?? '',
    createdAt: Date.now()
  };

  let lastProgressWrite = Date.now();

  const writeProgress = (phase: JobProgress['phase']): void => {
    let percent = progress.totalBytes > 0 ? Math.min(99, (progress.bytesDone / progress.totalBytes) * 100) : 0;
    if (phase === 'writing-index') percent = Math.max(percent, 99);
    if (phase === 'verifying') percent = 99.5;
    if (phase === 'completed') percent = 100;
    progress.phase = phase;
    progress.percent = percent;
    progress.createdAt = Date.now();
    lastProgressWrite = Date.now();
    try {
      fs.writeFileSync(progressPath, JSON.stringify(progress));
    } catch {
      /* progress reporting is best-effort */
    }
  };

  const isCancelled = (): boolean => fs.existsSync(cancelPath);

  const snapshotCache = new Map<string, SnapshotHandle>();

  const createSnapshots = (job2: ImagingJob): void => {
    const seen = new Set<string>();
    for (const p of job2.partitions) {
      if (p.readSource === 'volume' && p.volumeDevicePath && !seen.has(p.volumeDevicePath)) {
        seen.add(p.volumeDevicePath);
        progress.currentPartition = `${p.label}: snapshotting`;
        writeProgress('snapshotting');
        const snap = native.createSnapshot(p.volumeDevicePath);
        snapshotCache.set(p.volumeDevicePath, snap);
        snapshotsCreated++;
      }
    }
  };

  const deleteSnapshots = (): void => {
    for (const snap of snapshotCache.values()) {
      try {
        native.deleteSnapshot(snap.id);
      } catch {
        warnings.push(`Failed to delete snapshot ${snap.id}`);
      }
    }
    snapshotCache.clear();
  };

  const fd = fs.openSync(job.imagePath, 'w+');

  try {
    const header: ImageHeader = {
      version: IMAGE_VERSION,
      timestamp: Date.now(),
      totalBytes,
      blockSize,
      compressionId,
      partitionCount: job.partitions.length,
      flags: FLAG_HAS_BLOCK_INDEX | (job.baseImagePath ? FLAG_INCREMENTAL : 0),
      blockIndexOffset: 0,
      cipherId: cipher ? cipher.cipherId : CIPHER_NONE,
      kdfIterations: cipher ? cipher.kdfIterations : 0,
      salt: cipher ? cipher.salt : Buffer.alloc(0),
      baseImagePath: job.baseImagePath ?? '',
      sourceDiskModel: job.sourceDisk?.model ?? '',
      sourceDiskSerial: job.sourceDisk?.serial ?? ''
    };
    const placeholderHeader = encodeHeader(header);
    fs.writeSync(fd, placeholderHeader, 0, HEADER_SIZE, 0);

    // Reserve space for the partition table.
    const tableSize = job.partitions.length * PARTITION_TABLE_ENTRY_SIZE;
    const zeroTable = Buffer.alloc(tableSize);
    fs.writeSync(fd, zeroTable, 0, tableSize, HEADER_SIZE);

    const dataOffset = HEADER_SIZE + tableSize;
    let cursor = dataOffset;

    try {
      createSnapshots(job);
    } catch (error) {
      deleteSnapshots();
      throw new Error(`Failed to create VSS snapshot: ${errorMessage(error)}`, { cause: error });
    }

    const blocks: BlockRecord[] = [];
    const partitionEntries: PartitionEntryMeta[] = [];

    for (const part of job.partitions) {
      if (isCancelled()) {
        throw new CancelledError();
      }

      progress.currentPartition = part.label;
      writeProgress('reading');

      // Determine read source device and base offset.
      let device: string;
      let baseOffset: bigint;
      let snapshotDevice = '';

      if (part.readSource === 'volume' && part.volumeDevicePath) {
        const snap = snapshotCache.get(part.volumeDevicePath);
        if (snap) {
          device = snap.devicePath;
          baseOffset = 0n;
          snapshotDevice = part.volumeDevicePath;
        } else {
          device = part.volumeDevicePath;
          baseOffset = 0n;
        }
      } else {
        device = native.getPhysicalDrivePath(part.diskIndex);
        baseOffset = BigInt(part.offset);
      }

      const firstBlockFileOffset = cursor;
      const entry: PartitionEntryMeta = {
        partitionIndex: part.partitionIndex,
        size: part.size,
        offsetOnDisk: part.offset,
        firstBlockFileOffset,
        blockCount: 0
      };
      partitionEntries.push(entry);

      // USN-based changed-block tracking: when enabled and we have a volume + a
      // prior journal USN, only read the blocks touched by changed files. If the
      // journal cannot be used, `changedBlocks` is null and the full scan runs.
      let changedBlocks: Set<number> | null = null;
      if (
        job.useUsnJournal &&
        job.usnVolume &&
        job.usnLastUsn !== undefined &&
        part.readSource === 'volume' &&
        part.volumeDevicePath
      ) {
        changedBlocks = computeChangedBlockIndices({
          native,
          volumePath: job.usnVolume,
          device,
          baseOffset,
          partitionSize: part.size,
          blockSize,
          lastUsn: job.usnLastUsn
        });
      }

      // Used-blocks-only capture: drop blocks that hold no allocated cluster per
      // the NTFS $Bitmap. Read via the same snapshot/device the block reads use
      // so the bit map and the captured bytes are consistent.
      let usedBlocks: Set<number> | null = null;
      if (job.usedBlocksOnly) {
        usedBlocks = readUsedBlockIndexes(
          {
            size: part.size,
            read: (offset: number, length: number) =>
              Buffer.from(native.readBlocks(device, baseOffset + BigInt(offset), BigInt(length)))
          },
          part.size,
          blockSize
        );
        if (!usedBlocks) {
          warnings.push(
            `${part.label}: used-blocks scan could not read the NTFS $Bitmap; capturing the full partition`
          );
        }
      }

      let partitionBytes = 0;
      // Source block index within the partition; advances for every block read,
      // whether skipped (incremental) or written, so destination offsets stay
      // stable across full and delta images.
      let sourceBlockIndex = 0;

      // Multithreaded path: a small window of read-but-not-yet-written blocks.
      // Reads advance `partitionBytes` immediately (source bytes); frame writes
      // advance the file `cursor` strictly in order via `finalizeBlock`.
      const inFlight: {
        raw: Buffer;
        blockIndex: number;
        promise?: Promise<Buffer>;
      }[] = [];
      const windowSize = pool ? Math.max(2, pool.threads * 4) : 1;

      const setCursor = (cursor2: number): void => {
        cursor = cursor2;
      };

      // Write a single block's frame once its compressed bytes are ready.
      const shouldDrain = (): boolean => {
        if (!pool) return false;
        return inFlight.length >= windowSize;
      };

      const finalizeSync = (item: { raw: Buffer; blockIndex: number }, compressed: Buffer): void => {
        const frameOffset = cursor;
        const frame = encodeBlockFrame(item.raw, compressed, cipher);
        fs.writeSync(fd, frame, 0, frame.length, cursor);
        setCursor(cursor + frame.length);

        const block: BlockRecord = {
          partitionIndex: part.partitionIndex,
          blockIndex: item.blockIndex,
          fileOffset: frameOffset,
          rawSize: item.raw.length,
          compSize: compressed.length,
          rawCrc32: crc32(item.raw)
        };
        blocks.push(block);
        entry.blockCount++;
        blocksWritten++;
        bytesWritten += item.raw.length;
      };

      const drainOne = async (item: {
        raw: Buffer;
        blockIndex: number;
        promise?: Promise<Buffer>;
      }): Promise<void> => {
        let compressed: Buffer;
        if (item.promise) {
          compressed = await item.promise;
        } else {
          compressed = compressBlock(item.raw, compressionId, job.compressionLevel);
        }
        finalizeSync(item, compressed);
      };

      const drainAll = async (): Promise<void> => {
        for (const item of inFlight) {
          await drainOne(item);
        }
        inFlight.length = 0;
      };

      while (partitionBytes < part.size) {
        if (isCancelled()) {
          throw new CancelledError();
        }

        const remaining = part.size - partitionBytes;
        const readLength = BigInt(Math.min(blockSize, remaining));
        const blockIndex = sourceBlockIndex;

        // USN tracking / used-blocks filtering: skip blocks that did not change
        // or hold no allocated data, without reading them. Accounting still
        // advances so source offsets stay stable.
        if (
          (changedBlocks && !changedBlocks.has(blockIndex)) ||
          (usedBlocks && !usedBlocks.has(blockIndex))
        ) {
          const skipLen = Number(readLength);
          partitionBytes += skipLen;
          progress.bytesDone += skipLen;
          sourceBlockIndex++;
          skippedBlocks++;
          continue;
        }

        let raw: Buffer;
        try {
          raw = Buffer.from(
            native.readBlocks(device, baseOffset + BigInt(partitionBytes), readLength)
          );
        } catch (error) {
          warnings.push(
            `Read failed for ${part.label} at offset ${baseOffset + BigInt(partitionBytes)}: ${errorMessage(error)}`
          );
          break;
        }

        // Incremental: skip blocks whose content matches the base image.
        const baseCrc = baseCrcs.get(`${part.partitionIndex}:${blockIndex}`);
        if (job.baseImagePath && baseCrc !== undefined && crc32(raw) === baseCrc) {
          skippedBlocks++;
          partitionBytes += raw.length;
          progress.bytesDone += raw.length;
          sourceBlockIndex++;
          continue;
        }

        // Advance source-side accounting now (reads and subsequent writes are
        // contiguous in source space regardless of frame compression ratio).
        partitionBytes += raw.length;
        progress.bytesDone += raw.length;
        sourceBlockIndex++;

        // With the pool, defer compression/write until the window fills; the
        // pool resolves in submission order, so draining stays sequential.
        if (pool) {
          inFlight.push({ raw, blockIndex, promise: pool.compress(raw) });
          while (shouldDrain()) {
            const item = inFlight.shift()!;
            await drainOne(item);
          }
        } else {
          const compressed = compressBlock(raw, compressionId, job.compressionLevel);
          finalizeSync({ raw, blockIndex }, compressed);
        }

        const elapsedSec = (Date.now() - start) / 1000;
        progress.speed = elapsedSec > 0 ? progress.bytesDone / elapsedSec : 0;

        if (Date.now() - lastProgressWrite > 100) {
          writeProgress('reading');
        }
      }

      // Flush any remaining compressed blocks for this partition in order.
      await drainAll();
    }

    // Write the block index at the end of the file.
    writeProgress('writing-index');
    const blockIndexOffset = cursor;
    const countBuf = Buffer.alloc(8);
    countBuf.writeBigUInt64LE(BigInt(blocks.length));
    fs.writeSync(fd, countBuf, 0, 8, cursor);
    cursor += 8;
    for (const block of blocks) {
      const entryBuf = encodeBlockIndexEntry(block);
      fs.writeSync(fd, entryBuf, 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
      cursor += BLOCK_INDEX_ENTRY_SIZE;
    }

    // Patch the partition table with real values.
    for (let i = 0; i < partitionEntries.length; i++) {
      const entry = partitionEntries[i];
      const entryBuf = encodePartitionEntry(entry);
      fs.writeSync(fd, entryBuf, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE + i * PARTITION_TABLE_ENTRY_SIZE);
    }

    // Patch the header with the block index offset.
    const patchedHeader = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, patchedHeader, 0, HEADER_SIZE, 0);
    patchedHeader.writeBigUInt64LE(BigInt(blockIndexOffset), 40);
    fs.writeSync(fd, patchedHeader, 0, HEADER_SIZE, 0);

    fs.closeSync(fd);

    if (job.verificationEnabled) {
      writeProgress('verifying');
      const verified = await verifyImage(job.imagePath, cipher?.key);
      verifiedBlocks = verified.blocksVerified;
      if (!verified.ok) {
        throw new Error(`Image verification failed: ${verified.error ?? 'unknown error'}`);
      }
    }

    // Mark the image as verified.
    const verifyFd = fs.openSync(job.imagePath, 'r+');
    const finalBuf = Buffer.alloc(HEADER_SIZE);
    fs.readSync(verifyFd, finalBuf, 0, HEADER_SIZE, 0);
    const flags = finalBuf.readUInt32LE(36) | FLAG_VERIFIED;
    finalBuf.writeUInt32LE(flags, 36);
    fs.writeSync(verifyFd, finalBuf, 0, HEADER_SIZE, 0);
    fs.closeSync(verifyFd);

    writeProgress('completed');

    // Record the journal position so the next incremental can use USN tracking.
    if (job.useUsnJournal && job.usnVolume && native.getUsnJournalInfo) {
      try {
        const info = native.getUsnJournalInfo(job.usnVolume);
        fs.writeFileSync(
          `${job.imagePath}.usn`,
          JSON.stringify({ volume: job.usnVolume, usn: info.nextUsn.toString() })
        );
      } catch {
        /* best-effort: USN tracking falls back to a full scan next time */
      }
    }

    const result: JobResult = {
      ok: true,
      imagePath: job.imagePath,
      totalBytes,
      bytesWritten,
      durationMs: Date.now() - start,
      blocksWritten,
      snapshotsCreated,
      verifiedBlocks,
      skippedBlocks,
      incremental: !!job.baseImagePath,
      warnings
    };
    fs.writeFileSync(resultPath, JSON.stringify(result));
    return;
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    const cancelled = error instanceof CancelledError;
    const result: JobResult = {
      ok: false,
      error: cancelled ? 'Backup cancelled by user' : errorMessage(error),
      cancelled,
      imagePath: job.imagePath,
      totalBytes,
      bytesWritten,
      durationMs: Date.now() - start,
      blocksWritten,
      snapshotsCreated,
      verifiedBlocks,
      skippedBlocks,
      incremental: !!job.baseImagePath,
      warnings
    };
    // Remove the partial image so it is never mistaken for a good backup.
    try {
      fs.unlinkSync(job.imagePath);
    } catch {
      /* best-effort */
    }
    fs.writeFileSync(resultPath, JSON.stringify(result));
    return;
  } finally {
    deleteSnapshots();
    try {
      pool?.stop();
    } catch {
      /* best-effort cleanup */
    }
  }
}

class CancelledError extends Error {
  constructor() {
    super('Backup cancelled by user');
    this.name = 'CancelledError';
  }
}

/**
 * Restores partitions from a .opbs image to a target disk. Runs in the
 * elevated helper process.
 *
 * `nativeApi` is optional and injectable for testing.
 */
export async function runRestoreJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  nativeApi?: NativeImagingApi
): Promise<void> {
  const start = Date.now();
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as RestoreJob;
  const native: NativeImagingApi = nativeApi ?? loadNative<NativeImagingApi>();

  const warnings: string[] = [];
  const fsValidation: FsValidation[] = [];

  // Build-time warnings (disk-identity hints from the restore engine) are
  // reported on the final result alongside runtime warnings.
  warnings.push(...(job.warnings ?? []));

  // Chain: primary image first, then any deltas in order.
  const sources = [job.imagePath, ...(job.applyDeltas ?? [])];
  const infos = sources.map((p) => {
    try {
      return readImageInfo(p);
    } catch (error) {
      throw new Error(`Cannot read image ${p}: ${errorMessage(error)}`, { cause: error });
    }
  });

  const cipher = job.encryption ? cipherFromMetadata(job.encryption) : null;
  const key = cipher?.cipherId !== CIPHER_NONE ? cipher?.key : undefined;

  // Fail fast if any source is encrypted but we have no key.
  for (let i = 0; i < infos.length; i++) {
    if (infos[i].header.cipherId !== CIPHER_NONE && !key) {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          ok: false,
          error: `Image ${sources[i]} is encrypted; a passphrase is required`,
          imagePath: job.imagePath,
          totalBytes: 0,
          bytesWritten: 0,
          durationMs: Date.now() - start,
          blocksWritten: 0,
          targetsRestored: 0,
          verifiedBeforeWrite: false,
          warnings
        })
      );
      return;
    }
  }

  const selectedPartitions = new Set(job.targets.map((t) => t.partitionIndex));
  const usableBlocks = infos.flatMap((info) => info.blocks.filter((b) => selectedPartitions.has(b.partitionIndex)));

  // Multithreaded decompression pool. Only used when every source shares the
  // same compressed codec and the job asks for more than one thread; otherwise
  // the synchronous path runs.
  const sharedCompressionId = infos.every((info) => info.header.compressionId === infos[0].header.compressionId)
    ? infos[0].header.compressionId
    : null;
  const useDecompPool =
    sharedCompressionId !== null &&
    sharedCompressionId !== COMPRESSION_NONE &&
    typeof job.compressionThreads === 'number' &&
    job.compressionThreads > 1;
  const decompPool = useDecompPool
    ? new CompressionPool(job.compressionThreads!, 0, compressionTypeOf(sharedCompressionId!))
    : null;

  if (usableBlocks.length === 0) {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: false,
        error: 'The images contain no blocks for the requested partitions',
        imagePath: job.imagePath,
        totalBytes: 0,
        bytesWritten: 0,
        durationMs: Date.now() - start,
        blocksWritten: 0,
        targetsRestored: 0,
        verifiedBeforeWrite: false,
        warnings
      })
    );
    return;
  }

  const totalBytes = usableBlocks.reduce((sum, b) => sum + b.rawSize, 0);
  const progress: RestoreJobProgress = {
    phase: job.verifyBeforeWrite ? 'verifying' : 'reading-image',
    percent: 0,
    bytesDone: 0,
    totalBytes,
    speed: 0,
    currentPartition: '',
    createdAt: Date.now()
  };

  let lastProgressWrite = Date.now();

  const writeProgress = (phase: RestoreJobProgress['phase']): void => {
    progress.phase = phase;
    progress.percent =
      phase === 'completed'
        ? 100
        : progress.totalBytes > 0
          ? Math.min(99, (progress.bytesDone / progress.totalBytes) * 100)
          : 0;
    progress.createdAt = Date.now();
    lastProgressWrite = Date.now();
    try {
      fs.writeFileSync(progressPath, JSON.stringify(progress));
    } catch {
      /* best-effort */
    }
  };

  const isCancelled = (): boolean => fs.existsSync(cancelPath);

  let bytesWritten = 0;
  let blocksWritten = 0;
  let targetsRestored = 0;
  let verifiedBeforeWrite = false;

  try {
    // Integrity gate: verify every source that lacks the VERIFIED flag before
    // opening any target for writing.
    if (job.verifyBeforeWrite) {
      const unverified = infos.filter((info) => !(info.header.flags & FLAG_VERIFIED));
      if (unverified.length > 0) {
        progress.currentPartition = 'Verifying image';
        writeProgress('verifying');
        for (let i = 0; i < unverified.length; i++) {
          const source = sources[i];
          const verified = await verifyImage(source, key);
          if (!verified.ok) {
            throw new Error(
              `Image verification failed before restore (${path.basename(source)}): ${verified.error ?? 'unknown error'}`
            );
          }
        }
        verifiedBeforeWrite = true;
      }
    }

    // Dissimilar-hardware restore: lay down the new partition table (GPT with
    // protective MBR, or MBR) before writing any partition contents, so
    // headers, entry arrays and checksums exist on the target disk.
    if (job.writeTable && native.buildPartitionTable) {
      if (isCancelled()) {
        throw new CancelledError();
      }
      const tableDevicePath = native.getPhysicalDrivePath(job.targets[0].diskIndex);
      progress.currentPartition = 'Writing partition table';
      writeProgress('writing');

      const lbaCount = BigInt(Math.floor(job.writeTable.diskSize / SECTOR_SIZE));
      const table = native.buildPartitionTable(
        job.writeTable.scheme,
        lbaCount,
        job.writeTable.entries,
        job.writeTable.diskGuid ? { diskGuid: job.writeTable.diskGuid } : undefined
      );
      for (const region of table.regions) {
        if (isCancelled()) {
          throw new CancelledError();
        }
        native.writeBlocks(tableDevicePath, BigInt(region.offset), Buffer.from(region.data));
      }
    }

    for (const target of job.targets) {
      if (isCancelled()) {
        throw new CancelledError();
      }

      const partition = infos[0].partitions.find((p) => p.partitionIndex === target.partitionIndex);
      if (!partition) {
        warnings.push(`Image has no partition ${target.partitionIndex}; skipping`);
        continue;
      }

      const devicePath = native.getPhysicalDrivePath(target.diskIndex);
      progress.currentPartition = target.label;
      writeProgress('writing');

      // Apply each source in order; later sources (deltas) overwrite changed blocks.
      for (let s = 0; s < infos.length; s++) {
        const info = infos[s];
        const blocksForPartition = info.blocks.filter((b) => b.partitionIndex === target.partitionIndex);
        const useBlockPool = decompPool !== null && info.header.compressionId === sharedCompressionId;

        const writeBlock = (block: { blockIndex: number; rawSize: number; rawCrc32: number }, raw: Buffer): void => {
          if (raw.length !== block.rawSize) {
            throw new Error(
              `Decompressed size mismatch for ${target.label} block ${block.blockIndex} (${raw.length} != ${block.rawSize})`
            );
          }
          if (crc32(raw) !== block.rawCrc32) {
            throw new Error(`Raw data CRC mismatch for ${target.label} block ${block.blockIndex}`);
          }
          const writeOffset = BigInt(target.offset) + BigInt(block.blockIndex * info.header.blockSize);
          try {
            native.writeBlocks(devicePath, writeOffset, raw);
          } catch (error) {
            warnings.push(
              `Write failed for ${target.label} block ${block.blockIndex} at ${writeOffset}: ${errorMessage(error)}`
            );
            return;
          }

          blocksWritten++;
          bytesWritten += raw.length;
          progress.bytesDone += raw.length;
          const elapsedSec = (Date.now() - start) / 1000;
          progress.speed = elapsedSec > 0 ? progress.bytesDone / elapsedSec : 0;

          if (Date.now() - lastProgressWrite > 100) {
            writeProgress('writing');
          }
        };

        const inFlight: { block: { blockIndex: number; rawSize: number; rawCrc32: number }; promise?: Promise<Buffer> }[] =
          [];
        const windowSize = useBlockPool ? Math.max(2, decompPool!.threads * 4) : 1;

        for (const block of blocksForPartition) {
          if (isCancelled()) {
            throw new CancelledError();
          }

          if (useBlockPool) {
            const frame = readFrameFromImage(sources[s], block.fileOffset, info.header.cipherId, key);
            inFlight.push({ block, promise: decompPool!.decompress(frame.comp) });
            while (inFlight.length >= windowSize) {
              const item = inFlight.shift()!;
              writeBlock(item.block, await item.promise!);
            }
          } else {
            const raw = readBlockDataFromImage(
              sources[s],
              block.fileOffset,
              info.header.compressionId,
              info.header.cipherId,
              key
            );
            writeBlock(block, raw);
          }
        }

        for (const item of inFlight) {
          writeBlock(item.block, await item.promise!);
        }
        inFlight.length = 0;
      }

      // Filesystem grow-on-restore: when the target is explicitly larger than
      // the captured partition, extend the NTFS volume to the new size after
      // the partition data has been written. Unsupported layouts/filesystems
      // are reported as warnings and never fail the restore.
      const capturedPartition = infos[0].partitions.find((p) => p.partitionIndex === target.partitionIndex)!;
      if (target.size !== undefined && target.size > capturedPartition.size) {
        if (isCancelled()) {
          throw new CancelledError();
        }
        try {
          const metadata = readPartitionMetadata(sources, infos, target.partitionIndex, MAX_METADATA_BYTES, key);
          const plan = planNtfsGrow(metadata, Math.floor(target.size / SECTOR_SIZE));
          for (const region of plan.regions) {
            if (isCancelled()) {
              throw new CancelledError();
            }
            native.writeBlocks(devicePath, BigInt(target.offset + region.relativeOffset), region.data);
          }
          warnings.push(
            `Grew filesystem on ${target.label} from ${capturedPartition.size} to ${target.size} bytes ` +
              `(${plan.newTotalClusters} clusters)`
          );
        } catch (error) {
          warnings.push(`Could not grow filesystem on ${target.label} to ${target.size} bytes: ${errorMessage(error)}`);
        }
      }

      targetsRestored++;

      // Restore drill: read back the written filesystem and validate the boot
      // sector / $MFT. Failures land in the drill result (not here) so the
      // physical restore outcome stays accurate.
      if (job.validateAfterWrite) {
        if (isCancelled()) {
          throw new CancelledError();
        }
        const check = validateRestoredFilesystem(
          { readBlocks: native.readBlocks, getPhysicalDrivePath: native.getPhysicalDrivePath },
          devicePath,
          {
            partitionIndex: target.partitionIndex,
            label: target.label,
            offset: target.offset,
            capturedSize: capturedPartition.size
          }
        );
        fsValidation.push(check);
        writeProgress('writing');
      }
    }

    writeProgress('completed');

    const result: RestoreJobResult = {
      ok: true,
      imagePath: job.imagePath,
      totalBytes,
      bytesWritten,
      durationMs: Date.now() - start,
      blocksWritten,
      targetsRestored,
      verifiedBeforeWrite,
      warnings,
      fsValidation: fsValidation.length > 0 ? fsValidation : undefined,
      drill:
        job.validateAfterWrite && fsValidation.length > 0
          ? {
              ok: fsValidation.every((c) => c.ok),
              failures: fsValidation.filter((c) => !c.ok).map((c) => `${c.label}: ${c.error ?? 'validation failed'}`)
            }
          : undefined
    };
    fs.writeFileSync(resultPath, JSON.stringify(result));
  } catch (error) {
    const cancelled = error instanceof CancelledError;
    const result: RestoreJobResult = {
      ok: false,
      error: cancelled ? 'Restore cancelled by user' : errorMessage(error),
      cancelled,
      imagePath: job.imagePath,
      totalBytes,
      bytesWritten,
      durationMs: Date.now() - start,
      blocksWritten,
      targetsRestored,
      verifiedBeforeWrite,
      warnings,
      fsValidation: fsValidation.length > 0 ? fsValidation : undefined
    };
    fs.writeFileSync(resultPath, JSON.stringify(result));
  } finally {
    try {
      decompPool?.stop();
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * A disk-to-disk clone: reads selected live partitions and writes them straight
 * onto a target disk (optionally laying a fresh partition table first). Runs in
 * the elevated helper process.
 *
 * `nativeApi` is optional and injectable for testing.
 */
export async function runCloneJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  nativeApi?: NativeImagingApi
): Promise<void> {
  const start = Date.now();
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as CloneJob;
  const native: NativeImagingApi = nativeApi ?? loadNative<NativeImagingApi>();

  const warnings: string[] = [...(job.warnings ?? [])];
  const blockSize = job.blockSize > 0 ? job.blockSize : DEFAULT_BLOCK_SIZE;
  const totalBytes = job.partitions.reduce((sum, p) => sum + p.size, 0);

  let bytesWritten = 0;
  let blocksWritten = 0;
  let targetsRestored = 0;
  let usedBlocksSkipped = 0;

  const progress: CloneJobProgress = {
    phase: 'snapshotting',
    percent: 0,
    bytesDone: 0,
    totalBytes,
    speed: 0,
    currentPartition: job.partitions[0]?.label ?? '',
    createdAt: Date.now()
  };

  let lastProgressWrite = Date.now();

  const writeProgress = (phase: CloneJobPhase): void => {
    progress.phase = phase;
    progress.percent =
      phase === 'completed'
        ? 100
        : progress.totalBytes > 0
          ? Math.min(99, (progress.bytesDone / progress.totalBytes) * 100)
          : 0;
    progress.createdAt = Date.now();
    lastProgressWrite = Date.now();
    try {
      fs.writeFileSync(progressPath, JSON.stringify(progress));
    } catch {
      /* progress reporting is best-effort */
    }
  };

  const isCancelled = (): boolean => fs.existsSync(cancelPath);

  const snapshotCache = new Map<string, { id: string; devicePath: string }>();
  const createSnapshots = (): void => {
    const seen = new Set<string>();
    for (const p of job.partitions) {
      if (p.readSource === 'volume' && p.volumeDevicePath && !seen.has(p.volumeDevicePath)) {
        seen.add(p.volumeDevicePath);
        progress.currentPartition = `${p.label}: snapshotting`;
        writeProgress('snapshotting');
        const snap = native.createSnapshot(p.volumeDevicePath);
        snapshotCache.set(p.volumeDevicePath, snap);
      }
    }
  };

  const deleteSnapshots = (): void => {
    for (const snap of snapshotCache.values()) {
      try {
        native.deleteSnapshot(snap.id);
      } catch {
        warnings.push(`Failed to delete snapshot ${snap.id}`);
      }
    }
    snapshotCache.clear();
  };

  // Resolve the read source for a job partition (snapshot / volume / physical).
  const resolveSource = (
    part: CloneJob['partitions'][number]
  ): { device: string; baseOffset: bigint } => {
    if (part.readSource === 'volume' && part.volumeDevicePath) {
      const snap = snapshotCache.get(part.volumeDevicePath);
      if (snap) {
        return { device: snap.devicePath, baseOffset: 0n };
      }
      return { device: part.volumeDevicePath, baseOffset: 0n };
    }
    return { device: native.getPhysicalDrivePath(part.diskIndex), baseOffset: BigInt(part.offset) };
  };

  try {
    createSnapshots();
  } catch (error) {
    deleteSnapshots();
    throw new Error(`Failed to create VSS snapshot: ${errorMessage(error)}`, { cause: error });
  }

  try {
    // Dissimilar clone: lay the fresh partition table before writing contents.
    if (job.writeTable && native.buildPartitionTable) {
      if (isCancelled()) {
        throw new CancelledError();
      }
      const tableDevicePath = native.getPhysicalDrivePath(job.targets[0].diskIndex);
      progress.currentPartition = 'Writing partition table';
      writeProgress('writing');
      const lbaCount = BigInt(Math.floor(job.writeTable.diskSize / SECTOR_SIZE));
      const table = native.buildPartitionTable(
        job.writeTable.scheme,
        lbaCount,
        job.writeTable.entries,
        job.writeTable.diskGuid ? { diskGuid: job.writeTable.diskGuid } : undefined
      );
      for (const region of table.regions) {
        if (isCancelled()) {
          throw new CancelledError();
        }
        native.writeBlocks(tableDevicePath, BigInt(region.offset), Buffer.from(region.data));
      }
    }

    for (const target of job.targets) {
      if (isCancelled()) {
        throw new CancelledError();
      }

      const part = job.partitions.find((p) => p.partitionIndex === target.partitionIndex);
      if (!part) {
        warnings.push(`Clone source has no partition ${target.partitionIndex}; skipping target`);
        continue;
      }

      const source = resolveSource(part);
      const targetDevice = native.getPhysicalDrivePath(target.diskIndex);
      progress.currentPartition = target.label;
      writeProgress('reading');

      // Used-blocks-only: read the $Bitmap from the same source the blocks come
      // from, then skip blocks holding no allocated clusters.
      let usedBlocks: Set<number> | null = null;
      if (job.usedBlocksOnly) {
        usedBlocks = readUsedBlockIndexes(
          {
            size: part.size,
            read: (offset: number, length: number) =>
              Buffer.from(native.readBlocks(source.device, source.baseOffset + BigInt(offset), BigInt(length)))
          },
          part.size,
          blockSize
        );
        if (!usedBlocks) {
          warnings.push(
            `${target.label}: used-blocks scan could not read the NTFS $Bitmap; copying the full partition`
          );
        }
      }

      const blockCount = Math.ceil(part.size / blockSize);
      for (let b = 0; b < blockCount; b++) {
        if (isCancelled()) {
          throw new CancelledError();
        }

        const offset = BigInt(b * blockSize);
        const remaining = part.size - b * blockSize;
        const readLength = BigInt(Math.min(blockSize, remaining));

        if (usedBlocks && !usedBlocks.has(b)) {
          usedBlocksSkipped++;
          progress.bytesDone += Number(readLength);
          continue;
        }

        let raw: Buffer;
        try {
          raw = Buffer.from(native.readBlocks(source.device, source.baseOffset + offset, readLength));
        } catch (error) {
          warnings.push(
            `Read failed for ${target.label} at ${source.baseOffset + offset}: ${errorMessage(error)}`
          );
          continue;
        }

        try {
          native.writeBlocks(targetDevice, BigInt(target.offset) + offset, raw);
        } catch (error) {
          warnings.push(
            `Write failed for ${target.label} block ${b} at ${BigInt(target.offset) + offset}: ${errorMessage(error)}`
          );
          continue;
        }

        blocksWritten++;
        bytesWritten += raw.length;
        progress.bytesDone += raw.length;
        const elapsedSec = (Date.now() - start) / 1000;
        progress.speed = elapsedSec > 0 ? progress.bytesDone / elapsedSec : 0;

        if (Date.now() - lastProgressWrite > 100) {
          writeProgress('reading');
        }
      }

      // Grow-on-restore semantics: when the target range is larger than the
      // source partition, extend the NTFS filesystem to the new size afterwards.
      if (target.size !== undefined && target.size > part.size) {
        if (isCancelled()) {
          throw new CancelledError();
        }
        progress.currentPartition = `${target.label}: growing`;
        writeProgress('writing');
        try {
          const metadata = readLivePartitionMetadata(
            native,
            source.device,
            source.baseOffset,
            Math.min(MAX_METADATA_BYTES, part.size),
            part.size
          );
          const plan = planNtfsGrow(metadata, Math.floor(target.size / SECTOR_SIZE));
          for (const region of plan.regions) {
            if (isCancelled()) {
              throw new CancelledError();
            }
            native.writeBlocks(targetDevice, BigInt(target.offset + region.relativeOffset), region.data);
          }
          warnings.push(
            `Grew filesystem on ${target.label} from ${part.size} to ${target.size} bytes ` +
              `(${plan.newTotalClusters} clusters)`
          );
        } catch (error) {
          warnings.push(`Could not grow filesystem on ${target.label} to ${target.size} bytes: ${errorMessage(error)}`);
        }
      }

      targetsRestored++;
    }

    writeProgress('completed');

    const result: CloneJobResult = {
      ok: true,
      sourceDiskIndex: job.sourceDiskIndex,
      targetDiskIndex: job.targets[0].diskIndex,
      totalBytes,
      bytesWritten,
      durationMs: Date.now() - start,
      blocksWritten,
      targetsRestored,
      ...(job.usedBlocksOnly ? { usedBlocksSkipped } : {}),
      warnings
    };
    fs.writeFileSync(resultPath, JSON.stringify(result));
  } catch (error) {
    const cancelled = error instanceof CancelledError;
    const result: CloneJobResult = {
      ok: false,
      error: cancelled ? 'Clone cancelled by user' : errorMessage(error),
      cancelled,
      sourceDiskIndex: job.sourceDiskIndex,
      targetDiskIndex: job.targets[0]?.diskIndex ?? job.sourceDiskIndex,
      totalBytes,
      bytesWritten,
      durationMs: Date.now() - start,
      blocksWritten,
      targetsRestored,
      ...(job.usedBlocksOnly ? { usedBlocksSkipped } : {}),
      warnings
    };
    fs.writeFileSync(resultPath, JSON.stringify(result));
  } finally {
    deleteSnapshots();
  }
}

function readLivePartitionMetadata(
  native: NativeImagingApi,
  device: string,
  baseOffset: bigint,
  maxBytes: number,
  partitionSize: number
): Buffer {
  const out: Buffer[] = [];
  let done = 0;
  const CHUNK = 1024 * 1024;
  while (done < maxBytes) {
    const len = Math.min(CHUNK, maxBytes - done, partitionSize - done);
    if (len <= 0) break;
    out.push(Buffer.from(native.readBlocks(device, baseOffset + BigInt(done), BigInt(len))));
    done += len;
  }
  return Buffer.concat(out);
}

/**
 * Mounts a partition from a backup image as a read-only WinFsp drive (the job
 * flavour used when the helper has to hold the mount open). Writes a
 * `{ state: 'mounted', id, mountPoint }` progress update once the volume is
 * live, then stays alive until `cancelPath` appears (the unmount request), at
 * which point the volume is unmounted and the result file is written.
 */
export async function runMountJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string
): Promise<void> {
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as {
    imagePath: string;
    partitionIndex: number;
    driveLetter?: string;
    label?: string;
    passphrase?: string;
  };

  if (!winfspAvailable()) {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: false,
        error: 'WinFsp is not installed. Install the WinFsp runtime (https://winfsp.dev) and try again.'
      })
    );
    return;
  }

  let handle: { id: number; mountPoint: string; unmount(): boolean };
  try {
    handle = mountImage(job);
  } catch (error) {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: false, error: errorMessage(error) })
    );
    return;
  }

  fs.writeFileSync(
    progressPath,
    JSON.stringify({
      state: 'mounted',
      id: handle.id,
      mountPoint: handle.mountPoint,
      image: job.imagePath,
      partitionIndex: job.partitionIndex
    })
  );

  // Stay alive until the launcher asks us to unmount.
  while (!fs.existsSync(cancelPath)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  try {
    handle.unmount();
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true }));
  } catch (error) {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: false, error: errorMessage(error) })
    );
  }
}

/**
 * Reads the job file and dispatches to the correct runner based on its type.
 * Used by the elevated helper entry point.
 */
export async function dispatchHelperJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  nativeApi?: NativeImagingApi
): Promise<void> {
  const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as { type?: string };
  if (raw.type === 'mount') {
    await runMountJob(jobPath, resultPath, progressPath, cancelPath);
    return;
  }
  if (raw.type === 'restore') {
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, nativeApi);
    return;
  }
  if (raw.type === 'clone') {
    await runCloneJob(jobPath, resultPath, progressPath, cancelPath, nativeApi);
    return;
  }
  await runBackupJob(jobPath, resultPath, progressPath, cancelPath, nativeApi);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Resolve the ancestor chain of a base image (root full image first, then the
 * base itself last) by following `baseImagePath` links. Used so a delta can
 * skip blocks already present anywhere in its ancestry.
 */
function resolveBaseChain(imagePath: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = imagePath;
  while (current) {
    if (seen.has(current)) {
      throw new Error(`Circular incremental chain detected at ${current}`);
    }
    seen.add(current);
    chain.unshift(current);
    const info = readImageInfo(current);
    if (!(info.header.flags & FLAG_INCREMENTAL) || !info.header.baseImagePath) {
      break;
    }
    current = info.header.baseImagePath;
  }
  return chain;
}

/**
 * Assemble the leading bytes of a restored partition from the restore chain,
 * stopping once `maxBytes` have been read (or the partition content ends).
 * Later sources in the chain (deltas) override earlier blocks for the same
 * block index, mirroring how runRestoreJob applies them during the write pass.
 */
function readPartitionMetadata(
  sources: string[],
  infos: Array<{ header: ImageHeader; blocks: BlockRecord[] }>,
  partitionIndex: number,
  maxBytes: number,
  key?: Buffer
): Buffer {
  const overlay = new Map<
    number,
    { source: string; fileOffset: number; compressionId: number; cipherId: number }
  >();
  for (let s = 0; s < infos.length; s++) {
    const info = infos[s];
    for (const block of info.blocks) {
      if (block.partitionIndex !== partitionIndex) continue;
      overlay.set(block.blockIndex, {
        source: sources[s],
        fileOffset: block.fileOffset,
        compressionId: info.header.compressionId,
        cipherId: info.header.cipherId
      });
    }
  }
  const indices = Array.from(overlay.keys()).sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let total = 0;
  for (const index of indices) {
    if (total >= maxBytes) break;
    const entry = overlay.get(index)!;
    const raw = readBlockDataFromImage(
      entry.source,
      entry.fileOffset,
      entry.compressionId,
      entry.cipherId,
      key
    );
    const take = Math.min(raw.length, maxBytes - total);
    chunks.push(raw.subarray(0, take));
    total += take;
  }
  return Buffer.concat(chunks);
}