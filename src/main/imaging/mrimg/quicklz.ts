/**
 * QuickLZ 1.31 level-2 block decompression, as used by Macrium Reflect v7/v8
 * `.mrimg` images.
 *
 * Each stored block is a QuickLZ 1.31 frame:
 *   [flag byte][compressed size][decompressed size][payload]
 * The flag byte bit 0 selects compressed vs raw payload, bit 1 selects a
 * 9-byte header (u32 sizes) vs a 3-byte header (u8 sizes). The compressed
 * payload is a control-word bitstream of literal and LZ-match tokens.
 *
 * Level-2 decoding needs no hash table (level 0 only) and builds its window
 * purely from the output written so far. This implementation was written
 * from the QuickLZ 1.31 format description (block max 64 KiB, level 2), not
 * from the GPL reference sources.
 */

export interface QuickLzFrameInfo {
  compressed: boolean;
  /** Header length: 9 bytes (u32 sizes) or 3 bytes (u8 sizes). */
  headerLength: number;
  /** On-disk frame length including the header. */
  compressedSize: number;
  /** Output length in bytes. */
  decompressedSize: number;
}

export function parseQuickLzFrame(frame: Buffer): QuickLzFrameInfo {
  if (frame.length < 3) throw new Error('QuickLZ frame too short');
  const flag = frame.readUInt8(0);
  const wide = (flag & 0x02) !== 0;
  const headerLength = wide ? 9 : 3;
  const compressedSize = wide ? frame.readUInt32LE(1) : frame.readUInt8(1);
  const decompressedSize = wide ? frame.readUInt32LE(5) : frame.readUInt8(2);
  return {
    compressed: (flag & 0x01) !== 0,
    headerLength,
    compressedSize,
    decompressedSize
  };
}

// For a literal run, the low nibble of the control word is a bitmask whose
// lowest set bit position gives the run length (index 0 = four literals, as
// a zero nibble means the run did not end within this nibble).
const BITLUT = [4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0];

/** Decompress a QuickLZ 1.31 frame, returning the full decompressed block. */
export function decompressQuickLz(frame: Buffer): Buffer {
  const info = parseQuickLzFrame(frame);
  if (frame.length < info.compressedSize) {
    throw new Error('Truncated QuickLZ frame');
  }
  if (!info.compressed) {
    // Raw payload: copy the decompressed-size bytes that follow the header.
    const payload = frame.subarray(info.headerLength, info.headerLength + info.decompressedSize);
    if (payload.length !== info.decompressedSize) {
      throw new Error('Truncated QuickLZ raw payload');
    }
    return Buffer.from(payload);
  }

  const out = Buffer.alloc(info.decompressedSize);
  const srcStart = info.headerLength;
  const srcEnd = info.compressedSize;
  const size = out.length;
  let dst = 0;
  let src = srcStart;
  let cword = 1;

  // Reads past the end of the compressed payload are treated as zeroes,
  // matching the reference's size-limited read helpers.
  const readByte = (pos: number): number => (pos >= srcStart && pos < srcEnd ? frame[pos] : 0);
  const readU32 = (pos: number): number =>
    ((readByte(pos) | (readByte(pos + 1) << 8) | (readByte(pos + 2) << 16) | (readByte(pos + 3) << 24)) >>> 0);

  // The last 4 output bytes are always produced by the byte-precise tail
  // loop, so an LZ match never runs into them.
  const guarantee = size - 4;

  // Cover the degenerate short-block case (size < 4) as raw trailing bytes.
  if (dst >= guarantee) {
    src += 4;
    while (dst < size) out[dst++] = readByte(src++);
    return out;
  }

  for (;;) {
    if (cword === 1) {
      cword = (readU32(src) | 0x80000000) >>> 0;
      src += 4;
    }
    const fetch = readU32(src);

    if ((cword & 1) === 1) {
      // LZ match: one control bit per token.
      cword >>>= 1;

      if ((fetch & 3) === 0) {
        const offset = (fetch & 0xff) >>> 2;
        const len = 3;
        if (offset > dst || len > size - dst) throw new Error('QuickLZ match out of range');
        copyUp(out, dst, offset, len);
        dst += len;
        src += 1;
      } else if ((fetch & 2) === 0) {
        const offset = (fetch & 0xffff) >>> 2;
        const len = 3;
        if (offset > dst || len > size - dst) throw new Error('QuickLZ match out of range');
        copyUp(out, dst, offset, len);
        dst += len;
        src += 2;
      } else if ((fetch & 1) === 0) {
        const offset = (fetch & 0xffff) >>> 6;
        const len = ((fetch >>> 2) & 15) + 3;
        if (offset > dst || len > size - dst) throw new Error('QuickLZ match out of range');
        copyUp(out, dst, offset, len);
        dst += len;
        src += 2;
      } else if ((fetch & 4) === 0) {
        const offset = (fetch & 0xffffff) >>> 8;
        const len = ((fetch >>> 3) & 31) + 3;
        if (offset > dst || len > size - dst) throw new Error('QuickLZ match out of range');
        copyUp(out, dst, offset, len);
        dst += len;
        src += 3;
      } else if ((fetch & 8) === 0) {
        let offset = fetch >>> 15;
        let len: number;
        if (offset !== 0) {
          len = ((fetch >>> 4) & 2047) + 3;
          src += 4;
        } else {
          len = readU32(src + 4);
          offset = readU32(src + 8);
          src += 12;
        }
        if (offset > dst || len > size - dst) throw new Error('QuickLZ match out of range');
        copyUp(out, dst, offset, len);
        dst += len;
      } else {
        // Run-length token (fetch & 0xf == 0xf).
        const ch = (fetch >>> 16) & 0xff;
        let len = (fetch >>> 4) & 0xfff;
        if (len !== 0) {
          src += 3;
        } else {
          len = readU32(src + 3);
          src += 7;
        }
        if (len > size - dst) throw new Error('QuickLZ run out of range');
        out.fill(ch, dst, dst + len);
        dst += len;
      }
    } else {
      // Literal run: copies 4 bytes but only advances by the run length
      // (overlapping prefetch). The tail loop below produces the final
      // bytes precisely.
      if (dst >= guarantee) {
        while (dst < size) {
          if (cword === 1) {
            src += 4;
            cword = 0x80000000;
          }
          out[dst++] = readByte(src++);
          cword >>>= 1;
        }
        return out;
      }
      const n = BITLUT[cword & 0xf];
      out[dst] = readByte(src);
      out[dst + 1] = readByte(src + 1);
      out[dst + 2] = readByte(src + 2);
      out[dst + 3] = readByte(src + 3);
      dst += n;
      src += n;
      cword >>>= n;
    }
  }
}

function copyUp(out: Buffer, dst: number, offset: number, len: number): void {
  for (let i = 0; i < len; i++) {
    out[dst + i] = out[dst + i - offset];
  }
}