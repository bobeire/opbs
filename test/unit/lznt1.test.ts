import { describe, it, expect } from 'vitest';
import { decompressLznt1 } from '../../src/main/imaging/fs/lznt1';

describe('LZNT1 decompressor', () => {
  it('decodes a chunk with literals and a back-reference', () => {
    // Output "ABCABCABC": literals A,B,C then back-ref offset=3, length=6.
    // Flag byte 0b00001000 = 0x08 (bits 0-2 literals, bit 3 back-ref).
    // Tuple for offset=3,length=6 at emitted=3 (offset bits=4, length bits=12):
    //   tuple = ((offset-1) << 12) | (length-3) = (2 << 12) | 3 = 0x2003.
    const payload = Buffer.from([0x08, 0x41, 0x42, 0x43, 0x03, 0x20]);
    // Header: 0x8000 | 0x3000 | (len-1=5) = 0xB005.
    const chunk = Buffer.concat([Buffer.from([0x05, 0xb0]), payload]);
    const out = decompressLznt1(chunk, 9);
    expect(out.subarray(0, 9).toString()).toBe('ABCABCABC');
  });

  it('handles a literal (uncompressed) chunk', () => {
    const literal = Buffer.from('Hello, LZNT1!', 'utf8');
    // Uncompressed chunk: header without bit 15, chunkLen = literal.length.
    const header = Buffer.from([(literal.length - 1) & 0xff, ((literal.length - 1) >> 8) & 0xff]);
    const chunk = Buffer.concat([header, literal]);
    const out = decompressLznt1(chunk, literal.length);
    expect(out.subarray(0, literal.length).toString()).toBe('Hello, LZNT1!');
  });

  it('supports self-overlapping back-references (RLE)', () => {
    // Emit 'X' then back-ref offset=1 length=8 -> "XXXXXXXXX" (9 bytes).
    // Flag 0b00000010 = 0x02 (bit0 literal 'X', bit1 back-ref).
    const payload = Buffer.from([0x02, 0x58, 0x05, 0x00]); // flag, 'X', tuple 0x0005
    const header = Buffer.from([(payload.length - 1) & 0xff, ((payload.length - 1) >> 8) | 0x80]);
    const chunk = Buffer.concat([header, payload]);
    const out = decompressLznt1(chunk, 9);
    expect(out.subarray(0, 9).toString()).toBe('XXXXXXXXX');
  });

  it('stops at the end-of-stream marker', () => {
    const payload = Buffer.from([0x00, 0x41]); // flag 0, literal 'A'
    const header = Buffer.from([0x01, 0xb0]); // compressed, len=2
    const terminator = Buffer.from([0x00, 0x00]);
    const chunk = Buffer.concat([header, payload, terminator]);
    const out = decompressLznt1(chunk, 4096);
    expect(out.subarray(0, 1).toString()).toBe('A');
  });
});
