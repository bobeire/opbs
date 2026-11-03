import { describe, it, expect } from 'vitest';
import {
  readAllocationMap,
  allocationChanged,
  captureChangedMessage,
  type AllocationMap
} from '../../src/main/imaging/capture-consistency';
import { parseBootSector } from '../../src/main/imaging/fs/ntfs';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER } from '../helpers/ntfs-resize-fixture';

function readerOver(vol: Buffer) {
  return {
    size: vol.length,
    read: (offset: number, length: number) => vol.subarray(offset, offset + length)
  };
}

function map(clusterSize: number, totalClusters: number, bytes: Buffer): AllocationMap {
  return { clusterSize, totalClusters, bitmapBytes: bytes };
}

/**
 * A capture that is not a point in time is the defect behind the 2026-11-03
 * field report: every block verified, and the filesystem the blocks formed was
 * corrupt because the allocation bitmap and the file records were captured
 * moments apart. The volume's own allocation map is the cheapest thing that
 * moves when that happens.
 */
describe('capture consistency', () => {
  it('reads the allocation map from an NTFS volume', () => {
    const vol = buildCanonicalNtfsVolumeData({ totalClusters: 64 });
    const reader = readerOver(vol);
    const probe = readAllocationMap(reader);

    expect(probe).not.toBeNull();
    expect(probe!.clusterSize).toBe(parseBootSector(reader).clusterSize);
    expect(probe!.bitmapBytes.length).toBeGreaterThan(0);
  });

  it('returns no verdict for a volume that is not NTFS', () => {
    const vol = Buffer.alloc(GR_CLUSTER * 4);
    vol.write('FAT32   ', 3, 'ascii');
    // No verdict is not a clean bill of health — callers must not treat it
    // as one.
    expect(readAllocationMap(readerOver(vol))).toBeNull();
  });

  it('returns no verdict when the map cannot be read', () => {
    expect(readAllocationMap(readerOver(Buffer.alloc(64)))).toBeNull();
  });

  it('sees no change between two identical reads', () => {
    const bytes = Buffer.from([0b00001111, 0b10101010]);
    const result = allocationChanged(map(4096, 16, bytes), map(4096, 16, Buffer.from(bytes)));
    expect(result.changed).toBe(false);
    expect(result.clustersChanged).toBe(0);
  });

  it('counts the clusters that flipped mid-capture', () => {
    const before = map(4096, 16, Buffer.from([0b00000000, 0b00000000]));
    const after = map(4096, 16, Buffer.from([0b00001111, 0b00000001]));
    const result = allocationChanged(before, after);
    expect(result.changed).toBe(true);
    expect(result.clustersChanged).toBe(5);
  });

  it('treats a geometry change as a change too', () => {
    const bytes = Buffer.from([0xff]);
    // The volume itself moved under us — as bad as clusters flipping.
    expect(allocationChanged(map(4096, 8, bytes), map(4096, 16, bytes)).changed).toBe(true);
    expect(allocationChanged(map(4096, 8, bytes), map(8192, 8, bytes)).changed).toBe(true);
  });

  it('handles maps of different byte lengths without throwing', () => {
    // Same geometry, but one read returned a truncated map: the tail counts
    // as zero, so every cluster in the missing byte reads as flipped.
    const result = allocationChanged(map(4096, 16, Buffer.from([0x00])), map(4096, 16, Buffer.from([0x00, 0xff])));
    expect(result.changed).toBe(true);
    expect(result.clustersChanged).toBe(8);
  });

  it('says what it means in the message', () => {
    const message = captureChangedMessage('Real', 42);
    expect(message).toContain('42 allocation clusters flipped');
    expect(message).toContain('no single point in time');
    expect(message).toContain('every block verifies');
    // Singular reads correctly.
    expect(captureChangedMessage('Real', 1)).toContain('1 allocation cluster flipped');
  });
});
