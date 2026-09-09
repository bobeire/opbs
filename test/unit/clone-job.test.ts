import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCloneJob, runBackupJob } from '../../src/main/helper/job-runner';
import { readImageInfo } from '../../src/main/imaging/image-format';
import { CloneJob, JobResult, CloneJobResult, NativeImagingApi } from '../../src/main/imaging/imaging-job';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER } from '../helpers/ntfs-resize-fixture';

const TOTAL_CLUSTERS = 64;
const VOLUME_SIZE = TOTAL_CLUSTERS * GR_CLUSTER;

interface WrittenBlock {
  device: string;
  offset: bigint;
  data: Buffer;
}

/** A native mock whose readBlocks serves an in-memory buffer (a live volume). */
function bufferNative(buf: Buffer): NativeImagingApi & { writes: WrittenBlock[] } {
  const writes: WrittenBlock[] = [];
  return {
    writes,
    createSnapshot: vi.fn(() => ({ id: 'snap-1', devicePath: '\\\\.\\ShadowCopy1' })),
    deleteSnapshot: vi.fn(() => true),
    getPhysicalDrivePath: vi.fn((diskIndex: number) => `\\\\.\\PhysicalDrive${diskIndex}`),
    readBlocks: vi.fn((_device: string, offset: bigint, length: bigint): Buffer => {
      const start = Number(offset);
      return Buffer.from(buf.subarray(start, start + Number(length)));
    }),
    writeBlocks: vi.fn((device: string, offset: bigint, data: Buffer): number => {
      writes.push({ device, offset, data: Buffer.from(data) });
      return 0;
    })
  };
}

/** Reconstruct the target volume from the recorded writes (assumes zero fill). */
function reconstruct(native: NativeImagingApi & { writes: WrittenBlock[] }, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (const w of native.writes) {
    Buffer.from(w.data).copy(out, Number(w.offset));
  }
  return out;
}

describe('runCloneJob', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-clone-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeJob = (job: CloneJob): void => {
    fs.writeFileSync(jobPath, JSON.stringify(job));
  };

  const readResult = (): CloneJobResult => JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as CloneJobResult;

  it('copies selected partitions to the target disk', async () => {
    writeJob({
      type: 'clone',
      sourceDiskIndex: 0,
      blockSize: GR_CLUSTER,
      partitions: [
        { diskIndex: 0, partitionIndex: 0, size: VOLUME_SIZE, offset: 0, label: 'P0', readSource: 'physical' }
      ],
      targets: [{ partitionIndex: 0, diskIndex: 1, offset: 0, label: 'P0' }]
    });

    const vol = buildCanonicalNtfsVolumeData();
    const native = bufferNative(vol);
    await runCloneJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.targetsRestored).toBe(1);
    expect(result.blocksWritten).toBe(TOTAL_CLUSTERS);
    expect(result.snapshotsCreated).toBeUndefined();
    expect(result.warnings).toEqual([]);
    // Every byte of the source made it to the target.
    expect(reconstruct(native, VOLUME_SIZE).equals(vol)).toBe(true);
  });

  it('skips free-space blocks when usedBlocksOnly is set', async () => {
    writeJob({
      type: 'clone',
      sourceDiskIndex: 0,
      blockSize: GR_CLUSTER,
      usedBlocksOnly: true,
      partitions: [
        { diskIndex: 0, partitionIndex: 0, size: VOLUME_SIZE, offset: 0, label: 'P0', readSource: 'physical' }
      ],
      targets: [{ partitionIndex: 0, diskIndex: 1, offset: 0, label: 'P0' }]
    });

    const vol = buildCanonicalNtfsVolumeData(); // clusters 0..15 allocated
    const native = bufferNative(vol);
    await runCloneJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(16);
    expect(result.usedBlocksSkipped).toBe(TOTAL_CLUSTERS - 16);
    expect(native.writes).toHaveLength(16);
    // Only allocated blocks reach the target.
    for (let i = 0; i < 16; i++) {
      expect(native.writes[i].offset).toBe(BigInt(i * GR_CLUSTER));
    }
    // The copied region reconstructs to the source exactly (free clusters are
    // zeroes in the fixture, matching their untouched target state).
    expect(reconstruct(native, VOLUME_SIZE).equals(vol)).toBe(true);
  });

  it('cancels cleanly', async () => {
    writeJob({
      type: 'clone',
      sourceDiskIndex: 0,
      blockSize: GR_CLUSTER,
      partitions: [
        { diskIndex: 0, partitionIndex: 0, size: TOTAL_CLUSTERS * 10 * GR_CLUSTER, offset: 0, label: 'P0', readSource: 'physical' }
      ],
      targets: [{ partitionIndex: 0, diskIndex: 1, offset: 0, label: 'P0' }]
    });

    fs.writeFileSync(cancelPath, '1');
    const native = bufferNative(buildCanonicalNtfsVolumeData());
    await runCloneJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = readResult();
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
  });
});

describe('runBackupJob with usedBlocksOnly', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-ub-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    imagePath = path.join(dir, 'backup.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores only allocated blocks in the image', async () => {
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup',
        imagePath,
        blockSize: GR_CLUSTER,
        compressionLevel: 0,
        verificationEnabled: true,
        usedBlocksOnly: true,
        partitions: [
          { diskIndex: 0, partitionIndex: 0, size: VOLUME_SIZE, offset: 0, label: 'P0', readSource: 'physical' }
        ]
      })
    );

    const vol = buildCanonicalNtfsVolumeData();
    const native = bufferNative(vol);
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    expect(result.blocksWritten).toBe(16);
    expect(result.skippedBlocks).toBe(TOTAL_CLUSTERS - 16);
    expect(result.warnings).toEqual([]);

    const info = readImageInfo(imagePath);
    expect(info.partitions[0].blockCount).toBe(16);
    const indices = info.blocks.map((b) => b.blockIndex).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });
});