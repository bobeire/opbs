export type ReadSource = 'volume' | 'physical';

export interface NativeImagingApi {
  createSnapshot(volumePath: string): { id: string; devicePath: string };
  deleteSnapshot(id: string): boolean;
  readBlocks(devicePath: string, offset: bigint, length: bigint): Buffer;
  writeBlocks(devicePath: string, offset: bigint, data: Buffer): number;
  getPhysicalDrivePath(diskIndex: number): string;
  queryUsnJournal?(volumePath: string, startUsn?: number): Array<{ usn: bigint; fileReference: bigint; reason: number; fileName: string }>;
  getUsnJournalInfo?(volumePath: string): { firstUsn: bigint; nextUsn: bigint; lowestValidUsn: bigint };
  crc32?(data: Uint8Array, seed?: number): number;
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
  /** Volume path whose USN journal to query. */
  usnVolume?: string;
  /** Last backup's journal USN (from the base image sidecar). */
  usnLastUsn?: number;
  /** Only capture blocks containing allocated clusters (NTFS $Bitmap). Free
   *  space is skipped; non-NTFS partitions fall back to a full capture. */
  usedBlocksOnly?: boolean;
  /** Identity of the disk being imaged, persisted in the image header. */
  sourceDisk?: { model: string; serial: string };
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