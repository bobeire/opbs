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
import { launchElevatedJob } from '../../src/main/helper/launcher';

vi.mock('../../src/main/helper/launcher', () => ({
  launchElevatedJob: vi.fn(() => ({
    promise: Promise.resolve({ ok: true }),
    cancel: vi.fn(),
    onProgress: vi.fn()
  }))
}));

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

function createVolumeBackedEnumerator(): DiskEnumerator {  return {
    getDisks: vi.fn(async () => [
      { index: 0, model: 'NVMe Corp SSD 1TB', size: 1_000_000_000_000, serial: 'SN-ABCD-1234' }
    ]),
    getPartitions: vi.fn(async () => [
      {
        diskIndex: 0,
        partitionIndex: 0,
        offset: 1048576,
        size: 104857600,
        type: 7,
        label: 'C',
        driveLetter: 'C'
      },
      {
        diskIndex: 0,
        partitionIndex: 1,
        offset: 105906176,
        size: 104857600,
        type: 7,
        label: 'D',
        driveLetter: 'D'
      }
    ]),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async (_diskIndex: number, offset: number) =>
      offset === 1048576 ? '\\\\?\\Volume{c}\\' : '\\\\?\\Volume{d}\\'
    )
  } as unknown as DiskEnumerator;
}

/** Header-only image good enough for `buildJob`'s base-image partition check. */
function writeBaseImage(imgPath: string, partitionCount: number): void {
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: Date.now(),
    totalBytes: 0,
    blockSize: 1024 * 1024,
    compressionId: COMPRESSION_DEFLATE,
    partitionCount,
    flags: 0,
    blockIndexOffset: 0,
    cipherId: CIPHER_NONE,
    kdfIterations: 0,
    salt: Buffer.alloc(0),
    baseImagePath: ''
  };
  fs.writeFileSync(imgPath, encodeHeader(header));
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
        readSource: 'physical',
        volumeDevicePath: undefined
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

    it('seeds per-partition USN cursors when the base image has no sidecar', async () => {
      const base = path.join(dir, 'base.opbs');
      writeBaseImage(base, 2);
      const job = await new ImagingEngine(createVolumeBackedEnumerator()).buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0, 1],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        baseImagePath: base,
        useUsnJournal: true
      });
      // Missing sidecar no longer disables USN for the chain: the run
      // full-scans and rewrites a fresh sidecar (lastUsn 0 seeds).
      expect(job.useUsnJournal).toBe(true);
      expect(job.perPartitionUsn).toEqual({
        0: { volume: '\\\\?\\Volume{c}\\', lastUsn: 0 },
        1: { volume: '\\\\?\\Volume{d}\\', lastUsn: 0 }
      });
      expect(job.usnVolume).toBeUndefined();
      expect(job.usnFullScanThreshold).toBeUndefined();
    });

    it('attaches a legacy sidecar cursor only to its own volume', async () => {
      const base = path.join(dir, 'base.opbs');
      writeBaseImage(base, 2);
      fs.writeFileSync(
        `${base}.usn`,
        JSON.stringify({ volume: '\\\\?\\Volume{c}\\', usn: '777' })
      );
      const job = await new ImagingEngine(createVolumeBackedEnumerator()).buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0, 1],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        baseImagePath: base,
        useUsnJournal: true
      });
      expect(job.perPartitionUsn).toEqual({
        0: { volume: '\\\\?\\Volume{c}\\', lastUsn: 777 },
        // Partition 1 must NOT inherit the other volume's journal cursor.
        1: { volume: '\\\\?\\Volume{d}\\', lastUsn: 0 }
      });
    });

    it('overlays v2 sidecar cursors by volume identity', async () => {
      const base = path.join(dir, 'base.opbs');
      writeBaseImage(base, 2);
      fs.writeFileSync(
        `${base}.usn`,
        JSON.stringify({
          version: 2,
          partitions: [
            { partitionIndex: 0, volume: '\\\\?\\Volume{c}\\', usn: '55' },
            // Stale identity after a repartition: rejected, keeps the seed.
            { partitionIndex: 1, volume: '\\\\?\\Volume{old}\\', usn: '99' }
          ]
        })
      );
      const job = await new ImagingEngine(createVolumeBackedEnumerator()).buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0, 1],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        baseImagePath: base,
        useUsnJournal: true
      });
      expect(job.perPartitionUsn).toEqual({
        0: { volume: '\\\\?\\Volume{c}\\', lastUsn: 55 },
        1: { volume: '\\\\?\\Volume{d}\\', lastUsn: 0 }
      });
    });

    it('forwards usnFullScanThreshold and disables USN without volume-backed partitions', async () => {
      const thresholdJob = await new ImagingEngine(createVolumeBackedEnumerator()).buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        useUsnJournal: true,
        usnFullScanThreshold: 0.25
      });
      expect(thresholdJob.useUsnJournal).toBe(true);
      expect(thresholdJob.usnFullScanThreshold).toBe(0.25);

      // The default fixture has no volume-backed partitions (all physical).
      const physicalJob = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0, 2],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false,
        useUsnJournal: true
      });
      expect(physicalJob.useUsnJournal).toBeUndefined();
      expect(physicalJob.perPartitionUsn).toBeUndefined();
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

    it('captures every partition when a VHD source has no partition selection', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [],
        sourceVirtualDisk: 'C:/vms/source.vhdx',
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.partitions.map((p) => p.partitionIndex)).toEqual([0, 2]);
    });

    it('still filters explicit partitions on a VHD source', async () => {
      const job = await engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [2],
        sourceVirtualDisk: 'C:/vms/source.vhdx',
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false
      });
      expect(job.partitions.map((p) => p.partitionIndex)).toEqual([2]);
    });

    it('throws on an empty selection for a physical source', async () => {
      await expect(
        engine.buildJob({
          sourceDiskIndex: 0,
          sourcePartitions: [],
          destinationPath: dir,
          compressionLevel: 3,
          verificationEnabled: false
        })
      ).rejects.toThrow(/no matching partitions/i);
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

describe('ImagingEngine runBackup payloads', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-engine-payload-'));
    vi.mocked(launchElevatedJob).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('launches a backup-vhd payload when the source is a virtual disk file', async () => {
    const engine = new ImagingEngine(createFakeEnumerator());
    const config = {
      sourceDiskIndex: -1,
      sourcePartitions: [],
      sourceVirtualDisk: 'C:/vms/source.vhdx',
      destinationPath: dir,
      compressionLevel: 3,
      verificationEnabled: false
    };
    const result = await engine.runBackup(config, () => undefined);
    expect(result).toEqual({ ok: true });
    expect(launchElevatedJob).toHaveBeenCalledTimes(1);
    expect(launchElevatedJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'backup-vhd', config })
    );
  });

  it('builds and launches an ordinary backup job for disk sources', async () => {
    const engine = new ImagingEngine(createFakeEnumerator());
    const result = await engine.runBackup(
      {
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        destinationPath: dir,
        compressionLevel: 3,
        verificationEnabled: false
      },
      () => undefined
    );
    expect(result).toEqual({ ok: true });
    expect(launchElevatedJob).toHaveBeenCalledTimes(1);
    expect(launchElevatedJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'backup', partitions: expect.any(Array) })
    );
  });
});

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
    expect(mapJobProgress({ ...base, phase: 'writing-index' }).phase).toBe('finalizing');
    expect(mapJobProgress({ ...base, phase: 'verifying' }).phase).toBe('verifying');
    expect(mapJobProgress({ ...base, phase: 'completed' }).phase).toBe('completed');
  });
});
