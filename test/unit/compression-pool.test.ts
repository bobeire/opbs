import { describe, it, expect } from 'vitest';
import { CompressionPool } from '../../src/main/imaging/compression-pool';
import { compressBlock, decompressBlock, COMPRESSION_ZSTD, COMPRESSION_DEFLATE } from '../../src/main/imaging/image-format';

function blockPattern(seed: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed * 31 + i * 7) & 0xff;
  }
  return buf;
}

describe('CompressionPool', () => {
  it('compresses blocks out of order but resolves in submission order', async () => {
    const pool = new CompressionPool(4, 3, 'zstd');
    const blocks = [0, 1, 2, 3, 4, 5, 6, 7].map((seed) => blockPattern(seed, 32 * 1024));

    const results = await Promise.all(blocks.map((raw) => pool.compress(raw)));

    // Submission order == block index order; each result decodes back to its block.
    for (let i = 0; i < blocks.length; i++) {
      expect(decompressBlock(results[i], COMPRESSION_ZSTD)).toEqual(blocks[i]);
    }

    // Cross-check parity with the synchronous path.
    for (let i = 0; i < blocks.length; i++) {
      const expected = compressBlock(blocks[i], COMPRESSION_ZSTD, 3);
      expect(Buffer.compare(Buffer.from(results[i]), Buffer.from(expected))).toBe(0);
    }

    pool.stop();
  });

  it('matches the synchronous deflate path when run multithreaded', async () => {
    const pool = new CompressionPool(2, 3, 'deflate');
    const blocks = [10, 11, 12].map((seed) => blockPattern(seed, 16 * 1024));

    const results = await Promise.all(blocks.map((raw) => pool.compress(raw)));
    for (let i = 0; i < blocks.length; i++) {
      expect(Buffer.compare(Buffer.from(results[i]), Buffer.from(compressBlock(blocks[i], COMPRESSION_DEFLATE, 3)))).toBe(0);
    }
    pool.stop();
  });

  it('handles a large batch deterministically with fewer threads than blocks', async () => {
    const pool = new CompressionPool(3, 6, 'zstd');
    const count = 50;
    const blocks = Array.from({ length: count }, (_, i) => blockPattern(i, 8 * 1024));

    const results = await Promise.all(blocks.map((raw) => pool.compress(raw)));
    for (let i = 0; i < count; i++) {
      expect(decompressBlock(results[i], COMPRESSION_ZSTD)).toEqual(blocks[i]);
    }
    pool.stop();
  });

  it('rejects new work after stop', () => {
    const pool = new CompressionPool(2, 3, 'zstd');
    pool.stop();
    expect(() => pool.compress(Buffer.alloc(16))).toThrow(/stopped/i);
  });

  it('decompresses zstd blocks out of order but resolves in submission order', async () => {
    const pool = new CompressionPool(4, 3, 'zstd');
    const blocks = [0, 1, 2, 3, 4, 5, 6, 7].map((seed) => blockPattern(seed, 32 * 1024));
    const compressed = blocks.map((raw) => compressBlock(raw, COMPRESSION_ZSTD, 3));

    const results = await Promise.all(compressed.map((comp) => pool.decompress(comp)));

    for (let i = 0; i < blocks.length; i++) {
      expect(results[i]).toEqual(blocks[i]);
    }
    pool.stop();
  });

  it('decompresses deflate blocks matching the synchronous path', async () => {
    const pool = new CompressionPool(3, 3, 'deflate');
    const blocks = [20, 21, 22].map((seed) => blockPattern(seed, 16 * 1024));
    const compressed = blocks.map((raw) => compressBlock(raw, COMPRESSION_DEFLATE, 3));

    const results = await Promise.all(compressed.map((comp) => pool.decompress(comp)));
    for (let i = 0; i < blocks.length; i++) {
      expect(Buffer.compare(results[i], Buffer.from(decompressBlock(compressed[i], COMPRESSION_DEFLATE)))).toBe(0);
    }
    pool.stop();
  });

  it('round-trips through compress then decompress in the same pool', async () => {
    const pool = new CompressionPool(4, 3, 'zstd');
    const blocks = [30, 31, 32].map((seed) => blockPattern(seed, 8 * 1024));

    const compressed = await Promise.all(blocks.map((raw) => pool.compress(raw)));
    const restored = await Promise.all(compressed.map((comp) => pool.decompress(comp)));
    for (let i = 0; i < blocks.length; i++) {
      expect(restored[i]).toEqual(blocks[i]);
    }
    pool.stop();
  });
});