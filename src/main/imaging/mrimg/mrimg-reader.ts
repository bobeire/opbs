import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PartitionReader } from '../image-browse';
import { decompressBlock, COMPRESSION_ZSTD } from '../image-format';
import { decompressQuickLz, parseQuickLzFrame } from './quicklz';
import {
  MacriumImageInfo,
  MacriumPartitionInfo,
  MacriumUnsupportedError,
  MR_V7_HEADER_LEN,
  macriumUnsupportedReason,
  readImageFileRange,
  readMacriumImage
} from './mrimg-format';

/** Read and decompress a QuickLZ block frame at `filePosition`. */
function readQuickLzBlock(imagePath: string, filePosition: number, compressed: boolean): Buffer {
  const header = readImageFileRange(imagePath, filePosition, MR_V7_HEADER_LEN);
  const frame = parseQuickLzFrame(header);
  const stored = readImageFileRange(imagePath, filePosition, frame.compressedSize);
  return compressed ? decompressQuickLz(stored) : stored;
}

/**
 * Load the block that stores logical block `logicalIndex` of a base image,
 * following carries recursively down to the full image. Works for any base
 * role: a full image answers from its own full-extent index, a differential
 * from its local/carry index, an incremental from its delta list. Returns
 * undefined when the block is absent (unallocated zeroes) or the base chain
 * is broken.
 */
function loadBaseChainBlock(
  baseInfo: MacriumImageInfo,
  logicalIndex: number,
  compressed: boolean,
  seen: Set<string>
): Buffer | undefined {
  const basePath = baseInfo.imagePath;
  if (seen.has(basePath)) return undefined;
  seen.add(basePath);
  const basePart = baseInfo.partitions[0];
  if (!basePart) return undefined;
  const chain = basePart.chain;
  if (chain?.role === 'incremental' && chain.delta) {
    const hit = chain.delta.find((d) => d.logicalIndex === logicalIndex);
    if (hit) {
      const raw = readQuickLzBlock(basePath, hit.filePosition, compressed);
      const digest = createHash('md5').update(raw).digest();
      if (!digest.equals(hit.md5)) {
        throw new Error(`Macrium data block ${logicalIndex} failed hash verification in ${basePath}.`);
      }
      return raw;
    }
    // Unlisted block: unchanged since ITS base.
    if (chain.basePath) {
      try {
        return loadBaseChainBlock(readMacriumImage(chain.basePath), logicalIndex, compressed, seen);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  const el = basePart.blocks[logicalIndex];
  if (!el || el.storedLength === 0 || el.filePosition < 0) {
    if (el?.carry && chain?.basePath) {
      try {
        return loadBaseChainBlock(readMacriumImage(chain.basePath), logicalIndex, compressed, seen);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  const raw = readQuickLzBlock(basePath, el.filePosition, compressed);
  const digest = createHash('md5').update(raw).digest();
  if (!digest.equals(el.md5)) {
    throw new Error(`Macrium data block ${logicalIndex} failed hash verification in ${basePath}.`);
  }
  return raw;
}

/**
 * A `PartitionReader` over one partition of a `.mrimgx` (zstd) or `.mrimg`
 * (QuickLZ) image.
 *
 * Block N of a partition covers partition bytes
 * `[dataStart + N*blockSize, dataStart + (N+1)*blockSize)`. `dataStart` is
 * `lcn0_offset - start`: 0 for NTFS (LCN 0 holds the boot sector, so block 0
 * *is* the boot sector), and megabytes for FAT32, whose boot area + FATs
 * before the first cluster are stored separately as the index's "reserved"
 * track. This reader maps that track in front of the data blocks, so reader
 * offset 0 is always the partition's boot sector — what the NTFS/FAT32/exFAT
 * browse and restore layers expect.
 */

export class MacriumPartitionReader implements PartitionReader {
  size: number;
  /** Partition bytes before the filesystem's first cluster (FAT32 boot region). */
  private readonly dataStart: number;
  private readonly blockCount: number;
  private readonly compressed: boolean;
  private reservedTrack: Buffer | undefined;

  constructor(
    private readonly info: MacriumImageInfo,
    private readonly part: MacriumPartitionInfo
  ) {
    this.compressed = !!this.info.compression.level && this.info.compression.level !== 'none';
    this.dataStart = this.part.dataStart > 0 ? this.part.dataStart : 0;
    // An incremental has no full-extent index of its own; its extent is the
    // base's. readMacriumImage resolves that when the base is on disk, but a
    // reader built directly on an unresolved part needs it here.
    let blockCount = this.part.blockCount;
    if (this.part.chain?.role === 'incremental' && blockCount <= 0 && this.part.chain.basePath) {
      try {
        blockCount = readMacriumImage(this.part.chain.basePath).partitions[0]?.blockCount ?? 0;
      } catch {
        blockCount = 0;
      }
    }
    this.blockCount = blockCount;
    const dataBytes = blockCount * this.part.blockSize;
    // dataStart === 0 keeps the historic size (NTFS chains rely on it); a
    // FAT32 boot region extends the reader over the reserved track, capped
    // by the captured partition extent when the container records one (the
    // index may round blockCount up past the partition's last byte).
    this.size =
      this.dataStart === 0
        ? dataBytes
        : this.part.geometry.length > 0
          ? Math.min(this.dataStart + dataBytes, this.part.geometry.length)
          : this.dataStart + dataBytes;
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
      if (cur < this.dataStart) {
        const want = Math.min(length - outPos, this.dataStart - cur);
        this.loadReservedTrack().copy(out, outPos, cur, cur + want);
        outPos += want;
        cur += want;
        continue;
      }
      const rel = cur - this.dataStart;
      const idx = Math.floor(rel / this.part.blockSize);
      const inBlock = rel % this.part.blockSize;
      const want = Math.min(length - outPos, this.part.blockSize - inBlock);
      const data = this.loadBlock(idx);
      data.copy(out, outPos, inBlock, inBlock + want);
      outPos += want;
      cur += want;
    }
    return out;
  }

  /**
   * Where an mrimgx index element's bytes live: this image for its own file
   * number (no set needed), otherwise the backup-set member the composed
   * index routed it to.
   */
  private resolveBlockSource(fileNumber: number): { path: string; compressed: boolean } {
    const set = this.info.backupSet;
    if (set) {
      const src = set.files[fileNumber];
      if (src) return src;
      throw new MacriumUnsupportedError(
        `${this.info.imagePath}: block references chain member file #${fileNumber}, which was not found in its folder.`
      );
    }
    if (fileNumber !== this.info.fileNumber) {
      throw new MacriumUnsupportedError(
        `${this.info.imagePath}: split/volume images (blocks in .0000/.0001 files) are not supported for browsing yet.`
      );
    }
    return { path: this.info.imagePath, compressed: this.compressed };
  }

  private loadBlock(idx: number): Buffer {
    const totalBlocks = this.blockCount;
    if (idx >= totalBlocks) {
      throw new Error(`Macrium block index out of range: ${idx}`);
    }
    const expected = Math.min(this.part.blockSize, this.size - idx * this.part.blockSize);
    const chain = this.part.chain;
    let raw: Buffer | undefined;
    let expectedMd5: Buffer | undefined;

    if (chain?.role === 'incremental') {
      // The delta index names the blocks changed since the base; every other
      // block resolves recursively from the base chain. `part.blocks` is
      // empty for an incremental, so this branch must run before any
      // local-index lookup.
      const hit = chain.delta?.find((d) => d.logicalIndex === idx);
      if (hit) {
        raw = readQuickLzBlock(this.info.imagePath, hit.filePosition, this.compressed);
        expectedMd5 = hit.md5;
      } else if (chain.basePath) {
        try {
          const baseInfo = readMacriumImage(chain.basePath);
          raw = loadBaseChainBlock(baseInfo, idx, this.compressed, new Set([this.info.imagePath]));
          // The base may itself be an incremental with no full-extent md5s;
          // then verification was already done against the delta records.
          expectedMd5 = baseInfo.partitions[0]?.blocks[idx]?.md5;
        } catch {
          raw = undefined;
        }
      }
    } else {
      const el = this.part.blocks[idx];
      if (!el || el.storedLength === 0 || el.filePosition < 0) {
        // Unallocated region: covered by zeroes (matches the reference
        // restorer) — unless a differential carries the block forward.
        if (el?.carry && chain?.role === 'differential' && chain.basePath) {
          try {
            raw = loadBaseChainBlock(
              readMacriumImage(chain.basePath),
              idx,
              this.compressed,
              new Set([this.info.imagePath])
            );
            // A carry record's md5 equals the base's md5 of that block.
            expectedMd5 = el.md5;
          } catch {
            raw = undefined;
          }
        } else {
          return Buffer.alloc(expected);
        }
      } else {
        expectedMd5 = el.md5;
        if (this.info.format === 'mrimg-v7') {
          raw = readQuickLzBlock(this.info.imagePath, el.filePosition, this.compressed);
        } else {
          // An mrimgx index element names the file that stores its bytes:
          // this image on a full container, or the chain member the composed
          // backup-set index routed it to.
          const src = this.resolveBlockSource(el.fileNumber);
          const stored = readImageFileRange(src.path, el.filePosition, el.storedLength);
          raw = src.compressed ? decompressBlock(stored, COMPRESSION_ZSTD) : stored;
        }
      }
    }

    if (!raw) {
      return Buffer.alloc(expected);
    }
    if (expectedMd5) {
      const digest = createHash('md5').update(raw).digest();
      if (!digest.equals(expectedMd5)) {
        throw new Error(`Macrium data block ${idx} failed hash verification in ${this.info.imagePath}.`);
      }
    }
    if (raw.length === expected) return raw;
    if (raw.length < expected) return Buffer.concat([raw, Buffer.alloc(expected - raw.length)]);
    // The decompressed block is larger than the detected block size. The MD5
    // matches, so the data is correct — the block size was misdetected. Correct
    // it and return the full block.
    (this.part as { blockSize: number }).blockSize = raw.length;
    (this as { size: number }).size = this.dataStart + totalBlocks * raw.length;
    return raw;
  }

  /**
   * The reserved/boot-region track (FAT32 boot area + FATs): every index
   * element decompressed, hash-verified and concatenated, then truncated to
   * `dataStart` bytes. Built once per reader and shared across reads.
   */
  private loadReservedTrack(): Buffer {
    if (this.reservedTrack) return this.reservedTrack;
    const els = this.part.reserved ?? [];
    const chunks: Buffer[] = [];
    for (const el of els) {
      if (el.storedLength <= 0 || el.filePosition < 0) {
        throw new MacriumUnsupportedError(
          `${this.info.imagePath}: the reserved boot region of partition ${this.part.partitionIndex} has an uncaptured gap; browsing needs a capture that includes the boot sector.`
        );
      }
      const src = this.resolveBlockSource(el.fileNumber);
      const stored = readImageFileRange(src.path, el.filePosition, el.storedLength);
      const raw = src.compressed ? decompressBlock(stored, COMPRESSION_ZSTD) : stored;
      const digest = createHash('md5').update(raw).digest();
      if (!digest.equals(el.md5)) {
        throw new Error(`Macrium reserved block failed hash verification in ${src.path}.`);
      }
      chunks.push(raw);
    }
    const track = Buffer.concat(chunks);
    if (track.length < this.dataStart) {
      throw new MacriumUnsupportedError(
        `${this.info.imagePath}: the reserved boot region of partition ${this.part.partitionIndex} is captured short (${track.length} of ${this.dataStart} bytes); browsing needs a capture that includes the boot sector.`
      );
    }
    this.reservedTrack = track.subarray(0, this.dataStart);
    return this.reservedTrack;
  }
}

/**
 * Build a partition reader for a Macrium image, rejecting the container
 * features that are recognised but not yet readable (encryption, splits,
 * delta chains without their base, headless captures).
 */
export function openMacriumPartitionReader(
  info: MacriumImageInfo,
  partitionIndex: number
): PartitionReader {
  if (info.format !== 'mrimgx' && info.format !== 'mrimg-v7') {
    throw new MacriumUnsupportedError('Only Macrium image files are readable.');
  }
  const unsupported = macriumUnsupportedReason(info);
  if (unsupported) {
    throw new MacriumUnsupportedError(unsupported);
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
  // `$JSON` records where the filesystem's first cluster sits
  // (`lcn0_offset - start`). NTFS always has 0 (LCN 0 holds the boot sector).
  // FAT32 reserves megabytes of boot area + FATs, captured separately as the
  // index's reserved track — the reader maps it in front of the data blocks.
  // dataStart > 0 with no reserved track means the boot region was never
  // captured (a headless/partial capture): refuse, since a reader maps
  // offset 0 to the boot sector and a shifted stream would corrupt every byte.
  if (part.dataStart > 0 && !(part.reserved ?? []).some((el) => el.storedLength > 0)) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: partition ${partitionIndex} (${part.fsType}) reserves a ${part.dataStart}-byte boot region that is not captured in this image; browsing needs a capture that includes the boot sector.`
    );
  }
  // A chain member needs its base image on disk to resolve carried-forward and
  // delta blocks (macriumUnsupportedReason already refuses a missing base;
  // this catches readers built directly on a hand-parsed info).
  if (part.chain?.basePath && !fs.existsSync(part.chain.basePath)) {
    throw new MacriumUnsupportedError(
      `${info.imagePath}: base image ${path.basename(part.chain.basePath)} not found; restore or merge the chain in Reflect first.`
    );
  }
  return new MacriumPartitionReader(info, part);
}