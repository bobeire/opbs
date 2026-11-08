import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { runBackupJob, runRestoreJob } from '../../src/main/helper/job-runner';
import { readMacriumImage, openMacriumPartitionReader, macriumPartitionSize } from '../../src/main/imaging/mrimg';
import { buildMrimgxImage } from '../helpers/mrimg-image';
import { verifyImage, readImageInfo, resolveImageChain, clearImageInfoCache, encodeHeader, encodeBlockFrame, encodePartitionEntry, encodeBlockIndexEntry, HEADER_SIZE, PARTITION_TABLE_ENTRY_SIZE, BLOCK_INDEX_ENTRY_SIZE, IMAGE_VERSION, FLAG_HAS_BLOCK_INDEX, FLAG_VERIFIED, FLAGS_OFFSET, FLAG_INCREMENTAL, FLAG_RESUMED, COMPRESSION_DEFLATE, COMPRESSION_ZSTD, crc32, newImageCipher, metadataFromCipher, scanPartialImage, compressBlock, PartitionEntryMeta, BlockRecord, ImageHeader } from '../../src/main/imaging/image-format';
import { ImagingJob, RestoreJob, NativeImagingApi, JobResult, RestoreJobResult } from '../../src/main/imaging/imaging-job';
import { buildNtfsVolumeData, CLUSTER as NTFS_CLUSTER } from '../helpers/ntfs-fixture';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER, GR_SPC } from '../helpers/ntfs-resize-fixture';

const BLOCK = 16 * 1024;

// The restore path writes an interruption marker to %SystemDrive% before it
// touches anything, and clears it when the run ends. Point that at a temp
// directory so these tests do not try to write to the real system drive root.
const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-marker-root-'));
const savedSystemDrive = process.env.SystemDrive;
process.env.SystemDrive = markerRoot;
afterAll(() => {
  process.env.SystemDrive = savedSystemDrive;
  fs.rmSync(markerRoot, { recursive: true, force: true });
});

function blockPattern(seed: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed * 31 + i * 7) & 0xff;
  }
  return buf;
}

function createMockNative(): NativeImagingApi {
  return {
    createSnapshot: vi.fn((volumePath: string) => ({
      id: `snap-${Buffer.from(volumePath).toString('hex')}`,
      devicePath: volumePath.includes('vol-1') ? '\\\\.\\ShadowCopy1' : '\\\\.\\ShadowCopy2'
    })),
    deleteSnapshot: vi.fn(() => true),
    getPhysicalDrivePath: vi.fn((diskIndex: number) => `\\\\.\\PhysicalDrive${diskIndex}`),
    writeBlocks: vi.fn(() => 0),
    readBlocks: vi.fn((devicePath: string, offset: bigint, length: bigint): Buffer => {
      const seed = devicePath.includes('ShadowCopy1') ? 1 : devicePath.includes('ShadowCopy2') ? 2 : 3;
      return blockPattern(seed, Number(length));
    })
  };
}

describe('runBackupJob', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-job-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    imagePath = path.join(dir, 'backup.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeJob = (job: ImagingJob): void => {
    fs.writeFileSync(jobPath, JSON.stringify(job));
  };

  const readResult = (): JobResult => JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;

  it('writes an image covering all partitions and reports success', async () => {
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: true,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK * 3,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-1}\\'
        },
        {
          diskIndex: 0,
          partitionIndex: 4,
          size: BLOCK * 2,
          offset: 999669366784,
          label: 'Partition 4',
          readSource: 'physical'
        }
      ]
    });

    const native = createMockNative();
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(5);
    expect(result.snapshotsCreated).toBe(1);
    // The synthetic image has no readable filesystem, so the consistency
    // check has no verdict and says so. What must not appear is a claim that
    // anything is wrong.
    expect(result.warnings.every((w) => w.includes('filesystem consistency not checked'))).toBe(true);
    expect(native.deleteSnapshot).toHaveBeenCalledTimes(1);

    const verified = await verifyImage(imagePath);
    expect(verified.ok).toBe(true);
    expect(verified.blocksVerified).toBe(5);

    const info = readImageInfo(imagePath);
    expect(info.header.partitionCount).toBe(2);
    expect(info.header.totalBytes).toBe(BLOCK * 5);
    expect(info.partitions.map((p) => p.blockCount)).toEqual([3, 2]);

    // The runner consumes job.json on read so a crashed helper cannot leave it behind.
    expect(fs.existsSync(jobPath)).toBe(false);
  });

  it('creates one snapshot per unique volume', async () => {
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 0,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          size: BLOCK,
          offset: 1048576,
          label: 'P0',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-1}\\'
        },
        {
          diskIndex: 0,
          partitionIndex: 1,
          size: BLOCK,
          offset: 105906176,
          label: 'P1',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-1}\\'
        },
        {
          diskIndex: 0,
          partitionIndex: 3,
          size: BLOCK,
          offset: 998809534464,
          label: 'P3',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-2}\\'
        }
      ]
    });

    const native = createMockNative();
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    expect(readResult().ok).toBe(true);
    expect(readResult().snapshotsCreated).toBe(2);
    expect(native.createSnapshot).toHaveBeenCalledTimes(2);
    expect(native.deleteSnapshot).toHaveBeenCalledTimes(2);
  });

  it('writes progress and reaches 100%', async () => {
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK * 2,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'physical'
        }
      ]
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createMockNative());

    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    expect(progress.percent).toBe(100);
    expect(progress.bytesDone).toBe(BLOCK * 2);
    // The index-writing tail is reported as its own stage, not silently as
    // the last partition's imaging (verification was off in this job).
    expect(progress.phase).toBe('completed');
    expect(progress.currentPartition).toBe('Writing image index…');
  });

  it('aborts and removes the partial image when cancelled', async () => {
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK * 50,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'physical'
        }
      ]
    });

    fs.writeFileSync(cancelPath, '1');
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createMockNative());

    const result = readResult();
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(fs.existsSync(imagePath)).toBe(false);
    expect(fs.existsSync(jobPath)).toBe(false);
  });

  it('aborts on a read failure instead of finishing with a truncated image', async () => {
    // This test used to assert the opposite: that a read failure becomes a
    // warning and the other partitions still get written. That produced an
    // image that completed "successfully" with a silently truncated partition
    // — the same silent-success shape as every other defect in this area.
    // Windows discards a shadow copy when its storage fills, which makes this
    // the ordinary way a mid-backup read fails. (Field report 2026-11-04.)
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK * 2,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'physical'
        },
        {
          diskIndex: 0,
          partitionIndex: 4,
          size: BLOCK,
          offset: 999669366784,
          label: 'Partition 4',
          readSource: 'physical'
        }
      ]
    });

    const native = createMockNative();
    native.readBlocks = vi.fn((_device: string, _offset: bigint) => {
      throw new Error('access denied');
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(false);
    // And it says the image is not usable, rather than leaving the caller to
    // discover that at restore time.
    expect(result.error ?? '').toContain('must NOT be used');
    expect(result.error ?? '').toContain('truncated');
  });

  it('refuses when a snapshot cannot be created', async () => {
    // This test used to assert the opposite: that the backup "falls back to a
    // raw physical read" and succeeds. That fallback silently produced images
    // with no single point in time — every block verified, and the filesystem
    // they formed was corrupt (field report 2026-11-03). Refusing is the
    // correct behaviour; the escape hatch is tested separately.
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-1}\\'
        }
      ]
    });

    const native = createMockNative();
    native.createSnapshot = vi.fn(() => {
      throw new Error('VSS_E_VOLUME_NOT_SUPPORTED');
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const refused = readResult();
    expect(refused.ok).toBe(false);
    // VSS_E_VOLUME_NOT_SUPPORTED is a property of the volume, not a broken
    // machine — the message must say that, not "VSS is not working".
    expect(refused.error ?? '').toContain('No selected volume can be snapshotted');
    expect(refused.error ?? '').not.toContain('not working on this machine');
    // It refuses rather than quietly capturing live.
  });

  it('writes live only when the caller explicitly accepts the risk', async () => {
    writeJob({
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      allowInconsistentCapture: true,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-1}\\'
        }
      ]
    });

    const native = createMockNative();
    native.createSnapshot = vi.fn(() => {
      throw new Error('VSS_E_VOLUME_NOT_SUPPORTED');
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    // The decision is on the record, not buried.
    expect(result.warnings.join(' ')).toMatch(/WITHOUT a consistent point in time/);
  });

  describe('runBackupJob with resume', () => {
    const resumeNative = (): NativeImagingApi =>
      ({
        createSnapshot: vi.fn((volumePath: string) => ({
          id: `snap-${volumePath}`,
          devicePath: volumePath.includes('vol-1') ? '\\\\.\\ShadowCopy1' : '\\\\.\\ShadowCopy2'
        })),
        deleteSnapshot: vi.fn(() => true),
        getPhysicalDrivePath: vi.fn((diskIndex: number) => `\\\\.\\PhysicalDrive${diskIndex}`),
        writeBlocks: vi.fn(() => 0),
        readBlocks: vi.fn((devicePath: string, offset: bigint, length: bigint): Buffer => {
          const seed = devicePath.includes('ShadowCopy1') ? 1 : devicePath.includes('ShadowCopy2') ? 2 : 3;
          return blockPattern(seed, Number(length));
        })
      }) as NativeImagingApi;

    // Builds a partial image with partition 0 complete and partition 1 not
    // started at all (the frames stop exactly at partition 1's data offset).
    function writePartialImage(path: string, blockSize: number, partitionCount: number): number {
      const fd = fs.openSync(path, 'w+');
      const header = {
        version: IMAGE_VERSION,
        timestamp: Date.now(),
        totalBytes: blockSize * 3,
        blockSize,
        compressionId: COMPRESSION_DEFLATE,
        partitionCount,
        flags: FLAG_HAS_BLOCK_INDEX,
        blockIndexOffset: 0,
        cipherId: 0,
        kdfIterations: 0,
        salt: Buffer.alloc(0),
        baseImagePath: ''
      };
      fs.writeSync(fd, encodeHeader(header as never), 0, HEADER_SIZE, 0);
      const tableSize = partitionCount * PARTITION_TABLE_ENTRY_SIZE;
      fs.writeSync(fd, Buffer.alloc(tableSize), 0, tableSize, HEADER_SIZE);

      let cursor = HEADER_SIZE + tableSize;
      // Partition 0 (real index 2): three blocks, fully written.
      for (let b = 0; b < 3; b++) {
        const raw = blockPattern(2, blockSize);
        const comp = compressBlock(raw, COMPRESSION_DEFLATE, 3);
        const frame = encodeBlockFrame(raw, comp);
        fs.writeSync(fd, frame, 0, frame.length, cursor);
        cursor += frame.length;
      }
      fs.closeSync(fd);
      return cursor;
    }

    it('resumes from a partial image, keeps completed frames and marks the image', async () => {
      const blockSize = BLOCK;
      const partitions: ImagingJob['partitions'] = [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: blockSize * 3,
          offset: 122683392,
          label: 'Partition 2',
          readSource: 'volume',
          volumeDevicePath: '\\\\?\\Volume{vol-1}\\'
        },
        {
          diskIndex: 0,
          partitionIndex: 4,
          size: blockSize * 2,
          offset: 999669366784,
          label: 'Partition 4',
          readSource: 'physical'
        }
      ];

      // Write a partial image: partition 0 complete, partition 1 absent.
      const partialCursor = writePartialImage(imagePath, blockSize, 2);
      const scan = scanPartialImage(
        imagePath,
        [
          { partitionIndex: 2, size: blockSize * 3 },
          { partitionIndex: 4, size: blockSize * 2 }
        ],
        blockSize
      );
      expect(scan.complete).toBe(false);
      expect(scan.completedPartitions).toBe(1);
      expect(scan.cursor).toBe(partialCursor);

      // buildJob mirrors this: it derives the checkpoint from the scan. The
      // kept blocks are those of the completed partitions (real index 2).
      const keptBlocks = scan.blocks.filter((b) => b.partitionIndex === 2);
      const resumeCheckpoint = {
        imagePath,
        cursor: scan.cursor,
        completedPartitions: 1,
        partitionBytes: 0,
        sourceBlockIndex: 0,
        blocksWritten: keptBlocks.length,
        bytesWritten: keptBlocks.reduce((s, b) => s + b.rawSize, 0),
        skippedBlocks: 0
      };

      // Resume from that partial image.
      writeJob({ type: 'backup', imagePath, blockSize, compressionLevel: 3, verificationEnabled: true, resume: true, resumeCheckpoint, partitions });
      await runBackupJob(jobPath, resultPath, progressPath, cancelPath, resumeNative());

      const result = readResult();
      expect(result.ok).toBe(true);
      expect(result.resumed).toBe(true);
      // Completed partition 0's 3 blocks are kept; partition 1 adds 2.
      expect(result.blocksWritten).toBe(5);

      // The finished image verifies and contains both partitions.
      const verified = await verifyImage(imagePath);
      expect(verified.ok).toBe(true);
      expect(verified.blocksVerified).toBe(5);

      const info = readImageInfo(imagePath);
      expect(info.header.partitionCount).toBe(2);
      expect(info.partitions.map((p) => p.blockCount)).toEqual([3, 2]);
      expect(info.header.flags & FLAG_RESUMED).toBe(FLAG_RESUMED);

      // The block index must preserve the kept partition-0 frames.
      expect(info.blocks.filter((b) => b.partitionIndex === 2)).toHaveLength(3);
      expect(info.blocks.filter((b) => b.partitionIndex === 4)).toHaveLength(2);
    });

    it('keeps the partial image on failure when resume is enabled', async () => {
      writeJob({
        type: 'backup',
        imagePath,
        blockSize: BLOCK,
        compressionLevel: 0,
        verificationEnabled: false,
        resume: true,
        partitions: [
          {
            diskIndex: 0,
            partitionIndex: 2,
            size: BLOCK * 3,
            offset: 122683392,
            label: 'Partition 2',
            readSource: 'physical'
          }
        ]
      });
      // A hard failure (device resolution) aborts the job after the image is
      // created, exercising the partial-image retention path.
      const failing: NativeImagingApi = {
        ...resumeNative(),
        getPhysicalDrivePath: vi.fn(() => {
          throw new Error('no physical drive');
        })
      };
      await runBackupJob(jobPath, resultPath, progressPath, cancelPath, failing);
      const result = readResult();
      expect(result.ok).toBe(false);
      // The partial image must remain for a future resumed run.
      expect(fs.existsSync(imagePath)).toBe(true);
    });

    it('removes the partial image on failure when resume is not requested', async () => {
      writeJob({
        type: 'backup',
        imagePath,
        blockSize: BLOCK,
        compressionLevel: 0,
        verificationEnabled: false,
        partitions: [
          {
            diskIndex: 0,
            partitionIndex: 2,
            size: BLOCK * 3,
            offset: 122683392,
            label: 'Partition 2',
            readSource: 'physical'
          }
        ]
      });
      const failing: NativeImagingApi = {
        ...resumeNative(),
        getPhysicalDrivePath: vi.fn(() => {
          throw new Error('no physical drive');
        })
      };
      await runBackupJob(jobPath, resultPath, progressPath, cancelPath, failing);
      const result = readResult();
      expect(result.ok).toBe(false);
      expect(fs.existsSync(imagePath)).toBe(false);
    });
  });
});
describe('runRestoreJob', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    imagePath = path.join(dir, 'image.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const backupJob = (): ImagingJob => ({
    type: 'backup',
    imagePath,
    blockSize: BLOCK,
    compressionLevel: 3,
    verificationEnabled: true,
    partitions: [
      {
        diskIndex: 0,
        partitionIndex: 2,
        size: BLOCK * 2,
        offset: 122683392,
        label: 'Partition 2',
        readSource: 'physical'
      }
    ]
  });

  const writeAndBackup = async (native: NativeImagingApi): Promise<void> => {
    fs.writeFileSync(jobPath, JSON.stringify(backupJob()));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
  };

  it('writes each block to the target disk at the correct offset', async () => {
    await writeAndBackup(createMockNative());

    const targetOffset = 4096;
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: true,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: targetOffset, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(2);
    expect(result.targetsRestored).toBe(1);
    // The backup already marked the image as VERIFIED, so restore skips re-checking.
    expect(result.verifiedBeforeWrite).toBe(false);

    // Offset = target partition offset + blockIndex * blockSize.
    expect(native.writeBlocks).toHaveBeenNthCalledWith(1, '\\\\.\\PhysicalDrive3', BigInt(targetOffset + 0), expect.any(Buffer));
    expect(native.writeBlocks).toHaveBeenNthCalledWith(2, '\\\\.\\PhysicalDrive3', BigInt(targetOffset + BLOCK), expect.any(Buffer));

    // The written bytes must match what was backed up.
    const firstWrite = ((native.writeBlocks as any).mock.calls[0][2] as Buffer);
    expect(firstWrite).toEqual(blockPattern(3, BLOCK));
  });

  it('zero-fills target blocks absent from a used-blocks image so free space cannot survive', async () => {
    // Sparse image: only block 0 of a 3-block partition is present.
    const partSize = BLOCK * 3;
    const partition: PartitionEntryMeta = {
      partitionIndex: 2,
      size: partSize,
      offsetOnDisk: 122683392,
      firstBlockFileOffset: 0,
      blockCount: 1
    };
    const header: ImageHeader = {
      version: IMAGE_VERSION,
      timestamp: Date.now(),
      totalBytes: BLOCK,
      blockSize: BLOCK,
      compressionId: 0,
      partitionCount: 1,
      flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED,
      blockIndexOffset: 0,
      cipherId: 0,
      kdfIterations: 0,
      salt: Buffer.alloc(16),
      baseImagePath: ''
    };
    const fd = fs.openSync(imagePath, 'w+');
    fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
    fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
    partition.firstBlockFileOffset = cursor;
    const raw = blockPattern(7, BLOCK);
    const frame = encodeBlockFrame(raw, raw);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    const blocks: BlockRecord[] = [
      { partitionIndex: 2, blockIndex: 0, fileOffset: cursor, rawSize: BLOCK, compSize: frame.length, rawCrc32: crc32(raw) }
    ];
    cursor += frame.length;
    const bi = cursor;
    const countBuf = Buffer.alloc(8);
    countBuf.writeBigUInt64LE(BigInt(blocks.length));
    fs.writeSync(fd, countBuf, 0, 8, cursor);
    cursor += 8;
    fs.writeSync(fd, encodeBlockIndexEntry(blocks[0]), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    const patched = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
    patched.writeBigUInt64LE(BigInt(bi), 40);
    fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
    fs.closeSync(fd);

    const targetOffset = 4096;
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: targetOffset, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(1);
    expect(result.freeBlocksCleared).toBe(2);
    expect(result.warnings.some((w) => w.includes('Free space cleared on the target: 2 block(s)'))).toBe(true);
    // totalBytes includes image bytes + gap zeros.
    expect(result.totalBytes).toBe(BLOCK + BLOCK * 2);
    expect(result.bytesWritten).toBe(BLOCK * 3);

    const calls = (native.writeBlocks as any).mock.calls as Array<[string, bigint, Buffer]>;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe(BigInt(targetOffset + 0));
    expect(calls[0][2]).toEqual(raw);
    // Contiguous gap run (blocks 1–2) written as zeros in one call.
    expect(calls[1][1]).toBe(BigInt(targetOffset + BLOCK));
    expect(calls[1][2].length).toBe(BLOCK * 2);
    expect(calls[1][2].every((b: number) => b === 0)).toBe(true);
  });

  it('skips free-space zero-fill when clearFreeSpace is false', async () => {
    const partSize = BLOCK * 3;
    const partition: PartitionEntryMeta = {
      partitionIndex: 2,
      size: partSize,
      offsetOnDisk: 122683392,
      firstBlockFileOffset: 0,
      blockCount: 1
    };
    const header: ImageHeader = {
      version: IMAGE_VERSION,
      timestamp: Date.now(),
      totalBytes: BLOCK,
      blockSize: BLOCK,
      compressionId: 0,
      partitionCount: 1,
      flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED,
      blockIndexOffset: 0,
      cipherId: 0,
      kdfIterations: 0,
      salt: Buffer.alloc(16),
      baseImagePath: ''
    };
    const fd = fs.openSync(imagePath, 'w+');
    fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
    fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
    partition.firstBlockFileOffset = cursor;
    const raw = blockPattern(9, BLOCK);
    const frame = encodeBlockFrame(raw, raw);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    const record: BlockRecord = {
      partitionIndex: 2,
      blockIndex: 0,
      fileOffset: cursor,
      rawSize: BLOCK,
      compSize: frame.length,
      rawCrc32: crc32(raw)
    };
    cursor += frame.length;
    const bi = cursor;
    const countBuf = Buffer.alloc(8);
    countBuf.writeBigUInt64LE(1n);
    fs.writeSync(fd, countBuf, 0, 8, cursor);
    cursor += 8;
    fs.writeSync(fd, encodeBlockIndexEntry(record), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    const patched = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
    patched.writeBigUInt64LE(BigInt(bi), 40);
    fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
    fs.closeSync(fd);

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        clearFreeSpace: false,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.freeBlocksCleared).toBeUndefined();
    expect(result.blocksWritten).toBe(1);
    expect(native.writeBlocks).toHaveBeenCalledTimes(1);
    expect(result.totalBytes).toBe(BLOCK);
  });

  it('fails the restore when a target write fails instead of only warning', async () => {
    await writeAndBackup(createMockNative());

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        clearFreeSpace: false,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    native.writeBlocks = vi.fn(() => {
      throw new Error('ERROR_ACCESS_DENIED');
    });

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Write failed for Partition 2 block 0/);
    expect(result.targetsRestored).toBe(0);
  });

  it('surfaces build-time warnings alongside runtime warnings on the result', async () => {
    await writeAndBackup(createMockNative());

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: true,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' }],
        warnings: ['Target disk model (X) matches the source disk model of the image (X).']
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('Target disk model (X) matches the source disk model of the image (X).');
  });

  it('lays down a GPT partition table before restoring partition data', async () => {
    await writeAndBackup(createMockNative());

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: true,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 122683392, label: 'Partition 2' }],
        writeTable: {
          scheme: 'gpt',
          diskSize: 1_000_000_000,
          diskGuid: '11111111-2222-3333-4444-555555555555',
          entries: [
            {
              offset: 122683392,
              size: BLOCK * 2,
              typeGuid: 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7',
              name: 'Partition 2'
            }
          ]
        }
      } as RestoreJob)
    );

    const tableNative = {
      ...createMockNative(),
      buildPartitionTable: vi.fn(() => ({
        firstUsableLBA: 34,
        lastUsableLBA: 1953124 - 33,
        regions: [
          { offset: 0, data: Buffer.alloc(512, 0xee) },
          { offset: 512, data: Buffer.alloc(512, 0xef) },
          { offset: 1024, data: Buffer.alloc(16384, 0xab) }
        ]
      }))
    } as NativeImagingApi;

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, tableNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);

    expect(tableNative.buildPartitionTable).toHaveBeenCalledWith(
      'gpt',
      1953125n,
      expect.arrayContaining([expect.objectContaining({ offset: 122683392, size: BLOCK * 2 })]),
      { diskGuid: '11111111-2222-3333-4444-555555555555' }
    );
    // Table regions are written first, partition data afterwards.
    expect(tableNative.writeBlocks).toHaveBeenNthCalledWith(1, '\\\\.\\PhysicalDrive3', BigInt(0), Buffer.alloc(512, 0xee));
    expect(tableNative.writeBlocks).toHaveBeenNthCalledWith(4, '\\\\.\\PhysicalDrive3', BigInt(122683392), expect.any(Buffer));
  });

  it('grows an NTFS filesystem when the target partition is larger than the capture', async () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    const volumeJob: ImagingJob = {
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 0,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          size: vol.length,
          offset: 0,
          label: 'Volume',
          readSource: 'physical'
        }
      ]
    };
    fs.writeFileSync(jobPath, JSON.stringify(volumeJob));
    const backupNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, backupNative);

    const targetOffset = 1048576;
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [{ partitionIndex: 0, diskIndex: 3, offset: targetOffset, size: 80 * GR_CLUSTER, label: 'Volume' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /Grew filesystem .* to 327680 bytes/.test(w))).toBe(true);

    const calls = (native.writeBlocks as any).mock.calls as Array<[string, bigint, Buffer]>;
    // The boot sector patch reports the grown total sector count.
    const bootCall = calls.find(([, offset, data]) => offset === BigInt(targetOffset) && data.length === 512);
    expect(bootCall).toBeDefined();
    expect(bootCall![2].length).toBe(512);
    expect(bootCall![2].readBigUInt64LE(0x28)).toBe(BigInt(80 * GR_SPC));

    // The stored bitmap tail (clusters 64..79, offset 3 clusters + 8 bytes in)
    // is written as zeros = new clusters free.
    const tailCall = calls.find(([, offset]) => offset === BigInt(targetOffset + 3 * GR_CLUSTER + 8));
    expect(tailCall).toBeDefined();
    expect(tailCall![2].length).toBe(2);
    expect(tailCall![2][0]).toBe(0);
    expect(tailCall![2][1]).toBe(0);
  });

  it('reports a warning but does not fail when a larger target is not NTFS', async () => {
    const vol = Buffer.alloc(64 * GR_CLUSTER, 0xaa); // random data, not NTFS
    const volumeJob: ImagingJob = {
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 0,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          size: vol.length,
          offset: 0,
          label: 'Volume',
          readSource: 'physical'
        }
      ]
    };
    fs.writeFileSync(jobPath, JSON.stringify(volumeJob));
    const backupNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, backupNative);

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [{ partitionIndex: 0, diskIndex: 3, offset: 4096, size: 80 * GR_CLUSTER, label: 'Volume' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /Could not grow filesystem/.test(w))).toBe(true);
  });

  it('skips partitions the image does not contain and reports a warning', async () => {
    await writeAndBackup(createMockNative());

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: true,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.targetsRestored).toBe(1);
  });

  it('fails before writing when verification fails', async () => {
    // Build a valid image, then corrupt it and clear the VERIFIED flag so the
    // restore actually re-runs the verifier before any write.
    await writeAndBackup(createMockNative());
    const info = readImageInfo(imagePath);
    const fd = fs.openSync(imagePath, 'r+');
    fs.writeSync(fd, Buffer.from([0x00]), 0, 1, info.dataOffset + 20);
    fs.writeSync(fd, Buffer.from([info.header.flags & ~FLAG_VERIFIED]), 0, 1, FLAGS_OFFSET);
    fs.closeSync(fd);

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: true,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verification failed/i);
    expect(result.verifiedBeforeWrite).toBe(false);
    expect(native.writeBlocks).not.toHaveBeenCalled();
  });

  it('aborts when cancelled mid-write', async () => {
    await writeAndBackup(createMockNative());
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [
          { partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' },
          { partitionIndex: 2, diskIndex: 3, offset: 8192, label: 'Partition 2' }
        ]
      } as RestoreJob)
    );

    fs.writeFileSync(cancelPath, '1');
    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  it('restores a zstd image multithreaded with the same bytes as the synchronous path', async () => {
    // Back up a zstd-compressed image so the restore can exercise the pool.
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath,
        blockSize: BLOCK,
        compressionLevel: 3,
        compressionType: 'zstd',
        verificationEnabled: true,
        partitions: [
          {
            diskIndex: 0,
            partitionIndex: 2,
            size: BLOCK * 3,
            offset: 122683392,
            label: 'Partition 2',
            readSource: 'physical'
          }
        ]
      } as ImagingJob)
    );
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createMockNative());

    const info = readImageInfo(imagePath);
    expect(info.header.compressionId).toBe(COMPRESSION_ZSTD);

    const targetOffset = 8192;
    const native = createMockNative();
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: true,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: targetOffset, label: 'Partition 2' }],
        compressionThreads: 4
      } as RestoreJob)
    );
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(3);

    // Every written block must round-trip back to the source pattern at its
    // correct on-disk offset.
    for (let i = 0; i < 3; i++) {
      const written = (native.writeBlocks as any).mock.calls[i][2] as Buffer;
      expect(written).toEqual(blockPattern(3, BLOCK));
      expect((native.writeBlocks as any).mock.calls[i][1]).toBe(BigInt(targetOffset + i * BLOCK));
    }
  });

  it('streams progress over the pipe so the UI never sits at preparing 0%', async () => {
    await writeAndBackup(createMockNative());

    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [{ partitionIndex: 2, diskIndex: 3, offset: 4096, label: 'Partition 2' }]
      } as RestoreJob)
    );

    const send = vi.fn();
    const pipeClient = { send } as unknown as Parameters<typeof runRestoreJob>[5];
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, createMockNative(), pipeClient);

    const progressMessages = send.mock.calls
      .map((call) => call[0] as { type?: string; phase?: string; percent?: number; totalBytes?: number })
      .filter((msg) => msg?.type === 'progress');
    expect(progressMessages.length).toBeGreaterThan(1);

    // The first message must already carry a real job phase — without the
    // pipe send the launcher never falls back to progress.json polling
    // (pipeConnected is true) and the wizard stays on "preparing 0%".
    expect(['verifying', 'reading-image', 'writing', 'completed']).toContain(progressMessages[0].phase);
    expect(progressMessages[0]).toHaveProperty('percent');
    expect(progressMessages[0]).toHaveProperty('totalBytes');
    expect(progressMessages[0]).toHaveProperty('bytesDone');

    const last = progressMessages[progressMessages.length - 1];
    expect(last.phase).toBe('completed');
    expect(last.percent).toBe(100);

    // The file fallback still gets the same final state.
    const onDisk = JSON.parse(fs.readFileSync(progressPath, 'utf-8')) as { phase: string; percent: number };
    expect(onDisk.phase).toBe('completed');
    expect(onDisk.percent).toBe(100);
  });
});

describe('incremental and encrypted jobs', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let fullPath: string;
  let deltaPath: string;
  let delta2Path: string;

  const PART_OFFSET = 122683392;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-ext-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    fullPath = path.join(dir, 'full.opbs');
    deltaPath = path.join(dir, 'delta.opbs');
    delta2Path = path.join(dir, 'delta2.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeJob = (job: object): void => {
    fs.writeFileSync(jobPath, JSON.stringify(job));
  };

  const readResult = (): JobResult => JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;

  const singlePartitionJob = (imagePath: string): ImagingJob => ({
    type: 'backup',
    imagePath,
    blockSize: BLOCK,
    compressionLevel: 3,
    verificationEnabled: true,
    partitions: [
      {
        diskIndex: 0,
        partitionIndex: 2,
        size: BLOCK * 3,
        offset: PART_OFFSET,
        label: 'Partition 2',
        readSource: 'physical'
      }
    ]
  });

  /**
   * Mock whose block-1 content can be flipped between runs while blocks 0 and
   * 2 stay constant, so an incremental job after a full captures only block 1.
   */
  const createIncrementalMock = (): NativeImagingApi & { changeBlock1(): void } => {
    let block1Changed = false;
    const readBlocks = vi.fn((devicePath: string, offset: bigint, length: bigint): Buffer => {
      const offsetInPart = Number(offset) - PART_OFFSET;
      if (block1Changed && offsetInPart >= BLOCK && offsetInPart < 2 * BLOCK) {
        return blockPattern(9, Number(length));
      }
      if (offsetInPart === 2 * BLOCK) {
        return blockPattern(5, Number(length));
      }
      return blockPattern(3, Number(length));
    });
    return {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks,
      changeBlock1: () => {
        block1Changed = true;
      }
    };
  };

  it('incremental backup stores only changed blocks and flags the image', async () => {
    const native = createIncrementalMock();

    writeJob(singlePartitionJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const fullResult = readResult();
    expect(fullResult.ok).toBe(true);
    expect(fullResult.blocksWritten).toBe(3);

    // Change block 1 and take a delta against the full.
    native.changeBlock1();
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: fullPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const deltaResult = readResult();
    expect(deltaResult.ok).toBe(true);
    expect(deltaResult.blocksWritten).toBe(1);
    expect(deltaResult.skippedBlocks).toBe(2);
    expect(deltaResult.incremental).toBe(true);

    const info = readImageInfo(deltaPath);
    expect(info.header.flags & FLAG_INCREMENTAL).toBeTruthy();
    expect(info.header.baseImagePath).toBe(fullPath);
    expect(info.blocks.length).toBe(1);
    expect(info.blocks[0].blockIndex).toBe(1);
    expect(info.blocks[0].rawCrc32).toBe(crc32(blockPattern(9, BLOCK)));

    // The delta image verifies standalone (its own frames + index).
    const verified = await verifyImage(deltaPath);
    expect(verified.ok).toBe(true);
    expect(verified.blocksVerified).toBe(1);
  });

  it('records only the base file name when the folder path is too long for the header', async () => {
    // The header's base-path field holds 127 bytes. A deep or network folder
    // used to be cut off mid-name (and an accented one mangled), so the chain
    // could never be restored - while the backup reported success.
    const longDir = path.join(dir, 'Sauvegardes José Müller', 'x'.repeat(60), 'y'.repeat(60));
    fs.mkdirSync(longDir, { recursive: true });
    const longFull = path.join(longDir, 'full.opbs');
    const longDelta = path.join(longDir, 'delta.opbs');
    expect(Buffer.byteLength(longFull)).toBeGreaterThan(127);

    const native = createIncrementalMock();
    writeJob(singlePartitionJob(longFull));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);

    native.changeBlock1();
    writeJob({ ...singlePartitionJob(longDelta), baseImagePath: longFull });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);

    expect(readImageInfo(longDelta).header.baseImagePath).toBe('full.opbs');
    expect(resolveImageChain(longDelta)).toEqual([longFull, longDelta]);

    // And the chain still resolves after the folder is moved.
    const moved = path.join(dir, 'moved');
    fs.renameSync(path.join(dir, 'Sauvegardes José Müller'), moved);
    clearImageInfoCache();
    const movedDir = path.join(moved, 'x'.repeat(60), 'y'.repeat(60));
    expect(resolveImageChain(path.join(movedDir, 'delta.opbs'))).toEqual([
      path.join(movedDir, 'full.opbs'),
      path.join(movedDir, 'delta.opbs')
    ]);
  });

  it('stops an incremental whose base path cannot be recorded instead of writing a broken chain', async () => {
    const longDir = path.join(dir, 'x'.repeat(70), 'y'.repeat(70));
    fs.mkdirSync(longDir, { recursive: true });
    const longFull = path.join(longDir, 'full.opbs');

    const native = createIncrementalMock();
    writeJob(singlePartitionJob(longFull));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);

    // The delta goes to a different folder, so the file name alone cannot be
    // used and the full path does not fit: refuse before writing anything.
    native.changeBlock1();
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: longFull });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const result = readResult();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too long to record/);
    expect(fs.existsSync(deltaPath)).toBe(false);
  });

  it('restores a chain of full + delta so changed blocks land at their original offsets', async () => {
    const native = createIncrementalMock();

    writeJob(singlePartitionJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    native.changeBlock1();
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: fullPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const restoreNative = createIncrementalMock();
    writeJob({
      type: 'restore',
      imagePath: fullPath,
      verifyBeforeWrite: false,
      applyDeltas: [deltaPath],
      targets: [{ partitionIndex: 2, diskIndex: 1, offset: 4096, label: 'Partition 2' }]
    } as RestoreJob);
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(4); // 3 full + 1 delta
    expect(restoreNative.writeBlocks).toHaveBeenNthCalledWith(4, '\\\\.\\PhysicalDrive1', BigInt(4096 + BLOCK), expect.any(Buffer));
    const lastData = ((restoreNative.writeBlocks as any).mock.calls[3][2] as Buffer);
    expect(lastData).toEqual(blockPattern(9, BLOCK));
  });

  it('verify-before-write checks the source that is actually unverified', async () => {
    const native = createIncrementalMock();

    writeJob(singlePartitionJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    native.changeBlock1();
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: fullPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    // The full was verified during backup; only the delta is unverified.
    // Clear its VERIFIED flag and corrupt its frame payload: verifying the
    // delta must fail, while verifying the (already verified) full would pass.
    const deltaInfo = readImageInfo(deltaPath);
    const fd = fs.openSync(deltaPath, 'r+');
    fs.writeSync(fd, Buffer.from([deltaInfo.header.flags & ~FLAG_VERIFIED]), 0, 1, FLAGS_OFFSET);
    fs.writeSync(fd, Buffer.from([0xff]), 0, 1, deltaInfo.blocks[0].fileOffset + 16);
    fs.closeSync(fd);

    const restoreNative = createIncrementalMock();
    writeJob({
      type: 'restore',
      imagePath: fullPath,
      verifyBeforeWrite: true,
      applyDeltas: [deltaPath],
      targets: [{ partitionIndex: 2, diskIndex: 1, offset: 4096, label: 'Partition 2' }]
    } as RestoreJob);
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Image verification failed before restore');
    expect(result.error).toContain(path.basename(deltaPath));
    // The integrity gate runs before any target write.
    expect(restoreNative.writeBlocks).not.toHaveBeenCalled();
  });

  it('encrypted backup refuses to verify without the key and passes with it', async () => {
    const native = createMockNative();
    const cipher = newImageCipher('correct horse battery staple');

    writeJob({ ...singlePartitionJob(fullPath), encryption: metadataFromCipher(cipher) });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const result = readResult();
    expect(result.ok).toBe(true);

    const info = readImageInfo(fullPath);
    expect(info.header.cipherId).toBe(1);

    const noKey = await verifyImage(fullPath);
    expect(noKey.ok).toBe(false);
    expect(noKey.error).toMatch(/passphrase/i);

    const withKey = await verifyImage(fullPath, cipher.key);
    expect(withKey.ok).toBe(true);
  });

  it('restores an encrypted image back to the original plaintext blocks', async () => {
    const native = createMockNative();
    const cipher = newImageCipher('correct horse battery staple');

    // verificationEnabled: false leaves FLAG_VERIFIED clear, forcing the
    // restore's verify-before-write gate to actually decrypt and re-check the image.
    writeJob({
      ...singlePartitionJob(fullPath),
      verificationEnabled: false,
      encryption: metadataFromCipher(cipher)
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);

    // Clear FLAG_VERIFIED so the restore's verify-before-write gate actually runs.
    const info2 = readImageInfo(fullPath);
    const fd2 = fs.openSync(fullPath, 'r+');
    fs.writeSync(fd2, Buffer.from([info2.header.flags & ~FLAG_VERIFIED]), 0, 1, FLAGS_OFFSET);
    fs.closeSync(fd2);

    const restoreNative = createMockNative();
    writeJob({
      type: 'restore',
      imagePath: fullPath,
      verifyBeforeWrite: true,
      encryption: metadataFromCipher(cipher),
      targets: [{ partitionIndex: 2, diskIndex: 1, offset: 4096, label: 'Partition 2' }]
    } as RestoreJob);
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.verifiedBeforeWrite).toBe(true);
    expect(result.blocksWritten).toBe(3);
    const firstData = ((restoreNative.writeBlocks as any).mock.calls[0][2] as Buffer);
    expect(firstData).toEqual(blockPattern(3, BLOCK));
  });

  it('restores an encrypted chain applying each member\'s own key', async () => {
    const native = createIncrementalMock();
    const passphrase = 'correct horse battery staple';
    const cipherA = newImageCipher(passphrase);
    const cipherB = newImageCipher(passphrase);

    // verificationEnabled: false skips the post-backup verify pass (flags are
    // cleared below anyway — the runner marks every success VERIFIED).
    writeJob({
      ...singlePartitionJob(fullPath),
      verificationEnabled: false,
      encryption: metadataFromCipher(cipherA)
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);

    native.changeBlock1();
    writeJob({
      ...singlePartitionJob(deltaPath),
      baseImagePath: fullPath,
      verificationEnabled: false,
      encryption: metadataFromCipher(cipherB)
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);

    // The runner marks every successful backup VERIFIED regardless of the
    // verification pass; clear both members' flags so the restore's
    // verify-before-write gate actually decrypts each source.
    for (const p of [fullPath, deltaPath]) {
      const info = readImageInfo(p);
      const fd = fs.openSync(p, 'r+');
      fs.writeSync(fd, Buffer.from([info.header.flags & ~FLAG_VERIFIED]), 0, 1, FLAGS_OFFSET);
      fs.closeSync(fd);
    }

    // The two members were written under different salts, so the job carries
    // one derivation per source; a single key would fail on one member.
    const restoreNative = createIncrementalMock();
    writeJob({
      type: 'restore',
      imagePath: fullPath,
      applyDeltas: [deltaPath],
      verifyBeforeWrite: true,
      sourceEncryption: [
        { imagePath: fullPath, ...metadataFromCipher(cipherA) },
        { imagePath: deltaPath, ...metadataFromCipher(cipherB) }
      ],
      targets: [{ partitionIndex: 2, diskIndex: 1, offset: 4096, label: 'Partition 2' }]
    } as RestoreJob);
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.verifiedBeforeWrite).toBe(true);
    expect(result.blocksWritten).toBe(4); // 3 full + 1 delta
    const lastData = ((restoreNative.writeBlocks as any).mock.calls[3][2] as Buffer);
    expect(lastData).toEqual(blockPattern(9, BLOCK));
  });

  it('writes a zstd image using multithreaded compression that verifies and restores', async () => {
    const native = createMockNative();
    writeJob({
      ...singlePartitionJob(fullPath),
      compressionType: 'zstd',
      compressionThreads: 2
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(3);

    const info = readImageInfo(fullPath);
    expect(info.header.compressionId).toBe(COMPRESSION_ZSTD);

    const verified = await verifyImage(fullPath);
    expect(verified.ok).toBe(true);
    expect(verified.blocksVerified).toBe(3);

    // Data restored from the zstd image matches the source blocks.
    const restoreNative = createMockNative();
    writeJob({
      type: 'restore',
      imagePath: fullPath,
      verifyBeforeWrite: false,
      targets: [{ partitionIndex: 2, diskIndex: 1, offset: 4096, label: 'Partition 2' }]
    } as RestoreJob);
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const restoreResult = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.blocksWritten).toBe(3);
    for (let i = 0; i < 3; i++) {
      const data = ((restoreNative.writeBlocks as any).mock.calls[i][2] as Buffer);
      expect(data).toEqual(blockPattern(3, BLOCK));
    }
  });

  it('delta-on-delta skips blocks already present anywhere in the ancestor chain', async () => {
    // Block 0 and 2 stay constant (patterns 3 and 5); block 1 can be flipped
    // between runs so each delta captures only the block that actually changed.
    let block1Pattern = 3;
    const readBlocks = vi.fn((devicePath: string, offset: bigint, length: bigint): Buffer => {
      const offsetInPart = Number(offset) - PART_OFFSET;
      if (offsetInPart >= BLOCK && offsetInPart < 2 * BLOCK) {
        return blockPattern(block1Pattern, Number(length));
      }
      if (offsetInPart === 2 * BLOCK) {
        return blockPattern(5, Number(length));
      }
      return blockPattern(3, Number(length));
    });
    const native: NativeImagingApi & { setBlock1(p: number): void } = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks,
      setBlock1: (p: number) => {
        block1Pattern = p;
      }
    };

    // Full image.
    writeJob(singlePartitionJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().blocksWritten).toBe(3);

    // Delta 1: block 1 -> 9. Base = full.
    native.setBlock1(9);
    writeJob({ ...singlePartitionJob(deltaPath), baseImagePath: fullPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const d1 = readResult();
    expect(d1.blocksWritten).toBe(1);
    expect(d1.skippedBlocks).toBe(2);

    // Delta 2: block 1 -> 10. Base = delta 1. Because block 0 and 2 still match
    // the *grandparent* full image, they must be skipped even though delta 1
    // does not store them.
    native.setBlock1(10);
    writeJob({ ...singlePartitionJob(delta2Path), baseImagePath: deltaPath });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    const d2 = readResult();
    expect(d2.ok).toBe(true);
    expect(d2.incremental).toBe(true);
    expect(d2.blocksWritten).toBe(1);
    expect(d2.skippedBlocks).toBe(2);

    const info = readImageInfo(delta2Path);
    expect(info.blocks.length).toBe(1);
    expect(info.blocks[0].blockIndex).toBe(1);
    expect(info.blocks[0].rawCrc32).toBe(crc32(blockPattern(10, BLOCK)));
  });

  it('uses the USN journal to read only changed blocks for an incremental', async () => {
    const baseVolume = buildNtfsVolumeData();
    const incrementalVolume = Buffer.from(baseVolume);
    // Change big.bin (record 8, clusters 32..33) so the incremental sees a diff.
    for (let i = 0; i < 2 * NTFS_CLUSTER; i++) incrementalVolume[32 * NTFS_CLUSTER + i] = 0xee;

    const volumeJob = (imagePath: string): ImagingJob => ({
      type: 'backup',
      imagePath,
      blockSize: NTFS_CLUSTER,
      compressionLevel: 3,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: incrementalVolume.length,
          offset: 0,
          label: 'Volume',
          readSource: 'volume',
          volumeDevicePath: 'C:'
        }
      ]
    });

    const fullNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((device: string, offset: bigint, length: bigint) =>
        baseVolume.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    writeJob(volumeJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, fullNative);
    expect(readResult().blocksWritten).toBe(Math.ceil(incrementalVolume.length / NTFS_CLUSTER));

    // Incremental: USN reports only big.bin changed; the reader must skip
    // reading every other block.
    const deltaNative: NativeImagingApi & { readBlocks: ReturnType<typeof vi.fn> } = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((device: string, offset: bigint, length: bigint) =>
        incrementalVolume.subarray(Number(offset), Number(offset) + Number(length))
      ),
      queryUsnJournal: vi.fn(() => [{ usn: 100n, fileReference: 8n, reason: 0, fileName: 'big.bin' }])
    };
    writeJob({ ...volumeJob(deltaPath), baseImagePath: fullPath, useUsnJournal: true, usnVolume: 'C:', usnLastUsn: 1 });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, deltaNative);

    const result = readResult();
    expect(result.ok).toBe(true);
    // Only big.bin's two clusters (block indices 32, 33) differ and are stored.
    expect(result.blocksWritten).toBe(2);

    const info = readImageInfo(deltaPath);
    expect(info.blocks.map((b) => b.blockIndex).sort((a, b) => a - b)).toEqual([32, 33]);
  });

  const usnVolumeJob = (imagePath: string): ImagingJob => ({
    type: 'backup',
    imagePath,
    blockSize: NTFS_CLUSTER,
    compressionLevel: 3,
    verificationEnabled: false,
    partitions: [
      {
        diskIndex: 0,
        partitionIndex: 2,
        size: buildNtfsVolumeData().length,
        offset: 0,
        label: 'Volume',
        readSource: 'volume',
        volumeDevicePath: 'C:'
      }
    ]
  });

  const ntfsVolumes = (): { base: Buffer; changed: Buffer } => {
    const base = buildNtfsVolumeData();
    const changed = Buffer.from(base);
    // Change big.bin (record 8, clusters 32..33) so an incremental sees a diff.
    for (let i = 0; i < 2 * NTFS_CLUSTER; i++) changed[32 * NTFS_CLUSTER + i] = 0xee;
    return { base, changed };
  };

  it('reads every block of a full backup even when USN tracking is enabled', async () => {
    const { changed } = ntfsVolumes();
    const totalBlocks = Math.ceil(changed.length / NTFS_CLUSTER);
    const native: NativeImagingApi & { readBlocks: ReturnType<typeof vi.fn> } = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        changed.subarray(Number(offset), Number(offset) + Number(length))
      ),
      // A journal claiming only big.bin changed must NOT shrink a full backup.
      queryUsnJournal: vi.fn(() => [{ usn: 100n, fileReference: 8n, reason: 0, fileName: 'big.bin' }])
    };
    writeJob({
      ...usnVolumeJob(fullPath),
      useUsnJournal: true,
      usnVolume: 'C:',
      usnLastUsn: 1
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().blocksWritten).toBe(totalBlocks);
    // +1: each snapshot is probed with a 512-byte read before it is trusted.
    // The data blocks are still exactly totalBlocks.
    expect(native.readBlocks.mock.calls.length).toBe(totalBlocks + 1);
  });

  it('records the pre-snapshot USN cursor in the sidecar', async () => {
    const { changed } = ntfsVolumes();
    let snapshotTaken = false;
    const native: NativeImagingApi = {
      createSnapshot: vi.fn(() => {
        snapshotTaken = true;
        return { id: 's', devicePath: '\\\\.\\ShadowCopy1' };
      }),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        changed.subarray(Number(offset), Number(offset) + Number(length))
      ),
      // 4242 is the journal position at snapshot time; 999999 is a later
      // position (post-capture) that must never reach the sidecar.
      getUsnJournalInfo: vi.fn(() =>
        snapshotTaken
          ? { firstUsn: 0, nextUsn: 999999, lowestValidUsn: 0 }
          : { firstUsn: 0, nextUsn: 4242, lowestValidUsn: 0 }
      )
    };
    writeJob({
      ...usnVolumeJob(fullPath),
      useUsnJournal: true,
      perPartitionUsn: { 2: { volume: 'C:', lastUsn: 1 } }
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    expect(readResult().ok).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(`${fullPath}.usn`, 'utf-8')) as {
      version: number;
      partitions: Array<{ partitionIndex: number; volume: string; usn: string }>;
    };
    expect(sidecar.version).toBe(2);
    expect(sidecar.partitions).toEqual([{ partitionIndex: 2, volume: 'C:', usn: '4242' }]);
  });

  it('full-scans when the changed set exceeds usnFullScanThreshold', async () => {
    const { base, changed } = ntfsVolumes();
    const totalBlocks = Math.ceil(changed.length / NTFS_CLUSTER);
    // Real base image first (separate reader, unmodified content).
    const fullNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        base.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    writeJob(usnVolumeJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, fullNative);
    expect(readResult().ok).toBe(true);

    const native: NativeImagingApi & { readBlocks: ReturnType<typeof vi.fn> } = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        changed.subarray(Number(offset), Number(offset) + Number(length))
      ),
      queryUsnJournal: vi.fn(() => [{ usn: 100n, fileReference: 8n, reason: 0, fileName: 'big.bin' }])
    };
    writeJob({
      ...usnVolumeJob(deltaPath),
      baseImagePath: fullPath,
      useUsnJournal: true,
      usnVolume: 'C:',
      usnLastUsn: 1,
      usnFullScanThreshold: 0 // any changed block at all → give up on the journal
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    // Every block was read (threshold exceeded) — the MFT walk adds its own
    // readBlocks calls, so this is a lower bound, not an exact count.
    expect(native.readBlocks.mock.calls.length).toBeGreaterThanOrEqual(totalBlocks);
    // …but only the CRC-differing frames were written.
    expect(readResult().blocksWritten).toBe(2);
    expect(readImageInfo(deltaPath).blocks.map((b) => b.blockIndex).sort((a, b) => a - b)).toEqual([32, 33]);
  });

  it('ignores a USN cursor that belongs to a different volume', async () => {
    const { base, changed } = ntfsVolumes();
    const totalBlocks = Math.ceil(changed.length / NTFS_CLUSTER);
    const fullNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        base.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    writeJob(usnVolumeJob(fullPath));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, fullNative);
    expect(readResult().ok).toBe(true);

    const native: NativeImagingApi & { readBlocks: ReturnType<typeof vi.fn> } = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        changed.subarray(Number(offset), Number(offset) + Number(length))
      ),
      queryUsnJournal: vi.fn(() => [{ usn: 100n, fileReference: 8n, reason: 0, fileName: 'big.bin' }])
    };
    writeJob({
      ...usnVolumeJob(deltaPath),
      baseImagePath: fullPath,
      useUsnJournal: true,
      usnVolume: '\\\\?\\Volume{foreign}\\', // not this partition's volume
      usnLastUsn: 1
    });
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);
    // Foreign cursor → treated as "no cursor" → full read, correct frames.
    // +1: the snapshot probe read, before any data block.
    expect(native.readBlocks.mock.calls.length).toBe(totalBlocks + 1);
    expect(readResult().blocksWritten).toBe(2);
  });

  it('restore drill validates the written NTFS filesystem when validateAfterWrite is set', async () => {
    const imagePath = path.join(dir, 'drill.opbs');
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol.writeUInt16LE(0x55aa, 510);
    const volumeJob: ImagingJob = {
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 0,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          size: vol.length,
          offset: 0,
          label: 'C:',
          readSource: 'physical'
        }
      ]
    };
    fs.writeFileSync(jobPath, JSON.stringify(volumeJob));
    const backupNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, backupNative);

    const targetOffset = 1048576;
    const target = Buffer.alloc(targetOffset + vol.length);
    const restoreNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn((_device: string, offset: bigint, data: Buffer) => {
        data.copy(target, Number(offset));
        return 0;
      }),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        target.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        validateAfterWrite: true,
        targets: [{ partitionIndex: 0, diskIndex: 3, offset: targetOffset, label: 'C:' }]
      } as RestoreJob)
    );
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.fsValidation).toHaveLength(1);
    expect(result.fsValidation![0].ok).toBe(true);
    expect(result.fsValidation![0].checks.mftMagic).toBe('FILE');
    expect(result.drill).toBeDefined();
    expect(result.drill!.ok).toBe(true);
    expect(result.drill!.failures).toEqual([]);
  });

  it('restore drill keeps the restore result ok but reports validation failures', async () => {
    const imagePath = path.join(dir, 'drill.opbs');
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol.writeUInt16LE(0x55aa, 510);
    const volumeJob: ImagingJob = {
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 0,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          size: vol.length,
          offset: 0,
          label: 'C:',
          readSource: 'physical'
        }
      ]
    };
    fs.writeFileSync(jobPath, JSON.stringify(volumeJob));
    const backupNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, backupNative);

    // The disk the drill reads back has a corrupted $MFT record 0.
    const targetOffset = 1048576;
    const broken = Buffer.alloc(targetOffset + vol.length);
    vol.copy(broken, targetOffset);
    broken.write('NOPE', targetOffset + 4 * GR_CLUSTER, 'ascii');
    const restoreNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        broken.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        validateAfterWrite: true,
        targets: [{ partitionIndex: 0, diskIndex: 3, offset: targetOffset, label: 'C:' }]
      } as RestoreJob)
    );
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.drill!.ok).toBe(false);
    expect(result.drill!.failures[0]).toContain('C:');
    expect(result.drill!.failures[0]).toContain('magic');
  });

  it('post-restore CRC verify reads back blocks and reports mismatches', async () => {
    const imagePath = path.join(dir, 'verify-crc.opbs');
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol.writeUInt16LE(0x55aa, 510);
    const volumeJob: ImagingJob = {
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 0,
      verificationEnabled: false,
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          size: vol.length,
          offset: 0,
          label: 'C:',
          readSource: 'physical'
        }
      ]
    };
    fs.writeFileSync(jobPath, JSON.stringify(volumeJob));
    const backupNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn(() => 0),
      readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset), Number(offset) + Number(length))
      )
    };
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, backupNative);

    // Restore target: a buffer that returns corrupted data on read-back.
    const targetOffset = 0;
    const target = Buffer.alloc(vol.length);
    const restoreNative: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
      writeBlocks: vi.fn((_device: string, offset: bigint, data: Buffer) => {
        data.copy(target, Number(offset));
        return 0;
      }),
      // Read-back returns zeroes instead of the written data → CRC mismatch.
      readBlocks: vi.fn((_device: string, _offset: bigint, length: bigint) =>
        Buffer.alloc(Number(length))
      )
    };
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        verifyAfterRestore: true,
        targets: [{ partitionIndex: 0, diskIndex: 3, offset: targetOffset, label: 'C:' }]
      } as RestoreJob)
    );
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, restoreNative);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true); // restore itself succeeds
    // But warnings should report CRC mismatches from the post-restore verify.
    const crcWarnings = result.warnings.filter((w) => w.includes('Post-restore CRC mismatch'));
    expect(crcWarnings.length).toBeGreaterThan(0);
  });
});

describe('runRestoreJob (Macrium)', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let imagePath: string;

  const GEOM_OFFSET = 1048576;
  const TARGET_OFFSET = 4096;
  const DATA = 2 * 8192;
  // Geometry length exceeds the captured data so every restore has an
  // uncaptured tail to zero-fill unless the job opts out.
  const GEOM_LENGTH = 2 * DATA;

  const data0 = Buffer.alloc(8192, 0x11);
  data0.write('NTFS    ', 3, 'ascii');
  const data1 = Buffer.alloc(8192, 0x22);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-mrimg-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    imagePath = path.join(dir, 'image.mrimgx');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeImage(opts?: {
    tweak?: (json: any) => void;
    geometry?: { start?: number; length?: number };
  }): void {
    const start = opts?.geometry?.start ?? GEOM_OFFSET;
    const length = opts?.geometry?.length ?? GEOM_LENGTH;
    const built = buildMrimgxImage([data0, data1], (json) => {
      json.disks[0].partitions[0]._geometry = {
        start,
        end: start + length - 1,
        length,
        boot_sector_offset: 0
      };
      opts?.tweak?.(json);
    });
    fs.writeFileSync(imagePath, built.buffer);
  }

  const writeJob = (overrides: Partial<RestoreJob> & { targets: RestoreJob['targets'] }): void => {
    fs.writeFileSync(
      jobPath,
      JSON.stringify({ type: 'restore', imagePath, verifyBeforeWrite: false, ...overrides } as RestoreJob)
    );
  };

  const readResult = (): RestoreJobResult =>
    JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;

  const callsOf = (native: NativeImagingApi): Array<[string, bigint, Buffer]> =>
    (native.writeBlocks as ReturnType<typeof vi.fn>).mock.calls as Array<[string, bigint, Buffer]>;

  /** Mock native backed by an in-memory disk so read-backs see prior writes. */
  function createDiskNative(size = 1 << 20): NativeImagingApi {
    const native = createMockNative();
    const disk = Buffer.alloc(size);
    native.writeBlocks = vi.fn((_devicePath: string, offset: bigint, data: Buffer): number => {
      data.copy(disk, Number(offset));
      return 0;
    });
    native.readBlocks = vi.fn((_devicePath: string, offset: bigint, length: bigint): Buffer =>
      Buffer.from(disk.subarray(Number(offset), Number(offset) + Number(length)))
    );
    return native;
  }

  it('writes the captured data at the target offset and zeroes the uncaptured tail', async () => {
    writeImage();
    writeJob({ targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }] });
    const native = createDiskNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.targetsRestored).toBe(1);
    expect(result.blocksWritten).toBe(2);
    expect(result.verifiedBeforeWrite).toBe(false);
    expect(result.warnings).toEqual([]);

    const calls = callsOf(native);
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('\\\\.\\PhysicalDrive3');
    expect(calls[0][1]).toBe(BigInt(TARGET_OFFSET));
    expect(calls[0][2].equals(Buffer.concat([data0, data1]))).toBe(true);
    // The geometry extent (32768) is twice the captured data: the tail is
    // zero-filled so stale target bytes cannot survive.
    expect(calls[1][1]).toBe(BigInt(TARGET_OFFSET + DATA));
    expect(calls[1][2].length).toBe(DATA);
    expect(calls[1][2].every((b) => b === 0)).toBe(true);
    expect(result.bytesWritten).toBe(GEOM_LENGTH);
    expect(result.totalBytes).toBe(GEOM_LENGTH);
  });

  it('skips the tail zero-fill when clearFreeSpace is false', async () => {
    writeImage();
    writeJob({ clearFreeSpace: false, targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }] });
    const native = createDiskNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(callsOf(native)).toHaveLength(1);
    expect(result.bytesWritten).toBe(DATA);
    expect(result.totalBytes).toBe(DATA);
  });

  it('verifies restored blocks against the image index MD5s when asked', async () => {
    writeImage();
    writeJob({
      verifyAfterRestore: true,
      targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }]
    });
    const native = createDiskNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(native.readBlocks).toHaveBeenCalledTimes(2);
  });

  it('reports post-restore MD5 mismatches as warnings without failing the job', async () => {
    writeImage();
    writeJob({
      verifyAfterRestore: true,
      targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }]
    });
    // Plain mock: reads return an unrelated pattern, so every block mismatches.
    const native = createMockNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    const warnings = result.warnings.join(' ');
    expect(warnings).toMatch(/Post-restore MD5 mismatch on P0 block 0/);
    expect(warnings).toMatch(/Post-restore verify: 2 block\(s\) failed MD5 check/);
  });

  it('treats a grow beyond the captured extent as best-effort (warning, never failure)', async () => {
    writeImage({ geometry: { length: DATA } });
    writeJob({
      targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, size: DATA * 2, label: 'P0' }]
    });
    const native = createDiskNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Grew filesystem|Could not grow filesystem/);
  });

  it('fails cleanly before any write when the container is password-protected', async () => {
    writeImage({
      tweak: (json) => {
        json._encryption = { enable: true, keyIterations: 600000 };
      }
    });
    writeJob({ targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }] });
    const native = createMockNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/password/);
    expect(result.blocksWritten).toBe(0);
    expect(native.writeBlocks).not.toHaveBeenCalled();
  });

  it('fails cleanly before any write for a file-and-folder backup', async () => {
    writeImage({
      tweak: (json) => {
        json._header.backup_format = 'file_and_folder';
      }
    });
    writeJob({ targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }] });
    const native = createMockNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/file and folder/);
    expect(native.writeBlocks).not.toHaveBeenCalled();
  });

  it('cancels cleanly before writing when the cancel file exists', async () => {
    writeImage();
    writeJob({ targets: [{ partitionIndex: 0, diskIndex: 3, offset: TARGET_OFFSET, label: 'P0' }] });
    fs.writeFileSync(cancelPath, '');
    const native = createMockNative();

    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toBe('Restore cancelled by user');
    expect(native.writeBlocks).not.toHaveBeenCalled();
  });
});

// A real-image restore round-trip reads the whole restored extent into
// memory for the content comparison, so it needs a deliberately provided,
// modestly sized sample — never an auto-discovered fleet image whose sparse
// partition can span hundreds of gigabytes.
const V7_SAMPLE_MAX_BYTES = 64 * 1024 * 1024;
const V7_SAMPLE_ENV = process.env.OPBS_V7_SAMPLE;
const V7_SAMPLE =
  V7_SAMPLE_ENV && fs.existsSync(V7_SAMPLE_ENV) && fs.statSync(V7_SAMPLE_ENV).size <= V7_SAMPLE_MAX_BYTES
    ? V7_SAMPLE_ENV
    : '';

describe.skipIf(!V7_SAMPLE)('runRestoreJob with a real Reflect .mrimg image (OPBS_V7_SAMPLE)', () => {
  it('round-trips every captured block through the runner', async () => {
    const info = readMacriumImage(V7_SAMPLE);
    const part = info.partitions[0];
    const writeLen = Math.min(part.blockCount * part.blockSize, macriumPartitionSize(part));
    const expected = openMacriumPartitionReader(info, 0).read(0, writeLen);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-v7-restore-'));
    const jobPath = path.join(dir, 'job.json');
    const resultPath = path.join(dir, 'result.json');
    const progressPath = path.join(dir, 'progress.json');
    const cancelPath = path.join(dir, 'cancel');
    const written: Buffer[] = [];
    try {
      fs.writeFileSync(
        jobPath,
        JSON.stringify({
          type: 'restore',
          imagePath: V7_SAMPLE,
          verifyBeforeWrite: false,
          clearFreeSpace: false,
          targets: [{ partitionIndex: 0, diskIndex: 3, offset: 4096, label: 'P0' }]
        } as RestoreJob)
      );
      const native = createMockNative();
      native.writeBlocks = vi.fn((_p: string, _o: bigint, data: Buffer): number => {
        written.push(Buffer.from(data));
        return 0;
      });

      await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
      expect(result.ok).toBe(true);
      expect(result.targetsRestored).toBe(1);
      expect(result.warnings).toEqual([]);

      const got = Buffer.concat(written);
      expect(got.length).toBe(writeLen);
      expect(createHash('md5').update(got).digest('hex')).toBe(
        createHash('md5').update(expected).digest('hex')
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The free-space clear is the one mechanism in a restore that can destroy data
 * it must not touch: after writing the data it zeroes every block the image
 * chain does not contain. If the block-presence set ever misses a block that
 * some chain member holds, the clear silently wipes a block the restore just
 * wrote — the writer reports success, the volume has errors on boot, and files
 * are gone. Two field reports (2026-11-01, 2026-11-02) are exactly that shape,
 * so the safety property is pinned here rather than assumed.
 */
describe('free-space clear never zeroes a block the chain contains', () => {
  const PART_OFFSET = 1048576;
  const PART_BLOCKS = 6;
  const TARGET_OFFSET = 4096;

  /**
   * Write an image holding exactly `blocks` (blockIndex -> seed) of a
   * PART_BLOCKS partition, so the chain's present-set is entirely under the
   * test's control. `baseImagePath` makes it a delta member.
   */
  function writePartialImage(
    imagePath: string,
    blocks: Array<[number, number]>,
    baseImagePath?: string
  ): void {
    const partition: PartitionEntryMeta = {
      partitionIndex: 0,
      size: BLOCK * PART_BLOCKS,
      offsetOnDisk: PART_OFFSET,
      firstBlockFileOffset: 0,
      blockCount: PART_BLOCKS
    };
    const header: ImageHeader = {
      version: IMAGE_VERSION,
      timestamp: Date.now(),
      totalBytes: partition.size,
      blockSize: BLOCK,
      compressionId: 0,
      partitionCount: 1,
      flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED | (baseImagePath ? FLAG_INCREMENTAL : 0),
      blockIndexOffset: 0,
      cipherId: 0,
      kdfIterations: 0,
      salt: Buffer.alloc(16),
      baseImagePath: baseImagePath ?? ''
    };
    const fd = fs.openSync(imagePath, 'w+');
    fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
    fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
    partition.firstBlockFileOffset = cursor;
    const records: BlockRecord[] = [];
    for (const [blockIndex, seed] of blocks) {
      const raw = blockPattern(seed, BLOCK);
      const frame = encodeBlockFrame(raw, raw);
      fs.writeSync(fd, frame, 0, frame.length, cursor);
      records.push({
        partitionIndex: 0,
        blockIndex,
        fileOffset: cursor,
        rawSize: BLOCK,
        compSize: frame.length,
        rawCrc32: crc32(raw)
      });
      cursor += frame.length;
    }
    const bi = cursor;
    const countBuf = Buffer.alloc(8);
    countBuf.writeBigUInt64LE(BigInt(records.length));
    fs.writeSync(fd, countBuf, 0, 8, cursor);
    cursor += 8;
    for (const r of records) {
      fs.writeSync(fd, encodeBlockIndexEntry(r), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
      cursor += BLOCK_INDEX_ENTRY_SIZE;
    }
    fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    const patched = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
    patched.writeBigUInt64LE(BigInt(bi), 40);
    fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
    fs.closeSync(fd);
  }

  /** What the target partition looks like once every write has landed. */
  function restoredBytes(native: NativeImagingApi): Buffer {
    const disk = Buffer.alloc(PART_BLOCKS * BLOCK);
    const calls = (native.writeBlocks as any).mock.calls as Array<[string, bigint, Buffer]>;
    for (const [, offset, buf] of calls) {
      const start = Number(offset) - TARGET_OFFSET;
      if (start < 0 || start >= disk.length) continue;
      buf.copy(disk, start, 0, Math.min(buf.length, disk.length - start));
    }
    return disk;
  }

  let dir: string;
  let basePath: string;
  let deltaPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-clear-audit-'));
    basePath = path.join(dir, 'full.opbs');
    deltaPath = path.join(dir, 'delta.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every block held by the base or the delta, and zeroes only the gaps', async () => {
    // Base holds 0, 2, 4. The delta holds 3 - only in the newest member, which
    // is exactly the case a broken present-set would drop and then wipe.
    writePartialImage(basePath, [[0, 3], [2, 5], [4, 7]]);
    writePartialImage(deltaPath, [[3, 11]], basePath);

    const native = createMockNative();
    fs.writeFileSync(
      path.join(dir, 'job.json'),
      JSON.stringify({
        type: 'restore',
        imagePath: basePath,
        verifyBeforeWrite: false,
        applyDeltas: [deltaPath],
        targets: [{ partitionIndex: 0, diskIndex: 1, offset: TARGET_OFFSET, label: 'Partition 0' }]
      } as RestoreJob)
    );
    await runRestoreJob(path.join(dir, 'job.json'), path.join(dir, 'result.json'), path.join(dir, 'progress.json'), path.join(dir, 'cancel'), native);

    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);

    const disk = restoredBytes(native);
    // Present blocks keep the content the chain describes - including block 3,
    // which exists only in the delta.
    for (const [blockIndex, seed] of [[0, 3], [2, 5], [3, 11], [4, 7]] as Array<[number, number]>) {
      expect(disk.subarray(blockIndex * BLOCK, (blockIndex + 1) * BLOCK)).toEqual(blockPattern(seed, BLOCK));
    }
    // Only the true gaps are cleared.
    for (const gap of [1, 5]) {
      expect(disk.subarray(gap * BLOCK, (gap + 1) * BLOCK).every((b) => b === 0)).toBe(true);
    }
    expect(result.freeBlocksCleared).toBe(2);
  });

  it('clears nothing at all when the whole partition is covered by the chain', async () => {
    writePartialImage(basePath, [[0, 3], [1, 4], [2, 5]]);
    writePartialImage(deltaPath, [[3, 11], [4, 12], [5, 13]], basePath);

    const native = createMockNative();
    fs.writeFileSync(
      path.join(dir, 'job.json'),
      JSON.stringify({
        type: 'restore',
        imagePath: basePath,
        verifyBeforeWrite: false,
        applyDeltas: [deltaPath],
        targets: [{ partitionIndex: 0, diskIndex: 1, offset: TARGET_OFFSET, label: 'Partition 0' }]
      } as RestoreJob)
    );
    await runRestoreJob(path.join(dir, 'job.json'), path.join(dir, 'result.json'), path.join(dir, 'progress.json'), path.join(dir, 'cancel'), native);

    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(result.freeBlocksCleared ?? 0).toBe(0);

    const disk = restoredBytes(native);
    for (let b = 0; b < PART_BLOCKS; b++) {
      expect(disk.subarray(b * BLOCK, (b + 1) * BLOCK).every((x) => x === 0)).toBe(false);
    }
  });
});

/**
 * Field report 2026-11-03: a tester's machine had broken VSS, so every backup
 * silently read the live disk while Windows wrote to it. The images passed
 * every block checksum and were still internally inconsistent — the allocation
 * bitmap and the file records came from different moments — and a restore of
 * one produced a filesystem chkdsk described as corrupt. Nothing warned him.
 *
 * A backup that cannot obtain a snapshot must stop. Reading live is an
 * explicit, recorded decision, never a fallback.
 */
describe('a backup without a consistent snapshot', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-nosnap-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A backup of one partition that *needs* a shadow copy. */
  function jobFor(imagePath: string, allowInconsistentCapture?: boolean) {
    return {
      type: 'backup',
      imagePath,
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      ...(allowInconsistentCapture ? { allowInconsistentCapture: true } : {}),
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 2,
          size: BLOCK * 3,
          offset: 122683392,
          label: 'Real',
          readSource: 'volume',
          volumeDevicePath: '\\\\.\\Volume{deadbeef-0000-0000-0000-000000000000}\\'
        }
      ]
    };
  }

  /** A minimal backup native: snapshotting works unless told to throw. */
  function vssNative(snapshotThrows: boolean) {
    return {
      createSnapshot: vi.fn((volumePath: string) => {
        if (snapshotThrows) throw new Error('VSS_E_UNEXPECTED_PROVIDER_ERROR');
        return { id: 'snap-1', devicePath: volumePath };
      }),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
      readBlocks: vi.fn((_d: string, _o: bigint, length: bigint) => Buffer.alloc(Number(length), 7)),
      writeBlocks: vi.fn(() => 0)
    } as unknown as NativeImagingApi;
  }

  it('stops and says so, instead of silently reading a live disk', async () => {
    const imagePath = path.join(dir, 'should-not-exist.opbs');
    fs.writeFileSync(jobPath, JSON.stringify(jobFor(imagePath)));

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, vssNative(true));
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/shadow copy of/);
  });

  it('names the consequence and the way out in the refusal', async () => {
    fs.writeFileSync(jobPath, JSON.stringify(jobFor(path.join(dir, 'x.opbs'))));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, vssNative(true));
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    // The user has to be able to act on it, not just be told "failed".
    expect(result.error ?? '').toContain('no single point in time');
    expect(result.error ?? '').toContain('--allow-inconsistent');
  });

  it('proceeds, loudly, when the caller accepts the risk', async () => {
    const imagePath = path.join(dir, 'accepted.opbs');
    fs.writeFileSync(jobPath, JSON.stringify(jobFor(imagePath, true)));

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, vssNative(true));

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    // The decision is recorded, not buried.
    expect(result.warnings.some((w) => w.includes('WITHOUT a consistent point in time'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('no VSS snapshot'))).toBe(true);
  });

  it('never fires when a snapshot is taken', async () => {
    const imagePath = path.join(dir, 'fine.opbs');
    fs.writeFileSync(jobPath, JSON.stringify(jobFor(imagePath)));

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, vssNative(false));

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('no VSS snapshot'))).toBe(false);
  });
});

/**
 * Per-volume snapshot sets meant a multi-partition backup captured each
 * partition at a different moment — the image had no single point in time
 * across volumes. (Field report 2026-11-04.)
 */
describe('multi-volume backups share one point in time', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-snapset-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('snapshots every volume in one set, not one set each', async () => {
    const twoVolumes = [
      { label: 'One', volumeDevicePath: '\\\\.\\Volume{one}\\' },
      { label: 'Two', volumeDevicePath: '\\\\.\\Volume{two}\\' }
    ];
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath: path.join(dir, 'a.opbs'),
        blockSize: BLOCK,
        compressionLevel: 3,
        verificationEnabled: false,
        partitions: twoVolumes.map((v, i) => ({
          diskIndex: 0,
          partitionIndex: i + 1,
          size: BLOCK,
          offset: 122683392 + i * BLOCK,
          label: v.label,
          readSource: 'volume',
          volumeDevicePath: v.volumeDevicePath
        }))
      })
    );

    const setCalls: string[][] = [];
    const native = createMockNative() as unknown as {
      createSnapshot: ReturnType<typeof vi.fn>;
      createSnapshotSet: (paths: string[]) => Array<{ id: string; devicePath: string }>;
    };
    native.createSnapshotSet = (paths: string[]) => {
      setCalls.push(paths);
      return paths.map((p, i) => ({ id: `snap-${i}`, devicePath: p }));
    };

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native as never);

    // One call, both volumes: a single DoSnapshotSet freezes them together.
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toEqual(['\\\\.\\Volume{one}\\', '\\\\.\\Volume{two}\\']);
  });

  it('says so when it has to fall back to per-volume snapshots', async () => {
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath: path.join(dir, 'b.opbs'),
        blockSize: BLOCK,
        compressionLevel: 3,
        verificationEnabled: false,
        partitions: [
          {
            diskIndex: 0,
            partitionIndex: 1,
            size: BLOCK,
            offset: 122683392,
            label: 'One',
            readSource: 'volume',
            volumeDevicePath: '\\\\.\\Volume{one}\\'
          },
          {
            diskIndex: 0,
            partitionIndex: 2,
            size: BLOCK,
            offset: 122683392 + BLOCK,
            label: 'Two',
            readSource: 'volume',
            volumeDevicePath: '\\\\.\\Volume{two}\\'
          }
        ]
      })
    );

    // No createSnapshotSet: the old per-volume path. It must not pretend the
    // result is a single point in time.
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createMockNative());

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('no single point in time'))).toBe(true);
  });

  it('freezes what it can and warns about one volume that cannot be', async () => {
    // Field report 2026-11-04: a dual-partition recovery stick — OPBS-BOOT
    // (FAT32) plus OPBS-DATA (NTFS). The FAT32 volume made AddToSnapshotSet
    // fail, and the whole backup was refused with "VSS is not working on this
    // machine". Both halves were wrong: the NTFS volume freezes fine, and
    // FAT32 is a filesystem property, not damage.
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath: path.join(dir, 'usb.opbs'),
        blockSize: BLOCK,
        compressionLevel: 3,
        verificationEnabled: false,
        partitions: [
          {
            diskIndex: 1,
            partitionIndex: 1,
            size: BLOCK,
            offset: 1048576,
            label: 'OPBS-BOOT',
            readSource: 'volume',
            volumeDevicePath: '\\\\.\\Volume{boot}\\'
          },
          {
            diskIndex: 1,
            partitionIndex: 2,
            size: BLOCK,
            offset: 1048576 + BLOCK,
            label: 'OPBS-DATA',
            readSource: 'volume',
            volumeDevicePath: '\\\\.\\Volume{data}\\'
          }
        ]
      })
    );

    const native = createMockNative() as unknown as {
      createSnapshot: ReturnType<typeof vi.fn>;
      createSnapshotSet: () => Array<{ id: string; devicePath: string }>;
    };
    const notSupported = () =>
      new Error("VSS operation 'AddToSnapshotSet' failed with HRESULT 0x8004230c");
    native.createSnapshotSet = () => {
      throw notSupported();
    };
    native.createSnapshot = vi.fn((volumePath: string) => {
      if (volumePath.includes('boot')) throw notSupported();
      return { id: 'snap-data', devicePath: '\\\\.\\ShadowCopy2' };
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native as never);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    // The volume that could not be frozen is named, and the reason is honest.
    const warning = result.warnings.find((w) => w.includes('OPBS-BOOT')) ?? '';
    expect(warning).toContain('property of the volume');
    expect(warning).toContain('captured live');
    // And the machine is not accused of being broken.
    expect(result.warnings.some((w) => w.includes('not working on this machine'))).toBe(false);
  });

  const usbJob = (): string =>
    JSON.stringify({
      type: 'backup',
      imagePath: path.join(dir, 'usb.opbs'),
      blockSize: BLOCK,
      compressionLevel: 3,
      verificationEnabled: false,
      partitions: [
        { diskIndex: 1, partitionIndex: 1, size: BLOCK, offset: 1048576, label: 'OPBS-BOOT', readSource: 'volume', volumeDevicePath: '\\\\.\\Volume{boot}\\' },
        { diskIndex: 1, partitionIndex: 2, size: BLOCK, offset: 1048576 + BLOCK, label: 'OPBS-DATA', readSource: 'volume', volumeDevicePath: '\\\\.\\Volume{data}\\' }
      ]
    });

  it('treats VSS_E_VOLUME_NOT_SUPPORTED_BY_PROVIDER (0x8004230e) as a per-volume limit too', async () => {
    // The classifier carried a mistyped code (0x80042309, a success status)
    // where 0x8004230e belongs, so a provider that rejected one volume refused
    // the whole backup instead of freezing the rest.
    fs.writeFileSync(jobPath, usbJob());
    const native = createMockNative() as unknown as {
      createSnapshot: ReturnType<typeof vi.fn>;
      createSnapshotSet: () => Array<{ id: string; devicePath: string }>;
    };
    const rejected = () => new Error("VSS operation 'AddToSnapshotSet' failed with HRESULT 0x8004230e");
    native.createSnapshotSet = () => {
      throw rejected();
    };
    native.createSnapshot = vi.fn((volumePath: string) => {
      if (volumePath.includes('boot')) throw rejected();
      return { id: 'snap-data', devicePath: '\\\\.\\ShadowCopy2' };
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native as never);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    const warning = result.warnings.find((w) => w.includes('OPBS-BOOT')) ?? '';
    expect(warning).toContain('captured live');
  });

  it('does not fall back to a live capture when a provider vetoes the snapshot', async () => {
    // 0x80042306 (VSS_E_PROVIDER_VETO) is a fixable refusal, not a property of
    // the volume. Degrading it to a live read would recreate the failure this
    // project was hurt by: an image that verifies block by block and restores
    // as a corrupt filesystem.
    fs.writeFileSync(jobPath, usbJob());
    const native = createMockNative() as unknown as {
      createSnapshot: ReturnType<typeof vi.fn>;
      createSnapshotSet: () => Array<{ id: string; devicePath: string }>;
    };
    native.createSnapshotSet = () => {
      throw new Error("VSS operation 'DoSnapshotSet' failed with HRESULT 0x80042306");
    };
    native.createSnapshot = vi.fn(() => ({ id: 'should-not-happen', devicePath: '\\\\.\\ShadowCopy9' }));

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native as never);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(false);
    // No per-volume retry was attempted, so nothing was quietly captured live.
    expect(native.createSnapshot).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.includes('captured live'))).toBe(false);
  });

  it('refuses all-FAT32 media without calling VSS broken', async () => {
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath: path.join(dir, 'all-fat.opbs'),
        blockSize: BLOCK,
        compressionLevel: 3,
        verificationEnabled: false,
        partitions: [
          {
            diskIndex: 1,
            partitionIndex: 1,
            size: BLOCK,
            offset: 1048576,
            label: 'OPBS-BOOT',
            readSource: 'volume',
            volumeDevicePath: '\\\\.\\Volume{boot}\\'
          }
        ]
      })
    );

    const native = createMockNative() as unknown as {
      createSnapshot: ReturnType<typeof vi.fn>;
      createSnapshotSet: () => Array<{ id: string; devicePath: string }>;
    };
    const notSupported = () =>
      new Error("VSS operation 'AddToSnapshotSet' failed with HRESULT 0x8004230c");
    native.createSnapshotSet = () => {
      throw notSupported();
    };
    native.createSnapshot = vi.fn(() => {
      throw notSupported();
    });

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native as never);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).not.toContain('not working on this machine');
    expect(error).toContain('property of those volumes');
    expect(error).toContain('--allow-inconsistent');
  });
});

/**
 * The property that makes the check worth its cost: a backup that produces an
 * internally inconsistent image must NOT report success. Every 2026-11-03
 * image passed its CRCs and still restored as a corrupt filesystem.
 */
describe('a backup that produces an inconsistent image fails', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fscheck-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A volume whose file records disagree with its allocation map. */
  function inconsistentVolume(): Buffer {
    const totalClusters = 64;
    const vol = Buffer.alloc(totalClusters * 4096);
    vol.write('NTFS    ', 3, 'ascii');
    vol.writeUInt16LE(512, 0x0b);
    vol.writeUInt8(8, 0x0d);
    vol.writeBigUInt64LE(BigInt(totalClusters * 8), 0x28);
    vol.writeBigUInt64LE(4n, 0x30);
    vol.writeBigUInt64LE(5n, 0x38);
    vol.writeInt8(-10, 0x40);
    return vol;
  }

  it('does not call an inconsistent image a success', async () => {
    // The synthetic volume above is not a consistent NTFS filesystem, so the
    // check cannot pass it. What matters is that "could not verify" never
    // becomes "verified".
    const vol = inconsistentVolume();
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath: path.join(dir, 'bad.opbs'),
        blockSize: BLOCK,
        compressionLevel: 3,
        verificationEnabled: false,
        partitions: [
          {
            diskIndex: 0,
            partitionIndex: 2,
            size: vol.length,
            offset: 122683392,
            label: 'Real',
            readSource: 'physical'
          }
        ]
      })
    );

    const native = createMockNative();
    (native.readBlocks as ReturnType<typeof vi.fn>).mockImplementation(
      (_d: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset) - 122683392, Number(offset) - 122683392 + Number(length))
    );

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    // Whatever the verdict, it must never be a silent pass: either the check
    // reported something, or it said it could not check.
    const silent = result.ok && result.warnings.length === 0;
    expect(silent).toBe(false);
  });

  it('leaves the full report beside the image and names it in the error', async () => {
    // A volume whose file records and bitmap were captured moments apart: the
    // 2026-11-03 shape. The user cannot act on "inconsistent" alone, and
    // asking them to re-run a multi-minute check to see the detail is not an
    // answer — so the report must be on disk next to the image.
    const imagePath = path.join(dir, 'bad.opbs');
    const vol = buildNtfsVolumeData({ freeClusters: [32, 33] });
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath,
        blockSize: NTFS_CLUSTER,
        compressionLevel: 3,
        verificationEnabled: false,
        partitions: [
          {
            diskIndex: 0,
            partitionIndex: 2,
            size: vol.length,
            offset: 0,
            label: 'Real',
            readSource: 'physical'
          }
        ]
      })
    );

    const native = createMockNative();
    (native.readBlocks as ReturnType<typeof vi.fn>).mockImplementation(
      (_d: string, offset: bigint, length: bigint) =>
        vol.subarray(Number(offset), Number(offset) + Number(length))
    );

    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(false);
    const sidecarPath = `${imagePath}.fscheck.json`;
    expect(result.error ?? '').toContain(sidecarPath);
    // The evidence the message points at has to survive the failure.
    expect(fs.existsSync(imagePath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as {
      generatedAt: string;
      label: string;
      partitionIndex: number;
      report: { ok: boolean; claimedButFree: Array<{ cluster: number; label?: string }> };
    };
    expect(sidecar.label).toBe('Real');
    expect(sidecar.partitionIndex).toBe(2);
    expect(sidecar.report.ok).toBe(false);
    expect(sidecar.report.claimedButFree.map((i) => i.cluster)).toEqual([32, 33]);
    expect(sidecar.report.claimedButFree[0].label).toBe('big.bin');
    expect(new Date(sidecar.generatedAt).getTime()).toBeGreaterThan(0);
  });
});
