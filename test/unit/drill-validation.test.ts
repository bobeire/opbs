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
    vol.writeUInt16LE(0xaa55, 510);

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
    vol.writeUInt16LE(0xaa55, 510);
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

  it('skips a partition with no recognised filesystem instead of failing the drill', () => {
    const junk = Buffer.alloc(4096);
    junk.write('\xEB\x3C\x90', 0, 'latin1');
    junk.write('MAGIC   ', 3, 'ascii');
    junk.writeUInt16LE(0xaa55, 510);

    const check = validateRestoredFilesystem(fakeNative(junk), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: junk.length
    });

    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(true);
    expect(check.note).toContain('no recognised filesystem');
  });

  it('skips a reserved partition whose OEM bytes are not a filesystem id', () => {
    // Real MSR content read back by a tester (2026-11-09): arbitrary bytes at
    // the OEM offset, no BPB and usually no 0x55AA signature.
    const msr = Buffer.alloc(1024 * 1024);
    msr.write('\x00\x00\x01\x14PcFP', 3, 'latin1');

    const check = validateRestoredFilesystem(fakeNative(msr), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 1,
      label: 'Reserved',
      offset: 0,
      capturedSize: msr.length
    });

    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(true);
    expect(check.checks.bootSignature).toBe(false);
    expect(check.note).toContain('no recognised filesystem');
  });

  it('reads the boot signature in on-disk byte order (0x55 then 0xAA)', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol[0x1fe] = 0x55;
    vol[0x1ff] = 0xaa;

    const good = validateRestoredFilesystem(fakeNative(vol), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: vol.length
    });
    expect(good.checks.bootSignature).toBe(true);

    // The previous implementation read this as a little-endian u16 and compared
    // it with 0x55AA, which is the bytes AA 55 on disk - never a real volume.
    const swapped = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    swapped.writeUInt16LE(0x55aa, 510);

    const bad = validateRestoredFilesystem(fakeNative(swapped), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: swapped.length
    });
    expect(bad.checks.bootSignature).toBe(false);
  });

  it('performs a shallow structural check on FAT boot sectors', () => {
    const fat = Buffer.alloc(4096);
    fat.write('\xEB\x3C\x90', 0, 'latin1');
    fat.write('MSDOS5.0', 3, 'ascii');
    fat.writeUInt16LE(512, 0x0b);
    fat.writeUInt8(8, 0x0d); // 8 sectors/cluster
    fat.writeUInt16LE(0xaa55, 510);

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