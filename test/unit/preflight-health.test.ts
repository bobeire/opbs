import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestoreManager } from '../../src/main/restore/manager';
import { RestoreEngine } from '../../src/main/imaging/restore-engine';
import { destinationHealth } from '../../src/main/utils/destination-health';
import {
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  encodeBlockFrame,
  compressBlock,
  crc32,
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';

const BLOCK = 4096;
let counter = 0;

function writeImage(imagePath: string): void {
  const partition: PartitionEntryMeta = {
    partitionIndex: 0,
    size: BLOCK * 2,
    offsetOnDisk: 1048576,
    firstBlockFileOffset: 0,
    blockCount: 2
  };
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: Date.now(),
    totalBytes: partition.size,
    blockSize: BLOCK,
    compressionId: 0,
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
    const raw = Buffer.alloc(BLOCK, 0x41 + b);
    const comp = compressBlock(raw, 0, 3);
    const frame = encodeBlockFrame(raw, comp);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    blocks.push({ partitionIndex: 0, blockIndex: b, fileOffset: cursor, rawSize: raw.length, compSize: comp.length, rawCrc32: crc32(raw) });
    cursor += frame.length;
  }
  const bi = cursor;
  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(blocks.length));
  fs.writeSync(fd, countBuf, 0, 8, cursor);
  cursor += 8;
  for (const block of blocks) {
    const entry = encodeBlockIndexEntry(block);
    fs.writeSync(fd, entry, 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    cursor += BLOCK_INDEX_ENTRY_SIZE;
  }
  fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
  const patched = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
  patched.writeBigUInt64LE(BigInt(bi), 40);
  fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);
}

function tempDir(): string {
  const dir = path.join(os.tmpdir(), `opbs-preflight-${Date.now()}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('RestoreManager.preflight (dry-run)', () => {
  it('returns a plan with required size and targets without writing', async () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'system.opbs');
      writeImage(imagePath);

      const stubDisks = {
        getDisks: async () => [
          {
            index: 1,
            size: 40 * 1024 * 1024 * 1024,
            model: 'TestDrive',
            serial: 'TEST123',
            partitions: []
          }
        ]
      };
      const engine = new RestoreEngine(stubDisks as never);
      const manager = new RestoreManager(engine, stubDisks as never);

      const result = await manager.preflight({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0]
      });

      expect(result.ok).toBe(true);
      expect(result.targetDiskBytes).toBe(40 * 1024 * 1024 * 1024);
      expect(result.requiredBytes).toBe(BLOCK * 2);
      expect(result.targets).toHaveLength(1);
      expect(result.targetDiskPartitionCount).toBe(0);
      expect(result.writeTableScheme).toBeNull();
      expect(result.passphraseRequired).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports existing partitions on the target disk (data-loss signal)', async () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'system.opbs');
      writeImage(imagePath);

      const stubDisks = {
        getDisks: async () => [
          { index: 0, size: 40 * 1024 * 1024 * 1024, model: 'TestDrive', serial: 'TEST123', partitions: [{ partitionIndex: 0 }] }
        ]
      };
      const manager = new RestoreManager(new RestoreEngine(stubDisks as never), stubDisks as never);

      const result = await manager.preflight({
        imagePath,
        targetDiskIndex: 0,
        targetPartitions: [0]
      });

      expect(result.ok).toBe(true);
      expect(result.targetDiskPartitionCount).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails preflight when the target disk is missing', async () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'system.opbs');
      writeImage(imagePath);

      const stubDisks = { getDisks: async () => [{ index: 0, size: 1e9, model: 'A', serial: '1', partitions: [] }] };
      const manager = new RestoreManager(new RestoreEngine(stubDisks as never), stubDisks as never);

      const result = await manager.preflight({
        imagePath,
        targetDiskIndex: 9,
        targetPartitions: [0]
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Target disk 9 not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('destinationHealth', () => {
  it('reports free space and image/chain counts for a filesystem destination', async () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'system.opbs');
      writeImage(imagePath);

      const result = await destinationHealth(dir, {
        keepFull: 2,
        keepDeltasPerFull: 2,
        retentionDays: 30,
        autoCleanup: true
      });

      expect(result.reachable).toBe(true);
      expect(result.imageCount).toBe(1);
      expect(result.chainCount).toBe(1);
      expect(result.freeBytes).toBeGreaterThan(0);
      expect(result.totalBytes).toBeGreaterThan(0);
      expect(result.oldestDate).toBeGreaterThan(0);
      expect(result.newestDate).toBeGreaterThan(0);
      expect(result.plannedPrune).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not reachable for cloud destinations', async () => {
    const result = await destinationHealth('s3://bucket/prefix', {
      keepFull: 2,
      keepDeltasPerFull: 2,
      retentionDays: 30,
      autoCleanup: true
    });
    expect(result.reachable).toBe(false);
    expect(result.imageCount).toBe(0);
  });
});