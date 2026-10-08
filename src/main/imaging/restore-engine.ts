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
import { detectPartitionFilesystem, inferMbrTypes, inferTableTypeGuids } from './fs/file-browse';
import {
  detectMacriumFormat,
  readMacriumImage,
  macriumRestoreRefusal,
  macriumPartitionSize
} from './mrimg';
import { RestoreJob, RestoreJobProgress, RestoreJobResult, RestoreTarget, JobEncryption } from './imaging-job';
import { buildRestoreTablePlan, RestoreTableOptions, RestoreTablePlan } from './partition-table';
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
  if (detectMacriumFormat(imagePath)) {
    const info = readMacriumImage(imagePath);
    const refusal = macriumRestoreRefusal(info);
    if (refusal) throw new Error(refusal);
    const partitions = info.partitions.map((p, index) => ({
      index,
      size: macriumPartitionSize(p),
      fsType: detectPartitionFilesystem(imagePath, index).fsType,
      offsetOnDisk: p.offsetOnDisk ?? 0,
      blockCount: p.blockCount
    }));
    return {
      totalSize: partitions.reduce((sum, p) => sum + p.size, 0),
      partitions,
      backupDate: info.backupTime
        ? new Date(info.backupTime * 1000).toISOString()
        : fs.statSync(imagePath).mtime.toISOString(),
      compressionId: 0,
      flags: 0,
      blockSize: info.partitions[0]?.blockSize ?? 0,
      blocks: info.partitions.reduce((sum, p) => sum + p.blockCount, 0),
      // Container refusals above guarantee an unencrypted image; `incremental`
      // stays false because a Macrium chain member resolves to a full logical
      // volume on its own (the flag drives the .opbs delta-chain UI).
      encrypted: false,
      incremental: false
    };
  }
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
 * Normalized view of a restore source — an `.opbs` chain or a Macrium
 * container — so `buildJob` can place partitions, guard the same disk and
 * plan a fresh table without caring which container it is reading.
 */
interface RestoreSourceView {
  partitions: Array<{ partitionIndex: number; size: number; offsetOnDisk: number; blockCount: number }>;
  sourceDiskModel: string;
  sourceDiskSerial: string;
  /** Key for an encrypted `.opbs` source (Macrium containers refuse encryption). */
  detectKey?: Buffer;
  chain: string[];
  /** Decompression id used only to default the thread count (Macrium: none). */
  compressionId: number;
  isMacrium: boolean;
}

function opbsRestoreSource(config: RestoreJobConfig, chain: string[]): RestoreSourceView {
  const info = readImageInfo(config.imagePath);
  return {
    partitions: info.partitions.map((p) => ({
      partitionIndex: p.partitionIndex,
      size: p.size,
      offsetOnDisk: p.offsetOnDisk,
      blockCount: p.blockCount
    })),
    sourceDiskModel: info.header.sourceDiskModel ?? '',
    sourceDiskSerial: info.header.sourceDiskSerial ?? '',
    detectKey:
      config.passphrase && info.header.cipherId !== CIPHER_NONE
        ? deriveImageKey(config.passphrase, info.header.salt, info.header.kdfIterations)
        : undefined,
    chain,
    compressionId: info.header.compressionId,
    isMacrium: false
  };
}

function macriumRestoreSource(config: RestoreJobConfig): RestoreSourceView {
  const info = readMacriumImage(config.imagePath);
  const refusal = macriumRestoreRefusal(info);
  if (refusal) throw new Error(refusal);
  return {
    // Partition index is the position in `info.partitions` — the same key the
    // Macrium partition reader consumes.
    partitions: info.partitions.map((p, index) => ({
      partitionIndex: index,
      size: macriumPartitionSize(p),
      offsetOnDisk: p.offsetOnDisk ?? 0,
      blockCount: p.blockCount
    })),
    sourceDiskModel: '',
    sourceDiskSerial: '',
    detectKey: undefined,
    chain: [config.imagePath],
    compressionId: COMPRESSION_NONE,
    isMacrium: true
  };
}

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

    const isMacrium = detectMacriumFormat(config.imagePath) !== null;
    let chain: string[];
    if (isMacrium) {
      if (Array.isArray(config.applyDeltas) && config.applyDeltas.length > 0) {
        throw new Error('Macrium restore takes a single image file; delta chains are not supported.');
      }
      chain = [config.imagePath];
    } else if (Array.isArray(config.applyDeltas)) {
      chain = [config.imagePath, ...config.applyDeltas];
    } else if (config.applyDeltas === false) {
      chain = [config.imagePath];
    } else {
      chain = resolveImageChain(config.imagePath);
    }

    const source = isMacrium ? macriumRestoreSource(config) : opbsRestoreSource(config, chain);
    const targets: RestoreTarget[] = [];

    const layoutByPartition = new Map<number, { offset: number; size?: number }>();
    if (config.targetLayout) {
      for (const item of config.targetLayout) {
        layoutByPartition.set(item.partitionIndex, { offset: item.offset, size: item.size });
      }
    }

    // Macrium containers do not always record where a partition lived on the
    // source disk (partial images, logical MBR partitions). Without a captured
    // offset — and no explicit override — the restore cannot place it.
    if (source.isMacrium) {
      for (const partitionIndex of config.targetPartitions) {
        if (layoutByPartition.has(partitionIndex)) continue;
        const part = source.partitions.find((p) => p.partitionIndex === partitionIndex);
        if (part && !(part.offsetOnDisk > 0)) {
          throw new Error(
            `Cannot determine the source on-disk offset of partition ${partitionIndex} in this Macrium image. ` +
              `Provide explicit placement (CLI: --layout ${partitionIndex}:<offsetBytes>).`
          );
        }
      }
    }

    for (const partitionIndex of config.targetPartitions) {
      const partition = source.partitions.find((p) => p.partitionIndex === partitionIndex);
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
      const partition = source.partitions.find((p) => p.partitionIndex === target.partitionIndex)!;
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
          const captured = source.partitions.find((p) => p.partitionIndex === t.partitionIndex)!;
          return t.offset !== captured.offsetOnDisk || (t.size !== undefined && t.size !== captured.size);
        })
      : false;

    // Source-disk identity guard: restoring to the *same physical disk* the
    // image came from (matched by serial) with a deviating layout overwrites
    // the source layout in place and cannot be undone, so it needs its own
    // explicit acknowledgement beyond the generic layout one.
    const sourceModel = source.sourceDiskModel;
    const sourceSerial = source.sourceDiskSerial;
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

    // A blank target (no partition table at all) must get a fresh table or
    // the restored volumes are invisible in Explorer — same rule as a blank
    // virtual disk. Probe through the native call directly so enumeration
    // errors (thrown) are treated as "not blank" and we never overwrite a
    // table that could not be inspected. Skipped when a deviating custom
    // layout or a virtual disk target already decides the table.
    let blankTarget = false;
    if (
      config.writePartitionTable !== false &&
      vhd == null &&
      config.targetDiskIndex != null &&
      !(config.targetLayout != null && deviatesFromCaptured)
    ) {
      try {
        blankTarget = this.diskEnumerator.isDiskBlank(config.targetDiskIndex);
      } catch {
        blankTarget = false;
      }
    }

    const detectKey = source.detectKey;

    // Table-type inference: probe the image contents for EFI System
    // Partitions (FAT32 with the spec-required \EFI directory) so a freshly
    // laid table is bootable in a VM — GPT type GUID 0xEF as ESP, MBR type
    // byte 0xEF, plus fs-based MBR type bytes. Explicit config values win.
    const willWriteTable =
      config.writePartitionTable !== false &&
      ((config.targetLayout != null && deviatesFromCaptured) || vhd != null || blankTarget);
    const inferredTypeGuids = willWriteTable
      ? inferTableTypeGuids(config.imagePath, targets.map((t) => t.partitionIndex), detectKey)
      : {};
    const tableTypeGuids = { ...inferredTypeGuids, ...config.tableTypeGuids };
    const mbrTypes = willWriteTable
      ? inferMbrTypes(config.imagePath, targets.map((t) => t.partitionIndex), detectKey)
      : {};
    for (const idx of Object.keys(inferredTypeGuids)) {
      mbrTypes[Number(idx)] = 0xef;
    }
    const espDetected = Object.keys(inferredTypeGuids).length > 0;

    // Build a fresh partition-table plan for the restored placements. In
    // auto mode prefer GPT for blank virtual disks and images that contain
    // an ESP — a UEFI-sourced restore must not silently become MBR. Fall
    // back to plain auto (MBR when representable) only when GPT cannot fit.
    const buildFreshTablePlan = (): RestoreTablePlan => {
      const placements = targets.map((t) => {
        const partition = source.partitions.find((p) => p.partitionIndex === t.partitionIndex)!;
        return { partitionIndex: t.partitionIndex, offset: t.offset, size: t.size ?? partition.size };
      });
      const requested = config.tableScheme || 'auto';
      const tableOptions: RestoreTableOptions = {
        scheme: requested,
        diskGuid: config.tableDiskGuid,
        typeGuids: tableTypeGuids,
        mbrTypes,
        bootPartition: config.tableBootPartition
      };
      if (requested !== 'auto') {
        return buildRestoreTablePlan(placements, targetDiskSize, tableOptions);
      }
      if (vhd != null || espDetected) {
        try {
          return buildRestoreTablePlan(placements, targetDiskSize, { ...tableOptions, scheme: 'gpt' });
        } catch {
          // GPT unrepresentable — plain auto below picks a fitting scheme.
        }
      }
      return buildRestoreTablePlan(placements, targetDiskSize, tableOptions);
    };

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
        const plan = buildFreshTablePlan();
        writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      }
    } else if ((vhd != null || blankTarget) && config.writePartitionTable !== false) {
      // A blank target starts without a partition table: without one the
      // restored volumes would be invisible in Explorer. Always lay it down
      // (nothing to destroy, so no acknowledgement gate is needed).
      const plan = buildFreshTablePlan();
      writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      if (vhd != null) {
        warnings.push(
          `A fresh ${plan.scheme.toUpperCase()} partition table will be written — the virtual disk is a blank target.`
        );
        if (config.targetDiskIndex == null) {
          warnings.push('Disk identity and same-disk checks run again after the virtual disk is attached.');
        }
      } else {
        warnings.push(
          `Target disk ${config.targetDiskIndex} has no partition table — a fresh ${plan.scheme.toUpperCase()} partition table will be written.`
        );
      }
    }
    if (warnings.length > 0) {
      logger.warn(warnings.join(' '));
    }

    const encryption: JobEncryption | undefined =
      config.passphrase && !source.isMacrium ? metadataFromCipher(newImageCipher(config.passphrase)) : undefined;

    // Default to a few worker threads for decompression when the image is
    // compressed; 0/synchronous preserves the simplest path. Macrium readers
    // decompress synchronously per block, so the default stays 0 there.
    const compressionThreads =
      config.compressionThreads ?? (source.compressionId !== COMPRESSION_NONE
        ? Math.max(1, Math.min(4, os.cpus().length - 1))
        : 0);

    logger.info(`Restore chain resolved: ${chain.join(' -> ')}`);

    return {
      type: 'restore',
      imagePath: config.imagePath,
      // `.opbs` images carry per-block CRCs for a pre-write pass; Macrium
      // containers are MD5-verified per block by the reader instead.
      verifyBeforeWrite: source.isMacrium ? false : config.verifyBeforeWrite !== false,
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