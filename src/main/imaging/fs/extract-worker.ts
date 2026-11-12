import { parentPort, workerData } from 'worker_threads';
import { openAnyBrowse, extractPath, ExtractCancelledError } from './file-browse';
import type { ExtractProblem } from './file-browse';

/**
 * Worker-thread entry for extracting files from a backup image. Extraction reads and writes
 * synchronously, a piece at a time, so on the Electron main thread a large folder or a
 * multi-gigabyte file froze the whole window until it finished. Here it blocks only this thread.
 *
 * Receives the request via workerData, opens its own browse session (a session holds open files
 * and large maps, so it cannot be handed across threads), and posts back:
 *   { type: 'opened' }                          the image is open and extraction is starting
 *   { type: 'progress', files, bytes, current } throttled progress
 *   { type: 'problem',  problem }               a skipped or renamed item, as it is found
 *   { type: 'done',      files, bytes, problems }
 *   { type: 'cancelled', files, bytes, problems }
 *   { type: 'error',     error }
 *
 * `cancel` is a shared Int32Array(1): the main thread sets element 0 to ask for a stop, which is
 * polled between files and between pieces of a file, because this thread cannot receive messages
 * while it is busy.
 */
interface ExtractWorkerData {
  imagePath?: string;
  partitionIndex?: number;
  passphrase?: string;
  relPath?: string;
  outPath?: string;
  cancel?: SharedArrayBuffer;
}

const PROGRESS_INTERVAL_MS = 200;
const data = (workerData ?? {}) as ExtractWorkerData;
const post = (message: unknown): void => parentPort?.postMessage(message);

if (!data.imagePath || data.partitionIndex === undefined || data.relPath === undefined || !data.outPath) {
  post({ type: 'error', error: 'extract-worker: incomplete request in workerData' });
} else {
  const flag = data.cancel ? new Int32Array(data.cancel) : undefined;
  const problems: ExtractProblem[] = [];
  let bytes = 0;
  let lastPost = 0;
  try {
    const session = openAnyBrowse(data.imagePath, data.partitionIndex, data.passphrase);
    post({ type: 'opened' });
    const files = extractPath(session, data.relPath, data.outPath, problems, {
      isCancelled: () => flag !== undefined && Atomics.load(flag, 0) !== 0,
      onProgress: (progress) => {
        bytes = progress.bytes;
        const now = Date.now();
        if (now - lastPost >= PROGRESS_INTERVAL_MS) {
          lastPost = now;
          post({ type: 'progress', ...progress });
        }
      },
      // Sent one at a time as well as in the final list, so a forced stop still shows what had
      // already been skipped or renamed rather than claiming there were none.
      onProblem: (problem) => post({ type: 'problem', problem })
    });
    post({ type: 'done', files, bytes, problems });
  } catch (err) {
    if (err instanceof ExtractCancelledError) {
      post({ type: 'cancelled', files: err.files, bytes, problems });
    } else {
      post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
