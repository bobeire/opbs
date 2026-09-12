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
import { logger } from '../utils/logger';

export type BackupConfig = BackupJobConfig;

export interface BackupProgress {
  phase: 'preparing' | 'snapshotting' | 'backing_up' | 'verifying' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
  error?: string;
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

      // Self-healing: build XOR parity sidecar for bit-rot protection.
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