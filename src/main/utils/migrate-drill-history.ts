import * as fs from 'fs';
import * as path from 'path';

/** Outcome of one scheduled migration drill (a `migrate plan` dry run). */
export interface MigrationDrillRecord {
  imagePath: string;
  at: number;
  ok: boolean;
  profile: string;
  planHash?: string;
  plannedFiles?: number;
  plannedBytes?: number;
  storesMatched?: number;
  refusals?: number;
  durationMs?: number;
  error?: string;
}

const HISTORY_NAME = 'opbs-migrate-drill-history.json';

export function migrateDrillHistoryPath(dir: string): string {
  return path.join(dir, HISTORY_NAME);
}

/** All migration-drill results recorded in a backup directory, keyed by absolute image path. */
export function readMigrateDrillHistory(dir: string): Record<string, MigrationDrillRecord> {
  try {
    const raw = fs.readFileSync(migrateDrillHistoryPath(dir), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, MigrationDrillRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record a migration-drill outcome next to the image. Best-effort: noop on
 * errors so a failed result flush never masks the drill's own outcome.
 */
export function recordMigrateDrillResult(
  imagePath: string,
  record: Omit<MigrationDrillRecord, 'imagePath' | 'at'> & { at?: number }
): void {
  try {
    const dir = path.dirname(imagePath);
    const history = readMigrateDrillHistory(dir);
    history[path.resolve(imagePath)] = { imagePath, at: record.at ?? Date.now(), ...record };
    fs.writeFileSync(migrateDrillHistoryPath(dir), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    /* best-effort */
  }
}
