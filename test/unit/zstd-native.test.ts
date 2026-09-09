import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { compressBlock, decompressBlock, COMPRESSION_ZSTD } from '../../src/main/imaging/image-format';
import * as fzstd from 'fzstd';
import * as zstdify from 'zstdify';

const NATIVE_PATH = path.join(__dirname, '../../src/native/build/Release/opbs_native.node');

interface NativeZstd {
  zstdCompress: (data: Uint8Array, level?: number) => Uint8Array;
  zstdDecompress: (data: Uint8Array, maxOutput?: number) => Uint8Array;
  zstdCompressBound: (size: number) => number;
}

let native: NativeZstd | null = null;

function randomBuffer(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  crypto.randomFillSync(buf);
  return buf;
}

function compressibleBuffer(bytes: number): Buffer {
  const chunk = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(50));
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += chunk.length) {
    chunk.copy(out, i);
  }
  return out;
}

describe('native zstd (C++ libzstd in the addon)', () => {
  beforeAll(() => {
    try {
      if (fs.existsSync(NATIVE_PATH)) {
        native = require(NATIVE_PATH) as NativeZstd;
      }
    } catch {
      native = null;
    }
  });

  it('builds with the native zstd functions registered', () => {
    expect(native).not.toBeNull();
    expect(typeof native!.zstdCompress).toBe('function');
    expect(typeof native!.zstdDecompress).toBe('function');
    expect(typeof native!.zstdCompressBound).toBe('function');
  });

  it('round-trips compressible and random data across sizes and levels', () => {
    const sizes = [0, 1, 4096, 65536, 1024 * 1024];
    const levels = [1, 3, 9, 19];
    for (const size of sizes) {
      for (const compressible of [true, false]) {
        const input = compressible ? compressibleBuffer(size) : randomBuffer(size);
        for (const level of levels) {
          const frame = native!.zstdCompress(input, level);
          const out = native!.zstdDecompress(frame, input.length);
          expect(Buffer.compare(Buffer.from(out), input)).toBe(0);
        }
      }
    }
  });

  it('compressed frames start with the zstd magic and shrink compressible input', () => {
    const input = compressibleBuffer(65536);
    const frame = Buffer.from(native!.zstdCompress(input, 3));
    expect([frame[0], frame[1], frame[2], frame[3]]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(frame.length).toBeLessThan(input.length);
  });

  it('produces frames fzstd can decode (native output is standard zstd)', () => {
    const input = compressibleBuffer(100000);
    const frame = Buffer.from(native!.zstdCompress(input, 6));
    const dec = Buffer.from(fzstd.decompress(frame));
    expect(Buffer.compare(dec, input)).toBe(0);
  });

  it('decodes pure-JS zstdify frames natively', () => {
    // Single-repeated-byte data avoids zstdify's known FSE encoder bug on
    // long-match content, so the JS encoder produces a valid frame here.
    const input = Buffer.alloc(100000, 0x41);
    const jsFrame = Buffer.from(zstdify.compress(input, { level: 3 }));
    const dec = Buffer.from(native!.zstdDecompress(jsFrame, input.length));
    expect(Buffer.compare(dec, input)).toBe(0);
  });

  it('rejects garbage input', () => {
    expect(() => native!.zstdDecompress(Buffer.from('not a zstd frame'), 1024)).toThrow();
  });

  it('compressBlock/decompressBlock use the native path and stay byte-identical', () => {
    const input = randomBuffer(512 * 1024);
    const compressed = compressBlock(input, COMPRESSION_ZSTD, 3);
    expect([compressed[0], compressed[1], compressed[2], compressed[3]]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(Buffer.compare(decompressBlock(compressed, COMPRESSION_ZSTD), input)).toBe(0);
  });

  it('compressBound returns a safe upper bound', () => {
    for (const size of [0, 1024, 1024 * 1024]) {
      expect(native!.zstdCompressBound(size)).toBeGreaterThanOrEqual(size);
    }
  });
});