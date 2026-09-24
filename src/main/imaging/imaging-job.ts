export type ReadSource = 'volume' | 'physical';

export interface NativeImagingApi {
  createSnapshot(volumePath: string): { id: string; devicePath: string };
  deleteSnapshot(id: string): boolean;
  readBlocks(devicePath: string, offset: bigint, length: bigint): Buffer;
  writeBlocks(devicePath: string, offset: bigint, data: Buffer): number;
  readBlocksAsync?(devicePath: string, offset: bigint, length: bigint): Promise<Buffer>;
  writeBlocksAsync?(devicePath: string, offset: bigint, data: Buffer): Promise<number>;
  getPhysicalDrivePath(diskIndex: number): string;
  getVolumePath?(diskIndex: number, partitionOffset: number): string;
  queryUsnJournal?(volumePath: string, startUsn?: number): Array<{ usn: bigint; fileReference: bigint; reason: number; fileName: string }>;
  getUsnJournalInfo?(volumePath: string): { firstUsn: bigint; nextUsn: bigint; lowestValidUsn: bigint };
  crc32?(data: Uint8Array, seed?: number): number;
  closeAllHandles?(): void;
  /** Lock + dismount a mounted volume so raw writes are not racing the FS cache. */
  lockAndDismountVolume?(volumePath: string): boolean;
  /** Unlock/close volumes held by lockAndDismountVolume. */
  releaseLockedVolumes?(): void;
  /** Ask Windows to re-read the partition table after a raw restore. */
  updateDiskProperties?(devicePath: string): boolean;
  /**
   * Build a GPT or MBR partition table. Returns the regions (byte offset + data)
   * the elevated helper writes via writeBlocks before restoring partitions.
   */
  buildPartitionTable?(
    scheme: 'gpt' | 'mbr',
    lbaCount: bigint | number,
    entries: Array<{ offset: number; size: number; typeGuid?: string; name?: string; bootable?: boolean }>,
    opts?: { diskGuid?: string }
  ): { firstUsableLBA: number; lastUsableLBA: number; regions: Array<{ offset: number; data: Buffer }> };
}

export interface ImagingPartition {
  diskIndex: number;
  partitionIndex: number;
  size: number;
  offset: number;
  label: string;
  readSource: ReadSource;
  volumeDevicePath?: string;
}

/**
 * Derived-cipher metadata carried on a job so the helper never needs to see a
 * raw passphrase. `saltHex`/`keyHex` are the PBKDF2 salt and derived key.
 */
export interface JobEncryption {
  cipherId: number;
  saltHex: string;
  kdfIterations: number;
  keyHex: string;
}

export interface ResumeCheckpoint {
  imagePath: string;
  /** File offset where the next compressed frame should be written. */
  cursor: number;
  /** Number of partitions whose blocks are fully written. */
  completedPartitions: number;
  /** Source bytes written for the current (partially written) partition. */
  partitionBytes: number;
  /** Next source block index to read within the current partition. */
  sourceBlockIndex: number;
  /** Total compressed blocks written so far. */
  blocksWritten: number;
  /** Total source bytes read and written so far. */
  bytesWritten: number;
  /** Blocks skipped (USN/incremental/used-blocks filtering). */
  skippedBlocks: number;
}

export interface ImagingJob {
  type: 'backup';
  imagePath: string;
  blockSize: number;
  compressionLevel: number;
  verificationEnabled: boolean;
  partitions: ImagingPartition[];
  /** For incremental backups: path to the base image this delta builds on. */
  baseImagePath?: string;
  encryption?: JobEncryption;
  /** Compression algorithm to use (defaults to deflate when level > 0). */
  compressionType?: 'deflate' | 'zstd';
  /** Worker threads for multithreaded compression (0/unset = synchronous). */
  compressionThreads?: number;
  /** Use the USN journal to read only changed blocks for an incremental. */
  useUsnJournal?: boolean;
  /** Volume path whose USN journal to query (single-volume legacy). */
  usnVolume?: string;
  /** Last backup's journal USN (single-volume legacy). */
  usnLastUsn?: number;
  /** Per-partition USN state for multi-volume tracking. Each entry maps a
   *  partition index to its volume path and journal cursor. When present, this
   *  takes precedence over usnVolume/usnLastUsn. */
  perPartitionUsn?: Record<number, { volume: string; lastUsn: number }>;
  /** Only capture blocks containing allocated clusters (NTFS $Bitmap). Free
   *  space is skipped; non-NTFS partitions fall back to a full capture. */
  usedBlocksOnly?: boolean;
  /** Identity of the disk being imaged, persisted in the image header. */
  sourceDisk?: { model: string; serial: string };
  /** When set, the backup may be resumed from a partial image. Completed
   *  partitions are kept on failure so a later run continues from the same
   *  target path. */
  resume?: boolean;
  /** When set, resume the backup from this checkpoint instead of starting fresh. */
  resumeCheckpoint?: ResumeCheckpoint;
  /** Maximum size in bytes for each volume file (0/undefined = no splitting).
   *  Used for multi-volume images on FAT32 destinations. */
  maxVolumeSize?: number;
}

export interface RestoreTarget {
  partitionIndex: number;
  diskIndex: number;
  offset: number;
  /**
   * On-disk size of the restored partition. When larger than the captured
   * partition size the helper grows the partition's filesystem after writing
   * the partition data (NTFS grow-on-restore).
   */
  size?: number;
  label: string;
}

export interface RestoreJob {
  type: 'restore';
  imagePath: string;
  verifyBeforeWrite: boolean;
  targets: RestoreTarget[];
  /** For chained restoration: delta images to apply after the base image. */
  applyDeltas?: string[];
  encryption?: JobEncryption;
  /** Worker threads for multithreaded restore decompression (0/unset = sync). */
  compressionThreads?: number;
  /**
   * Partition-table plan for a dissimilar-hardware restore. The elevated
   * helper builds the table via the native addon and writes it to the target
   * disk before restoring any partition contents.
   */
  writeTable?: {
    scheme: 'gpt' | 'mbr';
    diskSize: number;
    diskGuid?: string;
    entries: Array<{ offset: number; size: number; typeGuid?: string; name?: string; bootable?: boolean }>;
  };
  /** Read back the written filesystem after every target and validate the
   *  boot sector / MFT. The CLI `drill` subcommand sets this flag. */
  validateAfterWrite?: boolean;
  /** Read back every restored block from the target disk and compare its CRC
   *  against the image's stored CRC. Catches silent disk write failures. */
  verifyAfterRestore?: boolean;
  /**
   * Zero every block in the target range that the image chain does not contain
   * (used-blocks / incremental gaps). Default true so free space left by a
   * post-backup file cannot survive a restore. Set false to skip gap wipe
   * (faster; leaves spare space untouched like older releases).
   */
  clearFreeSpace?: boolean;
  /**
   * Build-time warnings/hints (e.g. the target disk looks identical to the
   * source) that the helper appends to the restore result's warnings.
   */
  warnings?: string[];
}

export type JobPhase = 'snapshotting' | 'reading' | 'writing-index' | 'verifying' | 'completed';
export type RestoreJobPhase = 'reading-image' | 'verifying' | 'writing' | 'completed';

export interface JobProgress {
  phase: JobPhase;
  percent: number;
  bytesDone: number;
  totalBytes: number;
  speed: number;
  currentPartition: string;
  createdAt: number;
  /** True while a backup is continuing a previously interrupted image. */
  resuming?: boolean;
  /** Post-write verification progress (frames verified / total). */
  verifyDone?: number;
  verifyTotal?: number;
}

export interface JobResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  imagePath: string;
  totalBytes: number;
  bytesWritten: number;
  durationMs: number;
  blocksWritten: number;
  snapshotsCreated: number;
  verifiedBlocks: number;
  skippedBlocks?: number;
  incremental?: boolean;
  resumed?: boolean;
  warnings: string[];
}

export interface RestoreJobProgress {
  phase: RestoreJobPhase;
  percent: number;
  bytesDone: number;
  totalBytes: number;
  speed: number;
  currentPartition: string;
  createdAt: number;
}

export interface RestoreJobResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  imagePath: string;
  totalBytes: number;
  bytesWritten: number;
  durationMs: number;
  blocksWritten: number;
  targetsRestored: number;
  verifiedBeforeWrite: boolean;
  warnings: string[];
  /** Free-space blocks zeroed because they were absent from the image chain. */
  freeBlocksCleared?: number;
  /** Per-partition filesystem checks populated when validateAfterWrite is set. */
  fsValidation?: Array<{
    partitionIndex: number;
    label: string;
    ok: boolean;
    checks: Record<string, boolean | string | number>;
    error?: string;
  }>;
  /** Aggregate restore-drill outcome. */
  drill?: { ok: boolean; failures: string[] };
}

/** A disk-to-disk clone: read selected live partitions and write them straight
 *  onto another local disk (optionally laying a fresh partition table). */
export interface CloneJob {
  type: 'clone';
  sourceDiskIndex: number;
  /** Source partitions to clone. */
  partitions: ImagingPartition[];
  /** Where each selected partition lands on the target disk. */
  targets: RestoreTarget[];
  /** Capture block granularity (bytes). */
  blockSize: number;
  /** Skip free-space blocks (NTFS $Bitmap); non-NTFS falls back to full copy. */
  usedBlocksOnly?: boolean;
  /** Fresh partition-table plan for the target disk (optional). */
  writeTable?: RestoreJob['writeTable'];
  /** Build-time warnings/hints (target looks like the source, etc.). */
  warnings?: string[];
}

export type CloneJobPhase = 'snapshotting' | 'reading' | 'writing' | 'completed';

export interface CloneJobProgress {
  phase: CloneJobPhase;
  percent: number;
  bytesDone: number;
  totalBytes: number;
  speed: number;
  currentPartition: string;
  createdAt: number;
}

export interface CloneJobResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  sourceDiskIndex: number;
  targetDiskIndex: number;
  totalBytes: number;
  bytesWritten: number;
  durationMs: number;
  blocksWritten: number;
  targetsRestored: number;
  usedBlocksSkipped?: number;
  warnings: string[];
}

export function emptyProgress(): JobProgress {
  return {
    phase: 'snapshotting',
    percent: 0,
    bytesDone: 0,
    totalBytes: 0,
    speed: 0,
    currentPartition: '',
    createdAt: Date.now()
  };
}