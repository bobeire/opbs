import { describe, it, expect } from 'vitest';
import { computeChangedBlockIndices } from '../../src/main/imaging/usn-tracking';
import { NativeImagingApi } from '../../src/main/imaging/imaging-job';
import { buildNtfsVolumeData, CLUSTER } from '../helpers/ntfs-fixture';

function mockNative(data: Buffer, changedRecords: number[]): NativeImagingApi {
  return {
    createSnapshot: () => ({ id: 's', devicePath: '\\\\.\\ShadowCopy1' }),
    deleteSnapshot: () => true,
    getPhysicalDrivePath: (i) => `\\\\.\\PhysicalDrive${i}`,
    writeBlocks: () => 0,
    readBlocks: (device: string, offset: bigint, length: bigint) => data.subarray(Number(offset), Number(offset) + Number(length)),
    queryUsnJournal: () => changedRecords.map((fr) => ({ usn: BigInt(fr), fileReference: BigInt(fr), reason: 0, fileName: '' }))
  };
}

describe('USN change tracking', () => {
  it('maps a changed file to the block indices it occupies', () => {
    const volume = buildNtfsVolumeData();
    const native = mockNative(volume, [8]); // big.bin at clusters 32..33
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 1
    });
    expect(changed).toBeDefined();
    // big.bin spans clusters 32..33, which are block indices 32 and 33.
    expect(changed!.has(32)).toBe(true);
    expect(changed!.has(33)).toBe(true);
  });

  it('unions blocks from multiple changed files', () => {
    const volume = buildNtfsVolumeData();
    const native = mockNative(volume, [8, 1]); // big.bin + $MFTMirr (cluster 16)
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 1
    });
    expect(changed!.has(32)).toBe(true);
    expect(changed!.has(16)).toBe(true); // $MFTMirr data run at cluster 16
  });

  it('returns null (full scan) when the journal query throws', () => {
    const volume = buildNtfsVolumeData();
    const native: NativeImagingApi = {
      ...mockNative(volume, []),
      queryUsnJournal: () => {
        throw new Error('requires elevation');
      }
    };
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 1
    });
    expect(changed).toBeNull();
  });

  it('returns empty set when there are no USN records (nothing changed)', () => {
    const volume = buildNtfsVolumeData();
    const native = mockNative(volume, []);
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 1
    });
    expect(changed).not.toBeNull();
    expect(changed!.size).toBe(0);
  });

  it('returns null (full scan) when the journal has been recycled (stale lastUsn)', () => {
    const volume = buildNtfsVolumeData();
    const native: NativeImagingApi = {
      ...mockNative(volume, [8]),
      getUsnJournalInfo: () => ({
        firstUsn: 100n,
        nextUsn: 200n,
        lowestValidUsn: 150n // lastUsn (1) < lowestValidUsn (150) → stale
      })
    };
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 1 // older than lowestValidUsn
    });
    expect(changed).toBeNull();
  });

  it('proceeds normally when lastUsn is within the journal range', () => {
    const volume = buildNtfsVolumeData();
    const native: NativeImagingApi = {
      ...mockNative(volume, [8]),
      getUsnJournalInfo: () => ({
        firstUsn: 1n,
        nextUsn: 200n,
        lowestValidUsn: 50n // lastUsn (100) >= lowestValidUsn (50) → valid
      })
    };
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 100 // within range
    });
    expect(changed).not.toBeNull();
    expect(changed!.has(32)).toBe(true); // big.bin block
  });

  it('returns null when the native addon lacks USN support', () => {
    const volume = buildNtfsVolumeData();
    const native = mockNative(volume, [8]);
    delete (native as Partial<NativeImagingApi>).queryUsnJournal;
    const changed = computeChangedBlockIndices({
      native,
      volumePath: 'C:',
      device: '\\\\.\\PhysicalDrive0',
      baseOffset: 0n,
      partitionSize: volume.length,
      blockSize: CLUSTER,
      lastUsn: 1
    });
    expect(changed).toBeNull();
  });
});
