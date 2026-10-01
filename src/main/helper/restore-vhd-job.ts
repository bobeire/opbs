import * as fs from 'fs';
import { logger } from '../utils/logger';
import { loadNative } from '../utils/native-loader';
import type { PipeClient } from '../utils/pipe-ipc';
import {
  attachVirtualDiskFile,
  createVirtualDiskFile,
  detachVirtualDiskFile,
  discoverAttachedDiskIndex,
  parsePhysicalDriveIndex,
  readVirtualDiskInfo,
  virtualDiskPhysicalPath
} from '../utils/virtual-disk';
import type { RestoreJobConfig, RestoreVhdJob } from '../imaging/restore-engine';
import type { RestoreJobResult } from '../imaging/imaging-job';

/**
 * Elevated restore into a .vhd/.vhdx file. Runs in the helper process:
 *
 *   create file (when missing) → attach (no drive letter) → discover the disk
 *   index the virtual disk maps to → inject it into the config → build the
 *   ordinary restore job → run it → detach (only when we attached).
 *
 * The discovery prefers the exact `\\.\PhysicalDriveN` the virtdisk API
 * reports and falls back to a before/after disk-list diff; a pre-existing
 * physical disk can never be matched because only newly-appearing disks are
 * considered.
 */

const DISCOVERY_TIMEOUT_MS = 15000;
const DISCOVERY_POLL_MS = 250;
const DISK_APPEAR_TIMEOUT_MS = 8000;
const DETACH_RETRIES = 3;
const DETACH_RETRY_DELAY_MS = 500;

interface DiskLike {
  index: number;
  size: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function physicalDiskIndex(vhdPath: string): number | null {
  try {
    return parsePhysicalDriveIndex(virtualDiskPhysicalPath(vhdPath));
  } catch {
    return null;
  }
}

async function pollForAttachedDisk(before: DiskLike[], expectedSize: number): Promise<number | null> {
  const getDisks = loadNative<{ getDisks(): DiskLike[] }>();
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = discoverAttachedDiskIndex(before, getDisks.getDisks(), expectedSize);
    if (found !== null) {
      return found;
    }
    await sleep(DISCOVERY_POLL_MS);
  }
  return null;
}

async function waitForDiskToAppear(index: number): Promise<boolean> {
  const getDisks = loadNative<{ getDisks(): DiskLike[] }>();
  const deadline = Date.now() + DISK_APPEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (getDisks.getDisks().some((d) => d.index === index)) {
      return true;
    }
    await sleep(DISCOVERY_POLL_MS);
  }
  return getDisks.getDisks().some((d) => d.index === index);
}

/** Append a warning to an already-written result (best-effort: the parent
 *  may have consumed and removed the file already). */
function appendResultWarning(resultPath: string, warning: string): void {
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    result.warnings = [...(result.warnings ?? []), warning];
    fs.writeFileSync(resultPath, JSON.stringify(result));
  } catch {
    /* result already consumed or unreadable — log only */
  }
}

async function detachWithRetries(vhdPath: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DETACH_RETRIES; attempt++) {
    try {
      detachVirtualDiskFile(vhdPath);
      return;
    } catch (error) {
      lastError = error;
      await sleep(DETACH_RETRY_DELAY_MS);
    }
  }
  throw lastError;
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

    let info = readVirtualDiskInfo(vhd.path);
    let diskIndex: number | null = null;

    if (info.isLoaded) {
      reportPhase(progressPath, pipeClient, 'Virtual disk is already attached — locating it…');
      diskIndex = physicalDiskIndex(vhd.path);
    } else {
      const getDisks = loadNative<{ getDisks(): DiskLike[] }>();
      const before = getDisks.getDisks().map((d) => ({ index: d.index, size: d.size }));
      reportPhase(progressPath, pipeClient, 'Attaching virtual disk…');
      try {
        attachVirtualDiskFile(vhd.path);
        attachedByUs = true;
      } catch (attachError) {
        // A racing attach between the isLoaded check and our attempt leaves
        // the disk attached — that is still a state we can restore into.
        const after = readVirtualDiskInfo(vhd.path);
        if (!after.isLoaded) {
          throw attachError;
        }
        attachedByUs = true;
      }

      diskIndex = physicalDiskIndex(vhd.path);
      if (diskIndex === null) {
        info = readVirtualDiskInfo(vhd.path);
        diskIndex = await pollForAttachedDisk(before, info.virtualSize);
      }
    }

    if (diskIndex === null) {
      throw new Error(
        `Attached the virtual disk ${vhd.path} but could not determine which disk it maps to — detach it manually and retry`
      );
    }
    if (!(await waitForDiskToAppear(diskIndex))) {
      throw new Error(`Virtual disk attached as disk ${diskIndex} but the device never appeared`);
    }
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
