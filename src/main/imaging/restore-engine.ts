import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskEnumerator } from '../utils/disk-enumerator';
import {
  readImageInfo,
  newImageCipher,
  metadataFromCipher,
  deriveImageKey,
  resolveImageChain,
  FLAG_INCREMENTAL,
  COMPRESSION_NONE,
  CIPHER_NONE
} from './image-format';
import { detectPartitionFilesystem, inferTableTypeGuids } from './fs/file-browse';
import { RestoreJob, RestoreJobProgress, RestoreJobResult, RestoreTarget, JobEncryption } from './imaging-job';
import { buildRestoreTablePlan, RestoreTableOptions } from './partition-table';
import { launchElevatedJob } from '../helper/launcher';
import { logger } from '../utils/logger';
import { VirtualDiskTarget, resolveVirtualDiskSize } from '../utils/virtual-disk';

export { resolveImageChain };

export interface RestoreJobConfig {
  imagePath: string;
  /** Target physical disk. Required unless `targetVirtualDisk` is set (the
   *  elevated helper fills it in with the attached virtual disk's index). */
  targetDiskIndex?: number;
  /**
   * Restore into a .vhd/.vhdx file instead of a physical disk. When set, the
   * elevated helper creates the file if missing, attaches it, discovers the
   * resulting disk index and then runs the ordinary restore against it.
   */
  targetVirtualDisk?: VirtualDiskTarget;
  targetPartitions: number[];
  verifyBeforeWrite?: boolean;
  /** Optional passphrase required to read an encrypted image. */
  passphrase?: string;
  /** Include deltas to bring the restore up to date. Defaults to auto-resolving the chain. */
  applyDeltas?: boolean | string[];
  /** Worker threads for multithreaded restore decompression (0/unset = sync). */
  compressionThreads?: number;
  /** Dissimilar-hardware layout: override the on-disk offset (and optionally
   *  the size) for a partition. A larger size grows the filesystem on restore. */
  targetLayout?: Array<{ partitionIndex: number; offset: number; size?: number }>;
  /** Required when targetLayout moves a partition away from its captured
   *  on-disk offset: the restore writes a fresh GPT/MBR partition table and
   *  destroys whatever layout the target disk currently has.
   */
  acknowledgeLayout?: boolean;
  /**
   * Required when the target disk is the *same physical disk* the image came
   * from (matched by serial) and the custom layout moves a partition: the
   * restore then overwrites the source in place.
   */
  acknowledgeSameDisk?: boolean;
  /** Partition-table scheme for a dissimilar restore ('gpt' | 'mbr' | 'auto'). */
  tableScheme?: 'gpt' | 'mbr' | 'auto';
  /** Set to false to restore raw blocks without writing a partition table. */
  writePartitionTable?: boolean;
  /** Deterministic disk GUID for a GPT layout (defaults to a derived GUID). */
  tableDiskGuid?: string;
  /** Per-partition GPT type GUIDs keyed by image partition index. */
  tableTypeGuids?: Record<number, string>;
  /** Image partition index marked bootable for an MBR layout. */
  tableBootPartition?: number;
  /** Restore-drill: after writing, read back and validate the filesystems. */
  validateAfterWrite?: boolean;
  /** Post-restore CRC verify: read back every restored block and compare
   *  against the image's stored CRC. Catches silent disk write failures. */
  verifyAfterRestore?: boolean;
  /**
   * Zero target blocks absent from the image chain (used-blocks / delta gaps)
   * so free space cannot retain post-backup data. Defaults to true.
   */
  clearFreeSpace?: boolean;
}

export interface RestoreCoordinator {
  runRestore(config: RestoreJobConfig, onProgress: (p: RestoreJobProgress) => void): Promise<RestoreJobResult>;
  /** Build a restore job without writing anything: validates the image, the
   *  target disk size and the layout gates. Used for preflight/dry-run. */
  buildJob(config: RestoreJobConfig): Promise<RestoreJob>;
  cancel(): Promise<void>;
}

export interface ImageSummary {
  totalSize: number;
  partitions: Array<{
    index: number;
    size: number;
    fsType: string;
    offsetOnDisk: number;
    blockCount: number;
  }>;
  backupDate: string;
  compressionId: number;
  flags: number;
  blockSize: number;
  blocks: number;
  encrypted: boolean;
  incremental: boolean;
  baseImagePath?: string;
  /** Identity of the source disk, when the image recorded it. */
  sourceDisk?: { model: string; serial: string };
}

export function summarizeImage(imagePath: string): ImageSummary {
  const info = readImageInfo(imagePath);
  return {
    totalSize: info.header.totalBytes,
    partitions: info.partitions.map((p) => ({
      index: p.partitionIndex,
      size: p.size,
      fsType: detectPartitionFilesystem(imagePath, p.partitionIndex).fsType,
      offsetOnDisk: p.offsetOnDisk,
      blockCount: p.blockCount
    })),
    backupDate: new Date(info.header.timestamp).toISOString(),
    compressionId: info.header.compressionId,
    flags: info.header.flags,
    blockSize: info.header.blockSize,
    blocks: info.blocks.length,
    encrypted: info.header.cipherId !== 0,
    incremental: (info.header.flags & FLAG_INCREMENTAL) !== 0,
    baseImagePath: info.header.baseImagePath || undefined,
    sourceDisk:
      info.header.sourceDiskModel || info.header.sourceDiskSerial
        ? { model: info.header.sourceDiskModel, serial: info.header.sourceDiskSerial }
        : undefined
  };
}

type LaunchedRestoreJob = ReturnType<typeof launchElevatedJob<RestoreJob, RestoreJobProgress, RestoreJobResult>>;

/**
 * Elevated payload for a restore into a .vhd/.vhdx file. The helper creates
 * the file when missing, attaches it, discovers the disk index, injects it
 * into the config and then runs the ordinary restore job.
 */
export interface RestoreVhdJob {
  type: 'restore-vhd';
  config: RestoreJobConfig;
}

export class RestoreEngine implements RestoreCoordinator {
  private current: LaunchedRestoreJob | null = null;

  constructor(private diskEnumerator: DiskEnumerator) {}

  async buildJob(config: RestoreJobConfig): Promise<RestoreJob> {
    if (!fs.existsSync(config.imagePath)) {
      throw new Error(`Image file does not exist: ${config.imagePath}`);
    }

    let chain: string[];
    if (Array.isArray(config.applyDeltas)) {
      chain = [config.imagePath, ...config.applyDeltas];
    } else if (config.applyDeltas === false) {
      chain = [config.imagePath];
    } else {
      chain = resolveImageChain(config.imagePath);
    }

    const info = readImageInfo(config.imagePath);
    const targets: RestoreTarget[] = [];

    const layoutByPartition = new Map<number, { offset: number; size?: number }>();
    if (config.targetLayout) {
      for (const item of config.targetLayout) {
        layoutByPartition.set(item.partitionIndex, { offset: item.offset, size: item.size });
      }
    }

    for (const partitionIndex of config.targetPartitions) {
      const partition = info.partitions.find((p) => p.partitionIndex === partitionIndex);
      if (!partition) {
        throw new Error(`Image does not contain partition ${partitionIndex}`);
      }

      // Default target placement is the captured on-disk offset; a custom
      // targetLayout overrides it (dissimilar-hardware re-order/move).
      const layout = layoutByPartition.get(partitionIndex);
      const offset = layout?.offset ?? partition.offsetOnDisk;
      const size = layout?.size;
      if (size !== undefined && size < partition.size) {
        throw new Error(
          `Cannot shrink partition ${partitionIndex} from ${partition.size} to ${size} bytes (grow-on-restore only supports larger targets)`
        );
      }
      targets.push({
        partitionIndex,
        diskIndex: config.targetDiskIndex ?? -1,
        offset,
        size,
        label: `Partition ${partitionIndex}`
      });
    }

    // Sanity check: the target disk must be large enough for every placement.
    // A virtual-disk target before the helper attaches it has no disk entry —
    // size checks use the backing file's (or the configured) virtual capacity.
    const vhd = config.targetVirtualDisk;
    const disks = await this.diskEnumerator.getDisks();
    let targetDisk: (typeof disks)[number] | undefined;
    if (config.targetDiskIndex != null) {
      targetDisk = disks.find((d) => d.index === config.targetDiskIndex);
      if (!targetDisk) {
        throw new Error(`Target disk ${config.targetDiskIndex} not found`);
      }
    } else if (!vhd) {
      throw new Error('No target disk selected');
    }
    const targetDiskSize = targetDisk ? targetDisk.size : resolveVirtualDiskSize(vhd!);
    const targetLabel = targetDisk ? `target disk ${config.targetDiskIndex}` : `virtual disk ${vhd!.path}`;
    for (const target of targets) {
      const partition = info.partitions.find((p) => p.partitionIndex === target.partitionIndex)!;
      const size = target.size ?? partition.size;
      if (BigInt(target.offset) + BigInt(size) > BigInt(targetDiskSize)) {
        throw new Error(
          `Partition ${target.partitionIndex} (${size} bytes at offset ${target.offset}) does not fit on ${targetLabel} (${targetDiskSize} bytes)`
        );
      }
    }

    // Dissimilar-hardware safety gate: laying a new partition table and moving
    // partitions away from their captured offsets (or resizing them) destroys
    // the target disk's existing layout, so it must be explicitly acknowledged.
    const deviatesFromCaptured = config.targetLayout
      ? targets.some((t) => {
          const captured = info.partitions.find((p) => p.partitionIndex === t.partitionIndex)!;
          return t.offset !== captured.offsetOnDisk || (t.size !== undefined && t.size !== captured.size);
        })
      : false;

    // Source-disk identity guard: restoring to the *same physical disk* the
    // image came from (matched by serial) with a deviating layout overwrites
    // the source layout in place and cannot be undone, so it needs its own
    // explicit acknowledgement beyond the generic layout one.
    const sourceModel = info.header.sourceDiskModel ?? '';
    const sourceSerial = info.header.sourceDiskSerial ?? '';
    const targetModel = targetDisk?.model ?? '';
    const targetSerial = targetDisk?.serial ?? '';
    const warnings: string[] = [];

    const sameDisk = deviatesFromCaptured && sourceSerial !== '' && targetSerial === sourceSerial;
    if (sameDisk) {
      if (config.acknowledgeSameDisk !== true) {
        throw new Error(
          `Target disk ${config.targetDiskIndex} (${targetModel || 'unknown model'}, serial ${targetSerial}) is the same disk the image was taken from (serial ${sourceSerial}). ` +
            'A dissimilar restore overwrites the source layout in place and cannot be undone. ' +
            'Set acknowledgeSameDisk:true (CLI: --acknowledge-same-disk) to proceed.'
        );
      }
      warnings.push(`Target disk serial ${targetSerial} matches the source image's disk; restoring onto the imaged disk.`);
    } else if (
      deviatesFromCaptured &&
      sourceModel !== '' &&
      targetModel === sourceModel &&
      targetSerial !== sourceSerial
    ) {
      warnings.push(
        `Target disk model (${targetModel}) matches the source disk model of the image (${sourceModel}). ` +
          'If this is the same physical drive, restoring will overwrite the source; verify the target disk if unsure.'
      );
    }

    // GPT type-GUID inference: probe the image contents for EFI System
    // Partitions (FAT32 with the spec-required \EFI directory) so a freshly
    // laid table is bootable in a VM. Explicit tableTypeGuids always win.
    const willWriteTable =
      config.writePartitionTable !== false &&
      ((config.targetLayout != null && deviatesFromCaptured) || vhd != null);
    const tableTypeGuids = willWriteTable
      ? {
          ...inferTableTypeGuids(
            config.imagePath,
            targets.map((t) => t.partitionIndex),
            config.passphrase && info.header.cipherId !== CIPHER_NONE
              ? deriveImageKey(config.passphrase, info.header.salt, info.header.kdfIterations)
              : undefined
          ),
          ...config.tableTypeGuids
        }
      : config.tableTypeGuids;

    let writeTable: RestoreJob['writeTable'] = undefined;
    if (config.targetLayout && deviatesFromCaptured) {
      if (config.acknowledgeLayout !== true) {
        throw new Error(
          'The custom layout moves a partition away from its captured on-disk offset. ' +
            'This writes a fresh partition table and will erase the target disk\u2019s current layout. ' +
            'Set acknowledgeLayout:true (CLI: --confirm-layout) to proceed.'
        );
      }
      if (config.writePartitionTable !== false) {
        const tableOptions: RestoreTableOptions = {
          scheme: config.tableScheme ?? 'auto',
          diskGuid: config.tableDiskGuid,
          typeGuids: tableTypeGuids,
          bootPartition: config.tableBootPartition
        };
        const plan = buildRestoreTablePlan(
          targets.map((t) => {
            const partition = info.partitions.find((p) => p.partitionIndex === t.partitionIndex)!;
            return { partitionIndex: t.partitionIndex, offset: t.offset, size: t.size ?? partition.size };
          }),
          targetDiskSize,
          tableOptions
        );
        writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      }
    } else if (vhd && config.writePartitionTable !== false) {
      // A virtual disk starts blank: without a partition table the restored
      // volumes would be invisible in Explorer. Always lay one down (the
      // captured layout is not "destroyed" — there is nothing to destroy, so
      // no acknowledgement gate is needed). Prefer GPT for auto mode; fall
      // back to MBR when the layout cannot be represented as GPT.
      const tableOptions: RestoreTableOptions = {
        scheme: config.tableScheme ?? 'auto',
        diskGuid: config.tableDiskGuid,
        typeGuids: tableTypeGuids,
        bootPartition: config.tableBootPartition
      };
      const placements = targets.map((t) => {
        const partition = info.partitions.find((p) => p.partitionIndex === t.partitionIndex)!;
        return { partitionIndex: t.partitionIndex, offset: t.offset, size: t.size ?? partition.size };
      });
      let plan;
      try {
        plan = buildRestoreTablePlan(placements, targetDiskSize, {
          ...tableOptions,
          scheme: tableOptions.scheme === 'auto' ? 'gpt' : tableOptions.scheme
        });
      } catch (error) {
        if (tableOptions.scheme !== 'auto') {
          throw error;
        }
        plan = buildRestoreTablePlan(placements, targetDiskSize, tableOptions);
      }
      writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      warnings.push(
        `A fresh ${plan.scheme.toUpperCase()} partition table will be written — the virtual disk is a blank target.`
      );
      if (config.targetDiskIndex == null) {
        warnings.push('Disk identity and same-disk checks run again after the virtual disk is attached.');
      }
    }
    if (warnings.length > 0) {
      logger.warn(warnings.join(' '));
    }

    const encryption: JobEncryption | undefined = config.passphrase
      ? metadataFromCipher(newImageCipher(config.passphrase))
      : undefined;

    // Default to a few worker threads for decompression when the image is
    // compressed; 0/synchronous preserves the simplest path.
    const compressionThreads =
      config.compressionThreads ?? (info.header.compressionId !== COMPRESSION_NONE
        ? Math.max(1, Math.min(4, os.cpus().length - 1))
        : 0);

    logger.info(`Restore chain resolved: ${chain.join(' -> ')}`);

    return {
      type: 'restore',
      imagePath: config.imagePath,
      verifyBeforeWrite: config.verifyBeforeWrite !== false,
      targets,
      applyDeltas: chain.slice(1),
      encryption,
      compressionThreads,
      writeTable,
      validateAfterWrite: config.validateAfterWrite,
      verifyAfterRestore: config.verifyAfterRestore,
      clearFreeSpace: config.clearFreeSpace !== false,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  async runRestore(config: RestoreJobConfig, onProgress: (p: RestoreJobProgress) => void): Promise<RestoreJobResult> {
    // Virtual-disk targets are prepared inside the elevated helper (create /
    // attach / discover), so the job file carries the raw config instead of a
    // pre-built restore job.
    const payload: RestoreJob | RestoreVhdJob = config.targetVirtualDisk
      ? { type: 'restore-vhd', config }
      : await this.buildJob(config);

    logger.info(`Starting elevated restore from ${config.imagePath}`, {
      targets: payload.type === 'restore' ? payload.targets.length : undefined,
      virtualDisk: config.targetVirtualDisk?.path
    });

    const launched = launchElevatedJob<RestoreJob | RestoreVhdJob, RestoreJobProgress, RestoreJobResult>(payload);
    this.current = launched;

    launched.onProgress(onProgress);

    try {
      return await launched.promise;
    } finally {
      if (this.current === launched) {
        this.current = null;
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.current) {
      this.current.cancel();
    }
  }
}

export function mapRestoreJobProgress(jobProgress: RestoreJobProgress): {
  phase: 'preparing' | 'reading_image' | 'restoring' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
} {
  let phase: 'preparing' | 'reading_image' | 'restoring' | 'completed' | 'error';
  switch (jobProgress.phase) {
    case 'reading-image':
    case 'verifying':
      phase = 'reading_image';
      break;
    case 'writing':
      phase = 'restoring';
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