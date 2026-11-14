import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyImage, newImageCipher, COMPRESSION_NONE, COMPRESSION_DEFLATE, COMPRESSION_ZSTD } from '../../src/main/imaging/image-format';
import { verifyImageParallel } from '../../src/main/imaging/verify-parallel';
import { verifyImageAsync, verifyWorkerAvailable } from '../../src/main/imaging/verify-runner';
import { writeImageFromBytes, writeMultiVolumeImage } from '../helpers/opbs-image';

const BLOCK = 4096;

function makeBytes(blocks: number, fill = 0): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = fill === 0 ? (i * 31 + 7) % 251 : fill;
  }
  return raw;
}

describe('verifyImageParallel', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-verify-parallel-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const imagePath = (name = 'image.opbs'): string => path.join(dir, name);

  it('reports the same result and progress as verifyImage for a zstd image', async () => {
    const blocks = writeImageFromBytes(imagePath(), makeBytes(5), BLOCK, COMPRESSION_ZSTD);

    const parallelProgress: Array<[number, number]> = [];
    const parallel = await verifyImageParallel(imagePath(), undefined, (done, total) =>
      parallelProgress.push([done, total])
    );
    const sequential = await verifyImage(imagePath());

    expect(parallel).toEqual(sequential);
    expect(parallel.ok).toBe(true);
    expect(parallel.blocksVerified).toBe(blocks.length);
    expect(parallelProgress.at(-1)).toEqual([blocks.length, blocks.length]);
    expect(parallelProgress.every(([, total]) => total === blocks.length)).toBe(true);
  });

  it('verifies an encrypted image with the derived key', async () => {
    const cipher = newImageCipher('correct horse battery staple');
    const blocks = writeImageFromBytes(imagePath(), makeBytes(4), BLOCK, COMPRESSION_ZSTD, { cipher });

    const parallel = await verifyImageParallel(imagePath(), cipher.key);
    const sequential = await verifyImage(imagePath(), cipher.key);

    expect(parallel).toEqual(sequential);
    expect(parallel.ok).toBe(true);
    expect(parallel.blocksVerified).toBe(blocks.length);
  });

  it('refuses an encrypted image when no key is supplied', async () => {
    const cipher = newImageCipher('passphrase');
    writeImageFromBytes(imagePath(), makeBytes(2), BLOCK, COMPRESSION_ZSTD, { cipher });

    const parallel = await verifyImageParallel(imagePath());

    expect(parallel.ok).toBe(false);
    expect(parallel.blocksVerified).toBe(0);
    expect(parallel.error).toMatch(/passphrase is required/i);
  });

  it('handles uncompressed frames without a decompression pool', async () => {
    const blocks = writeImageFromBytes(imagePath(), makeBytes(3), BLOCK, COMPRESSION_NONE);

    const parallel = await verifyImageParallel(imagePath());
    const sequential = await verifyImage(imagePath());

    expect(parallel).toEqual(sequential);
    expect(parallel.ok).toBe(true);
    expect(parallel.blocksVerified).toBe(blocks.length);
  });

  it('verifies a deflate image the same way as the sequential pass', async () => {
    const blocks = writeImageFromBytes(imagePath(), makeBytes(4), BLOCK, COMPRESSION_DEFLATE);

    const parallel = await verifyImageParallel(imagePath());
    const sequential = await verifyImage(imagePath());

    expect(parallel).toEqual(sequential);
    expect(parallel.blocksVerified).toBe(blocks.length);
  });

  it('streams every volume of a multi-volume image', async () => {
    // Random data so 4 KiB frames do not compress below the volume limit.
    const raw = crypto.randomBytes(24 * BLOCK);
    const blocks = writeMultiVolumeImage(imagePath(), raw, BLOCK, 16 * 1024, {
      compressionId: COMPRESSION_ZSTD
    });

    // The fixture must actually have rolled over into at least one .001 file.
    expect(fs.existsSync(`${imagePath()}.001`)).toBe(true);

    const parallel = await verifyImageParallel(imagePath());
    const sequential = await verifyImage(imagePath());

    expect(parallel).toEqual(sequential);
    expect(parallel.ok).toBe(true);
    expect(parallel.blocksVerified).toBe(blocks.length);
  });

  it.runIf(verifyWorkerAvailable())('runs the same verification on a worker thread', async () => {
    const blocks = writeImageFromBytes(imagePath(), makeBytes(5), BLOCK, COMPRESSION_ZSTD);

    const progress: Array<[number, number]> = [];
    const worker = await verifyImageAsync(imagePath(), undefined, (done, total) =>
      progress.push([done, total])
    );
    const sequential = await verifyImage(imagePath());

    expect(worker).toEqual(sequential);
    expect(worker.ok).toBe(true);
    expect(worker.blocksVerified).toBe(blocks.length);
    expect(progress.at(-1)).toEqual([blocks.length, blocks.length]);
  });

  it('fails on corrupted frame data and reports the same block count in both paths', async () => {
    const blocks = writeImageFromBytes(imagePath(), makeBytes(4), BLOCK, COMPRESSION_ZSTD);

    // Flip a byte inside the second frame's compressed payload.
    const target = blocks[1];
    const fd = fs.openSync(imagePath(), 'r+');
    const byte = Buffer.alloc(1);
    fs.readSync(fd, byte, 0, 1, target.fileOffset + 16);
    byte[0] ^= 0xff;
    fs.writeSync(fd, byte, 0, 1, target.fileOffset + 16);
    fs.closeSync(fd);

    const parallel = await verifyImageParallel(imagePath());
    const sequential = await verifyImage(imagePath());

    expect(parallel.ok).toBe(false);
    expect(sequential.ok).toBe(false);
    expect(parallel.blocksVerified).toBe(sequential.blocksVerified);
    expect(parallel.blocksVerified).toBe(1);
    expect(parallel.error).toMatch(/CRC mismatch/i);
  });
});
