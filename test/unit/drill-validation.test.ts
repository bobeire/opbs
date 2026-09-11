import { describe, it, expect } from 'vitest';
import { validateRestoredFilesystem } from '../../src/main/imaging/drill-validation';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER, GR_SPC } from '../helpers/ntfs-resize-fixture';

function fakeNative(deviceData: Buffer): {
  readBlocks: (devicePath: string, offset: bigint, length: bigint) => Buffer;
  getPhysicalDrivePath: (diskIndex: number) => string;
} {
  return {
    readBlocks: (_devicePath: string, offset: bigint, length: bigint) =>
      deviceData.subarray(Number(offset), Number(offset) + Number(length)),
    getPhysicalDrivePath: (diskIndex: number) => `\\\\.\\PhysicalDrive${diskIndex}`
  };
}

describe('validateRestoredFilesystem', () => {
  it('passes a canonical NTFS volume with a boot sector present', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol.writeUInt16LE(0x55aa, 510);

    const check = validateRestoredFilesystem(fakeNative(vol), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: vol.length
    });

    expect(check.ok).toBe(true);
    expect(check.checks.bootSignature).toBe(true);
    expect(check.checks.oemId).toBe('NTFS');
    expect(check.checks.bytesPerSector).toBe(512);
    expect(check.checks.sectorsPerCluster).toBe(GR_SPC);
    expect(check.checks.mftMagic).toBe('FILE');
    expect(check.checks.mftInUse).toBe(true);
  });

  it('fails when the $MFT record 0 magic is not FILE', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol.writeUInt16LE(0x55aa, 510);
    // $MFT starts at LCN 4; corrupt record 0's FILE magic.
    vol.write('NOPE', 4 * GR_CLUSTER, 'ascii');

    const check = validateRestoredFilesystem(fakeNative(vol), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 1,
      label: 'D:',
      offset: 0,
      capturedSize: vol.length
    });

    expect(check.ok).toBe(false);
    expect(check.checks.mftMagic).toBe('NOPE');
    expect(check.error).toContain('magic');
  });

  it('fails when the boot sector is unreadable / too small', () => {
    const check = validateRestoredFilesystem(fakeNative(Buffer.alloc(256)), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: 256
    });

    expect(check.ok).toBe(false);
    expect(check.error).toBe('partition too small for a boot sector');
  });

  it('rejects an unknown filesystem OEM', () => {
    const junk = Buffer.alloc(4096);
    junk.write('\xEB\x3C\x90', 0, 'latin1');
    junk.write('MAGIC   ', 3, 'ascii');
    junk.writeUInt16LE(0x55aa, 510);

    const check = validateRestoredFilesystem(fakeNative(junk), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: junk.length
    });

    expect(check.ok).toBe(false);
    expect(check.error).toContain('unrecognised filesystem OEM "MAGIC"');
  });

  it('performs a shallow structural check on FAT boot sectors', () => {
    const fat = Buffer.alloc(4096);
    fat.write('\xEB\x3C\x90', 0, 'latin1');
    fat.write('MSDOS5.0', 3, 'ascii');
    fat.writeUInt16LE(512, 0x0b);
    fat.writeUInt8(8, 0x0d); // 8 sectors/cluster
    fat.writeUInt16LE(0x55aa, 510);

    const check = validateRestoredFilesystem(fakeNative(fat), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 2,
      label: 'DATA',
      offset: 0,
      capturedSize: fat.length
    });

    expect(check.ok).toBe(true);
    expect(check.checks.shallowCheck).toBe('FAT (structural only)');
    expect(check.checks.bytesPerSector).toBe(512);
    expect(check.checks.sectorsPerCluster).toBe(8);
  });

  it('rejects implausible FAT geometry', () => {
    const fat = Buffer.alloc(4096);
    fat.write('FAT16', 3, 'ascii');
    fat.writeUInt16LE(512, 0x0b);
    fat.writeUInt8(3, 0x0d); // 3 sectors/cluster is not a power of two

    const check = validateRestoredFilesystem(fakeNative(fat), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 2,
      label: 'DATA',
      offset: 0,
      capturedSize: fat.length
    });

    expect(check.ok).toBe(false);
    expect(check.error).toContain('sectorsPerCluster');
  });
});