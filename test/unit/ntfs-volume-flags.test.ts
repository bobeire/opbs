import { describe, it, expect } from 'vitest';
import { parseVolumeFlags, readVolumeFlags, VOLUME_FLAG_DIRTY, parseBootSector, dirtyVolumeWarning } from '../../src/main/imaging/fs/ntfs';
import { validateRestoredFilesystem } from '../../src/main/imaging/drill-validation';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER } from '../helpers/ntfs-resize-fixture';
import { buildFileRecord, standardInfo, fileNameAttr, volumeInfoAttr, FILE_RECORD } from '../helpers/ntfs-fixture';

/**
 * NTFS's dirty bit travels with the image: a capture of a mounted volume has
 * it set, so restoring one schedules a repair at first boot and the user is
 * told to "Restart to repair drive errors" (field report 2026-11-02, where it
 * read as the restore having broken the disk). Detecting it — and reporting it
 * before anyone boots — is the whole feature.
 */
function volumeRecord(flags: number): Buffer {
  return buildFileRecord(3, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(2000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$Volume', 1) },
      { type: 0x70, nonResident: false, resident: volumeInfoAttr(flags) }
    ]
  });
}

describe('parseVolumeFlags', () => {
  it('reads a clean $Volume', () => {
    const flags = parseVolumeFlags(volumeRecord(0));
    expect(flags).not.toBeNull();
    expect(flags!.dirty).toBe(false);
    expect(flags!.majorVersion).toBe(3);
  });

  it('reads a dirty $Volume — what a live capture produces', () => {
    const flags = parseVolumeFlags(volumeRecord(VOLUME_FLAG_DIRTY));
    expect(flags!.dirty).toBe(true);
    expect(flags!.flags & VOLUME_FLAG_DIRTY).toBe(VOLUME_FLAG_DIRTY);
  });

  it('keeps other flag bits without mistaking them for dirty', () => {
    // 0x0002 is VOLUME_RESIZE_LOG_FILE; it must not read as dirty.
    expect(parseVolumeFlags(volumeRecord(0x0002))!.dirty).toBe(false);
    expect(parseVolumeFlags(volumeRecord(0x0002))!.flags).toBe(0x0002);
  });

  it('returns null rather than guessing on a non-record', () => {
    expect(parseVolumeFlags(Buffer.alloc(1024))).toBeNull();
    expect(parseVolumeFlags(Buffer.from('FILE'))).toBeNull();
  });

  it('returns null when the record has no VOLUME_INFORMATION attribute', () => {
    const rec = buildFileRecord(3, {
      inUse: true,
      attrs: [{ type: 0x10, nonResident: false, resident: standardInfo(2000) }]
    });
    expect(parseVolumeFlags(rec)).toBeNull();
  });
});

describe('readVolumeFlags', () => {
  function readerOver(vol: Buffer) {
    return {
      size: vol.length,
      read: (offset: number, length: number) => vol.subarray(offset, offset + length)
    };
  }

  it('reads the flag straight off a volume', () => {
    const dirty = buildCanonicalNtfsVolumeData({ totalClusters: 64, volumeFlags: VOLUME_FLAG_DIRTY });
    const clean = buildCanonicalNtfsVolumeData({ totalClusters: 64 });

    expect(readVolumeFlags(readerOver(dirty), parseBootSector(readerOver(dirty)))!.dirty).toBe(true);
    expect(readVolumeFlags(readerOver(clean), parseBootSector(readerOver(clean)))!.dirty).toBe(false);
  });

  it('treats an unreadable $Volume as unknown, never as clean', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    // Wipe record 3: the caller must see `null` and stay silent, not claim
    // the volume is clean.
    vol.fill(0, 4 * GR_CLUSTER + 3 * FILE_RECORD, 4 * GR_CLUSTER + 4 * FILE_RECORD);
    const reader = readerOver(vol);
    expect(readVolumeFlags(reader, parseBootSector(reader))).toBeNull();
  });
});

describe('validateRestoredFilesystem — dirty flag reporting', () => {
  function fakeNative(deviceData: Buffer) {
    return {
      readBlocks: (_devicePath: string, offset: bigint, length: bigint) =>
        deviceData.subarray(Number(offset), Number(offset) + Number(length)),
      getPhysicalDrivePath: (diskIndex: number) => `\\\\.\\PhysicalDrive${diskIndex}`
    };
  }

  it('reports a dirty volume so the caller can warn before first boot', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64, volumeFlags: VOLUME_FLAG_DIRTY });
    vol.writeUInt16LE(0xaa55, 510);

    const check = validateRestoredFilesystem(fakeNative(vol), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: vol.length
    });

    expect(check.ok).toBe(true);
    expect(check.checks.volumeDirty).toBe(true);
  });

  it('reports a clean volume as clean', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    vol.writeUInt16LE(0xaa55, 510);

    const check = validateRestoredFilesystem(fakeNative(vol), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 0,
      label: 'C:',
      offset: 0,
      capturedSize: vol.length
    });

    expect(check.checks.volumeDirty).toBe(false);
  });

  it('does not flag FAT volumes as dirty', () => {
    const fat = Buffer.alloc(4096);
    fat.write('FAT16', 3, 'ascii');
    fat.writeUInt16LE(512, 0x0b);
    fat.writeUInt8(8, 0x0d);
    fat.writeUInt16LE(0xaa55, 510);

    const check = validateRestoredFilesystem(fakeNative(fat), '\\\\.\\PhysicalDrive5', {
      partitionIndex: 2,
      label: 'DATA',
      offset: 0,
      capturedSize: fat.length
    });

    expect(check.ok).toBe(true);
    expect(check.checks.volumeDirty).toBeUndefined();
  });
});

describe('dirtyVolumeWarning', () => {
  it('names the consequence and the way to avoid it, not just the prompt', () => {
    // A tester lost a browser profile to this repair (2026-11-02). The
    // earlier wording said a repair would run; it did not say what the repair
    // could take with it, which is the part that decides whether someone
    // closes their browser before backing up.
    const message = dirtyVolumeWarning('Partition 2');

    expect(message).toContain('Partition 2');
    expect(message).toContain('Restart to repair drive errors');
    expect(message).toContain('discard files');
    expect(message).toContain('Close open applications');
    expect(message).toContain('not the restore');
  });
});
