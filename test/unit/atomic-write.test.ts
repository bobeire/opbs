import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic, readJsonSafe } from '../../src/main/utils/atomic-write';

/**
 * A plain writeFileSync can leave a truncated file if the process dies
 * mid-write. For settings that turned into a silent reset to defaults: the
 * reader treated the damaged file as absent and the next save destroyed it
 * (field report 2026-11-04). Scrub history, analytics, perf history and both
 * drill histories had the same write pattern.
 */
describe('atomic state writes', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-atomic-'));
    file = path.join(dir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the content and leaves no temp file behind', () => {
    writeFileAtomic(file, JSON.stringify({ a: 1 }));

    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ a: 1 });
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('replaces an existing file rather than appending or truncating in place', () => {
    writeFileAtomic(file, JSON.stringify({ a: 1 }));
    writeFileAtomic(file, JSON.stringify({ b: 2 }));

    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ b: 2 });
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('never leaves a partial file visible to a reader', () => {
    // The whole point: whatever happens, a reader sees the old content or
    // the new one. Writing through a temp + rename is what guarantees it, so
    // assert the file is only ever replaced, never opened for writing.
    writeFileAtomic(file, 'first');
    const before = fs.statSync(file).ino;

    writeFileAtomic(file, 'second-and-longer-content');
    expect(fs.readFileSync(file, 'utf-8')).toBe('second-and-longer-content');
    // A rename gives the path a new inode; an in-place write would keep it.
    expect(fs.statSync(file).ino).not.toBe(before);
  });

  it('cleans up its temp file when the write fails', () => {
    // A directory cannot be written as a file: the write throws, and the temp
    // file must not survive to be mistaken for state.
    const dirTarget = path.join(dir, 'sub');
    fs.mkdirSync(dirTarget);
    expect(() => writeFileAtomic(dirTarget, 'x')).toThrow();

    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('reports a damaged file instead of pretending it is empty', () => {
    fs.writeFileSync(file, '{"a": 1, TRUNCATED');

    let damaged = false;
    const value = readJsonSafe(file, { fallback: true }, () => {
      damaged = true;
    });

    // "Corrupt" and "missing" must not look the same to a caller.
    expect(damaged).toBe(true);
    expect(value).toEqual({ fallback: true });
  });

  it('returns the fallback for a file that is genuinely missing, without alarm', () => {
    let damaged = false;
    const value = readJsonSafe(path.join(dir, 'absent.json'), { fallback: true }, () => {
      damaged = true;
    });
    expect(value).toEqual({ fallback: true });
    expect(damaged).toBe(false);
  });
});
