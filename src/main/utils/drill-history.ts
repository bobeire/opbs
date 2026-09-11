import * as fs from 'fs';
import * as path from 'path';

export interface DrillRecord {
  imagePath: string;
  at: number;
  ok: boolean;
  failures?: string[];
  targetDiskIndex?: number;
  partitionsValidated?: number;
  durationMs?: number;
}

const DRILL_HISTORY_NAME = 'opbs-drill-history.json';

export function drillHistoryPath(dir: string): string {
  return path.join(dir, DRILL_HISTORY_NAME);
}

/** All drill results recorded in a backup directory, keyed by absolute image path. */
export function readDrillHistory(dir: string): Record<string, DrillRecord> {
  try {
    const raw = fs.readFileSync(drillHistoryPath(dir), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, DrillRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record a restore-drill outcome next to the image. Best-effort: noop on
 * errors so a failed result flush never masks the drill's own outcome.
 */
export function recordDrillResult(
  imagePath: string,
  record: Omit<DrillRecord, 'imagePath' | 'at'> & { at?: number }
): void {
  try {
    const dir = path.dirname(imagePath);
    const history = readDrillHistory(dir);
    history[path.resolve(imagePath)] = { imagePath, at: record.at ?? Date.now(), ...record };
    fs.writeFileSync(drillHistoryPath(dir), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    /* best-effort */
  }
}