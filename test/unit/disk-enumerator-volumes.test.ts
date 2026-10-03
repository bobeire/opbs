import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  execFileSync: vi.fn()
}));

import { DiskEnumerator, NativeDiskApi } from '../../src/main/utils/disk-enumerator';

function createMockNative(): NativeDiskApi {
  return {
    getDisks: vi.fn(),
    getPartitions: vi.fn(),
    getPhysicalDrivePath: vi.fn(),
    getVolumePath: vi.fn()
  };
}

function psPartition(overrides: Record<string, unknown>): string {
  return JSON.stringify([
    {
      PartitionNumber: 3,
      DriveLetter: '',
      FileSystem: '',
      Label: '',
      Used: 0,
      IsSystem: false,
      IsBoot: false,
      ...overrides
    }
  ]);
}

/** The async disk-enumerator invokes execFile(cmd, args, opts, callback). */
function mockPsOutput(json: string): void {
  execFileMock.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, json);
    }
  );
}

describe('DiskEnumerator queryVolumes enrichment', () => {
  let mockNative: NativeDiskApi;
  let enumerator: DiskEnumerator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNative = createMockNative();
    enumerator = new DiskEnumerator(mockNative);
    (mockNative.getPartitions as any).mockReturnValue([
      { diskIndex: 0, partitionIndex: 2, offset: 122683392, size: 998686136832, type: 7 }
    ]);
  });

  it('normalizes the PowerShell NUL letter of a letterless partition to null', async () => {
    // Get-Partition serializes an absent DriveLetter as [char]0, which
    // ConvertTo-Json emits as a NUL character — a truthy string in JS that
    // would wrongly mark the volume as lettered (VSS snapshot path).
    mockPsOutput(psPartition({ DriveLetter: String.fromCharCode(0) }));

    const partitions = await enumerator.getPartitions(0);

    expect(partitions[0].driveLetter).toBeNull();
  });

  it('keeps a real drive letter and volume details', async () => {
    mockPsOutput(psPartition({ DriveLetter: 'C', FileSystem: 'NTFS', Label: 'Windows', IsBoot: true }));

    const partitions = await enumerator.getPartitions(0);

    expect(partitions[0].driveLetter).toBe('C');
    expect(partitions[0].fsType).toBe('NTFS');
    expect(partitions[0].label).toBe('Windows');
    expect(partitions[0].isBoot).toBe(true);
  });

  it('treats an empty letter as null', async () => {
    mockPsOutput(psPartition({ DriveLetter: '' }));

    const partitions = await enumerator.getPartitions(0);

    expect(partitions[0].driveLetter).toBeNull();
  });

  it('still returns partitions when PowerShell fails', async () => {
    execFileMock.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('powershell unavailable'));
      }
    );

    const partitions = await enumerator.getPartitions(0);

    expect(partitions).toHaveLength(1);
    expect(partitions[0].driveLetter).toBeNull();
    expect(partitions[0].fsType).toBe('Unknown');
  });
});
