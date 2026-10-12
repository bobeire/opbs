import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepStaleJobDirs } from '../../src/main/utils/job-dir-sweep';

const HOUR = 60 * 60 * 1000;

describe('sweepStaleJobDirs', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-sweep-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const makeDir = (name: string, files: Record<string, string>): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    return dir;
  };

  const backdate = (target: string, ageMs: number): void => {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(target, t, t);
  };

  it('removes a stale job dir that still has its unconsumed job.json', () => {
    const dir = makeDir('opbs-job-stale', { 'io.json': '{}', 'job.json': '{"keyHex":"aa"}' });
    backdate(path.join(dir, 'job.json'), 2 * HOUR);
    backdate(path.join(dir, 'io.json'), 2 * HOUR);
    backdate(dir, 2 * HOUR);

    const removed = sweepStaleJobDirs(root);

    expect(removed).toEqual(['opbs-job-stale']);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps a job dir whose job.json was written recently', () => {
    const dir = makeDir('opbs-job-fresh', { 'job.json': '{"keyHex":"aa"}' });

    expect(sweepStaleJobDirs(root)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps a consumed job dir with a live progress heartbeat regardless of dir mtime', () => {
    // NTFS never bumps a directory's mtime when files inside are rewritten,
    // so the dir can look hours old while the job is actively progressing.
    const dir = makeDir('opbs-job-live', { 'progress.json': '{"percent":42}' });
    backdate(dir, 48 * HOUR);

    expect(sweepStaleJobDirs(root)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes a consumed job dir whose entries are all stale', () => {
    const dir = makeDir('opbs-job-dead', { 'progress.json': '{"percent":100}', 'result.json': '{"ok":true}' });
    backdate(path.join(dir, 'progress.json'), 25 * HOUR);
    backdate(path.join(dir, 'result.json'), 25 * HOUR);
    backdate(dir, 25 * HOUR);

    const removed = sweepStaleJobDirs(root);

    expect(removed).toEqual(['opbs-job-dead']);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps a consumed job dir whose entries are younger than the litter threshold', () => {
    const dir = makeDir('opbs-job-recent', { 'progress.json': '{"percent":100}' });
    backdate(path.join(dir, 'progress.json'), 2 * HOUR);
    backdate(dir, 2 * HOUR);

    expect(sweepStaleJobDirs(root)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('sweeps stale wizard, scheduled and drill-inproc job dirs', () => {
    for (const name of ['opbs-wizard-a', 'opbs-scheduled-b', 'opbs-drill-inproc-c', 'opbs-compact-d']) {
      const dir = makeDir(name, { 'job.json': '{}' });
      backdate(path.join(dir, 'job.json'), 2 * HOUR);
      backdate(dir, 2 * HOUR);
    }

    const removed = sweepStaleJobDirs(root).sort();

    expect(removed).toEqual(['opbs-compact-d', 'opbs-drill-inproc-c', 'opbs-scheduled-b', 'opbs-wizard-a']);
  });

  it('leaves non-job prefixes and regular files alone', () => {
    const streamDir = makeDir('opbs-stream-x', { 'image.part': 'data' });
    backdate(path.join(streamDir, 'image.part'), 48 * HOUR);
    backdate(streamDir, 48 * HOUR);
    const plainFile = path.join(root, 'opbs-job-a-file');
    fs.writeFileSync(plainFile, 'not a dir');

    expect(sweepStaleJobDirs(root)).toEqual([]);
    expect(fs.existsSync(streamDir)).toBe(true);
    expect(fs.existsSync(plainFile)).toBe(true);
  });

  it('removes an empty stale job dir via its directory mtime', () => {
    const dir = makeDir('opbs-job-empty', {});
    backdate(dir, 48 * HOUR);

    const removed = sweepStaleJobDirs(root);

    expect(removed).toEqual(['opbs-job-empty']);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
