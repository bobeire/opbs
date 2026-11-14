import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { VerifyResult } from './image-format';

/**
 * Resolve the compiled verification worker. Mirrors the parity and extraction
 * workers: in production it sits next to this module in dist/; when running
 * from source (vitest) fall back to the compiled copy in dist/.
 */
export function resolveVerifyWorkerPath(): string {
  const candidate = path.resolve(__dirname, 'verify-worker.js');
  if (fs.existsSync(candidate)) return candidate;
  const distCandidate = path.resolve(__dirname, '../../../dist/imaging/verify-worker.js');
  if (fs.existsSync(distCandidate)) return distCandidate;
  return candidate;
}

/** False when neither the deployed nor the compiled worker exists. */
export function verifyWorkerAvailable(): boolean {
  return fs.existsSync(resolveVerifyWorkerPath());
}

type WorkerMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; result: VerifyResult }
  | { type: 'error'; error?: string };

/**
 * Run {@link verifyImage} on a worker thread with batched frame reads and
 * parallel decompression. `onProgress` fires as frames are checked; the promise
 * rejects only when the worker itself fails (a verification failure resolves
 * with `ok: false`, exactly like the in-process function).
 */
export function verifyImageAsync(
  imagePath: string,
  key?: Buffer,
  onProgress?: (done: number, total: number) => void,
  threads = 4
): Promise<VerifyResult> {
  return new Promise<VerifyResult>((resolve, reject) => {
    const worker = new Worker(resolveVerifyWorkerPath(), {
      workerData: {
        imagePath,
        ...(key ? { keyHex: key.toString('hex') } : {}),
        threads
      }
    });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'progress') {
        onProgress?.(msg.done, msg.total);
      } else if (msg.type === 'done') {
        settle(() => resolve(msg.result));
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(msg.error ?? 'Verification worker failed')));
      }
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => {
      settle(() => reject(new Error(`Verification worker exited unexpectedly with code ${code}`)));
    });
  });
}
