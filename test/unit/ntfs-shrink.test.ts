import { describe, it, expect } from 'vitest';
import { planNtfsShrink, ntfsShrinkMinimum, ShrinkUnsupportedError } from '../../src/main/imaging/fs/ntfs-shrink';
import { parseFileRecord } from '../../src/main/imaging/fs/ntfs';
import {
  buildShrinkVolumeData,
  shrinkVolumeReader,
  applyShrinkPlan,
  clusterPattern,
  SK_CLUSTER,
  SK_MFT_LCN,
  SK_BITMAP_LCN,
  SK_TARGET_CLUSTERS,
  SK_TARGET_SECTORS,
  SK_MIN_TARGET_CLUSTERS,
  SK_TOTAL_CLUSTERS,
  SK_USER_LCN,
  SK_SPC
} from '../helpers/ntfs-shrink-fixture';

const MFT_BASE = SK_MFT_LCN * SK_CLUSTER;
const RECORD = 1024;

function recordAt(data: Buffer, recordNumber: number) {
  return parseFileRecord(
    data.subarray(MFT_BASE + recordNumber * RECORD, MFT_BASE + (recordNumber + 1) * RECORD),
    recordNumber
  );
}

function isBitSet(data: Buffer, cluster: number): boolean {
  const byte = data[SK_BITMAP_LCN * SK_CLUSTER + (cluster >> 3)];
  return (byte & (1 << (cluster & 7))) !== 0;
}

describe('planNtfsShrink', () => {
  it('plans a shrink, relocates tail data and the applied volume re-parses', () => {
    const data = buildShrinkVolumeData();
    const plan = planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS);

    expect(plan.oldTotalClusters).toBe(SK_TOTAL_CLUSTERS);
    expect(plan.newTotalClusters).toBe(SK_TARGET_CLUSTERS);
    expect(plan.newTotalSectors).toBe(SK_TARGET_SECTORS);
    expect(plan.moves).toEqual([{ srcCluster: SK_USER_LCN, dstCluster: 17, clusterCount: 4 }]);
    expect(plan.relocatedBytes).toBe(4 * SK_CLUSTER);
    expect(Number(plan.bootSector.readBigUInt64LE(0x28))).toBe(SK_TARGET_SECTORS);
    expect(plan.mftMirrStartCluster).toBe(16);
    expect(plan.mirrorRecordCount).toBe(4);
    expect(plan.recordPatches.map((p) => p.recordNumber).sort((a, b) => a - b)).toEqual([6, 8, 16]);
    expect(plan.bitmapRegions.length).toBeGreaterThan(0);

    const applied = applyShrinkPlan(data, plan);

    // Boot sector advertises the new size; data moved to LCN 17; record 16
    // runlist points at the new location; content is intact.
    expect(Number(applied.readBigUInt64LE(0x28))).toBe(SK_TARGET_SECTORS);
    for (let c = 0; c < 4; c++) {
      expect(applied.subarray((17 + c) * SK_CLUSTER, (18 + c) * SK_CLUSTER)).toEqual(clusterPattern(SK_USER_LCN + c));
    }
    const rec16 = recordAt(applied, 16);
    expect(rec16.dataRuns).toEqual([{ startLcn: 17, runLength: 4 }]);

    // $Bitmap prefix: destination bits set, record 6 sizes truncated.
    expect(isBitSet(applied, 17)).toBe(true);
    expect(isBitSet(applied, 20)).toBe(true);
    expect(isBitSet(applied, 21)).toBe(false);
    const rec6 = recordAt(applied, 6);
    expect(rec6.size).toBe(Math.ceil(SK_TARGET_CLUSTERS / 8));

    // $BadClus sparse run spans the new volume.
    const rec8 = recordAt(applied, 8);
    expect(rec8.dataRuns).toEqual([{ startLcn: 0, runLength: SK_TARGET_CLUSTERS, sparse: true }]);

    // Backup boot sector at the new last sector.
    expect(Number(applied.readBigUInt64LE((SK_TARGET_SECTORS - 1) * 512 + 0x28))).toBe(SK_TARGET_SECTORS);
  });

  it('reports feasibility numbers via ntfsShrinkMinimum', () => {
    const data = buildShrinkVolumeData();
    const min = ntfsShrinkMinimum(shrinkVolumeReader(data));
    expect(min.clusterSize).toBe(SK_CLUSTER);
    expect(min.oldTotalClusters).toBe(SK_TOTAL_CLUSTERS);
    expect(min.usedClusters).toBe(12 + 1 + 1 + 4); // $MFT + $Bitmap + $MFTMirr + user data
    expect(min.minTargetClusters).toBe(SK_MIN_TARGET_CLUSTERS);
    expect(min.minTargetSectors).toBe(SK_MIN_TARGET_CLUSTERS * SK_SPC);
  });

  it('refuses a target below the minimum', () => {
    const data = buildShrinkVolumeData();
    expect(() => planNtfsShrink(shrinkVolumeReader(data), 128 * SK_SPC)).toThrowError(/below the minimum/);
  });

  it('refuses a target that is not cluster-aligned', () => {
    const data = buildShrinkVolumeData();
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS + 1)).toThrowError(/cluster-aligned/);
  });

  it('refuses a target that is not smaller than the volume', () => {
    const data = buildShrinkVolumeData();
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TOTAL_CLUSTERS * SK_SPC)).toThrowError(/not smaller/);
  });

  it('refuses a non-NTFS volume', () => {
    const data = Buffer.alloc(SK_TOTAL_CLUSTERS * SK_CLUSTER);
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(/Not a shrinkable NTFS/);
  });

  it('refuses when OS metadata extents reach beyond the boundary', () => {
    const data = buildShrinkVolumeData({
      userRuns: [],
      badClusRun: { startLcn: SK_USER_LCN, runLength: 4 }
    });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(
      /OS metadata \(record 8\)/
    );
  });

  it('refuses when a compressed stream reaches beyond the boundary', () => {
    const data = buildShrinkVolumeData({ compressedUser: true });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(/Compressed stream/);
  });

  it('refuses when an EFS-encrypted record reaches beyond the boundary', () => {
    const data = buildShrinkVolumeData({ efsUser: true });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(/EFS-encrypted/);
  });

  it('refuses when an attribute-listed record reaches beyond the boundary', () => {
    const data = buildShrinkVolumeData({ attributeListUser: true });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(/attribute list/);
  });

  it('refuses on bitmap/MFT disagreement below the boundary', () => {
    const data = buildShrinkVolumeData({
      stayingRuns: [{ recordNumber: 20, startLcn: 300, runLength: 2 }],
      bitmapClear: [{ start: 300, count: 1 }]
    });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(
      /Bitmap\/MFT disagreement/
    );
  });

  it('refuses an unsupported $BadClus layout', () => {
    const data = buildShrinkVolumeData({
      badClusRun: { startLcn: 40, runLength: 4 }
    });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(/Unsupported \$BadClus/);
  });

  it('refuses when two records share the clusters that must move', () => {
    const data = buildShrinkVolumeData({
      userRuns: [
        { recordNumber: 16, startLcn: SK_USER_LCN, runLength: 4 },
        { recordNumber: 17, startLcn: SK_USER_LCN + 2, runLength: 4 }
      ]
    });
    expect(() => planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS)).toThrowError(/shared with another stream/);
  });

  it('splits a relocated run across fragmented free space and leaves staying data intact', () => {
    const data = buildShrinkVolumeData({
      userRuns: [{ recordNumber: 16, startLcn: SK_USER_LCN, runLength: 8 }],
      stayingRuns: [
        { recordNumber: 20, startLcn: 20, runLength: 4 },
        { recordNumber: 21, startLcn: 28, runLength: 4 }
      ]
    });
    const plan = planNtfsShrink(shrinkVolumeReader(data), SK_TARGET_SECTORS);

    // Free below 640 is fragmented by the staying files: 17-19, 24-27, 32+.
    expect(plan.moves).toEqual([
      { srcCluster: SK_USER_LCN, dstCluster: 17, clusterCount: 3 },
      { srcCluster: SK_USER_LCN + 3, dstCluster: 24, clusterCount: 4 },
      { srcCluster: SK_USER_LCN + 7, dstCluster: 32, clusterCount: 1 }
    ]);

    const applied = applyShrinkPlan(data, plan);
    for (let c = 0; c < 8; c++) {
      const dst = [...plan.moves].find((m) => m.srcCluster <= SK_USER_LCN + c && SK_USER_LCN + c < m.srcCluster + m.clusterCount)!;
      const offset = dst.dstCluster + (SK_USER_LCN + c - dst.srcCluster);
      expect(applied.subarray(offset * SK_CLUSTER, (offset + 1) * SK_CLUSTER)).toEqual(clusterPattern(SK_USER_LCN + c));
    }

    // Staying files were not touched and still parse at their original LCNs.
    expect(recordAt(applied, 20).dataRuns).toEqual([{ startLcn: 20, runLength: 4 }]);
    expect(recordAt(applied, 21).dataRuns).toEqual([{ startLcn: 28, runLength: 4 }]);
    expect(applied.subarray(20 * SK_CLUSTER, 21 * SK_CLUSTER)).toEqual(clusterPattern(20));
    expect(applied.subarray(31 * SK_CLUSTER, 32 * SK_CLUSTER)).toEqual(clusterPattern(31));

    // The relocated file's runlist was re-encoded into three runs.
    const rec16 = recordAt(applied, 16);
    expect(rec16.dataRuns).toEqual([
      { startLcn: 17, runLength: 3 },
      { startLcn: 24, runLength: 4 },
      { startLcn: 32, runLength: 1 }
    ]);
    expect(rec16.size).toBe(8 * SK_CLUSTER);
  });
});
