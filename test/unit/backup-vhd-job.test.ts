import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBackupVhdJob } from '../../src/main/helper/backup-vhd-job';

const captured = vi.hoisted(() => ({
  builtJob: null as Record<string, unknown> | null,
  runBackupJobCalls: [] as unknown[][]
}));

const disks = vi.hoisted(() => [{ index: 7, size: 2 * 1024 ** 3 }]);

vi.mock('../../src/main/utils/native-loader', () => ({
  loadNative: vi.fn(() => ({ getDisks: vi.fn(() => disks) }))
}));

vi.mock('../../src/main/utils/virtual-disk', () => ({
  attachVirtualDiskFile: vi.fn(),
  detachVirtualDiskFile: vi.fn(),
  readVirtualDiskInfo: vi.fn(() => ({
    virtualSize: 2 * 1024 ** 3,
    physicalSize: 2 * 1024 ** 3,
    blockSize: 1024 * 1024,
    sectorSize: 512,
    isLoaded: false
  })),
  virtualDiskPhysicalPath: vi.fn(() => '\\\\.\\PhysicalDrive7'),
  parsePhysicalDriveIndex: vi.fn((p: string) => {
    const m = /PhysicalDrive(\d+)$/i.exec(p ?? '');
    return m ? Number(m[1]) : null;
  }),
  discoverAttachedDiskIndex: vi.fn(() => null),
  isVirtualDiskPath: vi.fn((p: string) => /\.vhdx?$/i.test(p ?? ''))
}));

vi.mock('../../src/main/utils/disk-enumerator', () => ({
  DiskEnumerator: vi.fn(() => ({
    getDisks: vi.fn(async () => disks),
    getPartitions: vi.fn(async (diskIndex: number) =>
      diskIndex === 7
        ? [
            {
              diskIndex: 7,
              partitionIndex: 0,
              offset: 1048576,
              size: 100 * 1024 * 1024,
              type: 7,
              label: 'Partition 0',
              driveLetter: null
            }
          ]
        : []
    ),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async () => null)
  }))
}));

vi.mock('../../src/main/helper/job-runner', () => ({
  runBackupJob: vi.fn(async (jobPath: string, resultPath: string) => {
    captured.builtJob = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
    captured.runBackupJobCalls.push([jobPath, resultPath]);
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: true,
        imagePath: (captured.builtJob as { imagePath?: string }).imagePath,
        totalBytes: 0,
        bytesWritten: 0,
        durationMs: 1,
        blocksWritten: 0,
        snapshotsCreated: 0,
        verifiedBlocks: 0,
        warnings: []
      })
    );
  })
}));

import {
  attachVirtualDiskFile,
  detachVirtualDiskFile
} from '../../src/main/utils/virtual-disk';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';
import { runBackupJob } from '../../src/main/helper/job-runner';

describe('runBackupVhdJob', () => {
  let dir: string;
  let vhdPath: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-backup-vhd-'));
    vhdPath = path.join(dir, 'source.vhdx');
    fs.writeFileSync(vhdPath, 'placeholder');
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    captured.builtJob = null;
    captured.runBackupJobCalls = [];
    vi.mocked(attachVirtualDiskFile).mockClear();
    vi.mocked(detachVirtualDiskFile).mockClear();
    vi.mocked(runBackupJob).mockClear();
    vi.mocked(DiskEnumerator).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeVhdJob = (overrides: Record<string, unknown> = {}): void => {
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        type: 'backup-vhd',
        config: {
          sourceDiskIndex: -1,
          sourcePartitions: [],
          sourceVirtualDisk: vhdPath,
          destinationPath: dir,
          compressionLevel: 0,
          verificationEnabled: false,
          ...overrides
        }
      })
    );
  };

  it('attaches read-only, injects the disk index, builds and runs, then detaches', async () => {
    writeVhdJob();
    await runBackupVhdJob(jobPath, resultPath, progressPath, cancelPath);

    expect(attachVirtualDiskFile).toHaveBeenCalledWith(vhdPath, { readOnly: true });
    // The discovered index (7) was injected before buildJob enumerated it.
    const enumerator = vi.mocked(DiskEnumerator).mock.results[0].value as unknown as {
      getPartitions: ReturnType<typeof vi.fn>;
    };
    expect(enumerator.getPartitions).toHaveBeenCalledWith(7);

    expect(captured.builtJob).not.toBeNull();
    expect(captured.builtJob!.type).toBe('backup');
    expect((captured.builtJob as { partitions: unknown[] }).partitions).toHaveLength(1);
    expect(String((captured.builtJob as { imagePath: string }).imagePath)).toMatch(/opbs-disk7-.*\.opbs$/);

    expect(runBackupJob).toHaveBeenCalledTimes(1);
    expect(detachVirtualDiskFile).toHaveBeenCalledWith(vhdPath);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.ok).toBe(true);
  });

  it('fails without attaching when the source file is missing', async () => {
    writeVhdJob({ sourceVirtualDisk: path.join(dir, 'missing.vhdx') });
    await runBackupVhdJob(jobPath, resultPath, progressPath, cancelPath);

    expect(attachVirtualDiskFile).not.toHaveBeenCalled();
    expect(runBackupJob).not.toHaveBeenCalled();
    expect(detachVirtualDiskFile).not.toHaveBeenCalled();

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Source virtual disk not found/);
  });

  it('rejects a path that is not a VHD/VHDX file', async () => {
    writeVhdJob({ sourceVirtualDisk: path.join(dir, 'disk.img') });
    await runBackupVhdJob(jobPath, resultPath, progressPath, cancelPath);

    expect(attachVirtualDiskFile).not.toHaveBeenCalled();
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a \.vhd\/\.vhdx file/);
  });

  it('honors a cancel file before attaching', async () => {
    writeVhdJob();
    fs.writeFileSync(cancelPath, '');
    await runBackupVhdJob(jobPath, resultPath, progressPath, cancelPath);

    expect(attachVirtualDiskFile).not.toHaveBeenCalled();
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
  });
});
