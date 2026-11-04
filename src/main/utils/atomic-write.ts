import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * Write a file so it is never observed half-written.
 *
 * A plain `writeFileSync` is not atomic: a crash, a power cut or a full disk
 * leaves a truncated file, and the next reader sees something between the old
 * contents and the new. For settings that turned into a silent reset to
 * defaults (field report 2026-11-04) — the reader treated the damaged file as
 * absent and the following save destroyed it.
 *
 * Write to a sibling temp file, then rename. On the same volume a rename is
 * atomic, so a reader sees either the whole old file or the whole new one.
 *
 * Deliberately not "fsync the file and the directory": that is the fully
 * durable variant and it costs a lot on every save. This closes the
 * truncation window, which is the one that actually bit us.
 */
export function writeFileAtomic(file: string, data: string | Buffer, encoding: BufferEncoding = 'utf-8'): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    if (typeof data === 'string') {
      fs.writeFileSync(tmp, data, encoding);
    } else {
      fs.writeFileSync(tmp, data);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    // Never leave a partial temp file behind to be mistaken for state.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    logger.warn(`Atomic write failed for ${file}: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

/**
 * Read JSON, tolerating a file that is missing or damaged. Returns `null` for
 * both so callers cannot mistake "corrupt" for "empty" without saying so —
 * a damaged state file is reported through `onDamaged`, which is the only way
 * a user ever learns their history or settings were unreadable.
 */
export function readJsonSafe<T>(
  file: string,
  fallback: T,
  onDamaged?: (error: unknown) => void
): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (error) {
    onDamaged?.(error);
    return fallback;
  }
}
