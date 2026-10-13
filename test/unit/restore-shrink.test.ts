import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBackupJob, runRestoreJob } from '../../src/main/helper/job-runner';
import { RestoreEngine } from '../../src/main/imaging/restore-engine';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';
import {
  ImagingJob,
  RestoreJob,
  RestoreJobResult,
  NativeImagingApi
} from '../../src/main/imaging/imaging-job';
import {
  buildShrinkVolumeData,
  SK_CLUSTER,
  SK_TARGET_CLUSTERS,
  SK_TARGET_SECTORS,
  SK_MIN_TARGET_CLUSTERS,
  SK_USER_LCN,
  SK_USER_CLUSTERS,
  SK_USER_RECORD,
  clusterPattern
} from '../helpers/ntfs-shrink-fixture';

const BLOCK = 16 * 1024;

function createBackupNative(vol: Buffer): NativeImagingApi {
  return {
    createSnapshot: vi.fn(() => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' })),
    deleteSnapshot: vi.fn(() => true),
    getPhysicalDrivePath: vi.fn((i) => `\\\\.\\PhysicalDrive${i}`),
    writeBlocks: vi.fn(() => 0),
    readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) =>
      vol.subarray(Number(offset), Number(offset) + Number(length))
    )
  };
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
    readBlocks: vi.fn((_device: string, offset: bigint, length: bigint) => Buffer.alloc(Number(length), 0))
  };
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

/** Captured writeBlocks calls as [devicePath, offset, data]. */
function writeCalls(native: NativeImagingApi): Array<[string, bigint, Buffer]> {
  return (native.writeBlocks as unknown as { mock: { calls: Array<[string, bigint, Buffer]> } }).mock.calls;
}

describe('restore shrink-on-restore (Phase 1)', () => {
  let dir: string;
  let imagePath: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let vol: Buffer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-restore-shrink-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    imagePath = path.join(dir, 'shrink.opbs');

    vol = buildShrinkVolumeData();
    const backupJob: ImagingJob = {
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
    fs.writeFileSync(jobPath, JSON.stringify(backupJob));
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createBackupNative(vol));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attaches shrinkInfo for a feasible shrink target', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      imagePath,
      targetDiskIndex: 1,
      targetPartitions: [0],
      targetLayout: [{ partitionIndex: 0, offset: 1048576, size: SK_TARGET_CLUSTERS * SK_CLUSTER }],
      acknowledgeLayout: true
    });

    expect(job.shrinkInfo).toBeDefined();
    expect(job.shrinkInfo!.length).toBe(1);
    expect(job.shrinkInfo![0].targetBytes).toBe(SK_TARGET_CLUSTERS * SK_CLUSTER);
    expect(job.shrinkInfo![0].minTargetClusters).toBe(SK_MIN_TARGET_CLUSTERS);
    expect(job.shrinkInfo![0].usedClusters).toBe(12 + 1 + 1 + SK_USER_CLUSTERS); // $MFT + $Bitmap + $MFTMirr + user
  });

  it('refuses a shrink target below the minimum size', async () => {
    const engine = new RestoreEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        imagePath,
        targetDiskIndex: 1,
        targetPartitions: [0],
        targetLayout: [{ partitionIndex: 0, offset: 0, size: 128 * SK_CLUSTER }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/minimum shrink target is \d+ bytes/);
  });

  it('shrinks the filesystem, relocates tail data, and patches boot/bitmap/MFT', async () => {
    const targetOffset = 1048576;
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [
          {
            partitionIndex: 0,
            diskIndex: 3,
            offset: targetOffset,
            size: SK_TARGET_CLUSTERS * SK_CLUSTER,
            label: 'Volume'
          }
        ]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((w) => new RegExp(`Shrank filesystem .* to ${SK_TARGET_CLUSTERS * SK_CLUSTER} bytes`).test(w))
    ).toBe(true);

    const calls = writeCalls(native);

    // Boot sector: new total sector count written at the partition start.
    const bootCall = calls.find(([, offset, data]) => offset === BigInt(targetOffset) && data.length === 512);
    expect(bootCall).toBeDefined();
    expect(bootCall![2].readBigUInt64LE(0x28)).toBe(BigInt(SK_TARGET_SECTORS));

    // Backup boot sector written at the new last sector.
    const backupBootCall = calls.find(
      ([, offset, data]) =>
        offset === BigInt(targetOffset + (SK_TARGET_SECTORS - 1) * 512) && data.length === 512
    );
    expect(backupBootCall).toBeDefined();
    expect(backupBootCall![2].readBigUInt64LE(0x28)).toBe(BigInt(SK_TARGET_SECTORS));

    // The tail user data (record ${SK_USER_RECORD} at LCN ${SK_USER_LCN}) is relocated to
    // the free LCN 17 that lies below the new boundary.
    const relocated = Buffer.concat(
      Array.from({ length: SK_USER_CLUSTERS }, (_v, k) => clusterPattern(SK_USER_LCN + k))
    );
    const relocateCall = calls.find(
      ([, offset, data]) => offset === BigInt(targetOffset + 17 * SK_CLUSTER) && data.equals(relocated)
    );
    expect(relocateCall).toBeDefined();
    expect(relocateCall![2].length).toBe(SK_USER_CLUSTERS * SK_CLUSTER);

    // The tail is NOT written at its original (now out-of-bounds) location.
    const tailAtOriginal = calls.find(
      ([, offset, data]) => offset === BigInt(targetOffset + SK_USER_LCN * SK_CLUSTER) && data.equals(relocated)
    );
    expect(tailAtOriginal).toBeUndefined();
  });

  it('writes the relocated data run into the MFT record patch', async () => {
    const targetOffset = 2097152;
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'restore',
        imagePath,
        verifyBeforeWrite: false,
        targets: [
          {
            partitionIndex: 0,
            diskIndex: 3,
            offset: targetOffset,
            size: SK_TARGET_CLUSTERS * SK_CLUSTER,
            label: 'Volume'
          }
        ]
      } as RestoreJob)
    );

    const native = createMockNative();
    await runRestoreJob(jobPath, resultPath, progressPath, cancelPath, native);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RestoreJobResult;
    expect(result.ok).toBe(true);

    const calls = writeCalls(native);
    // Record ${SK_USER_RECORD} lives at MFT file offset ${SK_USER_RECORD * 1024}; the MFT starts at
    // LCN 4, so its on-disk location is 4 * ${SK_CLUSTER} + record offset. The patched
    // record must point its $DATA run at the new LCN 17.
    const recordFileOffset = SK_USER_RECORD * 1024;
    const recordPartitionOffset = 4 * SK_CLUSTER + recordFileOffset;
    const recordCall = calls.find(
      ([, offset, data]) => offset === BigInt(targetOffset + recordPartitionOffset) && data.length === 1024
    );
    expect(recordCall).toBeDefined();
    const patched = recordCall![2];
    // Walk attributes to the unnamed $DATA and confirm the relocated LCN.
    let pos = patched.readUInt16LE(0x14);
    let found = false;
    while (pos + 8 <= patched.length) {
      const type = patched.readUInt32LE(pos);
      if (type === 0xffffffff) break;
      const length = patched.readUInt32LE(pos + 4);
      if (length < 8) break;
      if (type === 0x80 && patched.readUInt8(pos + 8) !== 0) {
        // Non-resident $DATA: the mapping-pairs offset (relative to the
        // attribute) leads to a run whose header encodes 1-byte length and
        // 1-byte LCN, so the relocated LCN sits two bytes in.
        const runStart = patched.readUInt16LE(pos + 0x20);
        expect(patched[pos + runStart] & 0x0f).toBe(1);
        expect(patched[pos + runStart] >> 4).toBe(1);
        expect(patched[pos + runStart + 1]).toBe(SK_USER_CLUSTERS);
        expect(patched[pos + runStart + 2]).toBe(17);
        found = true;
        break;
      }
      pos += length;
    }
    expect(found).toBe(true);
  });
});
