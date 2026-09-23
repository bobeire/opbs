import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBackupJob } from '../../src/main/helper/job-runner';
import {
  verifyImage,
  readImageInfo,
  clearImageInfoCache,
  FLAG_MULTI_VOLUME,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE
} from '../../src/main/imaging/image-format';
import { ImagingJob, NativeImagingApi, JobResult } from '../../src/main/imaging/imaging-job';

/**
 * ENOSPC → multi-volume switch. fs.writeSync is non-configurable on the real
 * module, so 'fs' is mocked. Frame writes (past header/table, not index
 * records) honour `enospcControl`:
 *  - mode 'once': fail the Nth frame write after a partial payload lands
 *  - mode 'always': fail every frame write (destination truly full)
 *
 * Must be hoisted: vi.mock runs before module imports.
 */
const enospcControl = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'once' | 'always',
  failOnFrameWrite: 0,
  frameWrites: 0,
  injected: false
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // HEADER_SIZE (256) + one PARTITION_TABLE_ENTRY_SIZE (64)
  const dataOffset = 256 + 64;
  const isFrameWrite = (position: unknown, length: unknown): boolean =>
    typeof position === 'number' &&
    position >= dataOffset &&
    typeof length === 'number' &&
    length > 64 &&
    length !== 8 &&
    length !== 32;

  const writeSync = ((...args: Parameters<typeof actual.writeSync>) => {
    const position = args[4];
    const length = args[3];
    if (enospcControl.mode === 'always' && isFrameWrite(position, length)) {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    }
    if (
      enospcControl.mode === 'once' &&
      !enospcControl.injected &&
      isFrameWrite(position, length)
    ) {
      enospcControl.frameWrites += 1;
      if (enospcControl.frameWrites === enospcControl.failOnFrameWrite) {
        enospcControl.injected = true;
        try {
          actual.writeSync(args[0], args[1], args[2], 24, position);
        } catch {
          /* best-effort partial frame */
        }
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
    }
    return actual.writeSync(...args);
  }) as typeof actual.writeSync;

  return {
    ...actual,
    writeSync,
    default: { ...actual, writeSync }
  };
});

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
    createSnapshot: vi.fn(() => ({ id: 'snap', devicePath: '\\\\.\\ShadowCopy1' })),
    deleteSnapshot: vi.fn(() => true),
    getPhysicalDrivePath: vi.fn((diskIndex: number) => `\\\\.\\PhysicalDrive${diskIndex}`),
    writeBlocks: vi.fn(() => 0),
    readBlocks: vi.fn((_device: string, _offset: bigint, length: bigint): Buffer =>
      blockPattern(1, Number(length))
    )
  };
}

function fourBlockJob(imagePath: string, verificationEnabled: boolean): ImagingJob {
  return {
    type: 'backup',
    imagePath,
    blockSize: BLOCK,
    compressionLevel: 0,
    verificationEnabled,
    partitions: [
      {
        diskIndex: 0,
        partitionIndex: 2,
        size: BLOCK * 4,
        offset: 122683392,
        label: 'Partition 2',
        readSource: 'physical'
      }
    ]
  };
}

describe('runBackupJob ENOSPC → multi-volume', () => {
  let dir: string;
  let jobPath: string;
  let resultPath: string;
  let progressPath: string;
  let cancelPath: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-enospc-'));
    jobPath = path.join(dir, 'job.json');
    resultPath = path.join(dir, 'result.json');
    progressPath = path.join(dir, 'progress.json');
    cancelPath = path.join(dir, 'cancel');
    imagePath = path.join(dir, 'backup.opbs');
    enospcControl.mode = 'off';
    enospcControl.failOnFrameWrite = 0;
    enospcControl.frameWrites = 0;
    enospcControl.injected = false;
    clearImageInfoCache();
  });

  afterEach(() => {
    enospcControl.mode = 'off';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rolls to volume .001, drops the partial frame, and verifies cleanly', async () => {
    fs.writeFileSync(jobPath, JSON.stringify(fourBlockJob(imagePath, true)));

    enospcControl.mode = 'once';
    enospcControl.failOnFrameWrite = 2;
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createMockNative());

    expect(enospcControl.injected).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(imagePath)).toBe(true);
    expect(fs.existsSync(`${imagePath}.001`)).toBe(true);

    clearImageInfoCache();
    const info = readImageInfo(imagePath);
    expect(info.header.flags & FLAG_MULTI_VOLUME).toBeTruthy();

    const verified = await verifyImage(imagePath);
    expect(verified.error).toBeUndefined();
    expect(verified.ok).toBe(true);
    expect(verified.blocksVerified).toBe(4);
  });

  it('reports a clear error when the next volume is also full', async () => {
    fs.writeFileSync(jobPath, JSON.stringify(fourBlockJob(imagePath, false)));

    enospcControl.mode = 'always';
    await runBackupJob(jobPath, resultPath, progressPath, cancelPath, createMockNative());

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/out of space/i);
  });
});
