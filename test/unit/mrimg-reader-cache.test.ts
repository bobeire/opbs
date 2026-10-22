import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildMrimgxImage } from '../helpers/mrimg-image';
import * as mrimgFormat from '../../src/main/imaging/mrimg/mrimg-format';
import { readMacriumImage } from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';

/**
 * Regression coverage for GitHub issue #7: browsing a large Macrium image
 * froze for minutes because every 1 KiB NTFS MFT record read re-read and
 * re-decompressed the whole image block it lived in. Repeat reads of one
 * block must come from the reader's cache without touching the image file.
 */

const BLOCK_SIZE = 8192; // buildMrimgxImage's fixed block size
const BLOCK_COUNT = 4;

let fixtureDir: string;
let imagePath: string;
let volume: Buffer;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimg-cache-'));
  volume = Buffer.alloc(BLOCK_SIZE * BLOCK_COUNT);
  for (let i = 0; i < volume.length; i++) volume[i] = i & 0xff;
  const blocks: Buffer[] = [];
  for (let i = 0; i < BLOCK_COUNT; i++) {
    blocks.push(Buffer.from(volume.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE)));
  }
  imagePath = path.join(fixtureDir, 'cache-test.mrimgx');
  fs.writeFileSync(imagePath, buildMrimgxImage(blocks).buffer);
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function openReader() {
  return openMacriumPartitionReader(readMacriumImage(imagePath), 0);
}

describe('MacriumPartitionReader block cache', () => {
  it('reads across block boundaries correctly', () => {
    const reader = openReader();
    expect(reader.read(0, 16).equals(volume.subarray(0, 16))).toBe(true);
    const spanning = reader.read(BLOCK_SIZE - 100, 200);
    expect(spanning.equals(volume.subarray(BLOCK_SIZE - 100, BLOCK_SIZE + 100))).toBe(true);
  });

  it('serves a repeat read of one block without touching the file again', () => {
    const reader = openReader();
    reader.read(0, 512); // warm the block
    const rangeSpy = vi.spyOn(mrimgFormat, 'readImageFileRange');
    const again = reader.read(512, 512);
    expect(rangeSpy).not.toHaveBeenCalled();
    expect(again.equals(volume.subarray(512, 1024))).toBe(true);
  });

  it('still loads blocks it has not seen', () => {
    const reader = openReader();
    reader.read(0, 512);
    const rangeSpy = vi.spyOn(mrimgFormat, 'readImageFileRange');
    const next = reader.read(BLOCK_SIZE, 512);
    expect(rangeSpy).toHaveBeenCalled();
    expect(next.equals(volume.subarray(BLOCK_SIZE, BLOCK_SIZE + 512))).toBe(true);
  });

  it('reads record-sized slices across one block with a single file read', () => {
    const reader = openReader();
    const rangeSpy = vi.spyOn(mrimgFormat, 'readImageFileRange');
    for (let off = 0; off < BLOCK_SIZE; off += 1024) {
      const slice = reader.read(off, 1024);
      expect(slice.equals(volume.subarray(off, off + 1024))).toBe(true);
    }
    // The issue #7 pattern: eight 1 KiB record reads inside one block must
    // decompress it once, not once per record.
    expect(rangeSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
