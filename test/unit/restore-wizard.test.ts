import { describe, it, expect, vi } from 'vitest';
import {
  runRestoreWizard,
  runBackupWizard,
  runRecoveryMenu,
  scanDrivesForImages,
  fmtBytes,
  type WizardIO,
  type WizardDeps,
  type WizardImage,
  type BackupWizardDeps
} from '../../src/main/cli/restore-wizard';

interface FakeIo {
  io: WizardIO;
  prompts: string[];
  output: string[];
  text(): string;
}

/** Scripted WizardIO: answers prompts from a fixed queue, records everything. */
function fakeIO(inputs: string[]): FakeIo {
  const prompts: string[] = [];
  const output: string[] = [];
  let next = 0;
  const io: WizardIO = {
    print: (line = '') => {
      output.push(line);
    },
    write: (text) => {
      output.push(text);
    },
    ask: async (prompt) => {
      prompts.push(prompt);
      if (next >= inputs.length) {
        throw new Error(`unexpected prompt: ${prompt}`);
      }
      return inputs[next++];
    },
    close: () => undefined
  };
  return { io, prompts, output, text: () => output.join('\n') };
}

const IMAGE_A: WizardImage = {
  path: 'D:\\backups\\sys.opbs',
  name: 'sys.opbs',
  size: 11_600_000_000,
  timestamp: Date.parse('2026-09-20T14:02:00Z'),
  incremental: false,
  encrypted: false
};

const IMAGE_B: WizardImage = {
  path: 'D:\\backups\\home.opbs',
  name: 'home.opbs',
  size: 45_000_000_000,
  timestamp: Date.parse('2026-08-02T09:11:00Z'),
  incremental: true,
  encrypted: false
};

function makeDeps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    scanDrives: vi.fn(async () => [IMAGE_A]),
    scanDir: vi.fn(async () => [IMAGE_A, IMAGE_B]),
    describeImage: vi.fn(async () => ({
      encrypted: false,
      incremental: false,
      totalSize: 11_600_000_000,
      partitions: [
        { index: 0, size: 104_857_600, fsType: 'fat32' },
        { index: 1, size: 11_495_142_400, fsType: 'ntfs' }
      ],
      sourceDisk: { model: 'Samsung SSD 980', serial: 'S123' }
    })),
    getDisks: vi.fn(async () => [
      { index: 0, size: 512_000_000_000, model: 'Samsung SSD 980', serial: 'S123' },
      { index: 1, size: 2_000_000_000_000, model: 'WDC WD20EZAZ', serial: 'W777' }
    ]),
    getPartitions: vi.fn(async () => [
      { partitionIndex: 0, size: 104_857_600, fsType: 'fat32', label: 'EFI' },
      { partitionIndex: 1, size: 511_000_000_000, fsType: 'ntfs', label: 'Windows' }
    ]),
    preflight: vi.fn(async (config) => ({
      imagePath: config.imagePath,
      verifyBeforeWrite: config.verifyBeforeWrite,
      targets: config.targetPartitions.map((partitionIndex) => ({
        diskIndex: config.targetDiskIndex,
        partitionIndex,
        offset: 0
      })),
      warnings: ['preflight warning shown']
    }) as never),
    renderPlan: vi.fn(
      () => 'Image: D:\\backups\\sys.opbs\nTarget partitions: disk 0\nwarning: preflight warning shown'
    ),
    execute: vi.fn(async () => ({ ok: true, bytesWritten: 11_600_000_000 })),
    ...overrides
  };
}

describe('runRestoreWizard', () => {
  it('restores the whole disk after image/disk selection, defaults and RESTORE confirm', async () => {
    const { io, text } = fakeIO(['1', '0', '', '', '', 'RESTORE']);
    const deps = makeDeps();

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledWith(
      {
        imagePath: 'D:\\backups\\sys.opbs',
        targetDiskIndex: 0,
        targetPartitions: [0, 1],
        verifyBeforeWrite: true,
        clearFreeSpace: true
      },
      expect.any(Function)
    );
    // Preflight runs before the restore is executed.
    expect((deps.preflight as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (deps.execute as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    );
    const out = text();
    expect(out).toContain('[1/4] Select the backup image');
    expect(out).toContain('[4/4] Review and confirm');
    expect(out).toContain('preflight warning shown');
    expect(out).toContain('Restore OK');
    // Disk 0 shares the image's source serial — the wizard must say so.
    expect(out).toContain('same physical disk the backup came from');
  });

  it('asks for a passphrase on encrypted images and passes it through', async () => {
    const { io } = fakeIO(['1', 'hunter2', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({
      describeImage: vi.fn(async () => ({
        encrypted: true,
        incremental: false,
        totalSize: 11_600_000_000,
        partitions: [{ index: 0, size: 11_600_000_000, fsType: 'ntfs' }]
      }))
    });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'hunter2', targetPartitions: [0] }),
      expect.any(Function)
    );
  });

  it('re-asks after an invalid disk number', async () => {
    const { io, prompts, text } = fakeIO(['1', '9', '1', 'w', 'n', '', 'RESTORE']);
    const deps = makeDeps();

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(prompts.filter((p) => p === 'Disk > ')).toHaveLength(2);
    expect(text()).toContain('Enter a disk number from this list');
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ targetDiskIndex: 1, verifyBeforeWrite: false }),
      expect.any(Function)
    );
  });

  it('supports selecting specific partitions and rejects invalid ones first', async () => {
    const { io, text } = fakeIO(['1', '1', 'p', '7', '0,1', '', '', 'RESTORE']);
    const deps = makeDeps();

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(text()).toContain('Invalid selection');
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ targetPartitions: [0, 1] }),
      expect.any(Function)
    );
  });

  it('cancels without executing when the confirmation is not RESTORE', async () => {
    const { io, text } = fakeIO(['1', '0', 'w', 'y', '', 'no']);
    const deps = makeDeps();

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(text()).toContain('Cancelled — nothing was written');
  });

  it('aborts cleanly when q is typed at the image prompt', async () => {
    const { io, text } = fakeIO(['q']);
    const deps = makeDeps();

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.scanDrives).toHaveBeenCalledTimes(1);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(text()).toContain('Aborted — nothing was written');
  });

  it('returns 1 and explains a failed preflight without executing', async () => {
    const { io, text } = fakeIO(['1', '0', 'w', '', '']);
    const deps = makeDeps({
      preflight: vi.fn(async () => {
        throw new Error('target disk too small');
      })
    });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(1);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(text()).toContain('Preflight FAILED: target disk too small');
    expect(text()).toContain('Nothing was written');
  });

  it('reports a failed restore result', async () => {
    const { io, text } = fakeIO(['1', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({
      execute: vi.fn(async () => ({ ok: false, error: 'write failed' }))
    });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(1);
    expect(text()).toContain('Restore FAILED: write failed');
  });

  it('treats a thrown execute as a failed restore', async () => {
    const { io, text } = fakeIO(['1', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({
      execute: vi.fn(async () => {
        throw new Error('disk vanished');
      })
    });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(1);
    expect(text()).toContain('Restore FAILED: disk vanished');
  });

  it('renders live progress from the execute callback', async () => {
    const { io, text } = fakeIO(['1', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({
      execute: vi.fn(async (_config, onProgress) => {
        onProgress({
          phase: 'writing',
          percent: 50,
          bytesDone: 5 * 1024 ** 3,
          totalBytes: 10 * 1024 ** 3,
          speed: 100 * 1024 ** 2,
          currentPartition: 'Partition 1',
          createdAt: 0
        });
        return { ok: true, bytesWritten: 5 * 1024 ** 3 };
      })
    });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain('[writing]  50%  5.0 GB/10.0 GB  100 MB/s  Partition 1');
  });

  it('accepts a typed .opbs path when the drive scan finds nothing', async () => {
    const { io } = fakeIO(['D:\\backups\\sys.opbs', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({ scanDrives: vi.fn(async () => []) });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.scanDir).not.toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: 'D:\\backups\\sys.opbs' }),
      expect.any(Function)
    );
  });

  it('accepts a typed Macrium .mrimgx path when the drive scan finds nothing', async () => {
    const { io } = fakeIO(['D:\\backups\\win.mrimgx', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({ scanDrives: vi.fn(async () => []) });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.scanDir).not.toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: 'D:\\backups\\win.mrimgx' }),
      expect.any(Function)
    );
  });

  it('lists a typed folder and lets the user pick one of its images', async () => {
    const { io } = fakeIO(['D:\\backups', '2', '1', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({ scanDrives: vi.fn(async () => []) });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.scanDir).toHaveBeenCalledWith('D:\\backups');
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: 'D:\\backups\\home.opbs', targetPartitions: [0, 1] }),
      expect.any(Function)
    );
  });

  it('rejects an unreadable image and re-prompts', async () => {
    const { io, text } = fakeIO(['1', '1', '0', 'w', '', '', 'RESTORE']);
    const describeCalls: string[] = [];
    let shouldFail = true;
    const deps = makeDeps({
      describeImage: async (imagePath) => {
        describeCalls.push(imagePath);
        if (shouldFail) {
          shouldFail = false;
          throw new Error('not an OPBS image');
        }
        return {
          encrypted: false,
          incremental: false,
          totalSize: 11_600_000_000,
          partitions: [
            { index: 0, size: 104_857_600, fsType: 'fat32' },
            { index: 1, size: 11_495_142_400, fsType: 'ntfs' }
          ],
          sourceDisk: { model: 'Samsung SSD 980', serial: 'S123' }
        };
      }
    });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(describeCalls).toHaveLength(2);
    expect(text()).toContain('Cannot use that image: not an OPBS image');
  });

  it('nudges a numeric answer when the scan found no images', async () => {
    const { io, text } = fakeIO(['3', 'D:\\backups\\sys.opbs', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps({ scanDrives: vi.fn(async () => []) });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(text()).toContain('No image list');
  });

  it('rescans when r is entered', async () => {
    const { io } = fakeIO(['r', '1', '0', 'w', '', '', 'RESTORE']);
    const deps = makeDeps();

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.scanDrives).toHaveBeenCalledTimes(2);
  });

  it('returns 1 when no disks are available', async () => {
    const { io, text } = fakeIO(['1']);
    const deps = makeDeps({ getDisks: vi.fn(async () => []) });

    const code = await runRestoreWizard(io, deps);

    expect(code).toBe(1);
    expect(text()).toContain('No disks found');
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

describe('scanDrivesForImages', () => {
  it('returns an empty list for drives that do not exist', () => {
    expect(scanDrivesForImages({ drives: ['?'] })).toEqual([]);
  });
});

describe('fmtBytes', () => {
  it('formats sizes', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(fmtBytes(-1)).toBe('0 B');
    expect(fmtBytes(Number.NaN)).toBe('0 B');
  });
});

describe('runRecoveryMenu', () => {
  it('offers restore, backup and a shell', async () => {
    const { io, text } = fakeIO(['2']);
    expect(await runRecoveryMenu(io)).toBe('backup');
    expect(text()).toContain('Back up this machine');
    expect(text()).toContain('Restore this machine');
    expect(text()).toContain('Command prompt');
  });

  it('accepts the short answers and re-prompts on nonsense', async () => {
    const nonsense = fakeIO(['what', 'r']);
    expect(await runRecoveryMenu(nonsense.io)).toBe('restore');
    expect(nonsense.text()).toContain('Enter 1, 2 or 3.');
    expect(await runRecoveryMenu(fakeIO(['3']).io)).toBe('shell');
    expect(await runRecoveryMenu(fakeIO(['q']).io)).toBe('shell');
  });
});

describe('runBackupWizard', () => {
  function makeBackupDeps(overrides: Partial<BackupWizardDeps> = {}): BackupWizardDeps {
    return {
      getDisks: vi.fn(async () => [
        { index: 0, size: 512_000_000_000, model: 'Samsung SSD 980', serial: 'S123' }
      ]),
      getPartitions: vi.fn(async () => [
        { partitionIndex: 0, size: 104_857_600, fsType: 'fat32', label: 'EFI' },
        { partitionIndex: 1, size: 511_000_000_000, fsType: 'ntfs', label: 'Windows' }
      ]),
      listDestinations: vi.fn(async () => [
        { path: 'E:\\', label: 'E: Image files', freeBytes: 1_400_000_000_000 }
      ]),
      execute: vi.fn(async () => ({ ok: true, bytesWritten: 46_000_000_000 })),
      ...overrides
    };
  }

  it('backs up the whole disk to the chosen destination on defaults', async () => {
    // source disk, mode (default = whole disk), destination, then three
    // option prompts left at their defaults, then BACKUP.
    const { io, text } = fakeIO(['0', '', '0', '', '', '', 'BACKUP']);
    const deps = makeBackupDeps();

    const code = await runBackupWizard(io, deps);

    expect(code).toBe(0);
    expect(deps.execute).toHaveBeenCalledWith(
      {
        sourceDiskIndex: 0,
        sourcePartitions: [],
        destinationPath: 'E:\\',
        compressionLevel: 1,
        verificationEnabled: true,
        usedBlocksOnly: true
      },
      expect.any(Function)
    );
    expect(text()).toContain('Backup complete');
    expect(text()).toContain('The image is in E:\\');
  });

  it('writes nothing when the confirmation is not BACKUP', async () => {
    const { io, text } = fakeIO(['0', '', '0', '', '', '', 'nope']);
    const deps = makeBackupDeps();

    expect(await runBackupWizard(io, deps)).toBe(1);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(text()).toContain('nothing was written');
  });

  it('re-prompts for partitions the disk does not have', async () => {
    const { io, text } = fakeIO(['0', 'p', '7', '0,1', '0', '', '', '', 'BACKUP']);
    const deps = makeBackupDeps();

    expect(await runBackupWizard(io, deps)).toBe(0);
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePartitions: [0, 1] }),
      expect.any(Function)
    );
    expect(text()).toContain('Invalid selection');
  });

  it('reports a failed backup instead of claiming success', async () => {
    const { io, text } = fakeIO(['0', '', '0', '', '', '', 'BACKUP']);
    const deps = makeBackupDeps({ execute: vi.fn(async () => ({ ok: false, error: 'disk full' })) });

    expect(await runBackupWizard(io, deps)).toBe(1);
    expect(text()).toContain('Backup FAILED: disk full');
    expect(text()).not.toContain('Backup complete');
  });

  it('says so when there is nowhere to write', async () => {
    const { io, text } = fakeIO(['0', '']);
    const deps = makeBackupDeps({ listDestinations: vi.fn(async () => []) });

    expect(await runBackupWizard(io, deps)).toBe(1);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(text()).toContain('No destination volume found');
  });
});
