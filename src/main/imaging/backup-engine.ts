import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskEnumerator } from '../utils/disk-enumerator';
import { defaultImagePath, DEFAULT_BLOCK_SIZE, newImageCipher, metadataFromCipher, readImageInfo } from './image-format';
import { ImagingJob, JobProgress, JobResult, ImagingPartition, JobEncryption } from './imaging-job';
import { launchElevatedJob } from '../helper/launcher';
import { normalizeBackupLocation, isNonFilesystemLocation } from '../utils/location';
import { S3Store, resolveS3Config, S3Config } from '../utils/s3';
import { SftpStore, resolveSftpConfig, SftpConfig } from '../utils/sftp';
import { logger } from '../utils/logger';

export interface BackupJobConfig {
  sourceDiskIndex: number;
  sourcePartitions: number[];
  destinationPath: string;
  compressionLevel: number;
  verificationEnabled: boolean;
  blockSize?: number;
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
  /** Cloud S3 profile (region/keys/endpoint) for s3:// destinations. The
   *  destination URI still determines the bucket/prefix. */
  s3Profile?: Partial<S3Config>;
  /** Cloud SFTP profile (host/port/user/credentials) for sftp:// destinations. */
  sftpProfile?: Partial<SftpConfig>;
}

export interface BackupCoordinator {
  runBackup(config: BackupJobConfig, onProgress: (p: JobProgress) => void): Promise<JobResult>;
  cancel(): Promise<void>;
}

type LaunchedBackupJob = ReturnType<typeof launchElevatedJob<ImagingJob, JobProgress, JobResult>>;

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
      const volumeDevicePath = await this.diskEnumerator.getVolumePath(diskIndex, part.offset);
      items.push({
        diskIndex,
        partitionIndex: part.partitionIndex,
        size: part.size,
        offset: part.offset,
        label: part.label ?? `Partition ${part.partitionIndex}`,
        readSource: volumeDevicePath ? 'volume' : 'physical',
        volumeDevicePath: volumeDevicePath ?? undefined
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
    // Non-filesystem destinations (S3/SFTP): write the image to a local temp
    // dir, then upload it after the job completes.
    let streamTempDir: string | undefined;
    if (isNonFilesystemLocation(config.destinationPath)) {
      if (config.destinationPath.startsWith('s3://') || config.destinationPath.startsWith('sftp://')) {
        streamTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-stream-'));
      } else {
        throw new Error(
          `Destination '${config.destinationPath}' is not a filesystem path; S3 and SFTP are supported, FTP is not yet`
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
    if (useUsnJournal) {
      if (config.baseImagePath) {
        try {
          const sidecar = JSON.parse(fs.readFileSync(`${config.baseImagePath}.usn`, 'utf-8')) as {
            volume: string;
            usn: string;
          };
          usnVolume = sidecar.volume;
          usnLastUsn = Number(sidecar.usn);
        } catch {
          useUsnJournal = false; // no sidecar: fall back to a full scan
        }
      }
      if (!usnVolume) {
        const volPart = items.find((p) => p.readSource === 'volume' && p.volumeDevicePath);
        if (volPart?.volumeDevicePath) {
          usnVolume = volPart.volumeDevicePath;
        } else {
          useUsnJournal = false; // no volume path to query
        }
      }
    }

    return {
      type: 'backup',
      imagePath: defaultImagePath(destDir, diskIndex),
      blockSize: config.blockSize ?? DEFAULT_BLOCK_SIZE,
      compressionLevel,
      compressionType: config.compressionType,
      compressionThreads,
      verificationEnabled: config.verificationEnabled,
      partitions: items,
      baseImagePath: config.baseImagePath,
      encryption,
      ...(config.usedBlocksOnly ? { usedBlocksOnly: true } : {}),
      ...(useUsnJournal && usnVolume ? { useUsnJournal, usnVolume, usnLastUsn } : {}),
      sourceDisk: sourceDiskIdentity
    };
  }

  async runBackup(config: BackupJobConfig, onProgress: (p: JobProgress) => void): Promise<JobResult> {
    const job = await this.buildJob(config);

    logger.info(`Starting elevated backup to ${job.imagePath}`, {
      partitions: job.partitions.length,
      totalBytes: job.partitions.reduce((s, p) => s + p.size, 0)
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
    try {
      fs.rmSync(path.dirname(imagePath), { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
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
  phase: 'preparing' | 'snapshotting' | 'backing_up' | 'verifying' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
} {
  let phase: 'preparing' | 'snapshotting' | 'backing_up' | 'verifying' | 'completed' | 'error';
  switch (jobProgress.phase) {
    case 'snapshotting':
      phase = 'snapshotting';
      break;
    case 'reading':
    case 'writing-index':
      phase = 'backing_up';
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
    currentPartition: jobProgress.currentPartition
  };
}