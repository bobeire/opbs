import { describe, it, expect } from 'vitest';
import {
  virtualDiskFormatFromPath,
  isVirtualDiskPath,
  roundToSector,
  alignUp,
  validateVirtualSize,
  defaultVirtualSizeBytes,
  defaultVirtualSizeGb,
  discoverAttachedDiskIndex,
  parsePhysicalDriveIndex,
  VHD_MAX_BYTES,
  VHDX_MAX_BYTES,
  VIRTUAL_DISK_MIN_BYTES
} from '../../src/main/utils/virtual-disk';

const MiB = 1048576;
const GiB = 1024 ** 3;

describe('virtualDiskFormatFromPath', () => {
  it('detects .vhd', () => {
    expect(virtualDiskFormatFromPath('D:\\VMs\\target.vhd')).toBe('vhd');
    expect(virtualDiskFormatFromPath('D:\\VMs\\target.VHD')).toBe('vhd');
  });

  it('detects .vhdx', () => {
    expect(virtualDiskFormatFromPath('D:\\VMs\\target.vhdx')).toBe('vhdx');
    expect(virtualDiskFormatFromPath('D:\\VMs\\target.Vhdx')).toBe('vhdx');
  });

  it('falls back to vhd for unknown extensions', () => {
    expect(virtualDiskFormatFromPath('D:\\VMs\\target.vhdx.bak')).toBe('vhd');
    expect(virtualDiskFormatFromPath('')).toBe('vhd');
  });
});

describe('isVirtualDiskPath', () => {
  it('accepts .vhd and .vhdx only', () => {
    expect(isVirtualDiskPath('a.vhd')).toBe(true);
    expect(isVirtualDiskPath('a.VHDX')).toBe(true);
    expect(isVirtualDiskPath('a.vhdx.tmp')).toBe(false);
    expect(isVirtualDiskPath('avhd')).toBe(false);
    expect(isVirtualDiskPath('a.vh')).toBe(false);
  });
});

describe('roundToSector / alignUp', () => {
  it('rounds byte counts up to whole sectors', () => {
    expect(roundToSector(0)).toBe(0);
    expect(roundToSector(512)).toBe(512);
    expect(roundToSector(513)).toBe(1024);
    expect(roundToSector(1, 4096)).toBe(4096);
  });

  it('aligns to arbitrary alignments', () => {
    expect(alignUp(0, MiB)).toBe(0);
    expect(alignUp(MiB, MiB)).toBe(MiB);
    expect(alignUp(MiB + 1, MiB)).toBe(2 * MiB);
  });
});

describe('validateVirtualSize', () => {
  it('accepts sane sizes', () => {
    expect(validateVirtualSize('vhd', 64 * GiB)).toBeNull();
    expect(validateVirtualSize('vhdx', 64 * GiB)).toBeNull();
    expect(validateVirtualSize('vhd', VHD_MAX_BYTES)).toBeNull();
    expect(validateVirtualSize('vhdx', VHDX_MAX_BYTES)).toBeNull();
  });

  it('rejects non-positive and sub-minimum sizes', () => {
    expect(validateVirtualSize('vhd', 0)).toMatch(/positive/);
    expect(validateVirtualSize('vhd', NaN)).toMatch(/positive/);
    expect(validateVirtualSize('vhd', VIRTUAL_DISK_MIN_BYTES - 1)).toMatch(/at least/);
  });

  it('caps classic VHD at 2040 GB and suggests vhdx', () => {
    expect(validateVirtualSize('vhd', VHD_MAX_BYTES + 1)).toMatch(/vhdx/);
    expect(validateVirtualSize('vhdx', VHD_MAX_BYTES + 1)).toBeNull();
  });
});

describe('defaultVirtualSizeBytes', () => {
  it('covers the furthest partition end with 1 MiB headroom, MiB-aligned', () => {
    const size = defaultVirtualSizeBytes([
      { offsetOnDisk: 0, size: 16 * MiB },
      { offsetOnDisk: MiB, size: 40 * GiB }
    ]);
    // end = 1 MiB + 40 GiB → +1 MiB headroom, already MiB-aligned
    expect(size).toBe(MiB + 40 * GiB + MiB);
  });

  it('rounds non-aligned ends up to the next MiB', () => {
    const size = defaultVirtualSizeBytes([{ offsetOnDisk: 100, size: 1000 }]);
    // end = 1100 → 1 MiB + 1100 → aligned to 2 MiB? (1 MiB headroom then align)
    expect(size).toBe(2 * MiB);
    expect(size % MiB).toBe(0);
    expect(size).toBeGreaterThan(1100);
  });

  it('returns 0 for an empty partition list', () => {
    expect(defaultVirtualSizeBytes([])).toBe(0);
  });

  it('rounds up to whole GiB for the wizard input', () => {
    expect(defaultVirtualSizeGb([{ offsetOnDisk: 0, size: GiB + 1 }])).toBe(2);
    expect(defaultVirtualSizeGb([])).toBe(1);
  });
});

describe('discoverAttachedDiskIndex', () => {
  const before = [
    { index: 0, size: 512 * GiB },
    { index: 1, size: 100 * GiB }
  ];

  it('finds a newly appeared disk with an exact size match', () => {
    const after = [...before, { index: 2, size: 64 * GiB }];
    expect(discoverAttachedDiskIndex(before, after, 64 * GiB)).toBe(2);
  });

  it('returns null when nothing new appeared', () => {
    expect(discoverAttachedDiskIndex(before, before, 64 * GiB)).toBeNull();
  });

  it('never matches pre-existing disks even with a matching size', () => {
    // A 512 GiB physical disk already exists — a failed attach that finds no
    // new disk must NOT resolve to it.
    expect(discoverAttachedDiskIndex(before, before, 512 * GiB)).toBeNull();
  });

  it('allows a small tolerance for one new disk only', () => {
    const after = [...before, { index: 3, size: 64 * GiB + 1024 }];
    expect(discoverAttachedDiskIndex(before, after, 64 * GiB)).toBe(3);
  });

  it('is ambiguous when several new disks share the size', () => {
    const after = [...before, { index: 2, size: 64 * GiB }, { index: 3, size: 64 * GiB }];
    expect(discoverAttachedDiskIndex(before, after, 64 * GiB)).toBeNull();
  });

  it('is ambiguous when several new disks are all within tolerance', () => {
    const after = [
      ...before,
      { index: 2, size: 64 * GiB + 512 },
      { index: 3, size: 64 * GiB + 1024 }
    ];
    expect(discoverAttachedDiskIndex(before, after, 64 * GiB)).toBeNull();
  });

  it('treats an index reused with a different size as a new disk', () => {
    const after = [
      { index: 0, size: 512 * GiB },
      { index: 1, size: 64 * GiB } // index 1 changed size → new identity
    ];
    expect(discoverAttachedDiskIndex(before, after, 64 * GiB)).toBe(1);
  });
});

describe('parsePhysicalDriveIndex', () => {
  it('parses the native physical path', () => {
    expect(parsePhysicalDriveIndex('\\\\.\\PhysicalDrive5')).toBe(5);
    expect(parsePhysicalDriveIndex('PhysicalDrive0')).toBe(0);
    expect(parsePhysicalDriveIndex('\\\\.\\PhysicalDrive12')).toBe(12);
  });

  it('returns null for anything else', () => {
    expect(parsePhysicalDriveIndex('')).toBeNull();
    expect(parsePhysicalDriveIndex('C:\\foo')).toBeNull();
    expect(parsePhysicalDriveIndex('PhysicalDriveX')).toBeNull();
    expect(parsePhysicalDriveIndex(undefined as unknown as string)).toBeNull();
  });
});
