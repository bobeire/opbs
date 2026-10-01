import { DiskEnumerator } from '../utils/disk-enumerator';
import { DEFAULT_BLOCK_SIZE } from './image-format';
import { CloneJob, CloneJobProgress, CloneJobResult, ImagingPartition, RestoreTarget } from './imaging-job';
import { buildRestoreTablePlan, GPT_EFI_SYSTEM_GUID, RestoreTableOptions, RestoreTablePlan } from './partition-table';
import { mbrTypeForFs } from './fs/file-browse';
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

    // A blank target (no partition table at all) must get a fresh table or
    // the cloned volumes are invisible in Windows — same rule as restore.
    // Skipped when a deviating custom layout already decides the table.
    let blankTarget = false;
    if (config.writePartitionTable !== false && !(config.targetLayout != null && deviatesFromCaptured)) {
      try {
        blankTarget = this.diskEnumerator.isDiskBlank(config.targetDiskIndex);
      } catch {
        blankTarget = false;
      }
    }

    const willWriteTable =
      config.writePartitionTable !== false &&
      ((config.targetLayout != null && deviatesFromCaptured) || blankTarget);

    // Source-side table-type inference (live disk, no image to probe): the
    // native enumerator maps GPT types to their MBR equivalents, so type 0xEF
    // marks an EFI System Partition — GPT gets the EFI type GUID and auto
    // prefers GPT so a UEFI source cannot silently become an unbootable MBR
    // clone. MBR type bytes come from the detected filesystem where a volume
    // exists, else the mapped source type (0xEE "unknown" falls back to the
    // generic 0x07). Explicit config tableTypeGuids always win.
    let espDetected = false;
    const mbrTypes: Record<number, number> = {};
    const espTypeGuids: Record<number, string> = {};
    if (willWriteTable) {
      for (const part of selected) {
        if (part.type === 0xef) {
          espTypeGuids[part.partitionIndex] = GPT_EFI_SYSTEM_GUID;
          mbrTypes[part.partitionIndex] = 0xef;
          espDetected = true;
          continue;
        }
        const fs = part.fsType;
        if (fs && fs !== 'Unknown') {
          mbrTypes[part.partitionIndex] = mbrTypeForFs(fs);
        } else {
          mbrTypes[part.partitionIndex] =
            part.type >= 1 && part.type <= 255 && part.type !== 0xee ? part.type : 0x07;
        }
      }
    }
    const tableTypeGuids = { ...espTypeGuids, ...config.tableTypeGuids };

    // Build a fresh partition-table plan for the cloned placements. In auto
    // mode prefer GPT when the source contains an ESP; fall back to plain
    // auto (MBR when representable) only when GPT cannot fit.
    const buildFreshTablePlan = (): RestoreTablePlan => {
      const placements = targets.map((t) => {
        const part = items.find((p) => p.partitionIndex === t.partitionIndex)!;
        return { partitionIndex: t.partitionIndex, offset: t.offset, size: t.size ?? part.size };
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
        return buildRestoreTablePlan(placements, targetDisk.size, tableOptions);
      }
      if (espDetected) {
        try {
          return buildRestoreTablePlan(placements, targetDisk.size, { ...tableOptions, scheme: 'gpt' });
        } catch {
          // GPT unrepresentable — plain auto below picks a fitting scheme.
        }
      }
      return buildRestoreTablePlan(placements, targetDisk.size, tableOptions);
    };

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
        const plan = buildFreshTablePlan();
        writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      }
    } else if (blankTarget && config.writePartitionTable !== false) {
      const plan = buildFreshTablePlan();
      writeTable = { scheme: plan.scheme, diskSize: plan.diskSize, entries: plan.entries, diskGuid: plan.diskGuid };
      warnings.push(
        `Target disk ${config.targetDiskIndex} has no partition table — a fresh ${plan.scheme.toUpperCase()} partition table will be written.`
      );
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