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
  resolveImageChain,
  baseImageCandidates,
  locateBaseImage,
  clearImageInfoCache
} from '../../src/main/imaging/image-format';

/**
 * Incremental chains record their base as an absolute path captured at
 * backup time. These tests pin the relocation behaviour: every hop resolves
 * against the folder of the file that references it first, so a moved or
 * copied chain keeps walking — and the co-located file wins over a still-
 * valid stored path (a copy must never chain onto a stale original).
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

describe('incremental chain relocation', () => {
  let root: string;

  beforeEach(() => {
    clearImageInfoCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-reloc-'));
  });

  afterEach(() => {
    clearImageInfoCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('offers the co-located base first, then the stored path, deduped', () => {
    const stored = path.join(root, 'A', 'full.opbs');
    // Unmoved chain: sibling and stored are the same file.
    expect(baseImageCandidates(path.join(root, 'A', 'd1.opbs'), stored)).toEqual([stored]);
    // Moved chain: sibling (new folder) leads, stored (stale) trails.
    expect(baseImageCandidates(path.join(root, 'B', 'd1.opbs'), stored)).toEqual([
      path.join(root, 'B', 'full.opbs'),
      stored
    ]);
  });

  it('control: resolves the chain where it was written', () => {
    const a = path.join(root, 'A');
    fs.mkdirSync(a);
    const full = writeImage(a, 'full.opbs', { ts: Date.now() - 2000 });
    const d1 = writeImage(a, 'd1.opbs', { ts: Date.now() - 1000, base: full });
    expect(resolveImageChain(d1)).toEqual([full, d1]);
  });

  it('resolves after the folder is moved (new drive letter / NAS / WinPE)', () => {
    const a = path.join(root, 'A');
    fs.mkdirSync(a);
    const full = writeImage(a, 'full.opbs', { ts: Date.now() - 2000 });
    writeImage(a, 'd1.opbs', { ts: Date.now() - 1000, base: full });
    const b = path.join(root, 'B');
    fs.renameSync(a, b);
    expect(resolveImageChain(path.join(b, 'd1.opbs'))).toEqual([
      path.join(b, 'full.opbs'),
      path.join(b, 'd1.opbs')
    ]);
  });

  it('prefers the co-located base over a still-existing stale original (copy scenario)', () => {
    const a = path.join(root, 'A');
    fs.mkdirSync(a);
    const full = writeImage(a, 'full.opbs', { ts: Date.now() - 2000 });
    const d1 = writeImage(a, 'd1.opbs', { ts: Date.now() - 1000, base: full });
    // Copy the folder while the original stays present: the chain must bind
    // to the copy, not silently chain deltas onto the original file.
    const b = path.join(root, 'B');
    fs.mkdirSync(b);
    fs.copyFileSync(full, path.join(b, 'full.opbs'));
    fs.copyFileSync(d1, path.join(b, 'd1.opbs'));
    expect(resolveImageChain(path.join(b, 'd1.opbs'))).toEqual([
      path.join(b, 'full.opbs'),
      path.join(b, 'd1.opbs')
    ]);
  });

  it('walks a multi-hop chain after the folder moves', () => {
    const a = path.join(root, 'A');
    fs.mkdirSync(a);
    const full = writeImage(a, 'full.opbs', { ts: Date.now() - 3000 });
    const d1 = writeImage(a, 'd1.opbs', { ts: Date.now() - 2000, base: full });
    const d2 = writeImage(a, 'd2.opbs', { ts: Date.now() - 1000, base: d1 });
    const b = path.join(root, 'B');
    fs.renameSync(a, b);
    expect(resolveImageChain(path.join(b, 'd2.opbs'))).toEqual([
      path.join(b, 'full.opbs'),
      path.join(b, 'd1.opbs'),
      path.join(b, 'd2.opbs')
    ]);
  });

  it('falls back to the stored path when no base sits beside the image', () => {
    const a = path.join(root, 'A');
    const f = path.join(root, 'F');
    fs.mkdirSync(a);
    fs.mkdirSync(f);
    const full = writeImage(f, 'full.opbs', { ts: Date.now() - 2000 });
    writeImage(a, 'd1.opbs', { ts: Date.now() - 1000, base: full });
    expect(resolveImageChain(path.join(a, 'd1.opbs'))).toEqual([full, path.join(a, 'd1.opbs')]);
  });

  it('still fails with the stored path in the error when the base is gone entirely', () => {
    const a = path.join(root, 'A');
    fs.mkdirSync(a);
    const full = writeImage(a, 'full.opbs', { ts: Date.now() - 2000 });
    const d1 = writeImage(a, 'd1.opbs', { ts: Date.now() - 1000, base: full });
    fs.unlinkSync(full);
    expect(() => resolveImageChain(d1)).toThrow(/Image not found/);
    expect(() => resolveImageChain(d1)).toThrow(full);
    // locateBaseImage itself never invents a path: stored comes back unchanged.
    expect(locateBaseImage(d1, full)).toBe(full);
  });
});
