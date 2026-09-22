import { describe, it, expect } from 'vitest';
import { readExfatUsedBlocks } from '../../src/main/imaging/fs/exfat';
import { PartitionReader } from '../../src/main/imaging/image-browse';

const SECTOR = 512;
const CLUSTER = 4096;
const SECTORS_PER_CLUSTER = CLUSTER / SECTOR; // 8
const CLUSTER_SHIFT = 3; // SectorsPerClusterShift: 1 << 3 = 8 sectors = 4096 bytes
const SECTOR_SHIFT = 9;

/**
 * Minimal exFAT volume: FAT at sector 8, cluster heap at sector 16,
 * root directory at cluster 2, allocation bitmap at cluster 3.
 * `bitmapLength` is the 0x81 entry's dataLength (can be shorter than
 * clusterCount needs — the regression under test).
 */
function buildExfatVolume(opts?: { clusterCount?: number; bitmapLength?: number; bitmapByte?: number }): Buffer {
  const clusterCount = opts?.clusterCount ?? 64;
  const bitmapLength = opts?.bitmapLength ?? 1;
  const fatStart = 8 * SECTOR;
  const heapStart = 16 * SECTOR;
  const size = heapStart + (clusterCount + 2) * CLUSTER;
  const buf = Buffer.alloc(size);

  // Boot sector — BytesPerSectorShift @ 0x6E, SectorsPerClusterShift @ 0x6F.
  buf.write('EXFAT   ', 3, 'ascii');
  buf[0x40] = 0x01; // partitionOffset present marker (ignored by parser)
  buf.writeUInt32LE(8, 0x50); // fatOffset in sectors
  buf.writeUInt32LE(16, 0x58); // clusterHeapOffset in sectors
  buf.writeUInt32LE(clusterCount, 0x5c);
  buf.writeUInt32LE(2, 0x60); // rootDirCluster
  buf.writeUInt32LE(0, 0x64); // firstClusterOfBitmap not used by parser
  buf.writeUInt32LE(0, 0x68); // firstClusterOfChecksum
  buf.writeUInt16LE(0, 0x6c); // VolumeFlags
  buf.writeUInt8(SECTOR_SHIFT, 0x6e);
  buf.writeUInt8(CLUSTER_SHIFT, 0x6f);
  buf[0x1fe] = 0x55;
  buf[0x1ff] = 0xaa;

  // FAT: clusters 2 (root) and 3 (bitmap) are single-cluster EOF chains.
  const fat = fatStart;
  buf.writeUInt32LE(0xfffffff8, fat + 2 * 4);
  buf.writeUInt32LE(0xfffffff8, fat + 3 * 4);

  // Root directory (cluster 2): allocation-bitmap entry (type 0x81) then end.
  const root = heapStart + (2 - 2) * CLUSTER;
  buf[root] = 0x81;
  buf.writeUInt32LE(3, root + 0x14); // firstCluster
  buf.writeBigUInt64LE(BigInt(bitmapLength), root + 0x18); // dataLength
  buf[root + 32] = 0x00; // end of directory

  // Allocation bitmap content at cluster 3.
  const bitmap = heapStart + (3 - 2) * CLUSTER;
  buf[bitmap] = opts?.bitmapByte ?? 0x00;

  return buf;
}

function readerOf(buf: Buffer): PartitionReader {
  return {
    size: buf.length,
    read: (offset: number, length: number) => buf.subarray(offset, offset + length)
  } as PartitionReader;
}

describe('readExfatUsedBlocks', () => {
  it('always captures the metadata region before the cluster heap', () => {
    const volume = buildExfatVolume();
    const used = readExfatUsedBlocks(readerOf(volume), volume.length, CLUSTER);
    expect(used).not.toBeNull();
    expect(used!.has(0)).toBe(true); // covers sectors 0..heapStart
  });

  it('marks clusters whose bitmap bit is set as used', () => {
    // bit 0 = cluster 2 (root) set
    const volume = buildExfatVolume({ bitmapByte: 0x01, bitmapLength: 1 });
    const used = readExfatUsedBlocks(readerOf(volume), volume.length, CLUSTER);
    expect(used).not.toBeNull();
    // cluster 2 sits at heapStart → block index heapStart/CLUSTER
    const rootBlock = Math.floor((16 * SECTOR) / CLUSTER);
    expect(used!.has(rootBlock)).toBe(true);
  });

  it('treats bits past a short allocation bitmap as allocated (deep directories)', () => {
    // bitmapLength=1 covers only clusters 2..9 (8 bits). Cluster 10+ would
    // previously be treated as free and omitted from a used-blocks backup,
    // so browsing a deep directory hit "No block N".
    const volume = buildExfatVolume({ clusterCount: 64, bitmapLength: 1, bitmapByte: 0x00 });
    const used = readExfatUsedBlocks(readerOf(volume), volume.length, CLUSTER);
    expect(used).not.toBeNull();
    const heapStartBlocks = Math.floor((16 * SECTOR) / CLUSTER);
    // block 0..heapStartBlocks-1 are metadata (always used).
    // cluster 10 → heapStart + 8*CLUSTER → block heapStartBlocks + 8
    const deepBlock = heapStartBlocks + 8;
    expect(used!.has(deepBlock)).toBe(true);
    // clusters 4..9 are in-range and free (bitmap byte 0x00) — not used
    // unless they fall in a block that also covers metadata.
    const freeInHeapBlock = heapStartBlocks + 2; // cluster 4
    expect(used!.has(freeInHeapBlock)).toBe(false);
  });

  it('captures every heap block when the bitmap covers the whole volume', () => {
    // 64 clusters need 8 bitmap bytes; all free except cluster 2.
    const volume = buildExfatVolume({
      clusterCount: 64,
      bitmapLength: 8,
      bitmapByte: 0x01
    });
    // zero the rest of the bitmap cluster already zeroed by alloc
    const used = readExfatUsedBlocks(readerOf(volume), volume.length, CLUSTER);
    expect(used).not.toBeNull();
    const heapStartBlocks = Math.floor((16 * SECTOR) / CLUSTER);
    const totalBlocks = Math.ceil(volume.length / CLUSTER);
    // With a full bitmap saying only cluster 2 is used, only metadata +
    // the root cluster's block should be captured (root block may share
    // with heap start). Far heap blocks that are free stay omitted.
    const farFree = heapStartBlocks + 30;
    if (farFree < totalBlocks) {
      expect(used!.has(farFree)).toBe(false);
    }
    expect(used!.has(0)).toBe(true);
  });
});
