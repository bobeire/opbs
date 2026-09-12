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
import { writeManifest } from '../../src/main/backup/retention';
import { detectTamper, readBackupManifest } from '../../src/main/utils/tamper';

const BLOCK = 64 * 1024;

function writeImage(imagePath: string, raw: Buffer, blockSize: number, timestamp: number): BlockRecord[] {
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

function makeRaw(blocks: number): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 3 + 7) & 0xff;
  return raw;
}

describe('tamper detection (manifest drift)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-tamper-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports no manifest when none has been written', () => {
    writeImage(path.join(dir, 'img_0_1000.opbs'), makeRaw(2), BLOCK, 1000);

    const report = detectTamper(dir);
    expect(report.manifestPresent).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('is clean when the directory matches the manifest', async () => {
    writeImage(path.join(dir, 'img_0_1000.opbs'), makeRaw(2), BLOCK, 1000);
    await writeManifest(dir);

    const report = detectTamper(dir);
    expect(report.manifestPresent).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.diff.missing).toEqual([]);
    expect(report.diff.unexpected).toEqual([]);
    expect(report.diff.sizeChanged).toEqual([]);
  });

  it('catches a silently deleted image', async () => {
    const victim = path.join(dir, 'img_1_2000.opbs');
    writeImage(path.join(dir, 'img_0_1000.opbs'), makeRaw(2), BLOCK, 1000);
    writeImage(victim, makeRaw(1), BLOCK, 2000);
    await writeManifest(dir);
    fs.unlinkSync(victim);

    const report = detectTamper(dir);
    expect(report.ok).toBe(false);
    expect(report.diff.missing.map((m) => m.name)).toContain('img_1_2000.opbs');
    expect(report.diff.unexpected).toEqual([]);
  });

  it('catches an unexpected image dropped into the directory', async () => {
    writeImage(path.join(dir, 'img_0_1000.opbs'), makeRaw(2), BLOCK, 1000);
    await writeManifest(dir);
    writeImage(path.join(dir, 'img_5_5000.opbs'), makeRaw(1), BLOCK, 5000);

    const report = detectTamper(dir);
    expect(report.ok).toBe(false);
    expect(report.diff.unexpected.map((u) => u.name)).toContain('img_5_5000.opbs');
  });

  it('catches a size-changed image', async () => {
    const target = path.join(dir, 'img_0_1000.opbs');
    writeImage(target, makeRaw(2), BLOCK, 1000);
    const original = fs.statSync(target).size;
    await writeManifest(dir);

    fs.appendFileSync(target, Buffer.alloc(1024, 0));
    const report = detectTamper(dir);
    expect(report.ok).toBe(false);
    expect(report.diff.sizeChanged).toEqual([{ name: 'img_0_1000.opbs', manifestSize: original, diskSize: original + 1024 }]);

    const manifest = readBackupManifest(dir);
    expect(manifest).not.toBeNull();
  });
});