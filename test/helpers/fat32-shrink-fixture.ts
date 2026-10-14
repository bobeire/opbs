import { PartitionReader } from '../../src/main/imaging/image-browse';
import { Fat32ShrinkPlan } from '../../src/main/imaging/fs/fat32-shrink';

export const F32_SECTOR = 512;
export const F32_SPC = 8;
export const F32_CLUSTER = F32_SECTOR * F32_SPC; // 4096
export const F32_RESERVED = 32;
export const F32_FATS = 2;
export const F32_SECTORS_PER_FAT = 9;
export const F32_TOTAL_CLUSTERS = 1024; // 4 MiB data area
export const F32_ROOT_CLUSTER = 2;
export const F32_DATA_START_SECTOR = F32_RESERVED + F32_FATS * F32_SECTORS_PER_FAT; // 50
export const F32_DATA_START = F32_DATA_START_SECTOR * F32_SECTOR;
export const F32_TOTAL_SECTORS = F32_DATA_START_SECTOR + F32_TOTAL_CLUSTERS * F32_SPC; // 8242
export const F32_FSINFO_SECTOR = 1;
export const F32_BACKUP_SECTOR = 6;

/** Used (root + files/dirs) clusters; the default target leaves free space. */
export const F32_FILE_A_CLUSTER = 600; // above the 512-cluster boundary
export const F32_FILE_B_CLUSTER = 5; // below the boundary, stays put
export const F32_SUBDIR_CLUSTER = 300; // below the boundary, stays put
export const F32_INNER_CLUSTER = 700; // above the boundary, relocates

/** Deterministic per-cluster filler so relocated data can be verified. */
export function fat32ClusterPattern(cluster: number): Buffer {
  const b = Buffer.alloc(F32_CLUSTER);
  for (let i = 0; i < F32_CLUSTER; i++) b[i] = (cluster * 37 + i * 11) & 0xff;
  return b;
}

function writeDirEntry(dir: Buffer, offset: number, name: string, attr: number, startCluster: number, size: number): void {
  const short = name.padEnd(11, ' ').slice(0, 11).toUpperCase();
  dir.write(short, offset, 'ascii');
  dir.writeUInt8(attr, offset + 0x0b);
  dir.writeUInt16LE((startCluster >>> 16) & 0xffff, offset + 0x14);
  dir.writeUInt16LE(startCluster & 0xffff, offset + 0x1a);
  dir.writeUInt32LE(size >>> 0, offset + 0x1c);
}

/**
 * A synthetic FAT32 volume: root with a below-boundary file, an above-boundary
 * file and a subdirectory; the subdirectory holds an above-boundary file.
 * Shrinking to 512 clusters relocates the two above-boundary chains (600/601
 * and 700) down into free space and patches their directory entries.
 */
export function buildFat32ShrinkVolume(): Buffer {
  const buf = Buffer.alloc(F32_TOTAL_SECTORS * F32_SECTOR);

  // Boot sector (BPB).
  buf.write('FAT32   ', 3, 'ascii');
  buf.writeUInt16LE(F32_SECTOR, 0x0b);
  buf.writeUInt8(F32_SPC, 0x0d);
  buf.writeUInt16LE(F32_RESERVED, 0x0e);
  buf.writeUInt8(F32_FATS, 0x10);
  buf.writeUInt8(0xf8, 0x15); // media
  buf.writeUInt32LE(F32_TOTAL_SECTORS, 0x20);
  buf.writeUInt32LE(F32_SECTORS_PER_FAT, 0x24);
  buf.writeUInt32LE(F32_ROOT_CLUSTER, 0x2c);
  buf.writeUInt16LE(F32_FSINFO_SECTOR, 0x30);
  buf.writeUInt16LE(F32_BACKUP_SECTOR, 0x32);
  buf.writeUInt8(0x29, 0x42); // boot signature
  buf.writeUInt16LE(0xaa55, 0x1fe);

  // Backup boot sector (a copy of the primary).
  buf.copy(buf, F32_BACKUP_SECTOR * F32_SECTOR, 0, F32_SECTOR);

  // FSInfo (sector 1).
  const fsInfo = Buffer.alloc(F32_SECTOR);
  fsInfo.writeUInt32LE(0x41615252, 0x00);
  fsInfo.writeUInt32LE(0x61417272, 0x1e4);
  fsInfo.writeUInt32LE(0xffffffff, 0x1e8); // free count (unknown)
  fsInfo.writeUInt32LE(0xffffffff, 0x1ec); // next free (unknown)
  fsInfo.writeUInt32LE(0xaa550000, 0x1f4);
  fsInfo.copy(buf, F32_FSINFO_SECTOR * F32_SECTOR);

  const fatStart = F32_RESERVED * F32_SECTOR;
  const fatSize = F32_SECTORS_PER_FAT * F32_SECTOR;
  const setFat = (fat: Buffer, cluster: number, value: number): void => {
    fat.writeUInt32LE(value & 0x0fffffff, cluster * 4);
  };
  const EOF = 0x0fffffff;

  for (let f = 0; f < F32_FATS; f++) {
    const fat = Buffer.alloc(fatSize);
    // Root chain (single cluster).
    setFat(fat, F32_ROOT_CLUSTER, EOF);
    // FILE_A: 600 -> 601 -> EOF (two clusters, above the boundary).
    setFat(fat, F32_FILE_A_CLUSTER, F32_FILE_A_CLUSTER + 1);
    setFat(fat, F32_FILE_A_CLUSTER + 1, EOF);
    // FILE_B: single cluster below the boundary.
    setFat(fat, F32_FILE_B_CLUSTER, EOF);
    // SUBDIR: single cluster below the boundary.
    setFat(fat, F32_SUBDIR_CLUSTER, EOF);
    // INNER: single cluster above the boundary.
    setFat(fat, F32_INNER_CLUSTER, EOF);
    fat.copy(buf, fatStart + f * fatSize);
  }

  // Root directory (cluster 2).
  const root = Buffer.alloc(F32_CLUSTER);
  writeDirEntry(root, 0, 'FILE_A', 0x20, F32_FILE_A_CLUSTER, 2 * F32_CLUSTER);
  writeDirEntry(root, 32, 'FILE_B', 0x20, F32_FILE_B_CLUSTER, F32_CLUSTER);
  writeDirEntry(root, 64, 'SUBDIR', 0x10, F32_SUBDIR_CLUSTER, 0);
  root.copy(buf, F32_DATA_START + (F32_ROOT_CLUSTER - 2) * F32_CLUSTER);

  // SUBDIR directory (cluster 300).
  const sub = Buffer.alloc(F32_CLUSTER);
  writeDirEntry(sub, 0, 'INNER', 0x20, F32_INNER_CLUSTER, F32_CLUSTER);
  sub.copy(buf, F32_DATA_START + (F32_SUBDIR_CLUSTER - 2) * F32_CLUSTER);

  // File data.
  for (const c of [F32_FILE_A_CLUSTER, F32_FILE_A_CLUSTER + 1, F32_FILE_B_CLUSTER, F32_INNER_CLUSTER]) {
    fat32ClusterPattern(c).copy(buf, F32_DATA_START + (c - 2) * F32_CLUSTER);
  }

  return buf;
}

export function fat32VolumeReader(data: Buffer): PartitionReader {
  return {
    size: data.length,
    read: (offset: number, length: number) => data.subarray(offset, offset + length)
  };
}

/** In-test reference applier mirroring the helper contract: boot sector first
 *  (plus its fixed backup), then data moves, then directory patches, then the
 *  rewritten FAT ranges and the FSInfo sector. */
export function applyFat32ShrinkPlan(data: Buffer, plan: Fat32ShrinkPlan): Buffer {
  plan.bootSector.copy(data, 0);
  if (plan.backupBootRegion) plan.bootSector.copy(data, plan.backupBootRegion.relativeOffset);
  for (const move of plan.moves) {
    data.copy(data, move.dstOffset, move.srcOffset, move.srcOffset + move.clusterCount * plan.clusterSize);
  }
  for (const patch of plan.dirPatches) patch.data.copy(data, patch.relativeOffset);
  for (const region of plan.fatRegions) region.data.copy(data, region.relativeOffset);
  if (plan.fsInfoRegion) plan.fsInfoRegion.data.copy(data, plan.fsInfoRegion.relativeOffset);
  return data;
}
