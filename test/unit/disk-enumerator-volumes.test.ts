import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args)
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
    execFileSync.mockReturnValue(psPartition({ DriveLetter: String.fromCharCode(0) }));

    const partitions = await enumerator.getPartitions(0);

    expect(partitions[0].driveLetter).toBeNull();
  });

  it('keeps a real drive letter and volume details', async () => {
    execFileSync.mockReturnValue(
      psPartition({ DriveLetter: 'C', FileSystem: 'NTFS', Label: 'Windows', IsBoot: true })
    );

    const partitions = await enumerator.getPartitions(0);

    expect(partitions[0].driveLetter).toBe('C');
    expect(partitions[0].fsType).toBe('NTFS');
    expect(partitions[0].label).toBe('Windows');
    expect(partitions[0].isBoot).toBe(true);
  });

  it('treats an empty letter as null', async () => {
    execFileSync.mockReturnValue(psPartition({ DriveLetter: '' }));

    const partitions = await enumerator.getPartitions(0);

    expect(partitions[0].driveLetter).toBeNull();
  });
});
