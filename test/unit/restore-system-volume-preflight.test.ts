import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RestoreCoordinator } from '../../src/main/imaging/restore-engine';
import { RestoreManager } from '../../src/main/restore/manager';

// The coordinator is faked below; only the image summary needs to look real.
vi.mock('../../src/main/imaging/restore-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/imaging/restore-engine')>();
  return {
    ...actual,
    summarizeImage: () => ({
      totalSize: 8192,
      partitions: [{ index: 0, size: 8192 }],
      encrypted: false,
      incremental: false
    })
  };
});

// Preflight only needs to know the image's volume is not BitLocker-locked.
vi.mock('../../src/main/utils/bitlocker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utils/bitlocker')>();
  return { ...actual, listBitlockerStatus: async () => ({ ok: false, volumes: [] }) };
});

const SYSTEM_OFFSET = 1048576;

function fakeManager(options: { targetOffset: number }) {
  const buildJobCalls: Array<unknown> = [];
  const coordinator: RestoreCoordinator = {
    buildJob: async (_config, opts) => {
      buildJobCalls.push(opts);
      return {
        type: 'restore',
        targets: [{ partitionIndex: 0, offset: options.targetOffset, size: 8192 }],
        warnings: []
      } as never;
    },
    runRestore: async () => ({ ok: true }) as never,
    cancel: async () => undefined
  };

  const enumerator = {
    getDisks: async () => [
      {
        index: 0,
        model: 'SYSDISK',
        size: 1_000_000_000,
        serial: 'SYS',
        partitions: [
          {
            partitionIndex: 1,
            offset: SYSTEM_OFFSET,
            size: 8192,
            isSystem: true,
            isBoot: true,
            driveLetter: 'C:'
          }
        ]
      }
    ],
    getPartitions: async () => [],
    isDiskBlank: () => false,
    getPhysicalDrivePath: (i: number) => `\\\\.\\PhysicalDrive${i}`,
    getVolumePath: async () => null
  };

  return {
    manager: new RestoreManager(coordinator, enumerator as never),
    buildJobCalls
  };
}

describe('RestoreManager.preflight — running system volume', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-sysvol-preflight-'));
    imagePath = path.join(dir, 'image.opbs');
    // validateConfig only checks existence; the coordinator is faked.
    fs.writeFileSync(imagePath, 'stub');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports the condition instead of refusing, so the UI can offer recovery', async () => {
    // Field report 2026-11-01: buildJob's refusal preempted this preflight, so
    // `targetsIncludeSystemVolume` never reached the renderer and the app's
    // own "restore after reboot into recovery" panel was unreachable.
    const { manager, buildJobCalls } = fakeManager({ targetOffset: SYSTEM_OFFSET });

    const result = await manager.preflight({
      imagePath,
      targetDiskIndex: 0,
      targetPartitions: [0]
    } as never);

    expect(result.ok).toBe(true);
    expect(result.targetsIncludeSystemVolume).toBe(true);
    expect(result.targetIsSystemDisk).toBe(true);
    // The dry run explicitly asks for the plan; execution does not.
    expect(buildJobCalls).toEqual([{ allowRunningSystemVolume: true }]);
  });

  it('does not flag a data partition that merely shares the system disk', async () => {
    const { manager } = fakeManager({ targetOffset: 5_242_880 });

    const result = await manager.preflight({
      imagePath,
      targetDiskIndex: 0,
      targetPartitions: [0]
    } as never);

    expect(result.ok).toBe(true);
    expect(result.targetsIncludeSystemVolume).toBe(false);
    // The disk still holds Windows, so a reboot after restoring is expected.
    expect(result.targetIsSystemDisk).toBe(true);
  });
});
