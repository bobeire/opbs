import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { parseQuickLzFrame, decompressQuickLz } from '../../src/main/imaging/mrimg/quicklz';

type Token =
  | { lit: Buffer }
  | { match: { offset: number; len: number; form: 'a' | 'b' | 'c' | 'd' | 'e' | 'ex' } }
  | { rle: { char: number; len: number } };

/**
 * A minimal QuickLZ 1.31 level-2 *encoder* used only to build deterministic
 * frames for the unit tests. Control-word bits are appended LSB-first: one
 * zero bit per literal byte, one one bit per match/RLE token.
 */
function encodeFrame(tokens: Token[]): Buffer {
  const bitParts: number[] = [];
  const data: number[] = [];
  let outLen = 0;

  const pushBit = (b: number) => bitParts.push(b);
  const pushData = (...bytes: number[]) => data.push(...bytes);

  for (const token of tokens) {
    if ('lit' in token) {
      const bytes = [...token.lit];
      pushData(...bytes);
      outLen += bytes.length;
      for (let i = 0; i < bytes.length; i++) pushBit(0);
    } else if ('match' in token) {
      const { offset, len, form } = token.match;
      pushBit(1);
      if (form === 'a') {
        // (fetch & 3) == 0: offset in low byte bits 2..7, fixed length 3.
        expect(offset).toBeLessThanOrEqual(63);
        pushData(offset << 2);
        outLen += 3;
      } else if (form === 'b') {
        // (fetch & 3) != 0, (fetch & 2) == 0: offset in 16 bits.
        expect(offset).toBeLessThanOrEqual(16383);
        pushData((offset << 2) | 1, ((offset << 2) | 1) >> 8);
        outLen += 3;
      } else if (form === 'c') {
        // (fetch & 1) == 0: 2-byte token, len 3..18, offset <= 1023.
        expect(len).toBeGreaterThan(2);
        expect(len).toBeLessThan(19);
        expect(offset).toBeLessThanOrEqual(1023);
        const fetch = (offset << 6) | ((len - 3) << 2) | 2;
        pushData(fetch & 0xff, (fetch >> 8) & 0xff);
        outLen += len;
      } else if (form === 'd') {
        // (fetch & 4) == 0: 3-byte token, len 3..34, offset <= 65535.
        expect(len).toBeGreaterThan(2);
        expect(len).toBeLessThan(35);
        expect(offset).toBeLessThanOrEqual(65535);
        const fetch = (offset << 8) | ((len - 3) << 3) | 3;
        pushData(fetch & 0xff, (fetch >> 8) & 0xff, (fetch >> 16) & 0xff);
        outLen += len;
      } else if (form === 'e') {
        // (fetch & 8) == 0: 4-byte token, len 3..2050.
        expect(len).toBeGreaterThan(2);
        expect(len).toBeLessThanOrEqual(2050);
        expect(offset).toBeGreaterThan(0);
        const fetch = (offset << 15) | ((len - 3) << 4) | 7;
        pushData(fetch & 0xff, (fetch >> 8) & 0xff, (fetch >> 16) & 0xff, (fetch >> 24) & 0xff);
        outLen += len;
      } else {
        // Extended: two u32 that follow a fetch of 7.
        pushData(7, 0, 0, 0, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff,
          offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, (offset >> 24) & 0xff);
        outLen += len;
      }
    } else {
      // RLE token: (fetch & 0xf) == 0xf, char in bits 16..23, len in 4..15.
      const { char, len } = token.rle;
      pushBit(1);
      expect(len).toBeGreaterThan(0);
      expect(len).toBeLessThan(4096);
      const fetch = (char << 16) | (len << 4) | 15;
      pushData(fetch & 0xff, (fetch >> 8) & 0xff, (fetch >> 16) & 0xff);
      outLen += len;
    }
  }

  let cword = 0;
  for (let i = 0; i < bitParts.length; i++) cword = cword | (bitParts[i] << i);
  cword = (cword | 0x80000000) >>> 0;

  const header = Buffer.alloc(9);
  header[0] = 0x03;
  const dataBuf = Buffer.from(data);
  header.writeUInt32LE(9 + 4 + dataBuf.length, 1); // compressed size (incl. header)
  header.writeUInt32LE(outLen, 5);
  const cwordBuf = Buffer.alloc(4);
  cwordBuf.writeUInt32LE(cword, 0);
  return Buffer.concat([header, cwordBuf, dataBuf]);
}

/** Decode a frame the way the reference source-agnostic reader would. */
function expectedFromTokens(tokens: Token[]): Buffer {
  let out: number[] = [];
  for (const token of tokens) {
    if ('lit' in token) out = out.concat([...token.lit]);
    else if ('match' in token) {
      const { offset, len } = token.match;
      for (let i = 0; i < len; i++) out.push(out[out.length - offset]);
    } else {
      for (let i = 0; i < token.rle.len; i++) out.push(token.rle.char);
    }
  }
  return Buffer.from(out);
}

describe('parseQuickLzFrame', () => {
  it('parses a 9-byte header with u32 sizes', () => {
    const f = Buffer.alloc(9);
    f[0] = 0x03;
    f.writeUInt32LE(18349, 1);
    f.writeUInt32LE(65536, 5);
    expect(parseQuickLzFrame(f)).toEqual({
      compressed: true,
      headerLength: 9,
      compressedSize: 18349,
      decompressedSize: 65536
    });
  });

  it('parses a 3-byte header with u8 sizes', () => {
    const f = Buffer.from([0x01, 10, 6]);
    expect(parseQuickLzFrame(f)).toEqual({
      compressed: true,
      headerLength: 3,
      compressedSize: 10,
      decompressedSize: 6
    });
  });

  it('exposes the raw flag for uncompressed frames', () => {
    const f = Buffer.from([0x02, 15, 0, 0, 0, 6, 0, 0, 0]);
    expect(parseQuickLzFrame(f).compressed).toBe(false);
    expect(parseQuickLzFrame(f).headerLength).toBe(9);
  });

  it('rejects truncated frames', () => {
    expect(() => decompressQuickLz(Buffer.from([0x03]))).toThrow(/too short/);
  });
});

describe('decompressQuickLz raw payloads', () => {
  it('copies a raw 3-byte-header payload', () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6]);
    const raw = Buffer.from([0x00, 9, 6]); // flag, csize=9, dsize=6
    expect(decompressQuickLz(Buffer.concat([raw, payload]))).toEqual(payload);
  });

  it('copies a raw 9-byte-header payload', () => {
    const payload = Buffer.from('hello, quicklz!');
    const header = Buffer.alloc(9);
    header[0] = 0x02;
    header.writeUInt32LE(9 + payload.length, 1);
    header.writeUInt32LE(payload.length, 5);
    expect(decompressQuickLz(Buffer.concat([header, payload])).toString()).toBe('hello, quicklz!');
  });
});

describe('decompressQuickLz compressed payloads', () => {
  it('decodes a pure literal stream (tag-0 runs)', () => {
    const lit = Buffer.from('0123456789abcdef');
    const tokens: Token[] = [{ lit }];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes a short literal run above the tag-0 nibble threshold', () => {
    const lit = Buffer.from('abc');
    const tokens: Token[] = [{ lit }];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes short-offset 3-byte matches (form a)', () => {
    const tokens: Token[] = [{ lit: Buffer.from('abcd') }, { match: { offset: 3, len: 3, form: 'a' } }, { lit: Buffer.from('!') }];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes 2-byte-offset matches (form b)', () => {
    const tokens: Token[] = [
      { lit: Buffer.from('abcdefgh') },
      { match: { offset: 7, len: 3, form: 'b' } },
      { lit: Buffer.from('XY') }
    ];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes 2-byte offset+len matches (form c)', () => {
    const tokens: Token[] = [
      { lit: Buffer.from('abcdefghij') },
      { match: { offset: 5, len: 6, form: 'c' } },
      { lit: Buffer.from('!') }
    ];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes 3-byte offset+len matches (form d)', () => {
    const tokens: Token[] = [
      { lit: Buffer.from('abcdefghijkl') },
      { match: { offset: 9, len: 8, form: 'd' } },
      { lit: Buffer.from('!') }
    ];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes 4-byte offset+len matches (form e)', () => {
    const tokens: Token[] = [
      { lit: Buffer.from('abcdefghijkl') },
      { match: { offset: 10, len: 20, form: 'e' } },
      { lit: Buffer.from('!') }
    ];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes extended offset+len matches (form ex)', () => {
    const tokens: Token[] = [
      { lit: Buffer.from('abcdefghijkl') },
      { match: { offset: 11, len: 70000, form: 'ex' } },
      { lit: Buffer.from('!') }
    ];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes run-length tokens', () => {
    const tokens: Token[] = [
      { lit: Buffer.from('a') },
      { rle: { char: 0x42, len: 200 } },
      { lit: Buffer.from('end') }
    ];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('decodes overlapping self-referential matches', () => {
    const tokens: Token[] = [{ rle: { char: 0x61, len: 3 } }, { match: { offset: 1, len: 700, form: 'e' } }];
    expect(decompressQuickLz(encodeFrame(tokens))).toEqual(expectedFromTokens(tokens));
  });

  it('rejects a match that references before the start of the block', () => {
    const tokens: Token[] = [{ match: { offset: 5, len: 3, form: 'a' } }, { lit: Buffer.from('abc') }];
    const frame = encodeFrame(tokens);
    expect(() => decompressQuickLz(frame)).toThrow(/out of range/);
  });
});

describe('decompressQuickLz against the real .mrimg sample', () => {
  const sample =
    process.env.OPBS_V7_SAMPLE ??
    path.join(__dirname, '..', '..', '14CC07500E727036-00-00.mrimg');

  const sampleAvailable = fs.existsSync(sample);

  it.skipIf(!sampleAvailable)('decodes stored blocks and verifies their MD5 checksums', () => {
    const buf = fs.readFileSync(sample);
    const size = buf.length;
    expect(size).toBeGreaterThan(54);

    const metaOff = Number(buf.readBigUInt64LE(size - 48));
    const footer = buf.subarray(metaOff);
    const pathLen = footer[12];

    // Find the first partition-record marker (a length-prefixed occurrence of
    // the stored file path within the footer).
    const headerPath = footer.subarray(13, 13 + pathLen).toString('latin1');
    let marker = -1;
    for (let pos = 0; pos < footer.length - 54; ) {
      const found = footer.indexOf(headerPath, pos);
      if (found === -1 || found >= footer.length - 54) break;
      if (found !== 13 && found >= 1 && footer[found - 1] === pathLen) {
        marker = found;
        break;
      }
      pos = found + 1;
    }
    expect(marker).toBeGreaterThan(0);

    const rec0 = marker + pathLen + 36;
    const count = footer.readUInt32LE(rec0 + 2);
    expect(count).toBeGreaterThan(0);

    let verified = 0;
    for (let i = 0; i < count; i++) {
      const rec = rec0 + i * 30;
      const md5 = footer.subarray(rec + 14, rec + 30);
      const zero = md5.equals(Buffer.alloc(16));
      if (zero) continue;
      const offset = Number(footer.readBigUInt64LE(rec + 6));
      expect(offset).toBeLessThan(metaOff);
      const info = parseQuickLzFrame(buf.subarray(offset));
      expect(info.decompressedSize).toBeGreaterThanOrEqual(4096);
      const block = buf.subarray(offset, offset + info.compressedSize);
      const data = decompressQuickLz(block);
      expect(createHash('md5').update(data).digest()).toEqual(md5);
      if (++verified >= 24) break;
    }
    expect(verified).toBeGreaterThan(0);
  });
});