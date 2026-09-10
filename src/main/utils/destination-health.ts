import * as fs from 'fs';
import { scanBackupDirectory, planRetention, groupIntoChains } from '../backup/retention';
import { isNonFilesystemLocation } from './location';

export interface DestinationHealth {
  path: string;
  reachable: boolean;
  error?: string;
  freeBytes?: number;
  totalBytes?: number;
  imageCount: number;
  chainCount: number;
  newestDate?: number;
  oldestDate?: number;
  /** How many images retention would prune right now (only when autoCleanup). */
  plannedPrune: number;
}

export interface DestinationHealthOptions {
  keepFull: number;
  keepDeltasPerFull: number;
  retentionDays: number;
  autoCleanup: boolean;
}

/**
 * Health snapshot of a backup destination: free/total capacity from the
 * filesystem plus a retention simulation preview (nothing is deleted).
 * Cloud destinations (s3:// etc.) are skipped as they have no local disk.
 */
export async function destinationHealth(
  directory: string,
  options: DestinationHealthOptions
): Promise<DestinationHealth> {
  const result: DestinationHealth = {
    path: directory,
    reachable: false,
    imageCount: 0,
    chainCount: 0,
    plannedPrune: 0
  };

  if (isNonFilesystemLocation(directory)) {
    return result;
  }

  try {
    const disk = await fs.promises.statfs(directory);
    result.freeBytes = Number(disk.bavail) * Number(disk.bsize);
    result.totalBytes = Number(disk.blocks) * Number(disk.bsize);
  } catch {
    // Offline UNC/drive or unsupported volume; reachability is determined below.
  }

  try {
    const entries = scanBackupDirectory(directory);
    const chains = groupIntoChains(entries);
    result.imageCount = entries.length;
    result.chainCount = chains.length;

    const newest = chains[0];
    if (newest) {
      result.newestDate = newest.newestTimestamp;
    }
    const times = entries.map((e) => e.timestamp).filter((t) => t > 0);
    if (times.length > 0) {
      result.oldestDate = Math.min(...times);
    }

    if (options.autoCleanup) {
      const plan = planRetention(entries, {
        keepFull: options.keepFull,
        keepDeltasPerFull: options.keepDeltasPerFull,
        retentionDays: options.retentionDays
      });
      result.plannedPrune = plan.prune.length;
    }

    result.reachable = true;
  } catch (error) {
    result.reachable = false;
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}