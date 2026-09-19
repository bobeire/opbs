import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { resolvePowershell } from '../utils/elevated';
import { ensureHelperTaskRegistered, triggerHelperTask } from '../utils/task-scheduler';
import { PipeServer, generatePipeName, type PipeMessage } from '../utils/pipe-ipc';

export const HELPER_FLAG = '--opbs-helper';
export const PIPE_FLAG = '--pipe';

const STARTED_TIMEOUT_MS = 45000;
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
 * Spawn an elevated instance of this application to execute an imaging job.
 *
 * Primary IPC: Windows named pipe (real-time, no polling).
 * Fallback IPC: temp-file polling (if pipe creation fails).
 *
 * Pipe messages (NDJSON, helper → parent):
 *   { type: "started" }                         — elevation confirmed
 *   { type: "progress", phase, percent, ... }   — progress update
 *   { type: "result", ok, error, ... }          — job complete
 *   { type: "cancelled" }                       — cancel acknowledged
 */
export function launchElevatedJob<J, P, R>(job: J): JobLaunchOptions<P> & { promise: Promise<R>; cancel(): void } {
  const dir = newTempDir();
  const jobPath = path.join(dir, 'job.json');
  const resultPath = path.join(dir, 'result.json');
  const progressPath = path.join(dir, 'progress.json');
  const cancelPath = path.join(dir, 'cancel');
  const pipeName = generatePipeName();

  fs.writeFileSync(jobPath, JSON.stringify(job));

  const emitter = new EventEmitter();
  let cancelled = false;
  let settled = false;
  let pipeConnected = false;
  let pipeFailed = false;
  let pipeResult: unknown = null;

  const pipe = new PipeServer(pipeName);

  // --- Promise settlement ---
  let settle: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<R>((resolve, reject) => {
    settle = () => {
      if (settled) return;
      settled = true;
      if (pipeResult) {
        resolve(pipeResult as R);
        cleanup();
        return;
      }
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as R;
        resolve(result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      cleanup();
    };
    fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      cleanup();
    };
  });

  // --- Pipe message handler ---
  pipe.onMessage((msg: PipeMessage) => {
    switch (msg.type) {
      case 'started':
        if (!helperStarted) {
          helperStarted = true;
          clearInterval(startupTimer);
        }
        break;
      case 'progress':
        emitter.emit('progress', msg);
        break;
      case 'result':
        pipeResult = msg;
        settle();
        break;
      case 'cancelled':
        break;
    }
  });

  pipe.onError((err) => {
    logger.warn(`Pipe error: ${err.message}`);
    if (!settled && fs.existsSync(resultPath)) {
      settle();
    }
  });

  pipe.onClose(() => {
    if (!settled && fs.existsSync(resultPath)) {
      settle();
    }
  });

  // --- Cleanup ---
  const cleanup = (): void => {
    clearInterval(startupTimer);
    pipe.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  // --- Elevation confirmation timer (fallback if pipe doesn't connect) ---
  const startedAt = Date.now();
  let helperStarted = false;
  const startupTimer = setInterval(() => {
    if (!pipeConnected && !helperStarted) {
      if (fs.existsSync(progressPath) || fs.existsSync(resultPath)) {
        helperStarted = true;
        clearInterval(startupTimer);
      }
    }
    if (fs.existsSync(resultPath)) {
      settle();
      return;
    }
    if (!helperStarted && Date.now() - startedAt > STARTED_TIMEOUT_MS) {
      clearInterval(startupTimer);
      fail(new Error('Elevation was not confirmed. The job did not start.'));
    }
  }, 300);

  // --- Spawn helper ---
  const exe = process.execPath;
  const appPath = app.isPackaged ? undefined : app.getAppPath();

  (async (): Promise<void> => {
    // Try to start the pipe server.
    try {
      await pipe.start();
      logger.info(`Pipe server listening on ${pipeName}`);
    } catch (pipeError) {
      pipeFailed = true;
      logger.warn(`Pipe server creation failed, using file-based IPC: ${pipeError}`);
    }

    // Spawn the helper via task scheduler (primary) or UAC fallback.
    try {
      await ensureHelperTaskRegistered(exe, appPath);
      await triggerHelperTask(exe, jobPath, resultPath, progressPath, cancelPath, appPath,
        pipeFailed ? undefined : pipeName);
      logger.info('Launched helper via scheduled task (no UAC).');
    } catch (taskError) {
      logger.warn('Scheduled task launch failed, falling back to UAC:', taskError);
      const args = [
        ...(appPath ? [appPath] : []),
        HELPER_FLAG,
        jobPath,
        resultPath,
        progressPath,
        cancelPath,
        ...(pipeFailed ? [] : [PIPE_FLAG, pipeName])
      ].map(quotePowerShell);

      const psScript =
        `Start-Process -FilePath ${quotePowerShell(exe)} -ArgumentList @(${args.join(', ')}) ` +
        `-Verb RunAs -WindowStyle Hidden -PassThru`;

      logger.info(`Launching elevated helper (UAC fallback): ${psScript}`);
      const ps = spawn(resolvePowershell(), ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true
      });

      ps.on('error', (error) => {
        clearInterval(startupTimer);
        fail(error);
      });
    }
  })();

  // --- Cancel ---
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    logger.info('Cancellation requested for elevated job.');
    if (!pipe.send({ type: 'cancel' })) {
      try {
        fs.writeFileSync(cancelPath, '1');
      } catch {
        /* best-effort */
      }
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
