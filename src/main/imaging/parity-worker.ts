import { parentPort, workerData } from 'worker_threads';
import { buildParity } from './parity';

/**
 * Worker-thread entry for {@link buildParity}: receives `{ imagePath }` via
 * workerData, streams per-group progress, and posts the final report (or
 * error) back. Keeps the Electron main thread responsive while every frame
 * of a just-written image is re-read for the XOR parity sidecar.
 */
const { imagePath } = (workerData ?? {}) as { imagePath?: string };

if (!imagePath) {
  parentPort?.postMessage({ type: 'error', error: 'parity-worker: no imagePath in workerData' });
} else {
  try {
    const report = buildParity(imagePath, (groupsDone, groupsTotal) => {
      parentPort?.postMessage({ type: 'progress', groupsDone, groupsTotal });
    });
    parentPort?.postMessage({ type: 'done', report });
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
