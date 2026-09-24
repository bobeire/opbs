import { EventEmitter } from 'events';
import * as fs from 'fs';
import { RestoreCoordinator, RestoreJobConfig, mapRestoreJobProgress, summarizeImage, ImageSummary } from '../imaging/restore-engine';
import { RestoreJobProgress, RestoreJobResult } from '../imaging/imaging-job';
import { DiskEnumerator, querySystemDiskIndex } from '../utils/disk-enumerator';
import { logger } from '../utils/logger';

export type RestoreConfig = RestoreJobConfig;

export interface RestorePreflightResult {
  ok: boolean;
  error?: string;
  /** Total bytes required on the target disk (captured partition sizes). */
  requiredBytes?: number;
  /** Total size of the target physical disk. */
  targetDiskBytes?: number;
  targetDiskModel?: string;
  /** Existing partitions on the target disk that the restore will overwrite. */
  targetDiskPartitionCount?: number;
  targets?: Array<{ partitionIndex: number; offset: number; size: number }>;
  /** Partition-table scheme the restore would write when the layout deviates. */
  writeTableScheme?: string | null;
  /** Engine warnings from the layout/same-disk safety gates. */
  warnings?: string[];
  sameDisk?: boolean;
  encrypted?: boolean;
  passphraseRequired?: boolean;
  /** True when the target disk holds Windows (system/boot) — a reboot is
   *  required after restore; secondary disks do not need one. */
  targetIsSystemDisk?: boolean;
}

export interface RestoreProgress {
  phase: 'preparing' | 'reading_image' | 'restoring' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
  error?: string;
}

export class RestoreManager extends EventEmitter {
  private isRunning = false;
  private shouldCancel = false;
  private lastJobResult: RestoreJobResult | null = null;

  constructor(private coordinator: RestoreCoordinator, private diskEnumerator = new DiskEnumerator()) {
    super();
  }

  get running(): boolean {
    return this.isRunning;
  }

  get lastResult(): RestoreJobResult | null {
    return this.lastJobResult;
  }

  async startRestore(config: RestoreConfig): Promise<RestoreJobResult> {
    if (this.isRunning) {
      throw new Error('Restore already in progress');
    }

    this.isRunning = true;
    this.shouldCancel = false;

    try {
      await this.validateConfig(config);

      this.emitProgress({
        phase: 'preparing',
        percentComplete: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: ''
      });

      const result = await this.coordinator.runRestore(config, (progress: RestoreJobProgress) => {
        if (this.shouldCancel) {
          void this.coordinator.cancel();
        }
        this.emitMapped(progress);
      });

      this.lastJobResult = result;

      if (!result.ok) {
        throw new Error(result.error ?? 'Restore failed');
      }

      logger.info(
        `Restore completed: ${result.targetsRestored} target(s), ${result.bytesWritten} bytes in ${result.durationMs}ms` +
          (result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '')
      );
      if (result.warnings.length > 0) {
        logger.warn(`Restore warnings: ${result.warnings.join('; ')}`);
      }

      this.emitProgress({
        phase: 'completed',
        percentComplete: 100,
        bytesProcessed: result.bytesWritten,
        totalBytes: result.totalBytes,
        speed: 0,
        estimatedTimeRemaining: 0,
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
        estimatedTimeRemaining: 0,
        currentPartition: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async cancelRestore(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.shouldCancel = true;
    await this.coordinator.cancel();
  }

  getImageSummary(imagePath: string): ImageSummary {
    return summarizeImage(imagePath);
  }

  /**
   * Preflight / dry-run: builds the restore job (image check, chain resolution,
   * disk-size and layout safety gates) WITHOUT writing a single byte, then
   * reports the plan so the UI can warn about data loss and demand an
   * explicit acknowledgement before the real restore starts.
   */
  async preflight(config: RestoreConfig): Promise<RestorePreflightResult> {
    try {
      await this.validateConfig(config);

      const job = await this.coordinator.buildJob(config);

      const summary = this.getImageSummary(config.imagePath);
      const sizeByIndex = new Map<number, number>(summary.partitions.map((p) => [p.index, p.size]));

      let requiredBytes = 0;
      const targets = job.targets.map((t) => {
        const size = t.size ?? sizeByIndex.get(t.partitionIndex) ?? 0;
        requiredBytes += size;
        return { partitionIndex: t.partitionIndex, offset: t.offset, size };
      });

      const disks = await this.diskEnumerator.getDisks();
      const targetDisk = disks.find((d) => d.index === config.targetDiskIndex);
      const systemDrive = (process.env.SystemDrive || 'C:').replace(':', '').toUpperCase();
      let targetIsSystemDisk =
        (targetDisk?.partitions ?? []).some(
          (p) =>
            p.isSystem === true ||
            p.isBoot === true ||
            (p.driveLetter || '').replace(':', '').toUpperCase() === systemDrive
        ) ?? false;
      if (!targetIsSystemDisk) {
        const sysDisk = querySystemDiskIndex();
        targetIsSystemDisk = sysDisk !== null && sysDisk === config.targetDiskIndex;
      }

      const warnings = [...(job.warnings ?? [])];
      const encrypted = summary.encrypted;
      const passphraseRequired = encrypted && !(config.passphrase?.trim());
      if (passphraseRequired) {
        warnings.push('This image is encrypted; the passphrase is required to restore it.');
      }

      return {
        ok: true,
        requiredBytes,
        targetDiskBytes: targetDisk?.size ?? 0,
        targetDiskModel: targetDisk?.model,
        targetDiskPartitionCount: targetDisk?.partitions.length ?? 0,
        targets,
        writeTableScheme: job.writeTable?.scheme ?? null,
        warnings,
        sameDisk: (job.warnings ?? []).some((w) => w.includes('same disk the image')),
        encrypted,
        passphraseRequired,
        targetIsSystemDisk
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private emitMapped(progress: RestoreJobProgress): void {
    this.emit('progress', mapRestoreJobProgress(progress));
  }

  private emitProgress(progress: RestoreProgress): void {
    this.emit('progress', progress);
  }

  private async validateConfig(config: RestoreConfig): Promise<void> {
    if (!config.imagePath) {
      throw new Error('Image path is empty');
    }

    if (!fs.existsSync(config.imagePath)) {
      throw new Error('Image file does not exist');
    }

    if (!config.targetPartitions || config.targetPartitions.length === 0) {
      throw new Error('No target partitions selected');
    }

    if (typeof config.targetDiskIndex !== 'number' || config.targetDiskIndex < 0) {
      throw new Error('Invalid target disk index');
    }
  }
}