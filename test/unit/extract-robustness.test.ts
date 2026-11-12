import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PartitionReader } from '../../src/main/imaging/image-browse';
import {
  extractPath,
  listDirectory,
  safeFileName,
  ExtractProblem
} from '../../src/main/imaging/fs/file-browse';
import { parseExfatBootSector, listExfatDirectory, forEachExfatFileChunk } from '../../src/main/imaging/fs/exfat';
import { forEachFat32FileChunk, Fat32Layout } from '../../src/main/imaging/fs/fat32';
import {
  parseBootSector,
  parseFileRecord,
  readFileData,
  readFileRange,
  forEachNtfsFileChunk,
  dataUnavailableReason,
  NtfsDataUnavailableError
} from '../../src/main/imaging/fs/ntfs';
import { buildNtfsVolume, buildFileRecord, fileNameAttr, CLUSTER as NTFS_CLUSTER } from '../helpers/ntfs-fixture';
import { ExfatVolume, ExEntry, CLUSTER, readerOf } from '../helpers/exfat-fixture';

/** Repeatable, position-dependent bytes, so a shifted or truncated read cannot match by accident. */
const pattern = (length: number, seed = 0): Buffer => {
  const b = Buffer.alloc(length);
  for (let i = 0; i < length; i++) b[i] = (i * 7 + seed) & 0xff;
  return b;
};

// ---------------------------------------------------------------------------
// exFAT
// ---------------------------------------------------------------------------

describe('exFAT extraction', () => {
  let out: string;

  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-extract-'));
  });

  afterEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('extracts a contiguous NoFatChain file in full instead of its first cluster', () => {
    // Windows sets NoFatChain on contiguous files and does not maintain their FAT entries, so a
    // reader that follows the FAT sees "free" after the first cluster and returns 4096 bytes.
    const size = 3 * CLUSTER - 100;
    const data = pattern(size, 3);
    const v = new ExfatVolume(40);
    v.putData(10, data);
    v.putEntries(2, [{ name: 'video.bin', start: 10, length: size, noFatChain: true }]);

    const session = v.session();
    expect(listExfatDirectory(readerOf(v.buf), parseExfatBootSector(readerOf(v.buf)), 2)[0].noFatChain).toBe(true);
    const problems: ExtractProblem[] = [];
    expect(extractPath(session, '', out, problems)).toBe(1);
    expect(problems).toEqual([]);
    const got = fs.readFileSync(path.join(out, 'video.bin'));
    expect(got.length).toBe(size);
    expect(got.equals(data)).toBe(true);
  });

  it('lists a NoFatChain directory that spans several clusters in full', () => {
    // The directory's own FAT entries are not valid either, so only its first cluster used to be read
    // and every file after the first ~42 silently vanished from the listing and the extraction.
    const v = new ExfatVolume(60);
    const entries: ExEntry[] = [];
    for (let i = 0; i < 100; i++) entries.push({ name: `f${String(i).padStart(3, '0')}`, start: 0, length: 0 });
    v.putEntries(2, [{ name: 'big', dir: true, start: 20, length: 3 * CLUSTER, noFatChain: true }]);
    v.putEntries(20, entries);

    const session = v.session();
    expect(listDirectory(session, '/big')).toHaveLength(100);
    expect(extractPath(session, '', out)).toBe(100);
    expect(fs.readdirSync(path.join(out, 'big'))).toHaveLength(100);
  });

  it('reads zeros past ValidDataLength instead of stale cluster contents', () => {
    const v = new ExfatVolume(40);
    v.putData(12, Buffer.alloc(2 * CLUSTER, 0xee)); // stale bytes from a deleted file
    v.putData(12, Buffer.alloc(1000, 0x11));
    v.chain(12, 13);
    v.putEntries(2, [{ name: 'prealloc.bin', start: 12, length: 6000, validDataLength: 1000 }]);

    extractPath(v.session(), '', out);
    const got = fs.readFileSync(path.join(out, 'prealloc.bin'));
    expect(got.length).toBe(6000);
    expect(got.subarray(0, 1000).every((x) => x === 0x11)).toBe(true);
    expect(got.subarray(1000).every((x) => x === 0)).toBe(true);
  });

  it('cannot be made to write outside the destination, and renames what Windows would reject', () => {
    const v = new ExfatVolume(40);
    for (let i = 0; i < 5; i++) v.putData(10 + i, Buffer.from(`file ${i}`));
    v.putEntries(2, [
      { name: '../escape.txt', start: 10, length: 6 },
      { name: 'CON', start: 11, length: 6 },
      { name: 'trailing.', start: 12, length: 6 },
      { name: 'A.txt', start: 13, length: 6 },
      { name: 'a.txt', start: 14, length: 6 }
    ]);

    const inner = path.join(out, 'inner');
    const problems: ExtractProblem[] = [];
    extractPath(v.session(), '', inner, problems);

    expect(fs.existsSync(path.join(out, 'escape.txt'))).toBe(false);
    expect(fs.readdirSync(inner).sort()).toEqual(['.._escape.txt', '_CON', 'A.txt', 'a (2).txt', 'trailing'].sort());
    expect(problems.filter((p) => p.kind === 'renamed').map((p) => p.path).sort()).toEqual(
      ['/../escape.txt', '/CON', '/a.txt', '/trailing.'].sort()
    );
    // Both case-colliding files survive with their own contents.
    expect(fs.readFileSync(path.join(inner, 'A.txt'), 'utf8')).toBe('file 3');
    expect(fs.readFileSync(path.join(inner, 'a (2).txt'), 'utf8')).toBe('file 4');
  });

  it('carries on past a file it cannot recover and says which one, when collecting problems', () => {
    const v = new ExfatVolume(40);
    v.putData(16, Buffer.from('good data'));
    v.chain(14); // chain ends after one cluster, but the entry claims 9000 bytes
    v.putEntries(2, [
      { name: 'truncated.bin', start: 14, length: 9000 },
      { name: 'good.bin', start: 16, length: 9 }
    ]);

    const problems: ExtractProblem[] = [];
    expect(extractPath(v.session(), '', out, problems)).toBe(1);
    expect(fs.readFileSync(path.join(out, 'good.bin'), 'utf8')).toBe('good data');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: '/truncated.bin', kind: 'skipped' });
    expect(problems[0].reason).toMatch(/chain ends/);
    // A half-written file must not be left looking like a complete, shorter one.
    expect(fs.existsSync(path.join(out, 'truncated.bin'))).toBe(false);
  });

  it('still throws on the first failure when no problem list is given', () => {
    const v = new ExfatVolume(40);
    v.chain(14);
    v.putEntries(2, [{ name: 'truncated.bin', start: 14, length: 9000 }]);
    expect(() => extractPath(v.session(), '', out)).toThrow(/chain ends/);
  });

  it('gives extracted files and folders their original modified time', () => {
    // 2024-05-17 10:30:20 local time
    const date = ((2024 - 1980) << 9) | (5 << 5) | 17;
    const time = (10 << 11) | (30 << 5) | 10;
    const expected = Math.floor(new Date(2024, 4, 17, 10, 30, 20).getTime() / 1000);
    const v = new ExfatVolume(40);
    v.putData(12, Buffer.from('hello'));
    v.putEntries(2, [{ name: 'sub', dir: true, start: 11, length: CLUSTER, date, time }]);
    v.putEntries(11, [{ name: 'note.txt', start: 12, length: 5, date, time }]);

    extractPath(v.session(), '', out);
    expect(Math.floor(fs.statSync(path.join(out, 'sub', 'note.txt')).mtimeMs / 1000)).toBe(expected);
    expect(Math.floor(fs.statSync(path.join(out, 'sub')).mtimeMs / 1000)).toBe(expected);
  });

  it('survives a directory that points back at one of its parents', () => {
    const v = new ExfatVolume(40);
    v.putEntries(2, [{ name: 'loop', dir: true, start: 2, length: CLUSTER }]);
    const problems: ExtractProblem[] = [];
    expect(extractPath(v.session(), '', out, problems)).toBe(0);
    expect(problems).toEqual([{ path: '/loop', kind: 'skipped', reason: 'This folder loops back to one of its parent folders.' }]);
  });

  it('streams a file in pieces whatever the filesystem keeps in its FAT', () => {
    const size = 3 * CLUSTER - 100;
    const data = pattern(size, 9);
    const v = new ExfatVolume(40);
    v.putData(10, data);
    v.putData(20, data.subarray(0, CLUSTER));
    v.putData(25, data.subarray(CLUSTER, 2 * CLUSTER));
    v.putData(21, data.subarray(2 * CLUSTER));
    v.chain(20, 25, 21);
    const layout = parseExfatBootSector(readerOf(v.buf));

    for (const [start, noFatChain] of [
      [10, true],
      [20, false]
    ] as Array<[number, boolean]>) {
      const chunks: Buffer[] = [];
      forEachExfatFileChunk(readerOf(v.buf), layout, start, size, (c) => chunks.push(c), { noFatChain, chunkBytes: CLUSTER });
      expect(chunks.map((c) => c.length)).toEqual([CLUSTER, CLUSTER, CLUSTER - 100]);
      expect(Buffer.concat(chunks).equals(data)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FAT32
// ---------------------------------------------------------------------------

describe('FAT32 streaming', () => {
  it('reads a file larger than 1 GiB, which the whole-file reader refuses', () => {
    const clusterSize = 32768;
    const clusters = 49152; // 1.5 GiB
    const size = clusters * clusterSize;
    const layout: Fat32Layout = {
      bytesPerSector: 512,
      sectorsPerCluster: 64,
      clusterSize,
      reservedSectors: 32,
      numberOfFATs: 2,
      sectorsPerFAT32: 1000,
      rootDirCluster: 2,
      fatStart: 0,
      dataStart: 1_000_000,
      totalClusters: 100_000
    };
    const zeros = Buffer.alloc(clusterSize);
    const reader = {
      size: layout.dataStart + 100_000 * clusterSize,
      read: (offset: number, length: number): Buffer => {
        if (offset < layout.dataStart) {
          const cluster = offset / 4;
          const next = cluster >= 2 + clusters - 1 ? 0x0fffffff : cluster + 1;
          const b = Buffer.alloc(4);
          b.writeUInt32LE(next, 0);
          return b;
        }
        return zeros.subarray(0, length);
      }
    } as PartitionReader;

    let total = 0;
    let largest = 0;
    forEachFat32FileChunk(reader, layout, 2, size, (chunk) => {
      total += chunk.length;
      largest = Math.max(largest, chunk.length);
    });
    expect(total).toBe(size);
    expect(largest).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('reports a chain that ends early instead of returning a short file', () => {
    const layout: Fat32Layout = {
      bytesPerSector: 512,
      sectorsPerCluster: 8,
      clusterSize: 4096,
      reservedSectors: 32,
      numberOfFATs: 2,
      sectorsPerFAT32: 8,
      rootDirCluster: 2,
      fatStart: 0,
      dataStart: 8192,
      totalClusters: 100
    };
    const reader = {
      size: 1 << 20,
      read: (offset: number, length: number): Buffer => {
        const b = Buffer.alloc(length);
        if (offset < layout.dataStart) b.writeUInt32LE(0x0fffffff, 0); // every chain ends at once
        return b;
      }
    } as PartitionReader;
    expect(() => forEachFat32FileChunk(reader, layout, 2, 10000, () => undefined)).toThrow(/chain ends/);
  });
});

// ---------------------------------------------------------------------------
// NTFS
// ---------------------------------------------------------------------------

const layout = parseBootSector(buildNtfsVolume());
const reparseValue = (tag: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(tag >>> 0, 0);
  return b;
};

function ntfsFile(opts: {
  size: number;
  runs: Array<{ startLcn: number; runLength: number; sparse?: boolean }>;
  initializedSize?: number;
  reparseTag?: number;
  compressionUnit?: number;
}) {
  const attrs: Array<Record<string, unknown>> = [{ type: 0x30, nonResident: false, resident: fileNameAttr(5, 'f.bin', 1) }];
  if (opts.reparseTag !== undefined) {
    attrs.push({ type: 0xc0, nonResident: false, resident: reparseValue(opts.reparseTag) });
  }
  attrs.push({
    type: 0x80,
    nonResident: true,
    runs: opts.runs,
    realSize: opts.size,
    initializedSize: opts.initializedSize,
    vcn: 0,
    compressionUnit: opts.compressionUnit
  });
  return parseFileRecord(buildFileRecord(14, { inUse: true, attrs: attrs as never }), 14);
}

const clusters = (...fills: Array<[number, number]>): PartitionReader => {
  const data = Buffer.alloc(64 * NTFS_CLUSTER);
  for (const [lcn, byte] of fills) data.fill(byte, lcn * NTFS_CLUSTER, (lcn + 1) * NTFS_CLUSTER);
  return readerOf(data);
};

describe('NTFS file data', () => {
  it('reads zeros past the valid data length instead of stale clusters', () => {
    const reader = clusters([40, 0xab], [41, 0xab]);
    const file = ntfsFile({ size: 2 * NTFS_CLUSTER, runs: [{ startLcn: 40, runLength: 2 }], initializedSize: 100 });
    expect(file.initializedSize).toBe(100);

    const whole = readFileData(reader, layout, file);
    expect(whole.length).toBe(2 * NTFS_CLUSTER);
    expect(whole.subarray(0, 100).every((x) => x === 0xab)).toBe(true);
    expect(whole.subarray(100).every((x) => x === 0)).toBe(true);

    const range = readFileRange(reader, layout, file, 50, 200);
    expect(range.subarray(0, 50).every((x) => x === 0xab)).toBe(true);
    expect(range.subarray(50).every((x) => x === 0)).toBe(true);

    const chunks: Buffer[] = [];
    forEachNtfsFileChunk(reader, layout, file, (c) => chunks.push(c), NTFS_CLUSTER);
    expect(Buffer.concat(chunks).equals(whole)).toBe(true);
  });

  it('streams a plain file in pieces that add up to the whole file', () => {
    const reader = clusters([40, 0x41], [41, 0x42], [42, 0x43]);
    const file = ntfsFile({ size: 3 * NTFS_CLUSTER, runs: [{ startLcn: 40, runLength: 3 }] });
    const chunks: Buffer[] = [];
    forEachNtfsFileChunk(reader, layout, file, (c) => chunks.push(c), NTFS_CLUSTER);
    expect(chunks.map((c) => c.length)).toEqual([NTFS_CLUSTER, NTFS_CLUSTER, NTFS_CLUSTER]);
    expect(Buffer.concat(chunks).equals(readFileData(reader, layout, file))).toBe(true);
  });

  it.each([
    [0x80000017, /Compact OS/],
    [0x9000701a, /cloud file/],
    [0x80000013, /Deduplication/]
  ])('refuses a redirected file (tag %s) rather than returning zeros that look like content', (tag, why) => {
    const file = ntfsFile({ size: 2 * NTFS_CLUSTER, runs: [{ startLcn: 0, runLength: 2, sparse: true }], reparseTag: tag });
    expect(file.reparseTag).toBe(tag >>> 0);
    expect(dataUnavailableReason(file)).toMatch(why);
    expect(() => readFileData(clusters(), layout, file)).toThrow(NtfsDataUnavailableError);
    expect(() => readFileRange(clusters(), layout, file, 0, 10)).toThrow(NtfsDataUnavailableError);
  });

  it('still reads a cloud file that is fully present on disk', () => {
    const file = ntfsFile({ size: 2 * NTFS_CLUSTER, runs: [{ startLcn: 40, runLength: 2 }], reparseTag: 0x9000001a });
    expect(dataUnavailableReason(file)).toBeUndefined();
    expect(readFileData(clusters([40, 0xcd], [41, 0xcd]), layout, file).every((x) => x === 0xcd)).toBe(true);
  });

  it('still reads a genuinely sparse file as zeros', () => {
    const file = ntfsFile({ size: 2 * NTFS_CLUSTER, runs: [{ startLcn: 0, runLength: 2, sparse: true }] });
    expect(dataUnavailableReason(file)).toBeUndefined();
    const data = readFileData(clusters(), layout, file);
    expect(data.length).toBe(2 * NTFS_CLUSTER);
    expect(data.every((x) => x === 0)).toBe(true);
  });

  it('reports a file whose data runs are missing instead of returning an empty file', () => {
    const file = ntfsFile({ size: 5000, runs: [{ startLcn: 0, runLength: 2, sparse: true }] });
    file.dataRuns = []; // the fixture cannot encode an empty run list
    expect(() => readFileData(clusters(), layout, file)).toThrow(/data runs could not be located/);
  });

  // A compressed unit of 2 clusters holding two LZNT1 chunks that each decode to 4096 copies of one byte.
  const lzChunks = (a: number, b: number): Buffer =>
    Buffer.concat([Buffer.from([0x03, 0xb0, 0x02, a, 0xfc, 0x0f]), Buffer.from([0x03, 0xb0, 0x02, b, 0xfc, 0x0f])]);

  it('reads a compressed file that has more than one compression unit', () => {
    // Every unit after the first used to fail with "Data run list does not cover offset": the reader looked
    // up a file-level offset in a list holding only the current run, so any compressed file larger than one
    // unit (64 KiB by default) could not be read, extracted, previewed or mounted.
    const data = Buffer.alloc(64 * NTFS_CLUSTER);
    lzChunks(0x41, 0x42).copy(data, 40 * NTFS_CLUSTER);
    lzChunks(0x43, 0x44).copy(data, 41 * NTFS_CLUSTER);
    const file = ntfsFile({
      size: 4 * NTFS_CLUSTER,
      runs: [
        { startLcn: 40, runLength: 1 },
        { startLcn: 0, runLength: 1, sparse: true },
        { startLcn: 41, runLength: 1 },
        { startLcn: 0, runLength: 1, sparse: true }
      ],
      compressionUnit: 1
    });
    const got = readFileData(readerOf(data), layout, file);
    expect(got.length).toBe(4 * NTFS_CLUSTER);
    for (const [i, byte] of [0x41, 0x42, 0x43, 0x44].entries()) {
      expect(got.subarray(i * NTFS_CLUSTER, (i + 1) * NTFS_CLUSTER).every((x) => x === byte)).toBe(true);
    }
  });

  it('reads a short last unit that is stored raw', () => {
    // Three clusters of a 4-cluster unit, no sparse fill after them: raw data, not LZNT1.
    const data = Buffer.alloc(64 * NTFS_CLUSTER);
    const raw = pattern(3 * NTFS_CLUSTER, 5);
    raw.copy(data, 40 * NTFS_CLUSTER);
    const file = ntfsFile({ size: 3 * NTFS_CLUSTER, runs: [{ startLcn: 40, runLength: 3 }], compressionUnit: 2 });
    expect(readFileData(readerOf(data), layout, file).equals(raw)).toBe(true);
  });

  it('reads a compressed file the same way every time it is read', () => {
    // Unit 0 is compressed (decodes to 4096 x 'A' + 4096 x 'B') and is followed by a sparse run that
    // covers its fill AND all of unit 1, then a raw unit. Consuming the fill used to shorten the shared
    // run in the cached record, so the second read of the same file came back shifted by a cluster.
    const chunkA = Buffer.from([0x03, 0xb0, 0x02, 0x41, 0xfc, 0x0f]);
    const chunkB = Buffer.from([0x03, 0xb0, 0x02, 0x42, 0xfc, 0x0f]);
    const data = Buffer.alloc(64 * NTFS_CLUSTER);
    Buffer.concat([chunkA, chunkB]).copy(data, 40 * NTFS_CLUSTER);
    data.fill(0x43, 42 * NTFS_CLUSTER, 43 * NTFS_CLUSTER);
    data.fill(0x44, 43 * NTFS_CLUSTER, 44 * NTFS_CLUSTER);
    const file = ntfsFile({
      size: 6 * NTFS_CLUSTER,
      runs: [
        { startLcn: 40, runLength: 1 },
        { startLcn: 0, runLength: 3, sparse: true },
        { startLcn: 42, runLength: 2 }
      ],
      compressionUnit: 1
    });
    const before = JSON.stringify(file.dataRuns);
    const reader = readerOf(data);

    const expected = Buffer.concat([
      Buffer.alloc(NTFS_CLUSTER, 0x41),
      Buffer.alloc(NTFS_CLUSTER, 0x42),
      Buffer.alloc(2 * NTFS_CLUSTER, 0),
      Buffer.alloc(NTFS_CLUSTER, 0x43),
      Buffer.alloc(NTFS_CLUSTER, 0x44)
    ]);
    expect(readFileData(reader, layout, file).equals(expected)).toBe(true);
    expect(readFileData(reader, layout, file).equals(expected)).toBe(true);
    expect(JSON.stringify(file.dataRuns)).toBe(before);
  });
});

describe('safeFileName', () => {
  it.each([
    ['plain.txt', 'plain.txt'],
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['..\\..\\evil.dll', '.._.._evil.dll'],
    ['..', '_'],
    ['.', '_'],
    ['', '_'],
    ['C:\\Windows\\x', 'C__Windows_x'],
    ['report: final?.doc', 'report_ final_.doc'],
    ['trailing. . ', 'trailing'],
    ['nul', '_nul'],
    ['COM1.txt', '_COM1.txt'],
    ['console.txt', 'console.txt'],
    ['tab\there', 'tab_here']
  ])('%j becomes %j', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });

  it('keeps a name within the 255-character limit', () => {
    expect(safeFileName('x'.repeat(400))).toHaveLength(255);
  });
});
