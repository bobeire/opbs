import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { resolvePowershell } from '../utils/elevated';
import { ensureHelperTaskRegistered, triggerHelperTask, isRunAsAdmin } from '../utils/task-scheduler';
import { PipeServer, generatePipeName, type PipeMessage } from '../utils/pipe-ipc';

/**
 * `electron` is required lazily: the WinPE CLI (plain node.exe) imports
 * backup-engine, which imports this module, and a top-level `require('electron')`
 * would crash there. `launchElevatedJob` is only ever called from the Electron
 * main process, where the require resolves.
 */
function electronApp(): typeof import('electron').app {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron').app;
}

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
  const ioPath = path.join(dir, 'io.json');
  const pipeName = generatePipeName();

  fs.writeFileSync(jobPath, JSON.stringify(job));
  // The helper reads its I/O paths (and pipe name) from this sibling file.
  // Passing them on the command line overflows the 261-char schtasks /TR limit.
  fs.writeFileSync(ioPath, JSON.stringify({ resultPath, progressPath, cancelPath, pipeName }));

  const emitter = new EventEmitter();
  let cancelled = false;
  let settled = false;
  let pipeConnected = false;
  let pipeResult: unknown = null;
  let lastFileProgress = '';
  let lastProgressAt = 0;

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
        pipeConnected = true;
        helperStarted = true;
        // Keep startupTimer running: it doubles as the result.json watchdog
        // if the pipe later drops before the result message arrives.
        break;
      case 'progress':
        pipeConnected = true;
        lastProgressAt = Date.now();
        emitter.emit('progress', msg);
        break;
      case 'result':
        pipeConnected = true;
        pipeResult = msg;
        settle();
        break;
      case 'cancelled':
        break;
    }
  });

  // When the pipe dies, the helper may still be flushing result.json (or may
  // have crashed without writing one). Poll briefly, then fail loudly instead
  // of hanging the wizard on a progress screen forever.
  const failAfterPipeLoss = (reason: string): void => {
    if (settled) return;
    if (fs.existsSync(resultPath)) {
      settle();
      return;
    }
    const deadline = Date.now() + 5000;
    const grace = setInterval(() => {
      if (settled) {
        clearInterval(grace);
        return;
      }
      if (fs.existsSync(resultPath)) {
        clearInterval(grace);
        settle();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(grace);
        fail(new Error(`${reason}. The helper exited without reporting a result.`));
      }
    }, 200);
  };

  pipe.onError((err) => {
    logger.warn(`Pipe error: ${err.message}`);
    failAfterPipeLoss(`The job pipe failed (${err.message})`);
  });

  pipe.onClose(() => {
    failAfterPipeLoss('The job pipe closed');
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
    // File-based IPC: detect that the helper is alive and surface progress.json
    // changes (the pipe never delivered them). Do NOT clear the timer here —
    // we still need to poll for result.json so the promise can settle.
    if (!pipeConnected) {
      if (!helperStarted && (fs.existsSync(progressPath) || fs.existsSync(resultPath))) {
        helperStarted = true;
      }
      if (helperStarted && fs.existsSync(progressPath)) {
        try {
          const raw = fs.readFileSync(progressPath, 'utf-8');
          if (raw !== lastFileProgress) {
            lastFileProgress = raw;
            lastProgressAt = Date.now();
            emitter.emit('progress', JSON.parse(raw) as P);
          }
        } catch {
          /* partial write — try again next tick */
        }
      }
    }

    if (fs.existsSync(resultPath)) {
      settle();
      return;
    }
    if (!helperStarted && Date.now() - startedAt > STARTED_TIMEOUT_MS) {
      clearInterval(startupTimer);
      fail(new Error('Elevation was not confirmed. The job did not start.'));
      return;
    }
    // Helper started but never produced a result and the pipe never settled
    // us: catch a silently-dead helper so the UI gets an error, not a hang.
    // Recent progress (pipe or file) means the helper is still working.
    if (
      helperStarted &&
      !pipe.connected &&
      !settled &&
      Date.now() - startedAt > STARTED_TIMEOUT_MS * 4
    ) {
      const recentActivity = lastProgressAt > 0 && Date.now() - lastProgressAt < STARTED_TIMEOUT_MS * 4;
      if (recentActivity) {
        return;
      }
      clearInterval(startupTimer);
      fail(new Error('The backup helper exited without reporting a result.'));
    }
  }, 300);

  // --- Spawn helper ---
  const exe = process.execPath;
  const app = electronApp();
  const appPath = app.isPackaged ? undefined : app.getAppPath();

  (async (): Promise<void> => {
    // Try to start the pipe server.
    try {
      await pipe.start();
      logger.info(`Pipe server listening on ${pipeName}`);
    } catch (pipeError) {
      logger.warn(`Pipe server creation failed, using file-based IPC: ${pipeError}`);
    }

    // Spawn the helper via task scheduler (primary) or UAC fallback.
    // If the app is already running as admin (RunAsAdmin registry key), the
    // helper inherits elevation — spawn it directly, no task/UAC needed.
    const alreadyElevated = isRunAsAdmin(exe);
    const args = [
      ...(appPath ? [appPath] : []),
      HELPER_FLAG,
      jobPath
    ];

    if (alreadyElevated) {
      logger.info('App is already elevated, spawning helper directly.');
      const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', (error) => {
        clearInterval(startupTimer);
        fail(error);
      });
    } else {
      try {
        await ensureHelperTaskRegistered(exe, appPath);
        await triggerHelperTask(exe, jobPath, appPath);
        logger.info('Launched helper via scheduled task (no UAC).');
      } catch (taskError) {
        logger.warn('Scheduled task launch failed, falling back to UAC:', taskError);
        const psArgs = args.map(quotePowerShell);
        const psScript =
          `Start-Process -FilePath ${quotePowerShell(exe)} -ArgumentList @(${psArgs.join(', ')}) ` +
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
    }
  })();

  // --- Cancel ---
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    logger.info('Cancellation requested for elevated job.');
    // Always write the cancel file: the helper polls it (isCancelled) and does
    // not consume pipe messages, so the pipe send is best-effort only.
    try {
      fs.writeFileSync(cancelPath, '1');
    } catch {
      /* best-effort */
    }
    pipe.send({ type: 'cancel' });
  };

  return {
    promise,
    cancel,
    onProgress: (cb: (p: P) => void) => {
      emitter.on('progress', cb);
    }
  };
}
