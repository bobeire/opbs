import { EventEmitter } from 'events';
import * as fs from 'fs';
import { RestoreCoordinator, RestoreJobConfig, mapRestoreJobProgress, summarizeImage, ImageSummary } from '../imaging/restore-engine';
import { RestoreJobProgress, RestoreJobResult } from '../imaging/imaging-job';

export type RestoreConfig = RestoreJobConfig;

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

  constructor(private coordinator: RestoreCoordinator) {
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