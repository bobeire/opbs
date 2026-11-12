import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runExtractionInWorker } from '../../src/main/imaging/fs/extract-runner';
import { COMPRESSION_NONE } from '../../src/main/imaging/image-format';
import { writeImageFromBytes } from '../helpers/opbs-image';
import { buildNtfsVolume, CLUSTER as NTFS_CLUSTER } from '../helpers/ntfs-fixture';
import { ExfatVolume } from '../helpers/exfat-fixture';

/**
 * Extraction reads and writes synchronously, so on the Electron main thread a large folder or file froze
 * the whole window until it finished. These run it on the real worker thread (the compiled worker in
 * dist/, as the parity and compression-pool tests do) and check the two things that matter: it gives the
 * same result, and the calling thread stays free while it works.
 *
 * Needs `npm run build:main` first, like the other worker tests; CI builds before it runs the suite.
 */
describe('extraction on a worker thread', () => {
  let root: string;
  let ntfsImage: string;
  let bigImage: string;
  let mixedImage: string;
  let bigData: Buffer;
  const BIG = 64 * 1024 * 1024;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-worker-'));

    // A small NTFS volume with real files.
    ntfsImage = path.join(root, 'ntfs.opbs');
    const volume = buildNtfsVolume();
    writeImageFromBytes(ntfsImage, volume.read(0, volume.size), NTFS_CLUSTER, COMPRESSION_NONE);

    // An exFAT volume holding one 64 MiB contiguous file: long enough that a synchronous extraction would
    // visibly stall the thread that runs it.
    bigData = crypto.randomBytes(BIG);
    const v = new ExfatVolume(BIG / 4096 + 20);
    bigData.copy(v.buf, v.offset(10));
    v.putEntries(2, [{ name: 'big.bin', start: 10, length: BIG, noFatChain: true }]);
    bigImage = path.join(root, 'big.opbs');
    writeImageFromBytes(bigImage, v.buf, 1 << 20, COMPRESSION_NONE);

    // The same file, preceded by a name Windows will not accept. The rename is found before the long
    // write starts, so a forced stop can be checked for keeping the problems it had already reported.
    v.putData(9, Buffer.from('hello'));
    v.putEntries(2, [
      { name: 'con.txt', start: 9, length: 5 },
      { name: 'big.bin', start: 10, length: BIG, noFatChain: true }
    ]);
    mixedImage = path.join(root, 'mixed.opbs');
    writeImageFromBytes(mixedImage, v.buf, 1 << 20, COMPRESSION_NONE);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const outDir = (name: string): string => fs.mkdtempSync(path.join(root, `${name}-`));

  it('extracts a folder tree and returns the same result an in-process extraction would', async () => {
    const out = outDir('tree');
    let opened = 0;
    const run = runExtractionInWorker(
      { imagePath: ntfsImage, partitionIndex: 0, relPath: '', outPath: out },
      undefined,
      () => opened++
    );
    const outcome = await run.promise;

    expect(outcome.cancelled).toBe(false);
    expect(outcome.partial).toBe(false);
    expect(opened).toBe(1);
    expect(outcome.files).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(path.join(out, 'hello.txt'), 'utf8')).toBe('Hello, OPBS world!');
    expect(outcome.problems.filter((p) => p.kind === 'skipped')).toEqual([]);
  }, 30_000);

  it('rejects with the reason when the image cannot be opened', async () => {
    const run = runExtractionInWorker({
      imagePath: path.join(root, 'does-not-exist.opbs'),
      partitionIndex: 0,
      relPath: '',
      outPath: outDir('missing')
    });
    await expect(run.promise).rejects.toThrow();
  }, 30_000);

  it('keeps the calling thread running while a large file is extracted', async () => {
    const out = outDir('large');
    // If extraction ran on this thread, these timers could not fire until it had finished.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    let outcome;
    try {
      outcome = await runExtractionInWorker({ imagePath: bigImage, partitionIndex: 0, relPath: '', outPath: out }).promise;
    } finally {
      clearInterval(timer);
    }

    expect(outcome.files).toBe(1);
    expect(outcome.bytes).toBe(BIG);
    expect(ticks).toBeGreaterThan(3);
    const got = fs.readFileSync(path.join(out, 'big.bin'));
    expect(got.length).toBe(BIG);
    expect(crypto.createHash('sha256').update(got).digest('hex')).toBe(crypto.createHash('sha256').update(bigData).digest('hex'));
  }, 60_000);

  it('can be cancelled from the calling thread, and leaves no partial file', async () => {
    const out = outDir('cancel');
    const run = runExtractionInWorker({ imagePath: bigImage, partitionIndex: 0, relPath: '', outPath: out });
    // Possible only because this thread is free to call it. The worker polls the shared flag between
    // files and between pieces, so it stops without finishing the 64 MiB file.
    run.cancel();
    const outcome = await run.promise;

    expect(outcome.cancelled).toBe(true);
    expect(outcome.partial).toBe(false);
    expect(outcome.bytes).toBeLessThan(BIG);
    expect(fs.existsSync(path.join(out, 'big.bin'))).toBe(false);
  }, 30_000);

  it('stops a worker that will not stop itself, and says a partial file may remain', async () => {
    const out = outDir('force');
    const run = runExtractionInWorker(
      { imagePath: bigImage, partitionIndex: 0, relPath: '', outPath: out },
      undefined,
      undefined,
      { forceStopAfterMs: 0 }
    );
    // The worker is stopped before it has even opened the image, which is the extreme case of a
    // worker that does not reach a cancellation check.
    run.cancel();
    const outcome = await run.promise;

    expect(outcome.cancelled).toBe(true);
    expect(outcome.partial).toBe(true);
    expect(outcome.bytes).toBeLessThan(BIG);
  }, 30_000);

  it('keeps the problems it already found when it has to stop the worker outright', async () => {
    const out = outDir('force-problems');
    let started: () => void = () => {};
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = runExtractionInWorker(
      { imagePath: mixedImage, partitionIndex: 0, relPath: '', outPath: out },
      // The rename of con.txt happens before its data is written, and the first progress report is
      // posted after it, so this guarantees the problem has already been reported.
      (progress) => {
        if (progress.files >= 1) started();
      },
      undefined,
      { forceStopAfterMs: 0 }
    );
    const firstMessage = await Promise.race([
      writing.then(() => 'writing' as const),
      run.promise.then(() => 'settled' as const)
    ]);
    expect(firstMessage).toBe('writing');
    run.cancel();
    const outcome = await run.promise;

    expect(outcome.cancelled).toBe(true);
    expect(outcome.partial).toBe(true);
    expect(outcome.problems.map((p) => p.kind)).toContain('renamed');
    expect(outcome.problems.map((p) => p.path)).toContain('/con.txt');
  }, 60_000);

  it('treats cancelling after it has finished as harmless', async () => {
    const run = runExtractionInWorker({ imagePath: ntfsImage, partitionIndex: 0, relPath: '', outPath: outDir('late') });
    const outcome = await run.promise;
    expect(outcome.cancelled).toBe(false);
    expect(() => run.cancel()).not.toThrow();
  }, 30_000);
});
