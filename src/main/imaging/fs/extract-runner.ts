import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { ExtractProblem, ExtractProgress } from './file-browse';

export interface ExtractRequest {
  imagePath: string;
  partitionIndex: number;
  /** A Macrium unlock cannot cross IPC, so only a raw passphrase reaches here. */
  passphrase?: string;
  /** Path inside the image; '' is the partition root. */
  relPath: string;
  /** Destination on the host: a folder for a directory, the file itself for a single file. */
  outPath: string;
}

export interface ExtractOutcome {
  files: number;
  bytes: number;
  /** Every skipped or renamed item the worker reported, including on a forced stop. */
  problems: ExtractProblem[];
  cancelled: boolean;
  /**
   * True when the worker had to be stopped outright rather than stopping itself. It could not tidy
   * up, so a file it was part-way through may have been left behind.
   */
  partial: boolean;
}

export interface RunningExtraction {
  /** Settles when the extraction finishes, is cancelled, or fails. Rejects with the reason on failure. */
  promise: Promise<ExtractOutcome>;
  /** Ask the extraction to stop. Safe to call more than once, or after it has finished. */
  cancel(): void;
}

export interface ExtractRunOptions {
  /**
   * How long a cancelled worker has to stop itself before it is stopped outright. 0 stops it
   * immediately; it is injectable so tests can cover that path without waiting.
   */
  forceStopAfterMs?: number;
}

/** If a cancelled worker is stuck in one long operation, stop it outright after this long. */
const FORCE_STOP_AFTER_MS = 10_000;

/**
 * Resolve the path to the compiled extraction worker. Mirrors the parity and compression-pool
 * resolution: in production the worker sits next to this module in dist/; when running from
 * source (vitest) fall back to the compiled copy in dist/.
 */
function resolveExtractWorkerPath(): string {
  const candidate = path.resolve(__dirname, 'extract-worker.js');
  if (fs.existsSync(candidate)) return candidate;
  const distCandidate = path.resolve(__dirname, '../../../../dist/imaging/fs/extract-worker.js');
  if (fs.existsSync(distCandidate)) return distCandidate;
  return candidate; // let it fail with a clear error
}

type WorkerMessage =
  | { type: 'opened' }
  | ({ type: 'progress' } & ExtractProgress)
  | { type: 'problem'; problem: ExtractProblem }
  | { type: 'done' | 'cancelled'; files: number; bytes: number; problems: ExtractProblem[] }
  | { type: 'error'; error?: string };

/**
 * Extract files from a backup image on a worker thread, so the Electron main thread (and with it
 * the window) stays responsive however large the folder or file is. `onProgress` is throttled by
 * the worker; `onOpened` fires once the image is open and extraction has begun.
 */
export function runExtractionInWorker(
  request: ExtractRequest,
  onProgress?: (progress: ExtractProgress) => void,
  onOpened?: () => void,
  options?: ExtractRunOptions
): RunningExtraction {
  const cancelBuffer = new SharedArrayBuffer(4);
  const cancelFlag = new Int32Array(cancelBuffer);
  const worker = new Worker(resolveExtractWorkerPath(), { workerData: { ...request, cancel: cancelBuffer } });
  const forceStopAfterMs = options?.forceStopAfterMs ?? FORCE_STOP_AFTER_MS;

  let forceStop: (() => void) | undefined;
  let last: ExtractProgress = { files: 0, bytes: 0, current: '' };
  let forceTimer: NodeJS.Timeout | undefined;
  // Problems arrive one by one, so a forced stop can still report what was already found. The final
  // message carries the full list and replaces this.
  let problems: ExtractProblem[] = [];

  const promise = new Promise<ExtractOutcome>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      fn();
      void worker.terminate();
    };
    // Resolves as cancelled with the last figures seen. A worker stopped this way cannot tidy up, so a
    // file it was part-way through may be left behind; the normal cooperative path removes it.
    forceStop = () =>
      settle(() => resolve({ files: last.files, bytes: last.bytes, problems, cancelled: true, partial: true }));

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'opened') {
        onOpened?.();
      } else if (msg.type === 'progress') {
        last = { files: msg.files, bytes: msg.bytes, current: msg.current };
        onProgress?.(last);
      } else if (msg.type === 'problem') {
        problems.push(msg.problem);
      } else if (msg.type === 'done' || msg.type === 'cancelled') {
        problems = msg.problems;
        settle(() =>
          resolve({
            files: msg.files,
            bytes: msg.bytes,
            problems: msg.problems,
            cancelled: msg.type === 'cancelled',
            partial: false
          })
        );
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(msg.error ?? 'Extraction failed')));
      }
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => {
      settle(() => reject(new Error(`Extraction worker exited unexpectedly with code ${code}`)));
    });
  });

  return {
    promise,
    cancel(): void {
      Atomics.store(cancelFlag, 0, 1);
      if (forceTimer) return;
      // The worker polls the flag between files and pieces, but a single long step (opening a very
      // large volume, decoding one huge compressed file) cannot. Do not wait on it forever.
      if (forceStopAfterMs <= 0) {
        forceStop?.();
        return;
      }
      forceTimer = setTimeout(() => forceStop?.(), forceStopAfterMs);
      forceTimer.unref?.();
    }
  };
}
