import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  encodeBlockFrame,
  compressBlock,
  crc32,
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  COMPRESSION_ZSTD,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';
import { scrubDirectory, readScrubHistory, classifyImage } from '../../src/main/imaging/scrub';
import { buildParity } from '../../src/main/imaging/parity';

const BLOCK = 64 * 1024;

function writeImageFromBytes(imagePath: string, raw: Buffer, blockSize: number, timestamp = Date.now()): BlockRecord[] {
  const partition: PartitionEntryMeta = {
    partitionIndex: 0,
    size: raw.length,
    offsetOnDisk: 0,
    firstBlockFileOffset: 0,
    blockCount: Math.ceil(raw.length / blockSize)
  };
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp,
    totalBytes: raw.length,
    blockSize,
    compressionId: COMPRESSION_ZSTD,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX,
    blockIndexOffset: 0,
    cipherId: 0,
    kdfIterations: 0,
    salt: Buffer.alloc(16),
    baseImagePath: '',
    sourceDiskModel: '',
    sourceDiskSerial: ''
  };

  const fd = fs.openSync(imagePath, 'w+');
  fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
  fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);

  const blocks: BlockRecord[] = [];
  let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
  partition.firstBlockFileOffset = cursor;
  for (let b = 0; b < partition.blockCount; b++) {
    const start = b * blockSize;
    const blockRaw = raw.subarray(start, Math.min(start + blockSize, raw.length));
    const comp = compressBlock(blockRaw, COMPRESSION_ZSTD, 3);
    const frame = encodeBlockFrame(blockRaw, comp);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    blocks.push({
      partitionIndex: 0,
      blockIndex: b,
      fileOffset: cursor,
      rawSize: blockRaw.length,
      compSize: frame.length - 16,
      rawCrc32: crc32(blockRaw)
    });
    cursor += frame.length;
  }

  const blockIndexOffset = cursor;
  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(blocks.length));
  fs.writeSync(fd, countBuf, 0, 8, cursor);
  cursor += 8;
  for (const block of blocks) {
    const entryBuf = encodeBlockIndexEntry(block);
    fs.writeSync(fd, entryBuf, 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    cursor += BLOCK_INDEX_ENTRY_SIZE;
  }

  fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
  const patched = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
  patched.writeBigUInt64LE(BigInt(blockIndexOffset), 40);
  fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);

  return blocks;
}

function makeRaw(blocks: number, seed = 3): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * seed + 7) & 0xff;
  return raw;
}

function corruptFrame(imagePath: string, block: BlockRecord): void {
  const fd = fs.openSync(imagePath, 'r+');
  const pos = block.fileOffset + 16 + 12;
  const buf = Buffer.alloc(1);
  fs.readSync(fd, buf, 0, 1, pos);
  buf[0] = buf[0] ^ 0xff;
  fs.writeSync(fd, buf, 0, 1, pos);
  fs.closeSync(fd);
}

describe('self-healing scrub', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-scrub-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports corruption as failed when no parity exists (report, not repair)', () => {
    const imagePath = path.join(dir, 'img_0_1000.opbs');
    const blocks = writeImageFromBytes(imagePath, makeRaw(30), BLOCK, 1000);
    corruptFrame(imagePath, blocks[3]);

    const summary = scrubDirectory(dir, { scope: 'all', repair: true });
    expect(summary.ok).toBe(false);
    expect(summary.failed).toBe(1);
    expect(summary.repairedBlocks).toBe(0);
    const record = summary.images[0];
    expect(record.corruptionFound).toBe(1);
    expect(record.parityPresent).toBe(false);
    expect(record.repaired).toBe(0);
    expect(record.stillFailed).toBe(1);

    const history = readScrubHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0].ok).toBe(false);
  });

  it('repairs a corrupted block from parity and records a healed image', () => {
    const imagePath = path.join(dir, 'img_0_1000.opbs');
    const blocks = writeImageFromBytes(imagePath, makeRaw(30), BLOCK, 1000);
    buildParity(imagePath);
    corruptFrame(imagePath, blocks[7]);

    const summary = scrubDirectory(dir, { scope: 'all', repair: true });
    expect(summary.ok).toBe(true);
    expect(summary.repairedBlocks).toBe(1);
    expect(summary.failed).toBe(0);

    const record = summary.images[0];
    expect(record.parityPresent).toBe(true);
    expect(record.repaired).toBe(1);
    expect(record.stillFailed).toBe(0);
    expect(record.ok).toBe(true);

    // The fix is real: the block now verifies cleanly again.
    const scan = classifyImage(imagePath);
    expect(scan.checks.filter((c) => !c.ok).length).toBe(0);
  });

  it('respects scope: newest only checks the newest image', () => {
    const olderPath = path.join(dir, 'img_0_1000.opbs');
    const newerPath = path.join(dir, 'img_1_2000.opbs');
    const olderBlocks = writeImageFromBytes(olderPath, makeRaw(30), BLOCK, 1000);
    writeImageFromBytes(newerPath, makeRaw(30), BLOCK, 2000);
    corruptFrame(olderPath, olderBlocks[2]);

    const summary = scrubDirectory(dir, { scope: 'newest', repair: true });
    expect(summary.checked).toBe(1);
    expect(summary.ok).toBe(true);
    expect(summary.images).toHaveLength(1);
    expect(summary.images[0].name).toBe('img_1_2000.opbs');
  });

  it('keeps only the latest history entry per image', () => {
    const imagePath = path.join(dir, 'img_0_1000.opbs');
    writeImageFromBytes(imagePath, makeRaw(30), BLOCK, 1000);
    buildParity(imagePath);

    scrubDirectory(dir, { scope: 'all', repair: true });
    scrubDirectory(dir, { scope: 'all', repair: true });

    const history = readScrubHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0].imagePath).toBe(path.resolve(imagePath));
    expect(history[0].ok).toBe(true);
  });
});