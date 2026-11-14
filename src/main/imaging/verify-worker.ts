import { parentPort, workerData } from 'worker_threads';
import { verifyImageParallel } from './verify-parallel';

/**
 * Worker-thread entry for image verification. Verification re-reads the whole
 * image and decompresses every frame; running it here keeps the process that
 * started it (the elevated helper or the app) responsive and able to write
 * progress while a large image is checked.
 */
interface VerifyWorkerData {
  imagePath: string;
  keyHex?: string;
  threads?: number;
}

const data = workerData as VerifyWorkerData;

void (async (): Promise<void> => {
  try {
    const key = data.keyHex ? Buffer.from(data.keyHex, 'hex') : undefined;
    const result = await verifyImageParallel(
      data.imagePath,
      key,
      (done, total) => parentPort?.postMessage({ type: 'progress', done, total }),
      data.threads
    );
    parentPort?.postMessage({ type: 'done', result });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    });
  }
})();
