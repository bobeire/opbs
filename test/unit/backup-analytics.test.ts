import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  parsePartitionEntry,
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_INCREMENTAL,
  COMPRESSION_ZSTD,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  crc32,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';
import { computeAnalytics, recordAnalytics, readAnalytics, recordBackupAnalytics } from '../../src/main/utils/backup-analytics';

const BLOCK = 1024 * 1024;

function writeImage(
  filePath: string,
  opts: {
    totalBytes: number;
    blockSize?: number;
    incremental?: boolean;
    baseImagePath?: string;
    blockIndices: number[];
    timestamp?: number;
  }
): void {
  const blockSize = opts.blockSize ?? BLOCK;
  const blocks: BlockRecord[] = opts.blockIndices.map((blockIndex, i) => ({
    partitionIndex: 0,
    blockIndex,
    fileOffset: 0,
    rawSize: blockSize,
    compSize: Math.floor(blockSize / 2),
    rawCrc32: crc32(Buffer.from([i]))
  }));
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: opts.timestamp ?? Date.now(),
    totalBytes: opts.totalBytes,
    blockSize,
    compressionId: COMPRESSION_ZSTD,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX | (opts.incremental ? FLAG_INCREMENTAL : 0),
    blockIndexOffset: HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE,
    cipherId: 0,
    kdfIterations: 0,
    salt: Buffer.alloc(16),
    baseImagePath: opts.baseImagePath ?? '',
    sourceDiskModel: '',
    sourceDiskSerial: ''
  };

  const blockIndexOffset = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;

  const fd = fs.openSync(filePath, 'w+');
  fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
  const entryBuf = encodePartitionEntry(parsePartitionEntry(Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE)));
  fs.writeSync(fd, entryBuf, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);

  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(blocks.length));
  fs.writeSync(fd, countBuf, 0, 8, blockIndexOffset);
  for (let i = 0; i < blocks.length; i++) {
    fs.writeSync(fd, encodeBlockIndexEntry(blocks[i]), 0, BLOCK_INDEX_ENTRY_SIZE, blockIndexOffset + 8 + i * BLOCK_INDEX_ENTRY_SIZE);
  }
  fs.closeSync(fd);
}

describe('backup analytics', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-analytics-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records and reads back per-image analytics entries', () => {
    const fullPath = path.join(dir, 'img_full.opbs');
    writeImage(fullPath, { totalBytes: BLOCK * 4, blockIndices: [0, 1, 2, 3], timestamp: 1000 });

    recordBackupAnalytics(dir, fullPath, {
      totalBytes: BLOCK * 4,
      bytesWritten: BLOCK,
      blocksWritten: 4,
      skippedBlocks: 0,
      incremental: false,
      durationMs: 20000
    });

    const entries = readAnalytics(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].imagePath).toBe(path.resolve(fullPath));
    expect(entries[0].totalBytes).toBe(BLOCK * 4);
    expect(entries[0].compressionRatio).toBeCloseTo(4, 5);
    expect(entries[0].speedMBs).toBeGreaterThan(0);

    // Re-recording the same image replaces, not duplicates.
    recordBackupAnalytics(dir, fullPath, {
      totalBytes: BLOCK * 4,
      bytesWritten: BLOCK,
      blocksWritten: 4,
      incremental: false,
      durationMs: 20000
    });
    expect(readAnalytics(dir)).toHaveLength(1);
  });

  it('computes chain-level insights from an incremental chain', () => {
    const fullPath = path.join(dir, 'img_0_1000.opbs');
    const deltaPath = path.join(dir, 'img_1_2000.opbs');
    writeImage(fullPath, {
      totalBytes: BLOCK * 4,
      blockIndices: [0, 1, 2, 3],
      timestamp: 1000
    });
    writeImage(deltaPath, {
      totalBytes: BLOCK * 4,
      incremental: true,
      baseImagePath: fullPath,
      blockIndices: [2], // only block 2 changed
      timestamp: 2000
    });

    const summary = computeAnalytics(dir);
    expect(summary.imageCount).toBe(2);
    expect(summary.chainCount).toBe(1);
    // 5 blocks stored across the two images (4 in the full + 1 changed in the delta),
    // but only 4 unique.
    expect(summary.chains[0].totalBlocksAcrossImages).toBe(5);
    expect(summary.chains[0].uniqueBlocks).toBe(4);
    expect(summary.chains[0].fullCount).toBe(1);
    expect(summary.chains[0].deltaCount).toBe(1);
    expect(summary.chains[0].totalDiskBytes).toBe(BLOCK * 4);
    // Block storage halves the image: 4 unique (raw) blocks compressed 2x => totalImageBytes
    // is computed from file sizes; the header-only file sizes make the exact ratio
    // hard to predict, so assert structural properties instead.
    expect(summary.chains[0].oldestTimestamp).toBe(1000);
    expect(summary.chains[0].newestTimestamp).toBe(2000);
    expect(summary.chains[0].chainEfficiency).toBeGreaterThan(0);
    expect(summary.chains[0].chainEfficiency).toBeLessThanOrEqual(1);
  });

  it('skips images that are not valid backups', () => {
    fs.writeFileSync(path.join(dir, 'junk.opbs'), 'not an image at all');
    writeImage(path.join(dir, 'img_0_1000.opbs'), { totalBytes: BLOCK, blockIndices: [0, 1, 2, 3], timestamp: 1000 });

    const summary = computeAnalytics(dir);
    expect(summary.imageCount).toBe(1);
    expect(summary.chainCount).toBe(1);
  });
});