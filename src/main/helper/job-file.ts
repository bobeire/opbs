import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Read a helper job file, then delete it from disk.
 *
 * Job files carry key material — the raw AES `keyHex` for encrypted images
 * and the plaintext passphrase for mount jobs — and used to sit in %TEMP%
 * for the entire run (hours), surviving as a permanent leak whenever the
 * process died before the launcher's cleanup. Deleting on read shrinks that
 * window to the milliseconds between the writer's `writeFileSync` and this
 * read: every runner consumes job.json exactly once and nothing needs the
 * file afterwards (the parent only watches result/progress). The delete
 * happens before the parse, so a corrupt file cannot keep leaking either.
 */
export function readAndConsumeJob<T>(jobPath: string): T {
  const text = fs.readFileSync(jobPath, 'utf-8');
  try {
    fs.rmSync(jobPath, { force: true });
  } catch (error) {
    logger.warn(`Could not remove job file ${jobPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return JSON.parse(text) as T;
}
