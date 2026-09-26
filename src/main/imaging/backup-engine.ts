import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskEnumerator } from '../utils/disk-enumerator';
import {
  defaultImagePath,
  DEFAULT_BLOCK_SIZE,
  newImageCipher,
  metadataFromCipher,
  readImageInfo,
  scanPartialImage,
  getCompressionId,
  CIPHER_NONE,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_RESUMED
} from './image-format';
import { ImagingJob, JobProgress, JobResult, ImagingPartition, JobEncryption, ResumeCheckpoint } from './imaging-job';
import { launchElevatedJob } from '../helper/launcher';
import { canUseVssSnapshot } from '../utils/disk-tools';
import { normalizeBackupLocation, isNonFilesystemLocation, detectFilesystemType, getMaxVolumeSizeForFs } from '../utils/location';
import { S3Store, resolveS3Config, S3Config } from '../utils/s3';
import { SftpStore, resolveSftpConfig, SftpConfig } from '../utils/sftp';
import { FtpStore, resolveFtpConfig, FtpConfig } from '../utils/ftp';
import { logger } from '../utils/logger';

export interface BackupJobConfig {
  sourceDiskIndex: number;
  sourcePartitions: number[];
  destinationPath: string;
  compressionLevel: number;
  verificationEnabled: boolean;
  blockSize?: number;
  /** Custom base name for the image file (without extension). When omitted a
   *  timestamped default (`opbs-diskN-<date>.opbs`) is used. */
  imageName?: string;
  /** Full path of a previous image to build an incremental delta against. */
  baseImagePath?: string;
  /** Optional passphrase; enables AES-256-GCM encryption of the image. */
  passphrase?: string;
  /** Compression algorithm (defaults to deflate when level > 0). */
  compressionType?: 'deflate' | 'zstd';
  /** Worker threads for multithreaded compression (0/unset = synchronous). */
  compressionThreads?: number;
  /** Use the USN journal to read only changed blocks for an incremental. */
  useUsnJournal?: boolean;
  /** Only capture blocks containing allocated clusters (NTFS $Bitmap). Free
   *  space is skipped; non-NTFS partitions fall back to a full capture. */
  usedBlocksOnly?: boolean;
  /** Maximum size in bytes for each volume file (0 = no splitting).
   *  Auto-detected from the destination filesystem (FAT32 → 3.9 GB). */
  maxVolumeSize?: number;
  /** Cloud S3 profile (region/keys/endpoint) for s3:// destinations. The
   *  destination URI still determines the bucket/prefix. */
  s3Profile?: Partial<S3Config>;
  /** Cloud SFTP profile (host/port/user/credentials) for sftp:// destinations. */
  sftpProfile?: Partial<SftpConfig>;
  /** Cloud FTP/FTPS profile (host/port/user/password/TLS mode) for ftp://
   *  destinations. The destination URI still determines the remote path. */
  ftpProfile?: Partial<FtpConfig>;
  /** When set, an interrupted backup to a local filesystem destination is
   *  continued from the partial image already present at the target path
   *  instead of starting fresh. Completed partitions are kept and the run
   *  resumes at the next partition boundary. */
  resume?: boolean;
}

export interface BackupCoordinator {
  runBackup(config: BackupJobConfig, onProgress: (p: JobProgress) => void): Promise<JobResult>;
  cancel(): Promise<void>;
}

type LaunchedBackupJob = ReturnType<typeof launchElevatedJob<ImagingJob, JobProgress, JobResult>>;

/**
 * Sanitise a user-supplied image name: strip any directory components and
 * characters that are invalid in Windows filenames, and drop a trailing
 * `.opbs` extension (it is appended by the caller).
 */
function sanitizeImageName(name: string): string {
  const base = path.basename(name.trim());
  const withoutExt = base.replace(/\.opbs$/i, '');
  const cleaned = withoutExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return cleaned || `opbs-${Date.now()}`;
}

export class ImagingEngine implements BackupCoordinator {
  private current: LaunchedBackupJob | null = null;

  constructor(private diskEnumerator: DiskEnumerator) {}

  async buildJob(config: BackupJobConfig): Promise<ImagingJob> {
    const diskIndex = config.sourceDiskIndex;

    const partitions = await this.diskEnumerator.getPartitions(diskIndex);
    const selected = partitions.filter((p) => config.sourcePartitions.includes(p.partitionIndex));

    if (selected.length === 0) {
      throw new Error(
        `No matching partitions on disk ${diskIndex}. Found ${partitions.length}, requested ${config.sourcePartitions.length}.`
      );
    }

    const items: ImagingPartition[] = [];
    for (const part of selected) {
      const ineligibleRawType = !part.driveLetter && !canUseVssSnapshot(part);
      const volumeDevicePath = ineligibleRawType
        ? null
        : await this.diskEnumerator.getVolumePath(diskIndex, part.offset);
      items.push({
        diskIndex,
        partitionIndex: part.partitionIndex,
        size: part.size,
        offset: part.offset,
        label: part.label ?? `Partition ${part.partitionIndex}`,
        readSource: volumeDevicePath ? 'volume' : 'physical',
        volumeDevicePath: volumeDevicePath ?? undefined,
        driveLetter: part.driveLetter || undefined
      });
    }

    // Record the source disk's identity so restores can guard against writing a
    // new partition table back onto the very disk the image came from.
    const disks = await this.diskEnumerator.getDisks();
    const sourceDisk = disks.find((d) => d.index === diskIndex);
    const sourceDiskIdentity =
      sourceDisk && (sourceDisk.model || sourceDisk.serial)
        ? { model: sourceDisk.model ?? '', serial: sourceDisk.serial ?? '' }
        : undefined;

    if (config.baseImagePath) {
      const baseInfo = readImageInfo(config.baseImagePath);
      if (baseInfo.header.partitionCount !== items.length) {
        throw new Error(
          `Base image partition count (${baseInfo.header.partitionCount}) does not match selection (${items.length})`
        );
      }
    }

    const destinationDir = normalizeBackupLocation(config.destinationPath);
    // Non-filesystem destinations (S3/SFTP/FTP): write the image to a local temp
    // dir, then upload it after the job completes.
    let streamTempDir: string | undefined;
    if (isNonFilesystemLocation(config.destinationPath)) {
      if (config.destinationPath.startsWith('s3://') || config.destinationPath.startsWith('sftp://') || config.destinationPath.startsWith('ftp://')) {
        streamTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-stream-'));
      } else {
        throw new Error(
          `Destination '${config.destinationPath}' is not a filesystem path; S3, SFTP and FTP are supported`
        );
      }
    }
    const destDir = streamTempDir ?? destinationDir;
    const destStats = fs.existsSync(destDir) ? fs.statSync(destDir) : null;
    if (!destStats || !destStats.isDirectory()) {
      throw new Error(`Destination is not an existing directory: ${destDir}`);
    }

    const encryption: JobEncryption | undefined = config.passphrase
      ? metadataFromCipher(newImageCipher(config.passphrase))
      : undefined;

    const compressionLevel = config.compressionLevel;
    // Default to multithreaded compression on the app path when compression is
    // enabled and the caller did not explicitly choose a thread count. The job
    // runner keeps a synchronous path for tests and callers that request 0/1.
    let compressionThreads = config.compressionThreads;
    if (compressionThreads === undefined && compressionLevel > 0) {
      compressionThreads = Math.max(1, Math.min(4, os.cpus().length - 1));
    }

    // USN-based changed-block tracking for incrementals. When enabled, read the
    // base image's journal sidecar to know where to start; the helper records the
    // new position after each run.
    let useUsnJournal = config.useUsnJournal;
    let usnVolume: string | undefined;
    let usnLastUsn: number | undefined;
    let perPartitionUsn: Record<number, { volume: string; lastUsn: number }> | undefined;
    if (useUsnJournal) {
      if (config.baseImagePath) {
        try {
          const raw = fs.readFileSync(`${config.baseImagePath}.usn`, 'utf-8');
          const sidecar = JSON.parse(raw);
          if (sidecar.version === 2 && Array.isArray(sidecar.partitions)) {
            // Multi-volume format: { version: 2, partitions: [{ partitionIndex, volume, usn }] }
            perPartitionUsn = {};
            for (const entry of sidecar.partitions) {
              perPartitionUsn[entry.partitionIndex] = {
                volume: entry.volume,
                lastUsn: Number(entry.usn)
              };
            }
          } else if (sidecar.volume && sidecar.usn) {
            // Legacy single-volume format: { volume, usn }
            usnVolume = sidecar.volume;
            usnLastUsn = Number(sidecar.usn);
          }
        } catch {
          useUsnJournal = false; // no sidecar: fall back to a full scan
        }
      }
      // If no sidecar data, discover volume paths from the partition list.
      // Build per-partition USN entries for all volume-backed partitions.
      if (!perPartitionUsn && !usnVolume) {
        const volParts = items.filter((p) => p.readSource === 'volume' && p.volumeDevicePath);
        if (volParts.length > 0) {
          // Multi-volume: build per-partition entries with no prior USN
          // (first incremental after enabling USN — full scan, but subsequent
          // runs will have per-partition cursors).
          perPartitionUsn = {};
          for (const vp of volParts) {
            perPartitionUsn[vp.partitionIndex] = {
              volume: vp.volumeDevicePath!,
              lastUsn: 0 // 0 = start of journal (full scan for this run)
            };
          }
        } else {
          useUsnJournal = false; // no volume path to query
        }
      }
    }

    // Resume support: if a partial image already exists at the target path and
    // its format settings match this job, resume from where the previous run
    // left off instead of starting fresh. Only block counts that are exactly
    // recoverable are reused (frames have self-describing headers); the block
    // index is rewritten at the end as usual.
    const imagePath = config.imageName
      ? path.join(destDir, `${sanitizeImageName(config.imageName)}.opbs`)
      : defaultImagePath(destDir, diskIndex);
    let resumeCheckpoint: ResumeCheckpoint | undefined;
    if (config.resume && fs.existsSync(imagePath)) {
      try {
        const scan = scanPartialImage(imagePath, items, config.blockSize ?? DEFAULT_BLOCK_SIZE);
        const compatible =
          !scan.complete &&
          scan.header.partitionCount === items.length &&
          scan.header.blockSize === (config.blockSize ?? DEFAULT_BLOCK_SIZE) &&
          scan.header.compressionId === getCompressionId(config.compressionLevel, config.compressionType) &&
          scan.header.cipherId === (encryption ? encryption.cipherId : CIPHER_NONE);

        if (compatible && scan.completedPartitions <= items.length && scan.blocks.length > 0) {
          const completed = scan.completedPartitions;
          const restartAtPartition = Math.min(completed, items.length);
          // Real (disk) partition indices that are fully written, so blocks kept
          // from the partial image are matched regardless of the selected subset
          // ordering in `items`.
          const keptIndexes = new Set<number>();
          for (let i = 0; i < restartAtPartition; i++) {
            keptIndexes.add(items[i].partitionIndex);
          }
          // Drop the partially-written frames of the interrupted partition so
          // that partition is restarted from a clean partition boundary.
          const keptBlocks = scan.blocks.filter((b) => keptIndexes.has(b.partitionIndex));
          const restartOffset =
            restartAtPartition < items.length
              ? (scan.partitionStartOffsets[restartAtPartition] ?? scan.cursor)
              : scan.cursor;

          resumeCheckpoint = {
            imagePath,
            cursor: restartOffset,
            completedPartitions: restartAtPartition,
            partitionBytes: 0,
            sourceBlockIndex: 0,
            blocksWritten: keptBlocks.length,
            bytesWritten: keptBlocks.reduce((s, b) => s + b.rawSize, 0),
            skippedBlocks: 0
          };
        }
      } catch {
        resumeCheckpoint = undefined; // not a resumable partial image
      }
    }

    // Multi-volume: auto-detect FAT32 and cap volume size at 3.9 GB, or use
    // the user's explicit maxVolumeSize if set.
    let maxVolumeSize = config.maxVolumeSize ?? 0;
    if (!maxVolumeSize && !isNonFilesystemLocation(config.destinationPath)) {
      const fsType = detectFilesystemType(destDir);
      logger.info(`Filesystem detection for ${destDir}: ${fsType ?? 'unknown'}`);
      maxVolumeSize = getMaxVolumeSizeForFs(fsType);
      if (maxVolumeSize > 0) {
        logger.info(`Destination filesystem is ${fsType}; splitting image into ${Math.ceil(maxVolumeSize / (1024 * 1024))} MB volumes`);
      }
    }

    return {
      type: 'backup',
      imagePath,
      blockSize: config.blockSize ?? DEFAULT_BLOCK_SIZE,
      compressionLevel,
      compressionType: config.compressionType,
      compressionThreads,
      verificationEnabled: config.verificationEnabled,
      partitions: items,
      baseImagePath: config.baseImagePath,
      encryption,
      ...(config.resume ? { resume: true } : {}),
      ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
      ...(config.usedBlocksOnly ? { usedBlocksOnly: true } : {}),
      ...(useUsnJournal && perPartitionUsn
        ? { useUsnJournal: true, perPartitionUsn }
        : useUsnJournal && usnVolume
          ? { useUsnJournal, usnVolume, usnLastUsn }
          : {}),
      sourceDisk: sourceDiskIdentity,
      ...(maxVolumeSize > 0 ? { maxVolumeSize } : {})
    };
  }

  async runBackup(config: BackupJobConfig, onProgress: (p: JobProgress) => void): Promise<JobResult> {
    const job = await this.buildJob(config);

    logger.info(`Starting elevated backup to ${job.imagePath}`, {
      partitions: job.partitions.length,
      totalBytes: job.partitions.reduce((s, p) => s + p.size, 0),
      usedBlocksOnly: !!job.usedBlocksOnly
    });

    const launched = launchElevatedJob<ImagingJob, JobProgress, JobResult>(job);
    this.current = launched;

    launched.onProgress(onProgress);

    try {
      const result = await launched.promise;
      if (result.ok && config.destinationPath.startsWith('s3://')) {
        await this.uploadImageToS3(config.destinationPath, result.imagePath, config.s3Profile);
      } else if (result.ok && config.destinationPath.startsWith('sftp://')) {
        await this.uploadImageToSftp(config.destinationPath, result.imagePath, config.sftpProfile);
      } else if (result.ok && config.destinationPath.startsWith('ftp://')) {
        await this.uploadImageToFtp(config.destinationPath, result.imagePath, config.ftpProfile);
      }
      return result;
    } finally {
      if (this.current === launched) {
        this.current = null;
      }
    }
  }

  /** Upload a locally-written image to S3 and remove the temp directory. */
  private async uploadImageToS3(
    uri: string,
    imagePath: string,
    profile?: Partial<S3Config>
  ): Promise<void> {
    const config = resolveS3Config(profile, uri);
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 access keys are required to upload to S3 (set the cloud profile in Settings or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)');
    }
    const store = new S3Store(config);
    const key = path.basename(imagePath);
    logger.info(`Uploading ${imagePath} to s3://${config.bucket}/${config.prefix ? config.prefix + '/' : ''}${key}`);
    await store.put(key, fs.readFileSync(imagePath));
    await this.uploadBitlockerSidecar(imagePath, (localPath, remoteKey) =>
      store.put(remoteKey, fs.readFileSync(localPath))
    );
    try {
      fs.rmSync(path.dirname(imagePath), { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }

  /**
   * Upload `<image>.bitlocker.json` next to the image when the helper wrote
   * one (encrypted backups). Runs after the image itself is safe: a sidecar
   * failure is logged loudly but never fails the completed backup.
   */
  private async uploadBitlockerSidecar(
    imagePath: string,
    put: (localPath: string, remoteKey: string) => Promise<void>
  ): Promise<void> {
    const sidecarPath = `${imagePath}.bitlocker.json`;
    if (!fs.existsSync(sidecarPath)) return;
    try {
      await put(sidecarPath, `${path.basename(imagePath)}.bitlocker.json`);
      logger.info(`Uploaded BitLocker key sidecar for ${path.basename(imagePath)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`BitLocker key sidecar upload failed for ${path.basename(imagePath)}: ${message}`);
    }
  }

  /** Upload a locally-written image to SFTP and remove the temp directory. */
  private async uploadImageToSftp(
    uri: string,
    imagePath: string,
    profile?: Partial<SftpConfig>
  ): Promise<void> {
    const config = resolveSftpConfig(profile, uri);
    if (!config.host) {
      throw new Error('SFTP destination requires a host (set the cloud profile in Settings or use sftp://user@host/path)');
    }
    if (!config.username) {
      throw new Error('SFTP destination requires a username (set the cloud profile in Settings or use sftp://user@host/path)');
    }
    if (!config.password && !config.privateKey) {
      throw new Error('SFTP credentials are required (set the cloud profile in Settings or SFTP_PASSWORD/SFTP_PRIVATE_KEY)');
    }
    const store = new SftpStore({ config });
    const key = path.basename(imagePath);
    logger.info(`Uploading ${imagePath} to sftp://${config.host}${config.remotePath ? '/' + config.remotePath : ''}/${key}`);
    await store.uploadFile(imagePath, key);
    await this.uploadBitlockerSidecar(imagePath, (localPath, remoteKey) => store.uploadFile(localPath, remoteKey));
    try {
      fs.rmSync(path.dirname(imagePath), { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }

  /** Upload a locally-written image to FTP/FTPS and remove the temp directory. */
  private async uploadImageToFtp(
    uri: string,
    imagePath: string,
    profile?: Partial<FtpConfig>
  ): Promise<void> {
    const config = resolveFtpConfig(profile, uri);
    if (!config.host) {
      throw new Error('FTP destination requires a host (set the cloud profile in Settings or use ftp://user@host/path)');
    }
    if (!config.username) {
      throw new Error('FTP destination requires a username (set the cloud profile in Settings or use ftp://user@host/path)');
    }
    if (!config.password) {
      throw new Error('FTP credentials are required (set the cloud profile in Settings or FTP_PASSWORD)');
    }
    const store = new FtpStore({ config });
    const key = path.basename(imagePath);
    logger.info(`Uploading ${imagePath} to ftp://${config.host}${config.remotePath ? '/' + config.remotePath : ''}/${key} (${config.secure})`);
    await store.uploadFile(imagePath, key);
    await this.uploadBitlockerSidecar(imagePath, (localPath, remoteKey) => store.uploadFile(localPath, remoteKey));
    try {
      fs.rmSync(path.dirname(imagePath), { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }

  async cancel(): Promise<void> {
    if (this.current) {
      this.current.cancel();
    }
  }
}

export function mapJobProgress(jobProgress: JobProgress): {
  phase: 'preparing' | 'snapshotting' | 'backing_up' | 'verifying' | 'finalizing' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
  resuming?: boolean;
  verifyDone?: number;
  verifyTotal?: number;
} {
  let phase: 'preparing' | 'snapshotting' | 'backing_up' | 'verifying' | 'finalizing' | 'completed' | 'error';
  switch (jobProgress.phase) {
    case 'snapshotting':
      phase = 'snapshotting';
      break;
    case 'reading':
      phase = 'backing_up';
      break;
    case 'writing-index':
      // Imaging bytes are done; the tail (block index, header patch) must not
      // masquerade as "Backing up" at a pinned 99%.
      phase = 'finalizing';
      break;
    case 'verifying':
      phase = 'verifying';
      break;
    case 'completed':
      phase = 'completed';
      break;
    default:
      phase = 'preparing';
  }

  const speed = jobProgress.speed || 0;
  const estimatedTimeRemaining =
    speed > 0 && jobProgress.totalBytes > 0
      ? (jobProgress.totalBytes - jobProgress.bytesDone) / speed
      : 0;

  return {
    phase,
    percentComplete: jobProgress.percent,
    bytesProcessed: jobProgress.bytesDone,
    totalBytes: jobProgress.totalBytes,
    speed,
    estimatedTimeRemaining,
    currentPartition: jobProgress.currentPartition,
    ...(jobProgress.resuming ? { resuming: true } : {}),
    ...(jobProgress.verifyTotal ? { verifyDone: jobProgress.verifyDone ?? 0, verifyTotal: jobProgress.verifyTotal } : {})
  };
}