import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

/** Temp-dir prefixes created by job launchers (helper/launcher.ts, cli/index.ts) and cloud-restore staging. */
const JOB_DIR_PREFIXES = ['opbs-job-', 'opbs-wizard-', 'opbs-scheduled-', 'opbs-drill-inproc-', 'opbs-restore-'];

/**
 * A dir still holding job.json means its reader never ran — the launcher or
 * CLI died before the helper consumed the file, so it still carries keyHex /
 * passphrase material: swept once an hour old. A dir without job.json was
 * consumed (or never held secrets): litter only (progress/result/io), swept
 * after a day.
 *
 * Age is the newest mtime across the dir's *entries*, not the directory
 * itself: NTFS does not bump a directory's mtime when files inside are
 * rewritten, and a live job rewrites progress.json constantly. A live job's
 * dir therefore always looks fresh and is never swept.
 */
const JOB_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function sweepStaleJobDirs(root: string = os.tmpdir(), now: number = Date.now()): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!JOB_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const dir = path.join(root, entry.name);
    try {
      const names = fs.readdirSync(dir);
      let newest = 0;
      let hasJobFile = false;
      for (const name of names) {
        if (name === 'job.json') hasJobFile = true;
        try {
          const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch {
          /* entry vanished mid-sweep (a live job finishing) — ignore it */
        }
      }
      if (newest === 0) {
        try {
          newest = fs.statSync(dir).mtimeMs;
        } catch {
          continue;
        }
      }
      const maxAge = hasJobFile ? JOB_FILE_MAX_AGE_MS : DIR_MAX_AGE_MS;
      if (now - newest < maxAge) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      /* in use or raced with another instance — leave it alone */
    }
  }
  if (removed.length > 0) {
    logger.info(`Swept ${removed.length} stale job dir(s) from ${root}`, { removed });
  }
  return removed;
}
