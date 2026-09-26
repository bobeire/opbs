import { EventEmitter } from 'events';
import * as fs from 'fs';
import {
  BackupCoordinator,
  BackupJobConfig,
  mapJobProgress
} from '../imaging/backup-engine';
import { JobProgress, JobResult } from '../imaging/imaging-job';
import { normalizeBackupLocation } from '../utils/location';
import { recordBackupDestination } from '../utils/recent';
import { recordBackupAnalytics } from '../utils/backup-analytics';
import { buildParity } from '../imaging/parity';
import { checkMediaHealth } from '../utils/media-health';
import { isNonFilesystemLocation } from '../utils/location';
import { logger } from '../utils/logger';

export type BackupConfig = BackupJobConfig;

export interface BackupProgress {
  phase: 'preparing' | 'snapshotting' | 'backing_up' | 'verifying' | 'finalizing' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
  error?: string;
  /** True while a backup is continuing a previously interrupted image. */
  resuming?: boolean;
  /** Set on the 'completed' event: the image the wizard can then open/browse. */
  imagePath?: string;
}

export class BackupManager extends EventEmitter {
  private isRunning = false;
  private shouldCancel = false;
  private lastJobResult: JobResult | null = null;

  constructor(private coordinator: BackupCoordinator) {
    super();
  }

  get running(): boolean {
    return this.isRunning;
  }

  get lastResult(): JobResult | null {
    return this.lastJobResult;
  }

  async startBackup(config: BackupConfig): Promise<JobResult> {
    if (this.isRunning) {
      throw new Error('Backup already in progress');
    }

    this.isRunning = true;
    this.shouldCancel = false;

    try {
      await this.validateConfig(config);

      // Media-quality gate: refuse to write to a storage device that reports
      // SMART problems. Only *reported* problems block; drives whose SMART data
      // cannot be read are allowed through with a warning.
      if (!isNonFilesystemLocation(config.destinationPath)) {
        const media = await checkMediaHealth(config.destinationPath);
        if (media.blocked) {
          throw new Error(
            `Backup refused: the drive backing ${config.destinationPath} reports problems (${media.warnings.join(
              '; '
            )}). Run 'opbs media check' for the full disk report.`
          );
        }
        if (!media.measured && media.driveLetter) {
          logger.warn(
            `Media health not measurable for ${config.destinationPath} (${media.driveLetter}:) — continuing, but the drive's SMART data could not be read.`
          );
        }
      }

      this.emitProgress({
        phase: 'preparing',
        percentComplete: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: ''
      });

      const result = await this.coordinator.runBackup(config, (progress: JobProgress) => {
        if (this.shouldCancel) {
          void this.coordinator.cancel();
        }
        this.emitMapped(progress);
      });

      this.lastJobResult = result;

      if (!result.ok) {
        throw new Error(result.error ?? 'Backup failed');
      }

      recordBackupDestination(config.destinationPath);
      recordBackupAnalytics(config.destinationPath, result.imagePath, result);

      // Self-healing: build XOR parity sidecar for bit-rot protection. This
      // re-reads every block of the image and can take a long time on a large
      // backup. It used to run silently after the helper already reported
      // 100%/"completed", so the wizard sat on a finished-looking progress
      // bar with no way to reach the completion screen. Surface it as its
      // own phase so the user sees real activity, and build parity on the
      // next tick so the final 'completed' emit + IPC return are not held
      // hostage by the parity pass.
      this.emitProgress({
        phase: 'finalizing',
        percentComplete: 100,
        bytesProcessed: result.bytesWritten,
        totalBytes: result.totalBytes,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: 'Building parity recovery data…'
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        buildParity(result.imagePath);
      } catch (error) {
        logger.warn(`Could not build parity for ${result.imagePath}: ${error instanceof Error ? error.message : error}`);
      }

      this.emitProgress({
        phase: 'completed',
        percentComplete: 100,
        bytesProcessed: result.bytesWritten,
        totalBytes: result.totalBytes,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: '',
        imagePath: result.imagePath,
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

  async cancelBackup(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.shouldCancel = true;
    await this.coordinator.cancel();
  }

  private emitMapped(progress: JobProgress): void {
    const mapped = mapJobProgress(progress);
    this.emit('progress', mapped);
  }

  private emitProgress(progress: BackupProgress): void {
    this.emit('progress', progress);
  }

  private async validateConfig(config: BackupConfig): Promise<void> {
    if (!config.destinationPath) {
      throw new Error('Destination path is empty');
    }

    const destinationPath = normalizeBackupLocation(config.destinationPath);

    if (!fs.existsSync(destinationPath)) {
      throw new Error('Destination path does not exist');
    }

    const stats = fs.statSync(destinationPath);
    if (!stats.isDirectory()) {
      throw new Error('Destination path is not a directory');
    }

    if (config.sourcePartitions.length === 0) {
      throw new Error('No partitions selected for backup');
    }

    if (typeof config.sourceDiskIndex !== 'number' || config.sourceDiskIndex < 0) {
      throw new Error('Invalid source disk index');
    }
  }
}