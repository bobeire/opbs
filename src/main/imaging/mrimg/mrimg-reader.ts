import { createHash } from 'crypto';
import { PartitionReader } from '../image-browse';
import { decompressBlock, COMPRESSION_ZSTD } from '../image-format';
import { decompressQuickLz, parseQuickLzFrame } from './quicklz';
import {
  MacriumImageInfo,
  MacriumPartitionInfo,
  MacriumUnsupportedError,
  MR_V7_HEADER_LEN,
  readImageFileRange
} from './mrimg-format';

/**
 * A `PartitionReader` over one partition of a `.mrimgx` (zstd) or `.mrimg`
 * (QuickLZ) image.
 *
 * Block N of a partition covers partition bytes
 * `[dataStart + N*blockSize, dataStart + (N+1)*blockSize)`. For an NTFS volume
 * the boot sector (LCN 0) lives at `lcn0Offset` within those bytes, so reads
 * are shifted by that offset: reader offset 0 always maps to the volume start,
 * exactly what the shared NTFS layer expects.
 */

export class MacriumPartitionReader implements PartitionReader {
  readonly size: number;
  private readonly compressed: boolean;

  constructor(
    private readonly info: MacriumImageInfo,
    private readonly part: MacriumPartitionInfo
  ) {
    this.compressed = !!this.info.compression.level && this.info.compression.level !== 'none';
    // Block N of a partition covers partition bytes
    // `[dataStart + N*blockSize, dataStart + (N+1)*blockSize)`. Partition
    // images start at the volume's first byte (dataStart 0 => boot sector is
    // block 0), so reader offset 0 maps to the volume start, matching the
    // .opbs reader the NTFS layer already consumes. (lcn0Offset is the
    // partition's byte offset on the source disk, not within the image.)
    this.size = this.part.blockCount * this.part.blockSize;
  }

  read(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new Error(`Macrium read out of range: offset=${offset} length=${length} size=${this.size}`);
    }
    if (length === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(length);
    let outPos = 0;
    let cur = offset;
    while (outPos < length) {
      const idx = Math.floor(cur / this.part.blockSize);
      const inBlock = cur % this.part.blockSize;
      const want = Math.min(length - outPos, this.part.blockSize - inBlock);
      const data = this.loadBlock(idx);
      data.copy(out, outPos, inBlock, inBlock + want);
      outPos += want;
      cur += want;
    }
    return out;
  }

  private loadBlock(idx: number): Buffer {
    if (idx >= this.part.blockCount) {
      throw new Error(`Macrium block index out of range: ${idx}`);
    }
    const expected = Math.min(this.part.blockSize, this.size - idx * this.part.blockSize);
    const el = this.part.blocks[idx];
    if (!el || el.storedLength === 0 || el.filePosition < 0) {
      // Unallocated region: covered by zeroes (matches the reference restorer).
      return Buffer.alloc(expected);
    }
    if (el.fileNumber !== 0) {
      throw new MacriumUnsupportedError(
        `${this.info.imagePath}: split/volume images (blocks in .0000/.0001 files) are not supported for browsing yet.`
      );
    }

    let raw: Buffer;
    if (this.info.format === 'mrimg-v7') {
      // QuickLZ frame: read the header to find the stored length, then the
      // full frame, and decompress per the frame's own size fields.
      const header = readImageFileRange(this.info.imagePath, el.filePosition, MR_V7_HEADER_LEN);
      const frame = parseQuickLzFrame(header);
      const stored = readImageFileRange(this.info.imagePath, el.filePosition, frame.compressedSize);
      raw = decompressQuickLz(stored);
    } else {
      const stored = readImageFileRange(this.info.imagePath, el.filePosition, el.storedLength);
      raw = this.compressed ? decompressBlock(stored, COMPRESSION_ZSTD) : stored;
    }

    const digest = createHash('md5').update(raw).digest();
    if (!digest.equals(el.md5)) {
      throw new Error(`Macrium data block ${idx} failed hash verification in ${this.info.imagePath}.`);
    }
    if (raw.length === expected) return raw;
    if (raw.length < expected) return Buffer.concat([raw, Buffer.alloc(expected - raw.length)]);
    throw new Error(`Macrium data block ${idx} is larger than its partition slot in ${this.info.imagePath}.`);
  }
}

/**
 * Build a partition reader for a Macrium image, rejecting the container
 * features that are recognised but not yet readable (encryption, splits,
 * delta chains, reserved-sector/FAT data regions).
 */
export function openMacriumPartitionReader(
  info: MacriumImageInfo,
  partitionIndex: number
): PartitionReader {
  if (info.format !== 'mrimgx' && info.format !== 'mrimg-v7') {
    throw new MacriumUnsupportedError('Only Macrium image files are readable.');
  }
  if (info.encryption.enable) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: password-protected Macrium images are not supported yet.`
    );
  }
  if (info.splitFile) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: split Macrium images (multi-part .mrimgx/.0001 files) are not supported yet.`
    );
  }
  if (info.deltaIndex) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: delta-incremental Macrium chains are not supported yet; restore or merge the chain in Reflect first.`
    );
  }
  const part = info.partitions[partitionIndex];
  if (!part) {
    throw new Error(`Partition ${partitionIndex} not present in ${info.imagePath}.`);
  }
  if (part.blockSize <= 0 || part.blockCount <= 0) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: partition ${partitionIndex} has no data blocks in this image.`
    );
  }
  if (part.dataStart !== 0) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: partition ${partitionIndex} (${part.fsType}) has a reserved-sectors data region; only NTFS volumes are browsable.`
    );
  }
  return new MacriumPartitionReader(info, part);
}