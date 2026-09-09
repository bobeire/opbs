import { describe, it, expect } from 'vitest';
import {
  parseNtfsBootSector,
  planNtfsGrow,
  findFileRecord,
  GrowUnsupportedError,
  NtfsGrowRegion
} from '../../src/main/imaging/fs/ntfs-resize';
import {
  buildCanonicalNtfsVolumeData,
  GR_CLUSTER,
  GR_SPC,
  GR_MFT_LCN
} from '../helpers/ntfs-resize-fixture';

const BASE_CLUSTERS = 64;
const GROWN_CLUSTERS = 80;
const MFT_BASE = GR_MFT_LCN * GR_CLUSTER;
const BITMAP_OFFSET = 3 * GR_CLUSTER;
const RECORD = 1024;

function applyRegions(base: Buffer, regions: NtfsGrowRegion[]): Buffer {
  const out = Buffer.from(base);
  for (const region of regions) {
    region.data.copy(out, region.relativeOffset);
  }
  return out;
}

describe('ntfs grow-on-restore planner', () => {
  it('parses a canonical NTFS boot sector', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS });
    const layout = parseNtfsBootSector(bytes.subarray(0, 512));
    expect(layout.bytesPerSector).toBe(512);
    expect(layout.sectorsPerCluster).toBe(GR_SPC);
    expect(layout.clusterSize).toBe(GR_CLUSTER);
    expect(layout.totalSectors).toBe(64 * 8);
    expect(layout.mftLcn).toBe(GR_MFT_LCN);
    expect(layout.fileRecordSize).toBe(RECORD);
  });

  it('plans boot, $Bitmap and $BadClus patches for a grow', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS });
    const plan = planNtfsGrow(bytes, GROWN_CLUSTERS * GR_SPC);

    expect(plan.newTotalClusters).toBe(GROWN_CLUSTERS);
    expect(plan.newTotalSectors).toBe(GROWN_CLUSTERS * GR_SPC);
    expect(plan.regions).toHaveLength(4);

    // 1. Boot sector: only the total-sector field changes.
    const [boot, bitmapRecord, bitmapTail, badClusRecord] = plan.regions;
    expect(boot.relativeOffset).toBe(0);
    expect(boot.data.length).toBe(512);
    expect(boot.data.readBigUInt64LE(0x28)).toBe(BigInt(GROWN_CLUSTERS * GR_SPC));

    // 2. Rewritten $Bitmap record at record 6 of the MFT.
    expect(bitmapRecord.relativeOffset).toBe(MFT_BASE + 6 * RECORD);
    expect(bitmapRecord.data.readUInt32LE(0x18)).toBeLessThan(RECORD);

    // 3. Bitmap tail: new clusters 64..79 marked free (two zero bytes).
    expect(bitmapTail.relativeOffset).toBe(BITMAP_OFFSET + Math.floor(BASE_CLUSTERS / 8));
    expect(bitmapTail.data.length).toBe(Math.ceil(GROWN_CLUSTERS / 8) - Math.ceil(BASE_CLUSTERS / 8));
    expect(bitmapTail.data[0]).toBe(0);
    expect(bitmapTail.data[1]).toBe(0);

    // 4. Rewritten $BadClus record at record 8 of the MFT.
    expect(badClusRecord.relativeOffset).toBe(MFT_BASE + 8 * RECORD);

    // Applying the plan produces a self-consistent grown volume.
    const grown = applyRegions(bytes, plan.regions);
    const grownLayout = parseNtfsBootSector(grown.subarray(0, 512));
    expect(grownLayout.totalSectors).toBe(GROWN_CLUSTERS * GR_SPC);

    const bitmap = findFileRecord(grown, grownLayout, 6)!;
    expect(bitmap.data).not.toBeNull();
    expect(bitmap.data!.runs).toEqual([{ startLcn: 3, runLength: 1 }]);
    expect(bitmap.data!.lastVcn).toBe(0);
    expect(bitmap.data!.allocatedSize).toBe(GR_CLUSTER);
    expect(bitmap.data!.realSize).toBe(Math.ceil(GROWN_CLUSTERS / 8));

    const bad = findFileRecord(grown, grownLayout, 8)!;
    expect(bad.data!.runs).toEqual([{ startLcn: 0, runLength: GROWN_CLUSTERS, sparse: true }]);
    expect(bad.data!.realSize).toBe(GROWN_CLUSTERS * GR_CLUSTER);
  });

  it('returns no regions when the target size equals the captured size', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS });
    const plan = planNtfsGrow(bytes, BASE_CLUSTERS * GR_SPC);
    expect(plan.regions).toEqual([]);
    expect(plan.newTotalClusters).toBe(BASE_CLUSTERS);
  });

  it('refuses to shrink a partition', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS });
    expect(() => planNtfsGrow(bytes, 32 * GR_SPC)).toThrow(/shrink/);
  });

  it('refuses a target that is not cluster-aligned', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS });
    expect(() => planNtfsGrow(bytes, BASE_CLUSTERS * GR_SPC + 1)).toThrow(/cluster-aligned/);
  });

  it('rejects a non-NTFS boot sector', () => {
    const bytes = Buffer.alloc(64 * GR_CLUSTER);
    bytes.write('FAT32   ', 3, 'ascii');
    expect(() => planNtfsGrow(bytes, 100)).toThrow(/not an NTFS volume/i);
  });

  it('refuses a $Bitmap with multiple data runs', () => {
    const bytes = buildCanonicalNtfsVolumeData({
      totalClusters: BASE_CLUSTERS,
      bitmapRuns: [
        { startLcn: 3, runLength: 1 },
        { startLcn: 40, runLength: 1 }
      ],
      bitmapRealSize: 2 * GR_CLUSTER
    });
    expect(() => planNtfsGrow(bytes, GROWN_CLUSTERS * GR_SPC)).toThrow(/single contiguous/i);
  });

  it('refuses when the metadata read does not cover the stored $Bitmap bytes', () => {
    // Move the stored bitmap far enough into the volume that a metadata read
    // ending just past the MFT still cannot reach the bitmap's first bytes.
    const bytes = buildCanonicalNtfsVolumeData({
      totalClusters: BASE_CLUSTERS,
      bitmapRuns: [{ startLcn: 50, runLength: 1 }]
    });
    const short = bytes.subarray(0, MFT_BASE + 8 * RECORD + 256);
    expect(() => planNtfsGrow(short, GROWN_CLUSTERS * GR_SPC)).toThrow(/covered by the metadata read/i);
  });

  it('skips $BadClus silently when it is not a single sparse run', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS, badClusAllocated: true });
    const plan = planNtfsGrow(bytes, GROWN_CLUSTERS * GR_SPC);
    expect(plan.regions).toHaveLength(3);
    expect(plan.regions.some((r) => r.relativeOffset === MFT_BASE + 8 * RECORD)).toBe(false);
  });

  it('throws a GrowUnsupportedError for unsupported layouts', () => {
    const bytes = buildCanonicalNtfsVolumeData({ totalClusters: BASE_CLUSTERS });
    expect(() => planNtfsGrow(bytes, 32 * GR_SPC)).toThrow(GrowUnsupportedError);
  });
});