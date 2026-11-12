import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPath, ExtractCancelledError } from '../../src/main/imaging/fs/file-browse';
import type { ExtractProblem, ExtractProgress } from '../../src/main/imaging/fs/file-browse';
import { ExfatVolume } from '../helpers/exfat-fixture';

/**
 * Extraction can run for a long time (a large folder, or one multi-gigabyte file), so a caller has to be
 * able to watch it and stop it. These cover the hooks that the worker thread uses for both.
 */
describe('extraction progress and cancellation', () => {
  let out: string;

  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-hooks-'));
  });

  afterEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  /** Five small files, one cluster each, so each is written in a single piece. */
  const fiveFiles = (): ExfatVolume => {
    const v = new ExfatVolume(40);
    const entries = [];
    for (let i = 0; i < 5; i++) {
      v.putData(10 + i, Buffer.from(`content ${i}`));
      entries.push({ name: `file${i}.txt`, start: 10 + i, length: 9 });
    }
    v.putEntries(2, entries);
    return v;
  };

  it('reports files, bytes and the item being worked on as it goes', () => {
    const seen: ExtractProgress[] = [];
    const count = extractPath(fiveFiles().session(), '', out, [], { onProgress: (p) => seen.push({ ...p }) });

    expect(count).toBe(5);
    const last = seen[seen.length - 1];
    expect(last.files).toBe(5);
    expect(last.bytes).toBe(5 * 9);
    expect(seen.map((p) => p.files)).toEqual([...seen.map((p) => p.files)].sort((a, b) => a - b)); // never goes backwards
    expect(seen[0].files).toBe(1); // the first file is counted while it is written, not only after
    expect(seen.some((p) => p.current === '/file3.txt')).toBe(true);
  });

  it('reports a renamed item as a problem as it happens', () => {
    // `con.txt` is a reserved device name on Windows, so extraction has to change it.
    const v = new ExfatVolume(40);
    v.putData(10, Buffer.from('content'));
    v.putEntries(2, [{ name: 'con.txt', start: 10, length: 7 }]);

    const seen: ExtractProblem[] = [];
    const problems: ExtractProblem[] = [];
    extractPath(v.session(), '', out, problems, { onProblem: (p) => seen.push(p) });

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('renamed');
    expect(seen[0].path).toBe('/con.txt');
    expect(problems).toEqual(seen);
    expect(fs.readdirSync(out)).toEqual(['_con.txt']);
  });

  it('stops between files when asked, and says how many it had written', () => {
    let finished = 0;
    const hooks = {
      onProgress: (p: ExtractProgress) => {
        finished = p.files;
      },
      isCancelled: () => finished >= 2
    };

    let caught: unknown;
    try {
      extractPath(fiveFiles().session(), '', out, [], hooks);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractCancelledError);
    expect((caught as ExtractCancelledError).files).toBe(2);
    expect(fs.readdirSync(out).sort()).toEqual(['file0.txt', 'file1.txt']);
  });

  it('stops between files that have no data to write, which only the per-file check can see', () => {
    // Empty files and folders are written in no pieces, so there is no point inside them to stop at.
    // Without a check between files, cancelling a tree of them would run to the end.
    const v = new ExfatVolume(40);
    const entries = [];
    for (let i = 0; i < 200; i++) entries.push({ name: `e${String(i).padStart(3, '0')}`, start: 0, length: 0 });
    v.putEntries(2, entries);

    let finished = 0;
    let caught: unknown;
    try {
      extractPath(v.session(), '', out, [], {
        onProgress: (p) => {
          finished = p.files;
        },
        isCancelled: () => finished >= 3
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractCancelledError);
    expect((caught as ExtractCancelledError).files).toBe(3);
    expect(fs.readdirSync(out)).toHaveLength(3);
  });

  it('stops part-way through one large file and removes the partly written copy', () => {
    // 20 MiB contiguous file: written in 8 MiB pieces, so there are points to stop at inside it.
    const size = 20 * 1024 * 1024;
    const v = new ExfatVolume(size / 4096 + 20);
    v.putEntries(2, [{ name: 'big.bin', start: 10, length: size, noFatChain: true }]);

    let bytes = 0;
    let firstFiles = -1;
    const hooks = {
      onProgress: (p: ExtractProgress) => {
        if (firstFiles < 0) firstFiles = p.files;
        bytes = p.bytes;
      },
      isCancelled: () => bytes > 0
    };
    // With a problem list, one bad file is recorded and the run carries on. Stopping on request happens
    // inside that same per-file handling here, and must not be caught by it and turned into "skipped".
    const problems: ExtractProblem[] = [];
    let caught: unknown;
    try {
      extractPath(v.session(), '', out, problems, hooks);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractCancelledError);
    expect(problems).toEqual([]);
    expect(firstFiles).toBe(1); // a single file is shown as one while it is being written
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(size); // it stopped within the file, not after it
    // A half-written file would look like a complete, shorter one.
    expect(fs.existsSync(path.join(out, 'big.bin'))).toBe(false);
  });

  it('extracts normally when no hooks are given', () => {
    expect(extractPath(fiveFiles().session(), '', out)).toBe(5);
    expect(fs.readdirSync(out)).toHaveLength(5);
  });
});
