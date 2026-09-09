/**
 * NTFS LZNT1 (LZNTX) decompressor. See Microsoft [MS-XCA] §2.5.
 *
 * A compressed stream is a sequence of chunks. Each chunk starts with a 16-bit
 * little-endian header:
 *   - bit 15: 1 = compressed, 0 = literal (raw copy).
 *   - bits 12-14: signature (0b011; ignored on decode).
 *   - bits 0-11: chunk payload length minus 1.
 * A header of 0x0000 terminates the stream.
 *
 * A compressed chunk is a sequence of 8-token groups: one flag byte (LSB
 * first), then up to 8 tokens. A 0 flag bit is a literal byte; a 1 flag bit is
 * a 16-bit back-reference tuple with a dynamic offset/length split based on how
 * many bytes have been emitted within the chunk (Microsoft's sliding bit
 * allocator).
 */

const MAX_CHUNK = 4096;
const OFFSET_BITS_LOOKUP = [0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000];

function offsetBits(emitted: number): number {
  let index = 0;
  while (index < OFFSET_BITS_LOOKUP.length - 1 && emitted > OFFSET_BITS_LOOKUP[index]) {
    index++;
  }
  // offset bits = 4 + index; length bits = 16 - offset bits = 12 - index.
  return 4 + index;
}

/** Decompress `src` (one or more LZNT1 chunks) into up to `outputSize` bytes. */
export function decompressLznt1(src: Buffer, outputSize: number): Buffer {
  const out = Buffer.alloc(outputSize);
  let srcPos = 0;
  let outPos = 0;

  while (srcPos + 2 <= src.length && outPos < outputSize) {
    const header = src.readUInt16LE(srcPos);
    if (header === 0) break;
    const isCompressed = (header & 0x8000) !== 0;
    const chunkLen = (header & 0x0fff) + 1;
    srcPos += 2;
    if (srcPos + chunkLen > src.length) break;
    const chunkEnd = srcPos + chunkLen;

    if (!isCompressed) {
      const take = Math.min(chunkLen, outputSize - outPos);
      src.copy(out, outPos, srcPos, srcPos + take);
      outPos += take;
      srcPos = chunkEnd;
      continue;
    }

    const chunkStart = outPos;
    while (srcPos < chunkEnd && outPos < outputSize) {
      const flag = src[srcPos++];
      for (let bit = 0; bit < 8; bit++) {
        if (srcPos >= chunkEnd || outPos >= outputSize) break;
        if ((flag & (1 << bit)) === 0) {
          out[outPos++] = src[srcPos++];
          continue;
        }
        if (srcPos + 2 > chunkEnd) break;
        const tuple = src.readUInt16LE(srcPos);
        srcPos += 2;
        const emitted = outPos - chunkStart;
        const obits = offsetBits(emitted);
        const lbits = 16 - obits;
        const offset = (tuple >> lbits) + 1;
        const length = (tuple & ((1 << lbits) - 1)) + 3;
        const srcStart = outPos - offset;
        if (srcStart < chunkStart) break; // corrupt: displacement before chunk start
        for (let i = 0; i < length && outPos < outputSize; i++) {
          out[outPos++] = out[srcStart + i];
        }
      }
    }
    srcPos = chunkEnd;
  }

  return out;
}
