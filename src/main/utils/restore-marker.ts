import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * "A restore is running right now" marker.
 *
 * A restore is the one operation in OPBS that can leave a machine unbootable
 * if it is interrupted — power cut, crash, the user closing the console. Until
 * now nothing recorded that a restore had started and not finished, so the
 * next thing the user saw was a machine that behaved oddly, with no indication
 * that half a disk had been written.
 *
 * The marker is written before the first byte goes to the target and removed
 * when the run ends, whatever the outcome. Finding one means the run did not
 * end normally.
 *
 * Deliberately NOT automatic: OPBS will not re-run a restore on its own. The
 * invariants say never write to a disk without a person deciding, and an
 * interrupted restore is exactly the situation where guessing is most
 * dangerous. The marker exists to be *reported*, not acted on.
 */
export const RESTORE_MARKER_FILENAME = 'OPBS-restore-in-progress.json';

export interface RestoreMarker {
  imagePath: string;
  targetDiskIndex?: number;
  targetPartitions: number[];
  startedAt: string;
  pid: number;
}

/** Where the marker lives: the system drive, beside the recovery result file. */
export function restoreMarkerPath(root: string = process.env.SystemDrive ?? 'C:'): string {
  return path.join(root, RESTORE_MARKER_FILENAME);
}

export function writeRestoreMarker(marker: Omit<RestoreMarker, 'startedAt' | 'pid'>): void {
  try {
    fs.writeFileSync(
      restoreMarkerPath(),
      JSON.stringify(
        { ...marker, startedAt: new Date().toISOString(), pid: process.pid } satisfies RestoreMarker,
        null,
        2
      ),
      'utf-8'
    );
  } catch (error) {
    // A marker we cannot write is not worth failing a restore over - the run
    // proceeds and simply has no interruption record.
    logger.warn(`Could not write the restore marker: ${error instanceof Error ? error.message : error}`);
  }
}

export function clearRestoreMarker(): void {
  try {
    fs.rmSync(restoreMarkerPath(), { force: true });
  } catch {
    /* best effort - a stale marker is reported, not fatal */
  }
}

/**
 * Read an interrupted-restore marker, if one is there. Consumed on read so
 * the report is made once; the details travel with it so the user can see
 * exactly which restore did not finish.
 */
export function readRestoreMarker(): RestoreMarker | null {
  const file = restoreMarkerPath();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RestoreMarker>;
    const marker: RestoreMarker = {
      imagePath: String(raw.imagePath ?? ''),
      targetDiskIndex: typeof raw.targetDiskIndex === 'number' ? raw.targetDiskIndex : undefined,
      targetPartitions: Array.isArray(raw.targetPartitions) ? raw.targetPartitions.map(Number) : [],
      startedAt: String(raw.startedAt ?? ''),
      pid: typeof raw.pid === 'number' ? raw.pid : 0
    };
    fs.rmSync(file, { force: true });
    return marker.imagePath ? marker : null;
  } catch {
    /* unreadable marker - treat as absent rather than guessing */
    return null;
  }
}
