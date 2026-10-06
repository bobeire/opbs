import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestoreEngine, summarizeImage } from '../../src/main/imaging/restore-engine';
import { GPT_BASIC_DATA_GUID, GPT_EFI_SYSTEM_GUID } from '../../src/main/imaging/partition-table';
import { inferMbrTypes, inferTableTypeGuids } from '../../src/main/imaging/fs/file-browse';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';
import { launchElevatedJob } from '../../src/main/helper/launcher';
import { encodeHeader, encodePartitionEntry, encodeBlockIndexEntry, encodeBlockFrame, compressBlock, crc32, newImageCipher, ImageCipher, IMAGE_VERSION, FLAG_HAS_BLOCK_INDEX, HEADER_SIZE, PARTITION_TABLE_ENTRY_SIZE, BLOCK_INDEX_ENTRY_SIZE, PartitionEntryMeta, BlockRecord, ImageHeader } from '../../src/main/imaging/image-format';
import { buildMrimgxImage } from '../helpers/mrimg-image';

vi.mock('../../src/main/helper/launcher', () => ({
  launchElevatedJob: vi.fn(() => ({
    promise: Promise.resolve({ ok: true }),
    cancel: vi.fn(),
    onProgress: vi.fn()
  }))
}));

const BLOCK = 4096;

/**
 * A minimal but structurally valid FAT32 boot sector + FAT tables + root
 * directory, sized to fill one 4 KiB image block. Layout: boot @0, FAT1 @512,
 * FAT2 @1024, root directory cluster 2 @1536 (reserved=1, 2 FATs of 1 sector,
 * 512-byte clusters). When `hasEfiDir` the root directory holds an `EFI`
 * subdirectory entry — what makes the partition an ESP.
 */
function fat32Payload(hasEfiDir: boolean): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b[0] = 0xeb;
  b[1] = 0x58;
  b[2] = 0x90;
  b.write('MSDOS5.0', 3, 'ascii');
  b.writeUInt16LE(512, 0x0b); // bytes per sector
  b.writeUInt8(1, 0x0d); // sectors per cluster
  b.writeUInt16LE(1, 0x0e); // reserved sectors
  b.writeUInt8(2, 0x10); // number of FATs
  b.writeUInt16LE(0, 0x11); // root entry count (0 => FAT32)
  b.writeUInt32LE(16, 0x20); // total sectors (16 = one 8 KiB partition)
  b.writeUInt32LE(1, 0x24); // sectors per FAT32
  b.writeUInt32LE(2, 0x2c); // root directory cluster
  b[510] = 0x55;
  b[511] = 0xaa;
  for (const fat of [512, 1024]) {
    b.writeUInt32LE(0x0ffffff8, fat); // cluster 0: media
    b.writeUInt32LE(0x0fffffff, fat + 4); // cluster 1
    b.writeUInt32LE(0x0fffffff, fat + 8); // cluster 2 (root): end-of-chain
  }
  if (hasEfiDir) {
    const entry = Buffer.alloc(32, 0);
    entry.write('EFI        ', 0, 'ascii');
    entry[11] = 0x10; // directory
    entry.copy(b, 1536);
  } else {
    const entry = Buffer.alloc(32, 0);
    entry.write('DATA       ', 0, 'ascii');
    entry[11] = 0x20; // archive file
    entry.copy(b, 1536);
  }
  return b;
}

function writeImage(
  imagePath: string,
  identity?: { model: string; serial: string },
  opts?: { partitionPayload?: Buffer; cipher?: ImageCipher }
): void {
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
    cipherId: opts?.cipher ? opts.cipher.cipherId : 0,
    kdfIterations: opts?.cipher ? opts.cipher.kdfIterations : 0,
    salt: opts?.cipher ? opts.cipher.salt : Buffer.alloc(16),
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
    const raw = b === 0 && opts?.partitionPayload ? Buffer.from(opts.partitionPayload) : Buffer.alloc(BLOCK, 0x41 + b);
    const comp = compressBlock(raw, 0, 3);
    const frame = encodeBlockFrame(raw, comp, opts?.cipher);
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
    isDiskBlank: vi.fn(() => false),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async () => null)
  } as unknown as DiskEnumerator;
}

/** Simulates a brand-new disk: no partition table at all. */
function createBlankEnumerator(): DiskEnumerator {
  const enumerator = createFakeEnumerator();
  (enumerator as unknown as { isDiskBlank: ReturnType<typeof vi.fn> }).isDiskBlank = vi.fn(() => true);
  return enumerator;
}

/** Simulates an unreadable partition layout — must be treated as "not blank". */
function createFailingEnumerator(): DiskEnumerator {
  const enumerator = createFakeEnumerator();
  (enumerator as unknown as { isDiskBlank: ReturnType<typeof vi.fn> }).isDiskBlank = vi.fn(() => {
    throw new Error('ioctl failed');
  });
  return enumerator;
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
    isDiskBlank: vi.fn(() => false),
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
    expect(job.clearFreeSpace).toBe(true);
  });

  it('forwards clearFreeSpace:false onto the job (skip free-space zero-fill)', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      clearFreeSpace: false
    });
    expect(job.clearFreeSpace).toBe(false);
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

describe('RestoreEngine virtual-disk targets', () => {
  let dir: string;
  let imagePath: string;
  let vhdPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-vhd-'));
    imagePath = path.join(dir, 'image.opbs');
    vhdPath = path.join(dir, 'target.vhdx');
    writeImage(imagePath);
    vi.mocked(launchElevatedJob).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preflights against the configured virtual size when no disk exists yet', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetPartitions: [0],
      targetVirtualDisk: { path: vhdPath, virtualSize: 2 * 1024 ** 3 }
    });
    expect(job.targets[0].diskIndex).toBe(-1);
    // The captured layout fits: a fresh GPT table is planned for the blank file.
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.diskSize).toBe(2 * 1024 ** 3);
    expect(job.warnings?.join(' ')).toMatch(/blank target/);
    expect(job.warnings?.join(' ')).toMatch(/after the virtual disk is attached/);
  });

  it('rejects a virtual disk that is too small for the captured layout', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetPartitions: [0],
        targetVirtualDisk: { path: vhdPath, virtualSize: 1048576 }
      })
    ).rejects.toThrow(/does not fit on virtual disk/);
  });

  it('runs the full disk gates once the helper has attached the disk', async () => {
    const engine = new RestoreEngine(createTargetEnumerator({ model: 'MSFT Virtual Disk', size: 2 * 1024 ** 3 }));
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetVirtualDisk: { path: vhdPath, virtualSize: 2 * 1024 ** 3 }
    });
    expect(job.targets[0].diskIndex).toBe(1);
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.diskSize).toBe(2 * 1024 ** 3);
    expect(job.warnings?.join(' ')).not.toMatch(/after the virtual disk is attached/);
  });

  it('skips the fresh table when writePartitionTable is false', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetPartitions: [0],
      targetVirtualDisk: { path: vhdPath, virtualSize: 2 * 1024 ** 3 },
      writePartitionTable: false
    });
    expect(job.writeTable).toBeUndefined();
  });

  it('launches a restore-vhd payload for virtual-disk targets', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const config = {
      imagePath,
      targetPartitions: [0],
      targetVirtualDisk: { path: vhdPath, virtualSize: 2 * 1024 ** 3 }
    };
    const result = await engine.runRestore(config, () => undefined);
    expect(result).toEqual({ ok: true });
    expect(launchElevatedJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'restore-vhd', config })
    );
  });

  it('builds and launches a normal restore job for physical targets', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const result = await engine.runRestore(
      { imagePath, targetDiskIndex: 1, targetPartitions: [0] },
      () => undefined
    );
    expect(result).toEqual({ ok: true });
    expect(launchElevatedJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'restore' })
    );
  });
});

describe('RestoreEngine EFI type-GUID inference', () => {
  let dir: string;
  let imagePath: string;
  let vhdPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-esp-'));
    imagePath = path.join(dir, 'image.opbs');
    vhdPath = path.join(dir, 'target.vhdx');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function buildVhdJob(payload?: Buffer) {
    writeImage(imagePath, undefined, { partitionPayload: payload });
    const engine = new RestoreEngine(createFakeEnumerator());
    return engine.buildJob({
      imagePath,
      targetPartitions: [0],
      targetVirtualDisk: { path: vhdPath, virtualSize: 2 * 1024 ** 3 }
    });
  }

  it('types a FAT32 ESP (root \\EFI) as the EFI System partition on a blank GPT target', async () => {
    const job = await buildVhdJob(fat32Payload(true));
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_EFI_SYSTEM_GUID);
  });

  it('keeps a plain FAT32 data partition as basic data (no \\EFI directory)', async () => {
    const job = await buildVhdJob(fat32Payload(false));
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_BASIC_DATA_GUID);
  });

  it('keeps the basic-data default for non-FAT32 payloads', async () => {
    const job = await buildVhdJob();
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_BASIC_DATA_GUID);
  });

  it('an explicit tableTypeGuids entry overrides the inference', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetPartitions: [0],
      targetVirtualDisk: { path: vhdPath, virtualSize: 2 * 1024 ** 3 },
      tableTypeGuids: { 0: '11111111-2222-3333-4444-555555555555' }
    });
    expect(job.writeTable!.entries[0].typeGuid).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('summarizeImage reports the detected filesystem', () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const summary = summarizeImage(imagePath);
    expect(summary.partitions[0].fsType).toBe('FAT32');
  });
});

describe('inferTableTypeGuids', () => {
  it('assigns the EFI GUID to every partition the probe accepts', () => {
    const probe = vi.fn((_imagePath: string, idx: number) => idx === 1 || idx === 3);
    const got = inferTableTypeGuids('image.opbs', [0, 1, 3], undefined, probe);
    expect(got).toEqual({ 1: GPT_EFI_SYSTEM_GUID, 3: GPT_EFI_SYSTEM_GUID });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledWith('image.opbs', 1, undefined);
  });

  it('returns an empty map when nothing qualifies', () => {
    expect(inferTableTypeGuids('image.opbs', [0, 1], undefined, () => false)).toEqual({});
  });
});

describe('RestoreEngine blank physical targets', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-blank-'));
    imagePath = path.join(dir, 'image.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lays down a fresh GPT table on a blank physical target when the image has an ESP', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createBlankEnumerator());
    const job = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_EFI_SYSTEM_GUID);
    expect(job.warnings!.join(' ')).toMatch(/has no partition table/);
  });

  it('falls back to MBR with a FAT32 type byte and active flag for a blank non-ESP image', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(false) });
    const engine = new RestoreEngine(createBlankEnumerator());
    const job = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].mbrType).toBe(0x0c);
    expect(job.writeTable!.entries[0].bootable).toBe(true);
    expect(job.warnings!.join(' ')).toMatch(/has no partition table/);
  });

  it('infers an ESP through an encrypted image when the passphrase is provided', async () => {
    const cipher = newImageCipher('correct horse battery staple');
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true), cipher });
    const engine = new RestoreEngine(createBlankEnumerator());

    // Without the key the probe cannot read the volume, so no ESP is claimed.
    const blind = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(blind.writeTable!.scheme).toBe('mbr');

    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      passphrase: 'correct horse battery staple'
    });
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_EFI_SYSTEM_GUID);
  });

  it('does not write a table on a target that already has partitions', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(job.writeTable).toBeUndefined();
    expect(job.warnings).toBeUndefined();
  });

  it('treats an unreadable partition layout as not blank (never overwrites blindly)', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createFailingEnumerator());
    const job = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(job.writeTable).toBeUndefined();
  });

  it('respects writePartitionTable:false on a blank target', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createBlankEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      writePartitionTable: false
    });
    expect(job.writeTable).toBeUndefined();
  });

  it('honors an explicit MBR scheme even when the image has an ESP (0xEF type byte)', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createBlankEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      tableScheme: 'mbr'
    });
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].mbrType).toBe(0xef);
    expect(job.writeTable!.entries[0].bootable).toBe(true);
    expect(job.writeTable!.entries[0].typeGuid).toBeUndefined();
  });
});

describe('RestoreEngine fresh-table scheme preference', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-scheme-'));
    imagePath = path.join(dir, 'image.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers GPT over MBR for a dissimilar restore whose image contains an ESP', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(true) });
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 4194304 }],
      acknowledgeLayout: true
    });
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_EFI_SYSTEM_GUID);
  });

  it('keeps auto→MBR for a dissimilar restore without an ESP and types the partition from its filesystem', async () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(false) });
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 4194304 }],
      acknowledgeLayout: true
    });
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].mbrType).toBe(0x0c);
    expect(job.writeTable!.entries[0].bootable).toBe(true);
  });
});

describe('inferMbrTypes', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-infer-mbr-'));
    imagePath = path.join(dir, 'image.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps FAT32 to 0x0C and unrecognized payloads to 0x07', () => {
    writeImage(imagePath, undefined, { partitionPayload: fat32Payload(false) });
    expect(inferMbrTypes(imagePath, [0])).toEqual({ 0: 0x0c });
    writeImage(imagePath, undefined);
    expect(inferMbrTypes(imagePath, [0])).toEqual({ 0: 0x07 });
  });
});

describe('RestoreEngine Macrium images', () => {
  let dir: string;
  let imagePath: string;

  const GEOM_OFFSET = 1048576;
  const PART_SIZE = 2 * 8192;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-mrimg-'));
    imagePath = path.join(dir, 'image.mrimgx');
    vi.mocked(launchElevatedJob).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ntfsBlock(seed: number): Buffer {
    const b = Buffer.alloc(8192, seed);
    b.write('NTFS    ', 3, 'ascii');
    return b;
  }

  function writeMacrium(tweak?: (json: any) => void, opts?: { start?: number; length?: number }): void {
    const start = opts?.start ?? GEOM_OFFSET;
    const length = opts?.length ?? PART_SIZE;
    const built = buildMrimgxImage([ntfsBlock(0x11), ntfsBlock(0x22)], (json) => {
      json.disks[0].partitions[0]._geometry = {
        start,
        end: start + length - 1,
        length,
        boot_sector_offset: 0
      };
      tweak?.(json);
    });
    fs.writeFileSync(imagePath, built.buffer);
  }

  it('places the partition at the captured on-disk offset from the geometry (bytes)', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] });
    expect(job.targets).toHaveLength(1);
    expect(job.targets[0].offset).toBe(GEOM_OFFSET);
    expect(job.targets[0].size).toBeUndefined();
    expect(job.writeTable).toBeUndefined();
    expect(job.verifyBeforeWrite).toBe(false);
    expect(job.applyDeltas).toEqual([]);
    expect(job.compressionThreads).toBe(0);
    expect(job.warnings).toBeUndefined();
  });

  it('never carries an encryption key for a Macrium source', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      passphrase: 'hunter2'
    });
    expect(job.encryption).toBeUndefined();
  });

  it('grows a partition when targetLayout requests a larger size (fresh table planned)', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    const targetLayout = [{ partitionIndex: 0, offset: GEOM_OFFSET, size: PART_SIZE * 2 }];
    await expect(
      engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0], targetLayout })
    ).rejects.toThrow(/acknowledgeLayout/i);
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout,
      acknowledgeLayout: true
    });
    expect(job.targets[0].size).toBe(PART_SIZE * 2);
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].size).toBe(PART_SIZE * 2);
    expect(job.writeTable!.entries[0].mbrType).toBe(0x07); // NTFS
  });

  it('refuses to shrink below the captured partition size', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: GEOM_OFFSET, size: 4096 }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/shrink/i);
  });

  it('requires explicit placement when the image records no source offset', async () => {
    writeMacrium(undefined, { start: 0 });
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] })).rejects.toThrow(
      /Cannot determine the source on-disk offset/
    );
    await expect(engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] })).rejects.toThrow(
      /--layout 0:/
    );
    // A layout override against a captured offset of 0 still deviates, so the
    // generic acknowledgement gate applies.
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: GEOM_OFFSET }]
      })
    ).rejects.toThrow(/acknowledgeLayout/i);
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: GEOM_OFFSET }],
      acknowledgeLayout: true
    });
    expect(job.targets[0].offset).toBe(GEOM_OFFSET);
  });

  it('rejects a placement that does not fit on the target disk', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: 999_999_999 }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/does not fit/i);
  });

  it('refuses a file-and-folder backup instead of restoring it as a disk image', async () => {
    writeMacrium((json) => {
      json._header.backup_format = 'file_and_folder';
    });
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] })).rejects.toThrow(
      /file and folder/
    );
    expect(() => summarizeImage(imagePath)).toThrow(/file and folder/);
  });

  it('refuses a differential image that cannot be restored independently', async () => {
    writeMacrium((json) => {
      json._header.backup_type = 'diff';
    });
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(engine.buildJob({ imagePath, targetDiskIndex: 1, targetPartitions: [0] })).rejects.toThrow(
      /differential/
    );
    expect(() => summarizeImage(imagePath)).toThrow(/differential/);
  });

  it('rejects a delta chain for a Macrium source', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        applyDeltas: ['more.mrimgx']
      })
    ).rejects.toThrow(/delta chains are not supported/);
  });

  it('summarizes the Macrium layout (size, offset, filesystem, backup time)', () => {
    writeMacrium();
    const summary = summarizeImage(imagePath);
    expect(summary.totalSize).toBe(PART_SIZE);
    expect(summary.partitions).toEqual([
      { index: 0, size: PART_SIZE, fsType: 'NTFS', offsetOnDisk: GEOM_OFFSET, blockCount: 2 }
    ]);
    expect(summary.blockSize).toBe(8192);
    expect(summary.blocks).toBe(2);
    expect(summary.compressionId).toBe(0);
    expect(summary.backupDate).toBe(new Date(1600000000 * 1000).toISOString());
    expect(summary.encrypted).toBe(false);
    expect(summary.incremental).toBe(false);
  });

  it('applies no same-disk gate (the container records no source identity)', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createTargetEnumerator({ serial: 'SRC123' }));
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 2097152 }],
      acknowledgeLayout: true
    });
    expect(job.targets[0].offset).toBe(2097152);
    expect(job.warnings).toBeUndefined();
  });

  it('runs the full engine pipeline (build + launch) for a Macrium source', async () => {
    writeMacrium();
    const engine = new RestoreEngine(createFakeEnumerator());
    const result = await engine.runRestore(
      { imagePath, targetDiskIndex: 1, targetPartitions: [0] },
      () => undefined
    );
    expect(result).toEqual({ ok: true });
    expect(launchElevatedJob).toHaveBeenCalledWith(expect.objectContaining({ type: 'restore' }));
  });
});
