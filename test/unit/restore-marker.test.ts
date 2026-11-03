import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeRestoreMarker,
  readRestoreMarker,
  clearRestoreMarker,
  restoreMarkerPath,
  RESTORE_MARKER_FILENAME
} from '../../src/main/utils/restore-marker';

/**
 * A restore is the one operation that can leave a machine unbootable if it is
 * interrupted. Nothing used to record that one had started and not finished,
 * so a power cut mid-restore left a person with an unexplained half-written
 * disk (borrowed from WinRE-Manager, which registers a resume task for the
 * same reason — we report rather than auto-retry, because re-running a restore
 * without a person deciding is exactly what the invariants forbid).
 */
describe('restore interruption marker', () => {
  let dir: string;
  const saved = process.env.SystemDrive;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-marker-'));
    process.env.SystemDrive = dir;
  });

  afterEach(() => {
    process.env.SystemDrive = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records what was being written and where', () => {
    writeRestoreMarker({ imagePath: 'D:\\img.opbs', targetDiskIndex: 2, targetPartitions: [0, 1, 2] });

    const marker = readRestoreMarker();
    expect(marker).not.toBeNull();
    expect(marker!.imagePath).toBe('D:\\img.opbs');
    expect(marker!.targetDiskIndex).toBe(2);
    expect(marker!.targetPartitions).toEqual([0, 1, 2]);
    // Someone has to be able to tell when it happened.
    expect(Number.isNaN(Date.parse(marker!.startedAt))).toBe(false);
  });

  it('is consumed on read, so the report is made once', () => {
    writeRestoreMarker({ imagePath: 'D:\\img.opbs', targetPartitions: [0] });
    expect(readRestoreMarker()).not.toBeNull();
    expect(fs.existsSync(restoreMarkerPath())).toBe(false);
    expect(readRestoreMarker()).toBeNull();
  });

  it('clears without complaint when there is nothing there', () => {
    clearRestoreMarker();
    expect(readRestoreMarker()).toBeNull();
  });

  it('treats an unreadable marker as absent rather than guessing', () => {
    fs.writeFileSync(restoreMarkerPath(), 'not json');
    expect(readRestoreMarker()).toBeNull();
  });

  it('ignores a marker with no image path', () => {
    fs.writeFileSync(restoreMarkerPath(), JSON.stringify({ targetPartitions: [0] }));
    expect(readRestoreMarker()).toBeNull();
  });

  it('lives on the system drive, beside the recovery result', () => {
    expect(restoreMarkerPath('C:')).toBe(path.join('C:', RESTORE_MARKER_FILENAME));
    expect(RESTORE_MARKER_FILENAME).toBe('OPBS-restore-in-progress.json');
  });
});
