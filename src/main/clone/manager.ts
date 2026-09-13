import { EventEmitter } from 'events';
import { CloneCoordinator, CloneJobConfig } from '../imaging/clone-engine';
import { CloneJobProgress, CloneJobResult } from '../imaging/imaging-job';
import { DiskEnumerator } from '../utils/disk-enumerator';

export type CloneConfig = CloneJobConfig;

export interface ClonePreflightResult {
  ok: boolean;
  error?: string;
  /** Total bytes required on the target disk (placed partition sizes). */
  requiredBytes?: number;
  /** Total size of the target physical disk. */
  targetDiskBytes?: number;
  targetDiskModel?: string;
  /** Existing partitions on the target disk that the copy will erase. */
  targetDiskPartitionCount?: number;
  targets?: Array<{ partitionIndex: number; offset: number; size: number }>;
  /** Partition-table scheme the copy would write on the target. */
  writeTableScheme?: string | null;
  /** Engine warnings from the layout/same-disk safety gates. */
  warnings?: string[];
  sameDisk?: boolean;
}

export interface CloneProgress {
  phase: 'preparing' | 'cloning' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  currentPartition: string;
  error?: string;
}

export class CloneManager extends EventEmitter {
  private isRunning = false;
  private shouldCancel = false;
  private lastJobResult: CloneJobResult | null = null;

  constructor(private coordinator: CloneCoordinator, private diskEnumerator = new DiskEnumerator()) {
    super();
  }

  get running(): boolean {
    return this.isRunning;
  }

  get lastResult(): CloneJobResult | null {
    return this.lastJobResult;
  }

  async startClone(config: CloneConfig): Promise<CloneJobResult> {
    if (this.isRunning) {
      throw new Error('Clone already in progress');
    }

    this.isRunning = true;
    this.shouldCancel = false;

    try {
      this.validateConfig(config);

      this.emitProgress({
        phase: 'preparing',
        percentComplete: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        speed: 0,
        currentPartition: ''
      });

      const result = await this.coordinator.runClone(config, (progress: CloneJobProgress) => {
        if (this.shouldCancel) {
          void this.coordinator.cancel();
        }
        this.emitProgress({
          phase: 'cloning',
          percentComplete: progress.percent,
          bytesProcessed: progress.bytesDone,
          totalBytes: progress.totalBytes,
          speed: progress.speed,
          currentPartition: progress.currentPartition
        });
      });

      this.lastJobResult = result;

      if (!result.ok) {
        throw new Error(result.error ?? 'Clone failed');
      }

      this.emitProgress({
        phase: 'completed',
        percentComplete: 100,
        bytesProcessed: result.bytesWritten,
        totalBytes: result.totalBytes,
        speed: 0,
        currentPartition: '',
        error: result.warnings.length > 0 ? result.warnings.join('; ') : undefined
      });

      return result;
    } catch (error) {
      this.emitProgress({
        phase: 'error',
        percentComplete: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        speed: 0,
        currentPartition: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async cancelClone(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.shouldCancel = true;
    await this.coordinator.cancel();
  }

  /**
   * Preflight / dry-run: builds the clone job (partition lookup, fit and
   * safety gates) WITHOUT writing a byte, then reports the plan so the UI
   * can warn about data loss and demand explicit acknowledgement.
   */
  async preflight(config: CloneConfig): Promise<ClonePreflightResult> {
    try {
      this.validateConfig(config);

      const job = await this.coordinator.buildJob(config);

      const sizeByIndex = new Map<number, number>(job.partitions.map((p) => [p.partitionIndex, p.size]));

      let requiredBytes = 0;
      const targets = job.targets.map((t) => {
        const size = t.size ?? sizeByIndex.get(t.partitionIndex) ?? 0;
        requiredBytes += size;
        return { partitionIndex: t.partitionIndex, offset: t.offset, size };
      });

      const disks = await this.diskEnumerator.getDisks();
      const targetDisk = disks.find((d) => d.index === config.targetDiskIndex);

      const warnings = [...(job.warnings ?? [])];
      const targetDiskPartitionCount = targetDisk?.partitions.length ?? 0;
      if (targetDiskPartitionCount > 0) {
        warnings.push(
          `Target disk already has ${targetDiskPartitionCount} partition(s); the copy writes a fresh partition table and erases them.`
        );
      }

      return {
        ok: true,
        requiredBytes,
        targetDiskBytes: targetDisk?.size ?? 0,
        targetDiskModel: targetDisk?.model,
        targetDiskPartitionCount,
        targets,
        writeTableScheme: job.writeTable?.scheme ?? null,
        warnings,
        sameDisk: (job.warnings ?? []).some((w) => w.includes('same disk'))
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private emitProgress(progress: CloneProgress): void {
    this.emit('progress', progress);
  }

  private validateConfig(config: CloneConfig): void {
    if (typeof config.sourceDiskIndex !== 'number' || config.sourceDiskIndex < 0) {
      throw new Error('Invalid source disk index');
    }
    if (typeof config.targetDiskIndex !== 'number' || config.targetDiskIndex < 0) {
      throw new Error('Invalid target disk index');
    }
    if (config.sourceDiskIndex === config.targetDiskIndex) {
      throw new Error('Source and target disk cannot be the same disk');
    }
    if (!config.sourcePartitions || config.sourcePartitions.length === 0) {
      throw new Error('No partitions selected to copy');
    }
    if (!config.targetLayout || config.targetLayout.length === 0) {
      throw new Error('No target layout planned for the copy');
    }
  }
}