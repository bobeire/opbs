import { describe, it, expect } from 'vitest';
import { PartitionReader } from '../../src/main/imaging/image-browse';
import { readUsedBlockIndexes } from '../../src/main/imaging/fs/used-blocks';
import { buildCanonicalNtfsVolumeData, GR_CLUSTER, GR_MFT_LCN } from '../helpers/ntfs-resize-fixture';
import { buildFileRecord, FILE_RECORD, standardInfo, fileNameAttr } from '../helpers/ntfs-fixture';

/** Expose raw NTFS volume bytes as a PartitionReader for the block scanner. */
function readerOf(buf: Buffer): PartitionReader {
  return {
    size: buf.length,
    read: (offset: number, length: number) => buf.subarray(offset, offset + length)
  } as PartitionReader;
}

const TOTAL_CLUSTERS = 64;

describe('readUsedBlockIndexes', () => {
  it('marks exactly the $Bitmap-allocated clusters as used (block == cluster)', () => {
    const reader = readerOf(buildCanonicalNtfsVolumeData());
    const used = readUsedBlockIndexes(reader, TOTAL_CLUSTERS * GR_CLUSTER, GR_CLUSTER);
    expect(used).not.toBeNull();
    // The canonical fixture marks clusters 0..15 in use.
    expect(Array.from(used!.values()).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => i)
    );
  });

  it('maps cluster ranges across larger blocks (block > cluster)', () => {
    const reader = readerOf(buildCanonicalNtfsVolumeData());
    const used = readUsedBlockIndexes(reader, TOTAL_CLUSTERS * GR_CLUSTER, 4 * GR_CLUSTER);
    expect(used).not.toBeNull();
    // 4-cluster blocks: blocks 0..3 cover clusters 0..15 (all used).
    expect(Array.from(used!.values()).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('ignores padding beyond the volume end', () => {
    const reader = readerOf(buildCanonicalNtfsVolumeData());
    const used = readUsedBlockIndexes(reader, (TOTAL_CLUSTERS + 6) * GR_CLUSTER, GR_CLUSTER);
    expect(used!.has(64)).toBe(false);
    expect(used!.has(69)).toBe(false);
    expect(used!.size).toBe(16);
  });

  it('respects a partition that is smaller than the full volume', () => {
    const reader = readerOf(buildCanonicalNtfsVolumeData());
    const used = readUsedBlockIndexes(reader, 8 * GR_CLUSTER, GR_CLUSTER);
    expect(Array.from(used!.values()).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 8 }, (_, i) => i)
    );
  });

  it('returns null for a non-NTFS volume', () => {
    const nonNtfs = Buffer.alloc(GR_CLUSTER);
    nonNtfs.write('FAT32   ', 3, 'ascii');
    const reader = readerOf(nonNtfs);
    expect(readUsedBlockIndexes(reader, GR_CLUSTER, GR_CLUSTER)).toBeNull();
  });

  it('returns null when the $Bitmap cannot be resolved', () => {
    // A volume whose record 6 does not parse (no MFT) must fall back to full scan.
    const notAnMft = Buffer.alloc(64 * GR_CLUSTER);
    notAnMft.write('NTFS    ', 3, 'ascii');
    notAnMft.writeUInt16LE(512, 0x0b);
    notAnMft.writeUInt8(8, 0x0d);
    notAnMft.writeBigUInt64LE(BigInt(64 * 8), 0x28);
    notAnMft.writeBigUInt64LE(70n, 0x30);
    notAnMft.writeBigUInt64LE(71n, 0x38);
    notAnMft.writeInt8(-10, 0x40);
    expect(readUsedBlockIndexes(readerOf(notAnMft), 64 * GR_CLUSTER, GR_CLUSTER)).toBeNull();
  });

  it('treats bits past a truncated $Bitmap as allocated', () => {
    // $Bitmap realSize covers only 16 clusters (2 bytes) while the boot
    // sector claims 64 — clusters 16+ have no bitmap byte and must be
    // captured, not treated as free (browsing would hit "No block N").
    const totalClusters = 64;
    const buf = Buffer.alloc(totalClusters * GR_CLUSTER);
    const mftBase = GR_MFT_LCN * GR_CLUSTER;
    const rec0 = buildFileRecord(0, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(1000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFT', 1) },
        { type: 0x80, nonResident: true, runs: [{ startLcn: GR_MFT_LCN, runLength: 12 }], realSize: 12 * GR_CLUSTER }
      ]
    });
    rec0.copy(buf, mftBase);
    // realSize=2 → 16 clusters covered by $Bitmap; volume has 64.
    const rec6 = buildFileRecord(6, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(3000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$Bitmap', 1) },
        {
          type: 0x80,
          nonResident: true,
          runs: [{ startLcn: 3, runLength: 1 }],
          realSize: 2
        }
      ]
    });
    rec6.copy(buf, mftBase + 6 * FILE_RECORD);
    buf.write('NTFS    ', 3, 'ascii');
    buf.writeUInt16LE(512, 0x0b);
    buf.writeUInt8(8, 0x0d);
    buf.writeUInt8(0xf8, 0x15);
    buf.writeBigUInt64LE(BigInt(totalClusters * 8), 0x28);
    buf.writeBigUInt64LE(BigInt(GR_MFT_LCN), 0x30);
    buf.writeBigUInt64LE(BigInt(GR_MFT_LCN + 1), 0x38);
    buf.writeInt8(-10, 0x40);
    // $Bitmap content: first byte marks clusters 0..7 used; clusters 16+
    // fall past the 2-byte $Bitmap entirely.
    const bmBase = 3 * GR_CLUSTER;
    buf[bmBase] = 0xff;

    const used = readUsedBlockIndexes(readerOf(buf), totalClusters * GR_CLUSTER, GR_CLUSTER);
    expect(used).not.toBeNull();
    expect(used!.has(0)).toBe(true);
    // past $Bitmap coverage → treated allocated
    expect(used!.has(16)).toBe(true);
    expect(used!.has(32)).toBe(true);
    // beyond the boot-sector volume size → still unused
    expect(used!.has(64)).toBe(false);
  });
});
