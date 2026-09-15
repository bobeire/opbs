import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImagingEngine, mapJobProgress } from '../../src/main/imaging/backup-engine';
import {
  ImageHeader,
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  CIPHER_NONE,
  PARTITION_TABLE_ENTRY_SIZE,
  HEADER_SIZE,
  COMPRESSION_DEFLATE,
  encodeHeader,
  encodeBlockFrame,
  compressBlock
} from '../../src/main/imaging/image-format';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';
import { JobProgress } from '../../src/main/imaging/imaging-job';

function createFakeEnumerator(): DiskEnumerator {
  return {
    getDisks: vi.fn(async () => [
      { index: 0, model: 'NVMe Corp SSD 1TB', size: 1_000_000_000_000, serial: 'SN-ABCD-1234' },
      { index: 1, model: 'Another Drive', size: 500_000_000_000, serial: 'SN-OTHER-0001' }
    ]),
    getPartitions: vi.fn(async (diskIndex: number) => {
      if (diskIndex === 0) {
        return [
          {
            diskIndex: 0,
            partitionIndex: 0,
            offset: 1048576,
            size: 104857600,
            type: 238,
            label: 'Partition 0',
            driveLetter: null
          },
          {
            diskIndex: 0,
            partitionIndex: 2,
            offset: 122683392,
            size: 998686136832,
            type: 238,
            label: 'Partition 2',
            driveLetter: null
          }
        ];
      }
      return [];
    }),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async (_diskIndex: number, offset: number) => {
      return offset === 1048576 ? '\\\\?\\Volume{aaaa}\\' : null;
    })
  } as unknown as DiskEnumerator;
}

describe('ImagingEngine', () => {
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already removed */
    }
  });

  let dir: string;
  let engine: ImagingEngine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-engine-'));
    engine = new ImagingEngine(createFakeEnumerator());
  });

  describe('buildJob', () => {
    it('builds a job from the selected partitions', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0, 2],
        destinationPath: dir,
        compressionLevel: 5,
        verificationEnabled: true
      });

      expect(job.partitions).toHaveLength(2);
      expect(job.partitions[0]).toMatchObject({
        diskIndex: 0,
        partitionIndex: 0,
        readSource: 'volume',
        volumeDevicePath: '\\\\?\\Volume{aaaa}\\'
      });
      expect(job.partitions[1]).toMatchObject({
        diskIndex: 0,
        partitionIndex: 2,
        readSource: 'physical',
        volumeDevicePath: undefined
      });
      expect(job.imagePath).toMatch(new RegExp(`^${dir.replace(/\\/g, '\\\\')}\\\\opbs-disk0-.*\\.opbs$`));
      expect(job.blockSize).toBe(1024 * 1024);
      expect(job.compressionLevel).toBe(5);
      expect(job.compressionThreads).toBeGreaterThan(0);
    });

    it('records the source disk identity for same-disk restore guards', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.sourceDisk).toEqual({ model: 'NVMe Corp SSD 1TB', serial: 'SN-ABCD-1234' });

      const missing = new ImagingEngine({
        getDisks: vi.fn(async () => [{ index: 0, size: 1 }]),
        getPartitions: vi.fn(async () => [
          { diskIndex: 0, partitionIndex: 0, offset: 1048576, size: 104857600, type: 238, label: 'Partition 0', driveLetter: null }
        ]),
        getPhysicalDrivePath: vi.fn(),
        getVolumePath: vi.fn(async () => null)
      } as unknown as DiskEnumerator);
      const fallback = await missing.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 0,
        verificationEnabled: false
      });
      expect(fallback.sourceDisk).toBeUndefined();
    });

    it('forwards usedBlocksOnly into the job', async () => {
      const full = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(full.usedBlocksOnly).toBeUndefined();

      const used = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        usedBlocksOnly: true
      });
      expect(used.usedBlocksOnly).toBe(true);
    });

    it('defaults compression threads for zstd and honors explicit config', async () => {
      const zstdJob = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        compressionType: 'zstd',
        verificationEnabled: false
      });
      expect(zstdJob.compressionType).toBe('zstd');
      expect(zstdJob.compressionThreads).toBeGreaterThan(0);

      const explicitJob = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        compressionType: 'deflate',
        compressionThreads: 1,
        verificationEnabled: false
      });
      expect(explicitJob.compressionThreads).toBe(1);
    });

    it('leaves threading unset when compression is disabled', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 0,
        verificationEnabled: false
      });
      expect(job.compressionThreads).toBeUndefined();
    });

    it('throws when no selected partitions match', async () => {
      await expect(
        engine.buildJob({
          sourceDiskIndex: 0,
          sourcePartitions: [9],
destinationPath: dir,
          compressionLevel: 3,
          verificationEnabled: false
        })
      ).rejects.toThrow(/no matching partitions/i);
    });

    it('throws when the destination is missing', async () => {
      await expect(
        engine.buildJob({
          sourceDiskIndex: 0,
          sourcePartitions: [0],
          destinationPath: path.join(dir, 'nope'),
          compressionLevel: 3,
          verificationEnabled: false
        })
      ).rejects.toThrow(/destination/i);
    });

    it('uses a local temp dir for SFTP destinations', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: 'sftp://user@host/backups',
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.imagePath).toMatch(/opbs-stream-/);
    });

    it('rejects streaming destinations that are not supported', async () => {
      await expect(
        engine.buildJob({
          sourceDiskIndex: 0,
          sourcePartitions: [0],
          destinationPath: 'webdav://host/path',
          compressionLevel: 3,
          verificationEnabled: false
        })
      ).rejects.toThrow(/Destination is not an existing directory/i);
    });

    it('uses a local temp dir for FTP destinations', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: 'ftp://user@host/backups',
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.imagePath).toMatch(/opbs-stream-/);
    });

    it('uses a local temp dir for S3 destinations', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: 's3://bucket/prefix',
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.imagePath).toMatch(/opbs-stream-/);
    });

    it('does not resume when the resume flag is off, even with a partial image present', async () => {
      // A partial image at the target path exists, but resume is not requested:
      // buildJob must NOT attach a resumeCheckpoint.
      const path = await buildPartialImageAtDefaultName(engine, dir);
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.imagePath).toBe(path);
      expect(job.resumeCheckpoint).toBeUndefined();
      expect(job.resume).toBeUndefined();
    });

    it('attaches a resume checkpoint when resume is enabled and a compatible partial exists', async () => {
      const path = await buildPartialImageAtDefaultName(engine, dir);
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        resume: true
      });
      expect(job.imagePath).toBe(path);
      expect(job.resume).toBe(true);
      expect(job.resumeCheckpoint).toBeDefined();
      // Partition 0 is fully written in the partial image so the checkpoint
      // resumes with completedPartitions=1 and the counted blocks preserved.
      expect(job.resumeCheckpoint!.completedPartitions).toBe(1);
      expect(job.resumeCheckpoint!.blocksWritten).toBe(100);
      expect(job.resumeCheckpoint!.cursor).toBeGreaterThan(0);
    });
  });
});

/** Writes a valid partial (unfinished) image to the default target name. */
async function buildPartialImageAtDefaultName(eng: ImagingEngine, destDir: string): Promise<string> {
  const job = await eng.buildJob({
    sourceDiskIndex: 0,
    sourcePartitions: [0],
    destinationPath: destDir,
    compressionLevel: 3,
    verificationEnabled: false
  });
  const defaultPath = job.imagePath;

  // Header + table for the single selected partition (100 MiB at 1 MiB blocks,
  // deflate, no encryption) matching what buildJob itself produces.
  const part = job.partitions[0];
  const blockCount = Math.ceil(part.size / job.blockSize);
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: Date.now(),
    totalBytes: part.size,
    blockSize: job.blockSize,
    compressionId: COMPRESSION_DEFLATE,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX,
    blockIndexOffset: 0,
    cipherId: CIPHER_NONE,
    kdfIterations: 0,
    salt: Buffer.alloc(0),
    baseImagePath: ''
  };
  const tableSize = 1 * PARTITION_TABLE_ENTRY_SIZE;
  const fd = fs.openSync(defaultPath, 'w+');
  fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
  fs.writeSync(fd, Buffer.alloc(tableSize), 0, tableSize, HEADER_SIZE);
  // Write every block so the partition counts as complete; an unfinished image
  // only differs by lacking the block index at the end.
  const raw = Buffer.alloc(job.blockSize, 0xab);
  const comp = compressBlock(raw, COMPRESSION_DEFLATE, 3);
  const frame = encodeBlockFrame(raw, comp);
  for (let b = 0; b < blockCount; b++) {
    fs.writeSync(fd, frame, 0, frame.length, HEADER_SIZE + tableSize + b * frame.length);
  }
  fs.closeSync(fd);
  return defaultPath;
}

describe('mapJobProgress', () => {
  const base: JobProgress = {
    phase: 'reading',
    percent: 50,
    bytesDone: 500,
    totalBytes: 1000,
    speed: 250,
    currentPartition: 'Partition 2',
    createdAt: 0
  };

  it('maps reading to backing_up', () => {
    const mapped = mapJobProgress(base);
    expect(mapped.phase).toBe('backing_up');
    expect(mapped.percentComplete).toBe(50);
    expect(mapped.bytesProcessed).toBe(500);
    expect(mapped.totalBytes).toBe(1000);
    expect(mapped.currentPartition).toBe('Partition 2');
  });

  it('computes estimated time remaining from speed', () => {
    const mapped = mapJobProgress(base);
    expect(mapped.estimatedTimeRemaining).toBe((1000 - 500) / 250);
  });

  it('returns zero ETA when speed is unknown', () => {
    const mapped = mapJobProgress({ ...base, speed: 0 });
    expect(mapped.estimatedTimeRemaining).toBe(0);
  });

  it('maps each helper phase', () => {
    expect(mapJobProgress({ ...base, phase: 'snapshotting' }).phase).toBe('snapshotting');
    expect(mapJobProgress({ ...base, phase: 'writing-index' }).phase).toBe('backing_up');
    expect(mapJobProgress({ ...base, phase: 'verifying' }).phase).toBe('verifying');
    expect(mapJobProgress({ ...base, phase: 'completed' }).phase).toBe('completed');
  });
});