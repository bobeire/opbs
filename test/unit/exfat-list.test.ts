import { describe, it, expect } from 'vitest';
import { listExfatDirectory, parseExfatBootSector, readExfatFileData } from '../../src/main/imaging/fs/exfat';
import { PartitionReader } from '../../src/main/imaging/image-browse';

const SECTOR = 512;
const CLUSTER = 4096;
const CLUSTER_SHIFT = 3; // 8 sectors = 4096
const SECTOR_SHIFT = 9;
const FAT_START_SECTORS = 8;
const HEAP_START_SECTORS = 16;
const FAT = FAT_START_SECTORS * SECTOR;
const HEAP = HEAP_START_SECTORS * SECTOR;

function readerOf(buf: Buffer): PartitionReader {
  return {
    size: buf.length,
    read: (offset: number, length: number) => buf.subarray(offset, offset + length)
  } as PartitionReader;
}

/**
 * Minimal exFAT volume with a directory at cluster 4 whose FAT chain
 * continues past the real directory data (end-of-directory marker in the
 * first cluster) into a long non-cyclic tail. The old full-chain walk hit
 * "chain too long" before it ever looked at the directory bytes.
 */
function buildLongTailDirectoryVolume(opts?: { tailLength?: number }): Buffer {
  const tailLength = opts?.tailLength ?? 100;
  const clusterCount = 4 + tailLength; // clusters 2..clusterCount+1 exist
  const size = HEAP + (clusterCount + 2) * CLUSTER;
  const buf = Buffer.alloc(size);

  // Boot sector
  buf.write('EXFAT   ', 3, 'ascii');
  buf[0x40] = 0x01;
  buf.writeUInt32LE(FAT_START_SECTORS, 0x50);
  buf.writeUInt32LE(HEAP_START_SECTORS, 0x58);
  buf.writeUInt32LE(clusterCount, 0x5c);
  buf.writeUInt32LE(2, 0x60); // rootDirCluster
  buf.writeUInt8(SECTOR_SHIFT, 0x6c);
  buf.writeUInt8(CLUSTER_SHIFT, 0x6d);
  buf[0x1fe] = 0x55;
  buf[0x1ff] = 0xaa;

  const setFat = (cluster: number, value: number) => {
    buf.writeUInt32LE(value >>> 0, FAT + cluster * 4);
  };

  // Root (cluster 2) → EOF, empty
  setFat(2, 0xfffffff8);

  // Directory chain: 4 → 5 → … → 4+tailLength → EOF (no cycle, long tail)
  for (let c = 4; c < 4 + tailLength; c++) {
    setFat(c, c + 1);
  }
  setFat(4 + tailLength, 0xfffffff8);

  // Directory data at cluster 4: one file entry set + end marker
  const dir = HEAP + (4 - 2) * CLUSTER;
  // File entry 0x85
  buf[dir] = 0x85;
  buf.writeUInt16LE(0x20, dir + 4); // archive
  buf.writeUInt16LE(0, dir + 0x0c);
  buf.writeUInt16LE(0, dir + 0x0e);
  // Stream extension 0xC0
  buf[dir + 32] = 0xc0;
  buf[dir + 32 + 3] = 5; // nameLength "track"
  buf.writeUInt32LE(10, dir + 32 + 0x14); // firstCluster
  buf.writeBigUInt64LE(100n, dir + 32 + 0x18); // dataLength
  // File name 0xC1
  buf[dir + 64] = 0xc1;
  const name = 'track';
  for (let i = 0; i < name.length; i++) {
    buf.writeUInt16LE(name.charCodeAt(i), dir + 64 + 2 + i * 2);
  }
  // End of directory
  buf[dir + 96] = 0x00;

  // File data cluster 10 (may fall inside or after the tail chain — set EOF)
  const dataCluster = Math.min(10, 4 + tailLength);
  setFat(dataCluster, 0xfffffff8);
  const dataOff = HEAP + (dataCluster - 2) * CLUSTER;
  buf.fill(0xab, dataOff, dataOff + 100);

  return buf;
}

describe('listExfatDirectory', () => {
  it('stops at the end-of-directory marker instead of walking the full FAT chain', () => {
    // Regression for "Master/party tracks": directory data ends in the first
    // cluster (type 0x00) but the FAT chain continued for >65536 clusters
    // (or any long tail), so the old readExfatChain(..., 65_536) threw
    // "exFAT chain too long" before parse ever ran.
    const volume = buildLongTailDirectoryVolume({ tailLength: 100 });
    const layout = parseExfatBootSector(readerOf(volume));
    expect(layout.clusterSize).toBe(CLUSTER);
    const entries = listExfatDirectory(readerOf(volume), layout, 4);
    expect(entries.map((e) => e.name)).toEqual(['track']);
    expect(entries[0].size).toBe(100);
    expect(entries[0].startCluster).toBe(10);
  });

  it('still throws on a cycle when there is no end marker', () => {
    const volume = buildLongTailDirectoryVolume({ tailLength: 8 });
    const layout = parseExfatBootSector(readerOf(volume));
    // Wipe both cycle clusters of any 0x00 end marker, then make 4→5→4.
    const dir = HEAP + (4 - 2) * CLUSTER;
    const next = HEAP + (5 - 2) * CLUSTER;
    volume.fill(0xff, dir, dir + CLUSTER);
    volume.fill(0xff, next, next + CLUSTER);
    volume.writeUInt32LE(5, FAT + 4 * 4);
    volume.writeUInt32LE(4, FAT + 5 * 4);
    expect(() => listExfatDirectory(readerOf(volume), layout, 4)).toThrow(/cycle detected/);
  });

  it('lists a multi-cluster directory up to the end marker', () => {
    const volume = buildLongTailDirectoryVolume({ tailLength: 4 });
    const layout = parseExfatBootSector(readerOf(volume));
    // Put a second entry in cluster 5, end marker there; chain 4→5→EOF.
    const c4 = HEAP + (4 - 2) * CLUSTER;
    const c5 = HEAP + (5 - 2) * CLUSTER;
    // Clear cluster 4 so it has no end marker (entries only).
    volume.fill(0xff, c4 + 96, c4 + CLUSTER);
    // cluster 5: another file set + end
    volume.writeUInt32LE(5, FAT + 4 * 4);
    volume.writeUInt32LE(0xfffffff8, FAT + 5 * 4);
    volume.writeUInt32LE(6, FAT + 6 * 4); // not used by this list
    volume[c5] = 0x85;
    volume.writeUInt16LE(0x20, c5 + 4);
    volume[c5 + 32] = 0xc0;
    volume[c5 + 32 + 3] = 3;
    volume.writeUInt32LE(0, c5 + 32 + 0x14);
    volume.writeBigUInt64LE(0n, c5 + 32 + 0x18);
    volume[c5 + 64] = 0xc1;
    volume.writeUInt16LE('a'.charCodeAt(0), c5 + 64 + 2);
    volume.writeUInt16LE('b'.charCodeAt(0), c5 + 64 + 4);
    volume.writeUInt16LE('c'.charCodeAt(0), c5 + 64 + 6);
    volume[c5 + 96] = 0x00;

    const entries = listExfatDirectory(readerOf(volume), layout, 4);
    expect(entries.map((e) => e.name)).toEqual(['track', 'abc']);
  });
});

describe('readExfatFileData', () => {
  it('reads only as many clusters as the file size needs', () => {
    const volume = buildLongTailDirectoryVolume({ tailLength: 50 });
    const layout = parseExfatBootSector(readerOf(volume));
    // File at cluster 10 with size 100 — one cluster is enough even if
    // the FAT chain after it is long/corrupt.
    const data = readExfatFileData(readerOf(volume), layout, 10, 100);
    expect(data.length).toBe(100);
    expect(data[0]).toBe(0xab);
    expect(data[99]).toBe(0xab);
  });
});
