import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { resolvePowershell } from '../utils/elevated';

export const HELPER_FLAG = '--opbs-helper';

const STARTED_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;
const JOB_DIR_PREFIX = 'opbs-job-';

export interface JobLaunchOptions<P> {
  onProgress(cb: (p: P) => void): void;
}

function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function newTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), JOB_DIR_PREFIX));
  return dir;
}

/**
 * Spawn an elevated instance of this application to execute an imaging job
 * (backup or restore). See runBackupJob/runRestoreJob for the protocol.
 *
 * The parent and child communicate over a set of temporary JSON files:
 *
 *   - job.json     : the job description (written by us)
 *   - result.json  : final result written by the child
 *   - progress.json: updated by the child during the job
 *   - cancel       : cancellation request (written by us; child polls it)
 */
export function launchElevatedJob<J, P, R>(job: J): JobLaunchOptions<P> & { promise: Promise<R>; cancel(): void } {
  const dir = newTempDir();
  const jobPath = path.join(dir, 'job.json');
  const resultPath = path.join(dir, 'result.json');
  const progressPath = path.join(dir, 'progress.json');
  const cancelPath = path.join(dir, 'cancel');

  fs.writeFileSync(jobPath, JSON.stringify(job));

  const emitter = new EventEmitter();
  let cancelled = false;
  let settled = false;

  const poller = setInterval(() => {
    let progress: P | null = null;
    try {
      if (fs.existsSync(progressPath)) {
        progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8')) as P;
      }
    } catch {
      progress = null; // partial write; ignore
    }
    if (progress) {
      emitter.emit('progress', progress);
    }

    if (fs.existsSync(resultPath)) {
      stopPolling();
      settle();
    }
  }, POLL_INTERVAL_MS);

  const stopPolling = (): void => {
    clearInterval(poller);
  };

  let settle: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<R>((resolve, reject) => {
    settle = () => {
      if (settled) return;
      settled = true;
      let result: R;
      try {
        result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as R;
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        cleanup();
        return;
      }
      resolve(result);
      cleanup();
    };
    fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      cleanup();
    };
  });

  const cleanup = (): void => {
    stopPolling();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  };

  // The child process is our own binary. It must run elevated for raw disk
  // access and VSS, so it is relaunched through the UAC prompt.
  const args = [
    HELPER_FLAG,
    jobPath,
    resultPath,
    progressPath,
    cancelPath
  ].map(quotePowerShell);

  const exe = process.execPath;
  const psScript =
    `Start-Process -FilePath ${quotePowerShell(exe)} -ArgumentList @(${args.join(', ')}) ` +
    `-Verb RunAs -WindowStyle Hidden -PassThru`;

  logger.info(`Launching elevated helper: ${psScript}`);
  const ps = spawn(resolvePowershell(), ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    windowsHide: true
  });

  const startedAt = Date.now();
  const startupTimer = setInterval(() => {
    if (fs.existsSync(resultPath)) {
      clearInterval(startupTimer);
      settle();
      return;
    }
    if (Date.now() - startedAt > STARTED_TIMEOUT_MS) {
      clearInterval(startupTimer);
      fail(new Error('Elevation was not confirmed. The job did not start.'));
    }
  }, 300);

  ps.on('error', (error) => {
    clearInterval(startupTimer);
    fail(error);
  });

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    logger.info('Cancellation requested for elevated job.');
    try {
      fs.writeFileSync(cancelPath, '1');
    } catch {
      /* best-effort */
    }
  };

  return {
    promise,
    cancel,
    onProgress: (cb: (p: P) => void) => {
      emitter.on('progress', cb);
    }
  };
}