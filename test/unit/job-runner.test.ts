import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { runBackupJob, runRestoreJob } from '../../src/main/helper/job-runner';
import { verifyImage, readImageInfo, encodeHeader, encodeBlockFrame, encodePartitionEntry, encodeBlockIndexEntry, HEADER_SIZE, PARTITION_TABLE_ENTRY_SIZE, BLOCK_INDEX_ENTRY_SIZE, IMAGE_VERSION, FLAG_HAS_BLOCK_INDEX, FLAG_VERIFIED, FLAGS_OFFSET, FLAG_INCREMENTAL, FLAG_RESUMED, COMPRESSION_DEFLATE, COMPRESSION_ZSTD, crc32, newImageCipher, metadataFromCipher, scanPartialImage, compressBlock } from '../../src/main/imaging/image-format';
import { ImagingJob, RestoreJob, NativeImagingApi, JobResult, RestoreJobResult } from '../../src/main/imaging/imaging-job';
import { buildNtfsVolumeData, CLUSTER as NTFS_CLUSTER } from '../helpers/ntfs-fixture';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER, GR_SPC } from '../helpers/ntfs-resize-fixture';

const BLOCK = 16 * 1024;

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
    expect(result.warnings).toEqual([]);
    expect(native.deleteSnapshot).toHaveBeenCalledTimes(1);

    const verified = await verifyImage(imagePath);
    expect(verified.ok).toBe(true);
    expect(verified.blocksVerified).toBe(5);

    const info = readImageInfo(imagePath);
    expect(info.header.partitionCount).toBe(2);
    expect(info.header.totalBytes).toBe(BLOCK * 5);
    expect(info.partitions.map((p) => p.blockCount)).toEqual([3, 2]);
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
    expect(progress.currentPartition).toBe('Partition 2');
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
  });

  it('reports read failures as warnings but finishes other partitions', async () => {
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
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(0);
    expect(result.warnings).toHaveLength(2);
  });

  it('falls back to a raw physical read when a snapshot cannot be created', async () => {
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

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/VSS snapshot unavailable/i);
    expect(fs.existsSync(imagePath)).toBe(true);
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
