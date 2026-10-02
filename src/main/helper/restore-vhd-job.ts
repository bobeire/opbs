import * as fs from 'fs';
import { logger } from '../utils/logger';
import type { PipeClient } from '../utils/pipe-ipc';
import { createVirtualDiskFile } from '../utils/virtual-disk';
import type { RestoreJobConfig, RestoreVhdJob } from '../imaging/restore-engine';
import type { RestoreJobResult } from '../imaging/imaging-job';
import {
  appendResultWarning,
  attachAndDiscoverDisk,
  detachWithRetries,
  errorMessage
} from './vhd-attach';

/**
 * Elevated restore into a .vhd/.vhdx file. Runs in the helper process:
 *
 *   create file (when missing) → attach (no drive letter) → discover the disk
 *   index the virtual disk maps to → inject it into the config → build the
 *   ordinary restore job → run it → detach (only when we attached).
 *
 * The attach/discover plumbing lives in ./vhd-attach (shared with backup-from-
 * VHD sources).
 */

function writeResult(resultPath: string, pipeClient: PipeClient | undefined, result: RestoreJobResult): void {
  fs.writeFileSync(resultPath, JSON.stringify(result));
  pipeClient?.send({ type: 'result', ...result });
}

function failureResult(
  config: RestoreJobConfig,
  start: number,
  error: string,
  warnings: string[]
): RestoreJobResult {
  return {
    ok: false,
    error,
    imagePath: config.imagePath,
    totalBytes: 0,
    bytesWritten: 0,
    durationMs: Date.now() - start,
    blocksWritten: 0,
    targetsRestored: 0,
    verifiedBeforeWrite: false,
    warnings
  };
}

/** Early phase feedback so the parent sees activity before the restore job
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

export async function runRestoreVhdJob(
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  nativeApi?: import('../imaging/imaging-job').NativeImagingApi,
  pipeClient?: PipeClient
): Promise<void> {
  const start = Date.now();
  const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as RestoreVhdJob;
  const config = raw.config;
  const warnings: string[] = [];
  let attachedByUs = false;
  let vhdPath = config.targetVirtualDisk?.path ?? '';

  const fail = (error: string): void => {
    if (fs.existsSync(resultPath)) {
      return;
    }
    writeResult(resultPath, pipeClient, failureResult(config, start, error, warnings));
  };

  try {
    const vhd = config.targetVirtualDisk;
    if (!vhd || !vhd.path) {
      throw new Error('restore-vhd job is missing targetVirtualDisk.path');
    }
    vhdPath = vhd.path;
    const cancelled = fs.existsSync(cancelPath);
    if (cancelled) {
      writeResult(
        resultPath,
        pipeClient,
        { ...failureResult(config, start, 'Restore cancelled by user', warnings), cancelled: true }
      );
      return;
    }

    if (!fs.existsSync(vhd.path)) {
      reportPhase(
        progressPath,
        pipeClient,
        vhd.type === 'fixed'
          ? 'Creating fixed virtual disk (pre-allocating the full size — this can take a while)…'
          : 'Creating virtual disk…'
      );
      createVirtualDiskFile(vhd);
    }

    const discovery = await attachAndDiscoverDisk(vhd.path, {
      report: (message) => reportPhase(progressPath, pipeClient, message)
    });
    attachedByUs = discovery.attachedByUs;
    const diskIndex = discovery.diskIndex;

    if (fs.existsSync(cancelPath)) {
      writeResult(
        resultPath,
        pipeClient,
        { ...failureResult(config, start, 'Restore cancelled by user', warnings), cancelled: true }
      );
      return;
    }

    // Inject the discovered index and run the ordinary restore path.
    config.targetDiskIndex = diskIndex;
    reportPhase(progressPath, pipeClient, `Building restore plan for virtual disk (disk ${diskIndex})…`);

    const { RestoreEngine } = await import('../imaging/restore-engine');
    const { DiskEnumerator } = await import('../utils/disk-enumerator');
    const engine = new RestoreEngine(new DiskEnumerator());
    const job = await engine.buildJob(config);
    fs.writeFileSync(jobPath, JSON.stringify(job));

    const { runRestoreJob } = await import('./job-runner');
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, nativeApi, pipeClient);
  } catch (error) {
    const message = errorMessage(error);
    logger.error(`VHD restore failed: ${message}`);
    fail(message);
  } finally {
    if (attachedByUs && vhdPath) {
      try {
        await detachWithRetries(vhdPath);
        logger.info(`Detached virtual disk ${vhdPath}`);
      } catch (detachError) {
        const warning = `The restore finished but ${vhdPath} could not be detached: ${errorMessage(detachError)}`;
        logger.warn(warning);
        appendResultWarning(resultPath, warning);
      }
    }
  }
}
