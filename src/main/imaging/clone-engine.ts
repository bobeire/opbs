import { DiskEnumerator } from '../utils/disk-enumerator';
import { DEFAULT_BLOCK_SIZE } from './image-format';
import { CloneJob, CloneJobProgress, CloneJobResult, ImagingPartition, RestoreTarget } from './imaging-job';
import { buildRestoreTablePlan, RestoreTableOptions } from './partition-table';
import { launchElevatedJob } from '../helper/launcher';
import { logger } from '../utils/logger';
import { canUseVssSnapshot } from '../utils/disk-tools';

export interface CloneJobConfig {
  /** Source (imaged) disk. */
  sourceDiskIndex: number;
  /** Partition indexes on the source disk to clone. */
  sourcePartitions: number[];
  /** Target disk the partitions are written to. */
  targetDiskIndex: number;
  /** Skip free-space blocks (NTFS $Bitmap); non-NTFS falls back to a full copy. */
  usedBlocksOnly?: boolean;
  /** Capture block granularity (bytes). */
  blockSize?: number;
  /** Dissimilar layout: override the on-disk offset (and optionally the size)
   *  for a partition. A larger size grows the filesystem on clone. */
  targetLayout?: Array<{ partitionIndex: number; offset: number; size?: number }>;
  /** Required when targetLayout moves a partition: a fresh GPT/MBR partition
   *  table is written and the target disk's current layout is destroyed. */
  acknowledgeLayout?: boolean;
  /** Required when the target disk is the source disk (or shares its serial). */
  acknowledgeSameDisk?: boolean;
  /** Partition-table scheme for a dissimilar clone ('gpt' | 'mbr' | 'auto'). */
  tableScheme?: 'gpt' | 'mbr' | 'auto';
  /** Set to false to copy raw blocks without writing a partition table. */
  writePartitionTable?: boolean;
  tableDiskGuid?: string;
  tableTypeGuids?: Record<number, string>;
  tableBootPartition?: number;
}

export interface CloneCoordinator {
  buildJob(config: CloneJobConfig): Promise<CloneJob>;
  runClone(config: CloneJobConfig, onProgress: (p: CloneJobProgress) => void): Promise<CloneJobResult>;
  cancel(): Promise<void>;
}

type LaunchedCloneJob = ReturnType<typeof launchElevatedJob<CloneJob, CloneJobProgress, CloneJobResult>>;

export class CloneEngine implements CloneCoordinator {
  private current: LaunchedCloneJob | null = null;

  constructor(private diskEnumerator: DiskEnumerator) {}

  async buildJob(config: CloneJobConfig): Promise<CloneJob> {
    const partitions = await this.diskEnumerator.getPartitions(config.sourceDiskIndex);
    const selected = partitions.filter((p) => config.sourcePartitions.includes(p.partitionIndex));
    if (selected.length === 0) {
      throw new Error(
        `No matching partitions on source disk ${config.sourceDiskIndex}. ` +
          `Found ${partitions.length}, requested ${config.sourcePartitions.length}.`
      );
    }

    const items: ImagingPartition[] = [];
    for (const part of selected) {
      const ineligibleRawType = !part.driveLetter && !canUseVssSnapshot(part);
      const volumeDevicePath = ineligibleRawType
        ? null
        : await this.diskEnumerator.getVolumePath(config.sourceDiskIndex, part.offset);
      items.push({
        diskIndex: config.sourceDiskIndex,
        partitionIndex: part.partitionIndex,
        size: part.size,
        offset: part.offset,
        label: part.label ?? `Partition ${part.partitionIndex}`,
        readSource: volumeDevicePath ? 'volume' : 'physical',
        volumeDevicePath: volumeDevicePath ?? undefined
      });
    }

    const layoutByPartition = new Map<number, { offset: number; size?: number }>();
    if (config.targetLayout) {
      for (const item of config.targetLayout) {
        layoutByPartition.set(item.partitionIndex, { offset: item.offset, size: item.size });
      }
    }

    const targets: RestoreTarget[] = [];
    for (const part of items) {
      const layout = layoutByPartition.get(part.partitionIndex);
      const offset = layout?.offset ?? part.offset;
      const size = layout?.size;
      if (size !== undefined && size < part.size) {
        throw new Error(
          `Cannot shrink partition ${part.partitionIndex} from ${part.size} to ${size} bytes ` +
            '(grow-on-restore only supports larger targets)'
        );
      }
      targets.push({
        partitionIndex: part.partitionIndex,
        diskIndex: config.targetDiskIndex,
        offset,
        size,
        label: part.label
      });
    }

    // Sanity check: target disk exists and every placement fits.
    const disks = await this.diskEnumerator.getDisks();
    const targetDisk = disks.find((d) => d.index === config.targetDiskIndex);
    if (!targetDisk) {
      throw new Error(`Target disk ${config.targetDiskIndex} not found`);
    }
    for (const target of targets) {
      const part = items.find((p) => p.partitionIndex === target.partitionIndex)!;
      const size = target.size ?? part.size;
      if (BigInt(target.offset) + BigInt(size) > BigInt(targetDisk.size)) {
        throw new Error(
          `Partition ${target.partitionIndex} (${size} bytes at offset ${target.offset}) does not fit on ` +
            `target disk ${config.targetDiskIndex} (${targetDisk.size} bytes)`
        );
      }
    }

    // Dissimilar-layout gate: moving/resizing partitions requires a fresh
    // partition table and destroys the target disk's existing layout.
    const deviatesFromCaptured = config.targetLayout
      ? targets.some((t) => {
          const captured = items.find((p) => p.partitionIndex === t.partitionIndex)!;
          return t.offset !== captured.offset || (t.size !== undefined && t.size !== captured.size);
        })
      : false;

    // Source-identity guard: cloning onto the same physical disk (by index or
    // serial) with a deviating layout overwrites the source in place.
    const sourceDisk = disks.find((d) => d.index === config.sourceDiskIndex);
    const sourceSerial = sourceDisk?.serial ?? '';
    const targetSerial = targetDisk.serial ?? '';
    const warnings: string[] = [];

    const sameDisk =
      deviatesFromCaptured &&
      (config.targetDiskIndex === config.sourceDiskIndex || (sourceSerial !== '' && targetSerial === sourceSerial));
    if (sameDisk) {
      if (config.acknowledgeSameDisk !== true) {
        throw new Error(
          `Target disk ${config.targetDiskIndex} (${targetDisk.model || 'unknown model'}, serial ${targetSerial}) ` +
            `is the same disk the clone source (${sourceDisk?.model || 'unknown model'}, serial ${sourceSerial}) ` +
            'came from; cloning onto it with a custom layout overwrites the source in place. ' +
            'Set acknowledgeSameDisk:true (CLI: --acknowledge-same-disk) to proceed.'
        );
      }
      warnings.push(`Target disk is the clone's source disk; cloning onto the source disk in place.`);
    }

    let writeTable: CloneJob['writeTable'] = undefined;
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
          typeGuids: config.tableTypeGuids,
          bootPartition: config.tableBootPartition
        };
        const plan = buildRestoreTablePlan(
          targets.map((t) => {
            const part = items.find((p) => p.partitionIndex === t.partitionIndex)!;
            return { partitionIndex: t.partitionIndex, offset: t.offset, size: t.size ?? part.size };
          }),
          targetDisk.size,
          tableOptions
        );
        writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      }
    }

    if (warnings.length > 0) {
      logger.warn(warnings.join(' '));
    }

    return {
      type: 'clone',
      sourceDiskIndex: config.sourceDiskIndex,
      partitions: items,
      targets,
      blockSize: config.blockSize ?? DEFAULT_BLOCK_SIZE,
      usedBlocksOnly: config.usedBlocksOnly,
      writeTable,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  async runClone(config: CloneJobConfig, onProgress: (p: CloneJobProgress) => void): Promise<CloneJobResult> {
    const job = await this.buildJob(config);

    logger.info(`Starting elevated clone disk ${job.sourceDiskIndex} -> disk ${job.targets[0].diskIndex}`, {
      partitions: job.targets.length
    });

    const launched = launchElevatedJob<CloneJob, CloneJobProgress, CloneJobResult>(job);
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