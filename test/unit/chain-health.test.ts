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
  FLAG_INCREMENTAL,
  COMPRESSION_ZSTD,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';
import { buildChainHealthReport } from '../../src/main/backup/chain-health';

const BLOCK = 64 * 1024;

function writeImage(
  imagePath: string,
  raw: Buffer,
  blockSize: number,
  timestamp: number,
  baseImagePath = ''
): BlockRecord[] {
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
    flags: FLAG_HAS_BLOCK_INDEX | (baseImagePath ? FLAG_INCREMENTAL : 0),
    blockIndexOffset: 0,
    cipherId: 0,
    kdfIterations: 0,
    salt: Buffer.alloc(16),
    baseImagePath,
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

function makeRaw(blocks: number): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 3 + 7) & 0xff;
  return raw;
}

describe('chain health (missing delta bases)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-chain-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a full + delta chain as complete', () => {
    const fullPath = path.join(dir, 'img_0_1000.opbs');
    writeImage(fullPath, makeRaw(3), BLOCK, 1000);
    writeImage(path.join(dir, 'img_1_2000.opbs'), makeRaw(1), BLOCK, 2000, fullPath);

    const report = buildChainHealthReport(dir);
    expect(report.chainCount).toBe(1);
    expect(report.completeChains).toBe(1);
    expect(report.brokenChains).toBe(0);
    expect(report.missingBases).toEqual([]);
    expect(report.chains[0].complete).toBe(true);
  });

  it('flags a delta whose base image is missing as an orphaned, broken chain', () => {
    const fullPath = path.join(dir, 'img_0_1000.opbs');
    const deltaPath = path.join(dir, 'img_1_2000.opbs');
    writeImage(fullPath, makeRaw(3), BLOCK, 1000);
    writeImage(deltaPath, makeRaw(1), BLOCK, 2000, fullPath);
    fs.unlinkSync(fullPath);

    const report = buildChainHealthReport(dir);
    expect(report.brokenChains).toBe(1);
    expect(report.completeChains).toBe(0);
    const chain = report.chains[0];
    expect(chain.orphaned).toBe(true);
    expect(chain.complete).toBe(false);
    expect(chain.missingBaseName).toBe('img_0_1000.opbs');
    expect(report.missingBases).toEqual([{ imageName: 'img_1_2000.opbs', basePath: fullPath }]);
  });

  it('detects a delta whose header points at a base that never existed', () => {
    const deltaPath = path.join(dir, 'img_1_2000.opbs');
    writeImage(deltaPath, makeRaw(1), BLOCK, 2000, path.join(dir, 'gone.opbs'));

    const report = buildChainHealthReport(dir);
    expect(report.brokenChains).toBe(1);
    expect(report.chains[0].orphaned).toBe(true);
    expect(report.chains[0].missingBaseName).toBe('gone.opbs');
    expect(report.missingBases).toEqual([{ imageName: 'img_1_2000.opbs', basePath: path.join(dir, 'gone.opbs') }]);
  });

  it('lists unparseable .opbs files', () => {
    writeImage(path.join(dir, 'img_0_1000.opbs'), makeRaw(2), BLOCK, 1000);
    const bogus = path.join(dir, 'stray_99_9999.opbs');
    fs.writeFileSync(bogus, Buffer.alloc(4096, 0x55));

    const report = buildChainHealthReport(dir);
    expect(report.unparseableImages).toContain('stray_99_9999.opbs');
  });
});