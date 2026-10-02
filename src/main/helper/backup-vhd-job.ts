import * as fs from 'fs';
import { logger } from '../utils/logger';
import type { PipeClient } from '../utils/pipe-ipc';
import { isVirtualDiskPath } from '../utils/virtual-disk';
import type { BackupJobConfig, BackupVhdJob } from '../imaging/backup-engine';
import type { JobResult } from '../imaging/imaging-job';
import { appendResultWarning, attachAndDiscoverDisk, detachWithRetries, errorMessage } from './vhd-attach';

/**
 * Elevated backup FROM a .vhd/.vhdx file. Runs in the helper process:
 *
 *   attach (read-only, no drive letter) → discover the disk index the virtual
 *   disk maps to → inject it into the config → build the ordinary backup job
 *   → run it → detach (only when we attached).
 *
 * The source is attached write-protected so the imaging path can never modify
 * the file it is reading.
 */

function writeResult(resultPath: string, pipeClient: PipeClient | undefined, result: JobResult): void {
  fs.writeFileSync(resultPath, JSON.stringify(result));
  pipeClient?.send({ type: 'result', ...result });
}

function failureResult(config: BackupJobConfig, start: number, error: string, warnings: string[]): JobResult {
  return {
    ok: false,
    error,
    imagePath: '',
    totalBytes: 0,
    bytesWritten: 0,
    durationMs: Date.now() - start,
    blocksWritten: 0,
    snapshotsCreated: 0,
    verifiedBlocks: 0,
    warnings
  };
}

/** Early phase feedback so the parent sees activity before the backup job
 *  takes over progress reporting. */
function reportPhase(progressPath: string, pipeClient: PipeClient | undefined, currentPartition: string): void {
  const progress = {
    phase: 'preparing',
    percent: 0,
    bytesDone: 0,
    totalBytes: 0,
    speed: 0,
    currentPartition,
    createdAt: Date.now()
  };
  try {
    fs.writeFileSync(progressPath, JSON.stringify(progress));
  } catch {
    /* best-effort */
  }
  pipeClient?.send({ type: 'progress', ...progress });
}

export async function runBackupVhdJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  nativeApi?: import('../imaging/imaging-job').NativeImagingApi,
  pipeClient?: PipeClient
): Promise<void> {
  const start = Date.now();
  const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as BackupVhdJob;
  const config = raw.config;
  const warnings: string[] = [];
  let attachedByUs = false;
  const vhdPath = config.sourceVirtualDisk ?? '';

  const fail = (error: string): void => {
    if (fs.existsSync(resultPath)) {
      return;
    }
    writeResult(resultPath, pipeClient, failureResult(config, start, error, warnings));
  };

  try {
    if (!vhdPath) {
      throw new Error('backup-vhd job is missing sourceVirtualDisk');
    }
    if (!isVirtualDiskPath(vhdPath)) {
      throw new Error(`Source is not a .vhd/.vhdx file: ${vhdPath}`);
    }
    if (!fs.existsSync(vhdPath)) {
      throw new Error(`Source virtual disk not found: ${vhdPath}`);
    }
    if (fs.existsSync(cancelPath)) {
      writeResult(resultPath, pipeClient, {
        ...failureResult(config, start, 'Backup cancelled by user', warnings),
        cancelled: true
      });
      return;
    }

    const discovery = await attachAndDiscoverDisk(vhdPath, {
      readOnly: true,
      report: (message) => reportPhase(progressPath, pipeClient, message)
    });
    attachedByUs = discovery.attachedByUs;
    const diskIndex = discovery.diskIndex;

    if (fs.existsSync(cancelPath)) {
      writeResult(resultPath, pipeClient, {
        ...failureResult(config, start, 'Backup cancelled by user', warnings),
        cancelled: true
      });
      return;
    }

    // Inject the discovered index and run the ordinary backup path.
    config.sourceDiskIndex = diskIndex;
    reportPhase(progressPath, pipeClient, `Building backup plan for virtual disk (disk ${diskIndex})…`);

    const { ImagingEngine } = await import('../imaging/backup-engine');
    const { DiskEnumerator } = await import('../utils/disk-enumerator');
    const engine = new ImagingEngine(new DiskEnumerator());
    const job = await engine.buildJob(config);
    fs.writeFileSync(jobPath, JSON.stringify(job));

    const { runBackupJob } = await import('./job-runner');
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, nativeApi, pipeClient);
  } catch (error) {
    const message = errorMessage(error);
    logger.error(`VHD backup failed: ${message}`);
    fail(message);
  } finally {
    if (attachedByUs && vhdPath) {
      try {
        await detachWithRetries(vhdPath);
        logger.info(`Detached virtual disk ${vhdPath}`);
      } catch (detachError) {
        const warning = `The backup finished but ${vhdPath} could not be detached: ${errorMessage(detachError)}`;
        logger.warn(warning);
        appendResultWarning(resultPath, warning);
      }
    }
  }
}
