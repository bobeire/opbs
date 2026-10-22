import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  migrateDrillHistoryPath,
  readMigrateDrillHistory,
  recordMigrateDrillResult
} from '../../src/main/utils/migrate-drill-history';

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrate-drill-history', () => {
  it('records and reads back a drill result keyed by absolute image path', () => {
    const dir = tempDir('opbs-mdh-');
    const imagePath = path.join(dir, 'pc-2026-01-01.opbs');
    fs.writeFileSync(imagePath, 'x');

    recordMigrateDrillResult(imagePath, {
      ok: true,
      profile: 'rober',
      planHash: 'abc',
      plannedFiles: 42,
      plannedBytes: 1024,
      storesMatched: 7,
      refusals: 0,
      durationMs: 1234
    });

    const history = readMigrateDrillHistory(dir);
    const record = history[path.resolve(imagePath)];
    expect(record).toBeDefined();
    expect(record.ok).toBe(true);
    expect(record.profile).toBe('rober');
    expect(record.plannedFiles).toBe(42);
    expect(record.storesMatched).toBe(7);
    expect(record.at).toBeGreaterThan(0);
    expect(migrateDrillHistoryPath(dir)).toBe(path.join(dir, 'opbs-migrate-drill-history.json'));
  });

  it('keeps the latest result per image and one entry per image', () => {
    const dir = tempDir('opbs-mdh-');
    const a = path.join(dir, 'a.opbs');
    const b = path.join(dir, 'b.opbs');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');

    recordMigrateDrillResult(a, { ok: false, profile: 'p', error: 'plan failed', refusals: 2 });
    recordMigrateDrillResult(b, { ok: true, profile: 'p' });
    recordMigrateDrillResult(a, { ok: true, profile: 'p', plannedFiles: 10 });

    const history = readMigrateDrillHistory(dir);
    expect(Object.keys(history)).toHaveLength(2);
    expect(history[path.resolve(a)].ok).toBe(true);
    expect(history[path.resolve(a)].error).toBeUndefined();
    expect(history[path.resolve(b)].ok).toBe(true);
  });

  it('returns an empty record set for missing or corrupt history files', () => {
    const dir = tempDir('opbs-mdh-');
    expect(readMigrateDrillHistory(dir)).toEqual({});
    fs.writeFileSync(migrateDrillHistoryPath(dir), 'not-json{');
    expect(readMigrateDrillHistory(dir)).toEqual({});
  });

  it('is best-effort when the directory cannot be written', () => {
    expect(() =>
      recordMigrateDrillResult(path.join(os.tmpdir(), 'definitely-missing-dir', 'x', 'img.opbs'), {
        ok: true,
        profile: 'p'
      })
    ).not.toThrow();
  });
});
