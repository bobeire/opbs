import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestoreEngine } from '../../src/main/imaging/restore-engine';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';
import { encodeHeader, encodePartitionEntry, encodeBlockIndexEntry, encodeBlockFrame, compressBlock, crc32, IMAGE_VERSION, FLAG_HAS_BLOCK_INDEX, HEADER_SIZE, PARTITION_TABLE_ENTRY_SIZE, BLOCK_INDEX_ENTRY_SIZE, PartitionEntryMeta, BlockRecord, ImageHeader } from '../../src/main/imaging/image-format';

const BLOCK = 4096;

function writeImage(imagePath: string, identity?: { model: string; serial: string }): void {
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
    sourceDiskModel: identity?.model ?? '',
    sourceDiskSerial: identity?.serial ?? ''
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

function createFakeEnumerator(): DiskEnumerator {
  return {
    getDisks: vi.fn(async () => [{ index: 1, model: 'TEST', size: 1_000_000_000, serial: 'TEST' }]),
    getPartitions: vi.fn(async () => []),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async () => null)
  } as unknown as DiskEnumerator;
}

function createTargetEnumerator(disk: { index?: number; model?: string; serial?: string; size?: number }): DiskEnumerator {
  const disks = [{
    index: disk.index ?? 1,
    model: disk.model ?? '',
    size: disk.size ?? 1_000_000_000,
    serial: disk.serial ?? ''
  }];
  return {
    getDisks: vi.fn(async () => disks),
    getPartitions: vi.fn(async () => []),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async () => null)
  } as unknown as DiskEnumerator;
}

describe('RestoreEngine dissimilar layout', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-layout-'));
    imagePath = path.join(dir, 'image.opbs');
    writeImage(imagePath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the captured on-disk offset by default', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(job.targets[0].offset).toBe(1048576);
  });

  it('honors a custom targetLayout offset (dissimilar-hardware re-order/move)', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 2097152 }],
      acknowledgeLayout: true
    });
    expect(job.targets[0].offset).toBe(2097152);
    // A small (<2 TiB) single-partition placement maps to an MBR table.
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.diskSize).toBe(1_000_000_000);
    expect(job.writeTable!.entries![0].offset).toBe(2097152);
    expect(job.writeTable!.entries[0].size).toBe(8192);
  });

  it('requires acknowledgement before writing a new partition table', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0], targetLayout: [{ partitionIndex: 0, offset: 2097152 }] })
    ).rejects.toThrow(/acknowledgeLayout/i);
  });

  it('does not require acknowledgement for an identity layout', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 1048576 }]
    });
    expect(job.targets[0].offset).toBe(1048576);
    expect(job.writeTable).toBeUndefined();
  });

  it('rejects an unrepresentable custom offset even when acknowledged', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: 4096 }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/cannot be represented|Cannot build/);
  });

  it('honors an explicit GPT scheme for a dissimilar layout', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 2097152 }],
      acknowledgeLayout: true,
      tableScheme: 'gpt',
      tableDiskGuid: '11111111-2222-3333-4444-555555555555'
    });
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.diskGuid).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('skips the partition table when writePartitionTable is false', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 2097152 }],
      acknowledgeLayout: true,
      writePartitionTable: false
    });
    expect(job.targets[0].offset).toBe(2097152);
    expect(job.writeTable).toBeUndefined();
  });

  it('rejects a layout that does not fit on the target disk', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0], targetLayout: [{ partitionIndex: 0, offset: 999_999_999 }] })
    ).rejects.toThrow(/does not fit/i);
  });

  it('accepts a larger target size and uses it for the partition table entry', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 16384 }],
      acknowledgeLayout: true
    });
    expect(job.targets[0].size).toBe(16384);
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.entries[0].size).toBe(16384);
  });

  it('refuses to shrink a partition below its captured size', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 4096 }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/shrink/i);
  });

  it('treats a size-only deviation like an offset deviation (ack still required)', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 16384 }]
      })
    ).rejects.toThrow(/acknowledgeLayout/i);
  });

  it('rejects a grown target that does not fit on the disk', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: 999_000_000, size: 2_000_000 }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/does not fit/i);
  });
});

describe('RestoreEngine same-disk identity guards', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-identity-'));
    imagePath = path.join(dir, 'image.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = {
    targetDiskIndex: 1,
    targetPartitions: [0],
    targetLayout: [{ partitionIndex: 0, offset: 2097152 }],
    acknowledgeLayout: true
  };

  it('refuses a dissimilar layout onto the same physical disk unless acknowledged', async () => {
    writeImage(imagePath, { model: 'ACME NVMe', serial: 'SRC123' });
    const engine = new RestoreEngine(createTargetEnumerator({ serial: 'SRC123' }));
    await expect(engine.buildJob({ ...base, imagePath })).rejects.toThrow(/same disk|acknowledgeSameDisk/i);
  });

  it('allows a same-disk dissimilar layout when acknowledged, with a warning', async () => {
    writeImage(imagePath, { model: 'ACME NVMe', serial: 'SRC123' });
    const engine = new RestoreEngine(createTargetEnumerator({ serial: 'SRC123' }));
    const job = await engine.buildJob({ ...base, imagePath, acknowledgeSameDisk: true });
    expect(job.targets[0].offset).toBe(2097152);
    expect(job.warnings?.join(' ')).toMatch(/restoring onto the imaged disk/i);
  });

  it('only warns (does not block) when the model matches but serials differ', async () => {
    writeImage(imagePath, { model: 'ACME NVMe', serial: 'SRC123' });
    const engine = new RestoreEngine(createTargetEnumerator({ model: 'ACME NVMe', serial: 'TARGET9' }));
    const job = await engine.buildJob({ ...base, imagePath });
    expect(job.writeTable).toBeDefined();
    expect(job.warnings?.join(' ')).toMatch(/matches the source disk model/i);
  });

  it('applies no identity gate when the image recorded no source disk', async () => {
    writeImage(imagePath);
    const engine = new RestoreEngine(createTargetEnumerator({ model: 'ACME NVMe', serial: 'SRC123' }));
    const job = await engine.buildJob({ ...base, imagePath });
    expect(job.targets[0].offset).toBe(2097152);
    expect(job.warnings).toBeUndefined();
  });

  it('does not gate an identity-layout restore even on the same serial', async () => {
    writeImage(imagePath, { model: 'ACME NVMe', serial: 'SRC123' });
    const engine = new RestoreEngine(createTargetEnumerator({ serial: 'SRC123' }));
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0]
    });
    expect(job.targets[0].offset).toBe(1048576);
    expect(job.warnings).toBeUndefined();
  });
});
