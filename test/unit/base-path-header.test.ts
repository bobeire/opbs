import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeHeader,
  ImageHeader,
  IMAGE_VERSION,
  DEFAULT_BLOCK_SIZE,
  COMPRESSION_NONE,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_VERIFIED,
  FLAG_INCREMENTAL,
  CIPHER_NONE,
  SALT_LENGTH,
  BASE_IMAGE_PATH_LENGTH,
  BASE_IMAGE_PATH_MAX_BYTES,
  encodeBaseImagePath,
  decodeBaseImagePath,
  baseImageFileName,
  baseImageHeaderValue,
  baseImageCandidates,
  resolveImageChain,
  readImageInfo,
  clearImageInfoCache
} from '../../src/main/imaging/image-format';

/**
 * The header records an incremental's base in a fixed 128-byte field. It used
 * to be written as 'ascii' and cut at 127 characters, so a deep folder, a
 * network path or an accented name produced a header that pointed nowhere and
 * a chain that could never be restored - with no error at backup time.
 */
function writeImage(dir: string, name: string, opts: { ts: number; base?: string }): string {
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: opts.ts,
    totalBytes: 0,
    blockSize: DEFAULT_BLOCK_SIZE,
    compressionId: COMPRESSION_NONE,
    partitionCount: 0,
    flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED | (opts.base ? FLAG_INCREMENTAL : 0),
    blockIndexOffset: 0,
    cipherId: CIPHER_NONE,
    kdfIterations: 0,
    salt: Buffer.alloc(SALT_LENGTH),
    baseImagePath: opts.base ?? '',
    sourceDiskModel: '',
    sourceDiskSerial: ''
  };
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, encodeHeader(header));
  return filePath;
}

const roundTrip = (value: string): string => decodeBaseImagePath(encodeBaseImagePath(value));

describe('base image path field encoding', () => {
  it('round-trips ASCII, accented, CJK and astral characters', () => {
    for (const value of ['D:\\Backups\\full.opbs', 'D:\\Sauvegardes\\José Müller\\full.opbs', 'D:\\バックアップ\\full.opbs', '/mnt/💾/full.opbs']) {
      expect(roundTrip(value)).toBe(value);
    }
  });

  it('keeps the last byte as a NUL terminator', () => {
    const buf = encodeBaseImagePath('x'.repeat(500));
    expect(buf.length).toBe(BASE_IMAGE_PATH_LENGTH);
    expect(buf[BASE_IMAGE_PATH_LENGTH - 1]).toBe(0);
    expect(roundTrip('x'.repeat(500))).toHaveLength(BASE_IMAGE_PATH_MAX_BYTES);
  });

  it('never cuts a multi-byte character in half when it has to truncate', () => {
    // 126 ASCII bytes + a 2-byte character = 128 bytes: the character straddles
    // the limit, so it is dropped whole rather than leaving half of it behind.
    const straddling = 'a'.repeat(126) + 'é';
    const decoded = roundTrip(straddling);
    expect(decoded).toBe('a'.repeat(126));
    expect(decoded).not.toContain('\uFFFD');
    // Exactly at the limit, the character is kept.
    expect(roundTrip('a'.repeat(125) + 'éz')).toBe('a'.repeat(125) + 'é');
  });

  it('reads a value an older version wrote as latin1-style bytes', () => {
    // Old versions called buf.write(value, 'ascii'), which Node encodes as
    // latin1: an accented name became single bytes that are not valid UTF-8.
    const legacy = Buffer.alloc(BASE_IMAGE_PATH_LENGTH);
    legacy.write('D:\\Sauvegardes\\José Müller\\full.opbs', 0, 'ascii');
    expect(decodeBaseImagePath(legacy)).toBe('D:\\Sauvegardes\\José Müller\\full.opbs');
    // Plain ASCII is identical in both encodings.
    const plain = Buffer.alloc(BASE_IMAGE_PATH_LENGTH);
    plain.write('D:\\Backups\\full.opbs', 0, 'ascii');
    expect(decodeBaseImagePath(plain)).toBe('D:\\Backups\\full.opbs');
  });

  it('treats an empty field as no base', () => {
    expect(decodeBaseImagePath(encodeBaseImagePath(undefined))).toBe('');
    expect(decodeBaseImagePath(encodeBaseImagePath(''))).toBe('');
  });
});

describe('baseImageFileName', () => {
  it('splits on both separators so a Windows header reads anywhere', () => {
    expect(baseImageFileName('E:\\Backups\\Work\\full.opbs')).toBe('full.opbs');
    expect(baseImageFileName('/mnt/backups/full.opbs')).toBe('full.opbs');
    expect(baseImageFileName('\\\\nas\\share/mixed\\full.opbs')).toBe('full.opbs');
    expect(baseImageFileName('full.opbs')).toBe('full.opbs');
    expect(baseImageFileName('')).toBe('');
  });
});

describe('baseImageHeaderValue (what a new incremental records)', () => {
  const longDir = path.join(path.sep, 'backups', 'x'.repeat(70), 'y'.repeat(70));

  it('records nothing for a full image', () => {
    expect(baseImageHeaderValue('/b/delta.opbs', '')).toBe('');
  });

  it('keeps the full path when it is plain ASCII and fits, so older versions still read it', () => {
    const base = path.join(path.sep, 'backups', 'full.opbs');
    expect(baseImageHeaderValue(path.join(path.sep, 'backups', 'delta.opbs'), base)).toBe(base);
  });

  it('records just the file name when a long base sits beside the new image', () => {
    const base = path.join(longDir, 'full.opbs');
    expect(Buffer.byteLength(base)).toBeGreaterThan(BASE_IMAGE_PATH_MAX_BYTES);
    expect(baseImageHeaderValue(path.join(longDir, 'delta.opbs'), base)).toBe('full.opbs');
  });

  it('records just the file name for a non-ASCII folder beside the new image', () => {
    const dir = path.join(path.sep, 'sauvegardes', 'José Müller');
    expect(baseImageHeaderValue(path.join(dir, 'delta.opbs'), path.join(dir, 'full.opbs'))).toBe('full.opbs');
  });

  it('keeps a non-ASCII full path as UTF-8 when the base is elsewhere but fits', () => {
    const base = path.join(path.sep, 'sauvegardes', 'José', 'full.opbs');
    const value = baseImageHeaderValue(path.join(path.sep, 'other', 'delta.opbs'), base);
    expect(value).toBe(base);
    expect(roundTrip(value)).toBe(base);
  });

  it('refuses, before anything is written, a base that is elsewhere and too long to record', () => {
    const base = path.join(longDir, 'full.opbs');
    expect(() => baseImageHeaderValue(path.join(path.sep, 'other', 'delta.opbs'), base)).toThrow(/too long to record/);
    expect(() => baseImageHeaderValue(path.join(path.sep, 'other', 'delta.opbs'), base)).toThrow(/127/);
  });
});

describe('baseImageCandidates with the new header values', () => {
  it('resolves a bare file name only beside the referencing image', () => {
    const delta = path.join(path.sep, 'moved', 'here', 'delta.opbs');
    // Never against the process's working directory: that would be a guess.
    expect(baseImageCandidates(delta, 'full.opbs')).toEqual([path.join(path.sep, 'moved', 'here', 'full.opbs')]);
  });

  it('finds the file name in a Windows-style value on any platform', () => {
    const delta = path.join(path.sep, 'moved', 'delta.opbs');
    expect(baseImageCandidates(delta, 'E:\\Backups\\full.opbs')).toEqual([
      path.join(path.sep, 'moved', 'full.opbs'),
      'E:\\Backups\\full.opbs'
    ]);
  });

  it('still tries an absolute stored path second', () => {
    const delta = path.join(path.sep, 'moved', 'delta.opbs');
    const stored = path.join(path.sep, 'orig', 'full.opbs');
    expect(baseImageCandidates(delta, stored)).toEqual([path.join(path.sep, 'moved', 'full.opbs'), stored]);
  });
});

describe('incremental chains with long and non-ASCII folders', () => {
  let root: string;

  beforeEach(() => {
    clearImageInfoCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-basepath-'));
  });

  afterEach(() => {
    clearImageInfoCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves, and keeps resolving after a move, when the folder path exceeds the header field', () => {
    // 149+ characters including accented names: the case that used to be cut
    // off mid-file-name or mangled to "Josi M|ller".
    const dir = path.join(root, 'Sauvegardes José Müller', 'x'.repeat(60), 'y'.repeat(60));
    fs.mkdirSync(dir, { recursive: true });
    expect(Buffer.byteLength(path.join(dir, 'full.opbs'))).toBeGreaterThan(BASE_IMAGE_PATH_MAX_BYTES);

    const full = writeImage(dir, 'full.opbs', { ts: 1000 });
    const delta1 = writeImage(dir, 'delta1.opbs', { ts: 2000, base: baseImageHeaderValue(path.join(dir, 'delta1.opbs'), full) });
    const delta2 = writeImage(dir, 'delta2.opbs', { ts: 3000, base: baseImageHeaderValue(path.join(dir, 'delta2.opbs'), delta1) });

    expect(readImageInfo(delta2).header.baseImagePath).toBe('delta1.opbs');
    expect(resolveImageChain(delta2)).toEqual([full, delta1, delta2]);

    // Move the whole folder, as a new drive letter or a NAS copy would.
    const moved = path.join(root, 'elsewhere');
    fs.renameSync(path.join(root, 'Sauvegardes José Müller'), moved);
    clearImageInfoCache();
    const movedDir = path.join(moved, 'x'.repeat(60), 'y'.repeat(60));
    expect(resolveImageChain(path.join(movedDir, 'delta2.opbs'))).toEqual([
      path.join(movedDir, 'full.opbs'),
      path.join(movedDir, 'delta1.opbs'),
      path.join(movedDir, 'delta2.opbs')
    ]);
  });

  it('explains a chain whose recorded path was cut off by the old limit', () => {
    // What an older version left behind: a full 127-byte value that points at
    // nothing. The error has to say why, not just that a truncated path is missing.
    const cutOff = path.join(path.sep, 'nonexistent', 'd'.repeat(200), 'full.opbs');
    const delta = writeImage(root, 'delta.opbs', { ts: 2000, base: cutOff });
    expect(Buffer.byteLength(readImageInfo(delta).header.baseImagePath)).toBe(BASE_IMAGE_PATH_MAX_BYTES);
    expect(() => resolveImageChain(delta)).toThrow(/cut off by the limit of earlier versions/);
  });

  it('keeps the ordinary not-found error for a genuinely missing short base', () => {
    const delta = writeImage(root, 'delta.opbs', { ts: 2000, base: path.join(path.sep, 'nonexistent', 'full.opbs') });
    expect(() => resolveImageChain(delta)).toThrow(/Image not found/);
    expect(() => resolveImageChain(delta)).not.toThrow(/cut off/);
  });
});
