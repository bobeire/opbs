import { describe, it, expect } from 'vitest';
import { planFat32Shrink, fat32ShrinkMinimum, ShrinkUnsupportedError } from '../../src/main/imaging/fs/fat32-shrink';
import { parseFat32BootSector, readFatChain, listFat32Directory, clusterToOffset } from '../../src/main/imaging/fs/fat32';
import {
  buildFat32ShrinkVolume,
  fat32VolumeReader,
  applyFat32ShrinkPlan,
  fat32ClusterPattern,
  F32_CLUSTER,
  F32_SPC,
  F32_TOTAL_CLUSTERS,
  F32_TOTAL_SECTORS,
  F32_FILE_A_CLUSTER,
  F32_FILE_B_CLUSTER,
  F32_SUBDIR_CLUSTER,
  F32_INNER_CLUSTER,
  F32_DATA_START_SECTOR,
  F32_SECTOR
} from '../helpers/fat32-shrink-fixture';

const F32_TARGET_CLUSTERS = 512;
// Target partition size that leaves exactly 512 data clusters (metadata + data).
const F32_TARGET_SECTORS = F32_DATA_START_SECTOR + F32_TARGET_CLUSTERS * F32_SPC;

function fatEntry(data: Buffer, cluster: number): number {
  const fatStart = 32 * F32_SECTOR;
  return data.readUInt32LE(fatStart + cluster * 4) & 0x0fffffff;
}

describe('planFat32Shrink', () => {
  it('plans a shrink, relocates tail data and the applied volume re-parses', () => {
    const data = buildFat32ShrinkVolume();
    const plan = planFat32Shrink(fat32VolumeReader(data), F32_TARGET_SECTORS);

    expect(plan.oldTotalClusters).toBe(F32_TOTAL_CLUSTERS);
    expect(plan.newTotalClusters).toBe(F32_TARGET_CLUSTERS);
    expect(plan.newTotalSectors).toBe(F32_TARGET_SECTORS);
    expect(plan.moves.map((m) => ({ src: m.srcCluster, dst: m.dstCluster, n: m.clusterCount }))).toEqual([
      { src: F32_FILE_A_CLUSTER, dst: 3, n: 2 },
      { src: F32_INNER_CLUSTER, dst: 6, n: 1 }
    ]);
    expect(plan.relocatedBytes).toBe(3 * F32_CLUSTER);
    expect(plan.bootSector.readUInt32LE(0x20)).toBe(F32_TARGET_SECTORS);
    expect(plan.backupBootRegion?.relativeOffset).toBe(6 * F32_SECTOR);
    // FILE_A and INNER heads moved, so both directory entries get high+low patches.
    expect(plan.dirPatches).toHaveLength(4);

    const applied = applyFat32ShrinkPlan(data, plan);
    const reader = fat32VolumeReader(applied);
    const layout = parseFat32BootSector(reader);

    expect(layout.totalClusters).toBe(F32_TARGET_CLUSTERS);
    expect(applied.readUInt32LE(6 * F32_SECTOR + 0x20)).toBe(F32_TARGET_SECTORS);

    // Root points FILE_A at its relocated head (3); the chain resolves, data intact.
    const rootEntries = listFat32Directory(reader, layout, layout.rootDirCluster);
    const fileA = rootEntries.find((e) => e.name === 'FILE_A');
    expect(fileA?.startCluster).toBe(3);
    expect(readFatChain(reader, layout, fileA!.startCluster)).toEqual([3, 4]);
    for (let c = 0; c < 2; c++) {
      const off = clusterToOffset(layout, 3 + c);
      expect(applied.subarray(off, off + F32_CLUSTER)).toEqual(fat32ClusterPattern(F32_FILE_A_CLUSTER + c));
    }

    // The subdirectory still resolves; its inner file moved to 6.
    const subEntries = listFat32Directory(reader, layout, F32_SUBDIR_CLUSTER);
    const inner = subEntries.find((e) => e.name === 'INNER');
    expect(inner?.startCluster).toBe(6);
    expect(readFatChain(reader, layout, inner!.startCluster)).toEqual([6]);

    // Old tail clusters freed; below-boundary file untouched.
    expect(fatEntry(applied, F32_FILE_A_CLUSTER)).toBe(0);
    expect(fatEntry(applied, F32_FILE_A_CLUSTER + 1)).toBe(0);
    expect(fatEntry(applied, F32_INNER_CLUSTER)).toBe(0);
    expect(readFatChain(reader, layout, F32_FILE_B_CLUSTER)).toEqual([F32_FILE_B_CLUSTER]);

    // FSInfo free count reflects the shrunken volume (512 - 6 used = 506).
    expect(applied.readUInt32LE(F32_SECTOR + 0x1e8)).toBe(506);
  });

  it('reports the used-cluster minimum without building a plan', () => {
    const data = buildFat32ShrinkVolume();
    const min = fat32ShrinkMinimum(fat32VolumeReader(data));

    expect(min.oldTotalClusters).toBe(F32_TOTAL_CLUSTERS);
    // root + FILE_A(2) + FILE_B + SUBDIR + INNER = 6 used clusters.
    expect(min.usedClusters).toBe(6);
    expect(min.minTargetClusters).toBe(512);
    expect(min.minTargetSectors).toBe(512 * F32_SPC);
  });

  it('refuses a target below the minimum shrink size', () => {
    const data = buildFat32ShrinkVolume();
    expect(() => planFat32Shrink(fat32VolumeReader(data), 256 * F32_SPC)).toThrow(ShrinkUnsupportedError);
  });

  it('refuses a target that is not smaller than the volume', () => {
    const data = buildFat32ShrinkVolume();
    expect(() => planFat32Shrink(fat32VolumeReader(data), F32_TOTAL_SECTORS)).toThrow(/not smaller/);
  });

  it('refuses a target that leaves no data area', () => {
    const data = buildFat32ShrinkVolume();
    expect(() => planFat32Shrink(fat32VolumeReader(data), F32_DATA_START_SECTOR)).toThrow(/no data area/);
  });

  it('refuses a volume that is not FAT32', () => {
    const data = Buffer.alloc(F32_TOTAL_SECTORS * F32_SECTOR);
    data.writeUInt16LE(0xaa55, 0x1fe);
    expect(() => planFat32Shrink(fat32VolumeReader(data), F32_TARGET_SECTORS)).toThrow(/Not a FAT32/);
  });

  it('refuses when a bad cluster sits at or above the boundary', () => {
    const data = buildFat32ShrinkVolume();
    // Mark cluster 800 (above the 514 boundary) bad in the first FAT.
    data.writeUInt32LE(0x0ffffff7, 32 * F32_SECTOR + 800 * 4);
    expect(() => planFat32Shrink(fat32VolumeReader(data), F32_TARGET_SECTORS)).toThrow(/bad cluster/);
  });
});
