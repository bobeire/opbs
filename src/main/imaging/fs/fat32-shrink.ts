/**
 * FAT32 shrink planner.
 *
 * Mirrors the NTFS planner (`ntfs-shrink.ts`): computes a serializable
 * `Fat32ShrinkPlan` — which clusters move where, how the FAT is re-linked,
 * which directory entries change their start cluster — plus a patched boot
 * sector, backup boot and FSInfo. The plan is applied by the elevated helper
 * after the data phase; like NTFS, a failed shrink fails the job.
 *
 * FAT32 specifics versus NTFS:
 *  - The allocation structure is the FAT (a linked list of 4-byte entries),
 *    not an MFT with data runs. Relocation re-links FAT entries.
 *  - The backup boot sector lives at a FIXED BPB slot (usually sector 6), not
 *    the last sector, so it is patched in place (no relocation).
 *  - Directory entries carry a split start-cluster (high word at +20, low at
 *    +26); a chain whose head moves needs its parent entry (or the BPB root
 *    cluster) patched.
 *
 * Only clusters at/above the new boundary are relocated downward into free
 * clusters below the boundary. A chain head below the boundary keeps its start
 * cluster, so most files need no directory patch at all.
 */

import type { PartitionReader } from '../image-browse';
import { parseFat32BootSector, clusterToOffset, type Fat32Layout } from './fat32';
import { ShrinkUnsupportedError } from './ntfs-shrink';

/** One relocated run: `clusterCount` contiguous clusters moved src -> dst. */
export interface Fat32ShrinkMove {
  srcCluster: number;
  dstCluster: number;
  clusterCount: number;
  /** Partition-relative byte offset of the source run. */
  srcOffset: number;
  /** Partition-relative byte offset of the destination run. */
  dstOffset: number;
}

/** One byte region to write on the target partition (partition-relative). */
export interface Fat32ShrinkRegion {
  relativeOffset: number;
  data: Buffer;
}

export interface Fat32ShrinkPlan {
  oldTotalClusters: number;
  newTotalClusters: number;
  newTotalSectors: number;
  clusterSize: number;
  /** Sum of relocated clusters × cluster size. */
  relocatedBytes: number;
  moves: Fat32ShrinkMove[];
  /** Boot sector (512 bytes) with the new total-sector count — write first. */
  bootSector: Buffer;
  /** Patched backup boot sector (FAT32 keeps it at a fixed BPB slot). */
  backupBootRegion?: Fat32ShrinkRegion;
  /** Patched FSInfo sector (free-cluster count / next free), if present. */
  fsInfoRegion?: Fat32ShrinkRegion;
  /** Rewritten FAT ranges (one region per changed run, per FAT copy). */
  fatRegions: Fat32ShrinkRegion[];
  /** Patched directory entries (new start cluster), partition-relative. */
  dirPatches: Fat32ShrinkRegion[];
}

/** Feasibility numbers a preflight can show without building a full plan. */
export interface Fat32ShrinkMinimum {
  clusterSize: number;
  oldTotalClusters: number;
  /** Clusters referenced by the FAT (allocated, non-bad). */
  usedClusters: number;
  /** Smallest cluster count a shrink can target (used + margin, aligned). */
  minTargetClusters: number;
  minTargetSectors: number;
}

const FAT32_EOF_MIN = 0x0FFFFFF8;
const FAT32_BAD = 0x0FFFFFF7;
const ATTR_DIRECTORY = 0x10;
const ATTR_LFN = 0x0F;

/** 1 MiB margin above the used bytes for metadata slack (per the design). */
const MIN_TARGET_MARGIN = 1024 * 1024;
const ALIGN_BYTES = 1024 * 1024;
/** Guard against buffering an implausibly large FAT in memory. */
const MAX_FAT_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// FAT accessors
// ---------------------------------------------------------------------------

function fatGet(fat: Buffer, cluster: number): number {
  return fat.readUInt32LE(cluster * 4) & 0x0FFFFFFF;
}

/** Walk a FAT chain starting at `startCluster`; throws on a cycle. */
function readChain(fat: Buffer, startCluster: number, totalClusters: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let current = startCluster;
  while (current >= 2 && current < FAT32_EOF_MIN) {
    if (current > totalClusters + 1) {
      throw new ShrinkUnsupportedError(`FAT chain references cluster ${current} beyond the volume`);
    }
    if (seen.has(current)) {
      throw new ShrinkUnsupportedError(`FAT chain cycle detected at cluster ${current}`);
    }
    seen.add(current);
    chain.push(current);
    current = fatGet(fat, current);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Directory walk (tracks the partition-relative offset of each entry so a
// moved chain head can be patched in its parent entry)
// ---------------------------------------------------------------------------

interface DirChild {
  startCluster: number;
  isDirectory: boolean;
  /** Partition-relative offsets of the entry's start-cluster high/low words. */
  patchHighOffset: number;
  patchLowOffset: number;
}

function walkDirectory(
  reader: PartitionReader,
  layout: Fat32Layout,
  fat: Buffer,
  startCluster: number,
  out: DirChild[],
  visitedDirs: Set<number>
): void {
  const totalClusters = layout.totalClusters;
  const chain: number[] = [];
  const seen = new Set<number>();
  let current = startCluster;
  while (current >= 2 && current < FAT32_EOF_MIN) {
    if (seen.has(current)) {
      throw new ShrinkUnsupportedError(`Directory chain cycle detected at cluster ${current}`);
    }
    seen.add(current);
    chain.push(current);
    current = fatGet(fat, current);
  }

  for (let ci = 0; ci < chain.length; ci++) {
    const data = reader.read(clusterToOffset(layout, chain[ci]), layout.clusterSize);
    let ended = false;
    for (let off = 0; off + 32 <= data.length; off += 32) {
      const first = data[off];
      if (first === 0x00) {
        ended = true;
        break;
      }
      if (first === 0xe5 || first === 0x2e) continue; // deleted, or "." / ".."
      const attr = data[off + 0x0b];
      if (attr === ATTR_LFN) continue; // long-name part (the 8.3 entry follows)
      if (attr & 0x08) continue; // volume label
      const startHigh = data.readUInt16LE(off + 20);
      const startLow = data.readUInt16LE(off + 26);
      const childStart = (startHigh << 16) | startLow;
      if (childStart < 2) continue;
      const isDirectory = !!(attr & ATTR_DIRECTORY);
      const entryBase = clusterToOffset(layout, chain[ci]) + off;
      out.push({
        startCluster: childStart,
        isDirectory,
        patchHighOffset: entryBase + 20,
        patchLowOffset: entryBase + 26
      });
      if (isDirectory && !visitedDirs.has(childStart) && childStart <= totalClusters + 1) {
        visitedDirs.add(childStart);
        walkDirectory(reader, layout, fat, childStart, out, visitedDirs);
      }
    }
    if (ended) break;
  }
}

// ---------------------------------------------------------------------------
// Minimum
// ---------------------------------------------------------------------------

function computeMinimum(usedClusters: number, clusterSize: number, sectorsPerCluster: number): Fat32ShrinkMinimum {
  const usedBytes = usedClusters * clusterSize;
  let minTargetClusters = Math.ceil((usedBytes + MIN_TARGET_MARGIN) / clusterSize);
  if (ALIGN_BYTES % clusterSize === 0) {
    const alignClusters = ALIGN_BYTES / clusterSize;
    minTargetClusters = Math.ceil(minTargetClusters / alignClusters) * alignClusters;
  }
  return {
    clusterSize,
    oldTotalClusters: 0,
    usedClusters,
    minTargetClusters,
    minTargetSectors: minTargetClusters * sectorsPerCluster
  };
}

interface VolumeScan {
  layout: Fat32Layout;
  fat: Buffer;
  usedClusters: number;
  oldTotalClusters: number;
}

function scanVolume(reader: PartitionReader): VolumeScan {
  let layout: Fat32Layout;
  try {
    layout = parseFat32BootSector(reader);
  } catch (error) {
    throw new ShrinkUnsupportedError(
      error instanceof Error ? error.message : 'Not a shrinkable FAT32 volume'
    );
  }
  const entryCount = layout.totalClusters + 2;
  const fatBytes = entryCount * 4;
  if (fatBytes <= 0 || fatBytes > MAX_FAT_BYTES) {
    throw new ShrinkUnsupportedError(
      `FAT is ${Math.round(fatBytes / (1024 * 1024))} MB (limit ${Math.round(MAX_FAT_BYTES / (1024 * 1024))} MB); volume too large to shrink`
    );
  }
  const fat = reader.read(layout.fatStart, fatBytes);
  let used = 0;
  for (let c = 2; c <= layout.totalClusters + 1; c++) {
    const v = fatGet(fat, c);
    if (v !== 0 && v !== FAT32_BAD) used++;
  }
  return { layout, fat, usedClusters: used, oldTotalClusters: layout.totalClusters };
}

/** Feasibility summary without building a full relocation plan. */
export function fat32ShrinkMinimum(reader: PartitionReader): Fat32ShrinkMinimum {
  const scan = scanVolume(reader);
  const min = computeMinimum(scan.usedClusters, scan.layout.clusterSize, scan.layout.sectorsPerCluster);
  min.oldTotalClusters = scan.oldTotalClusters;
  return min;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Plan a shrink of the FAT32 volume readable through `reader` down to
 * `newTotalSectors` (partition-relative sector count). Throws
 * `ShrinkUnsupportedError` when the shrink cannot be planned safely.
 */
export function planFat32Shrink(reader: PartitionReader, newTotalSectors: number): Fat32ShrinkPlan {
  const scan = scanVolume(reader);
  const layout = scan.layout;
  const fat = scan.fat;
  const clusterSize = layout.clusterSize;
  const sectorsPerCluster = layout.sectorsPerCluster;

  if (!Number.isInteger(newTotalSectors) || newTotalSectors <= 0) {
    throw new ShrinkUnsupportedError(`Invalid target size ${newTotalSectors} sectors`);
  }
  // Data clusters exclude the reserved area and the FATs, matching the BPB
  // parse. The partition size itself need not be cluster-aligned (the metadata
  // shifts the data area off a raw sector multiple).
  const metaSectors = layout.reservedSectors + layout.numberOfFATs * layout.sectorsPerFAT32;
  const dataSectors = newTotalSectors - metaSectors;
  if (dataSectors <= 0) {
    throw new ShrinkUnsupportedError(`Target size ${newTotalSectors} sectors leaves no data area`);
  }
  const newTotalClusters = Math.floor(dataSectors / sectorsPerCluster);
  if (newTotalClusters >= scan.oldTotalClusters) {
    throw new ShrinkUnsupportedError(
      `Target of ${newTotalClusters} clusters is not smaller than the current volume (${scan.oldTotalClusters} clusters)`
    );
  }
  const min = computeMinimum(scan.usedClusters, clusterSize, sectorsPerCluster);
  if (newTotalClusters < min.minTargetClusters) {
    throw new ShrinkUnsupportedError(
      `Target of ${newTotalClusters} clusters is below the minimum shrink size of ${min.minTargetClusters} clusters ` +
        `(${scan.usedClusters} used + 1 MiB margin, aligned)`
    );
  }

  const boundaryCluster = newTotalClusters + 2;
  if (boundaryCluster <= 2) {
    throw new ShrinkUnsupportedError(`Target of ${newTotalClusters} clusters leaves no data area`);
  }

  // Classify clusters relative to the new boundary.
  const freeBelow: number[] = [];
  const relocatedSrcs: number[] = [];
  for (let c = 2; c < boundaryCluster; c++) {
    if (fatGet(fat, c) === 0) freeBelow.push(c);
  }
  for (let c = boundaryCluster; c <= scan.oldTotalClusters + 1; c++) {
    const v = fatGet(fat, c);
    if (v === FAT32_BAD) {
      throw new ShrinkUnsupportedError(`Volume has a bad cluster (${c}) at or above the shrink boundary`);
    }
    if (v !== 0) relocatedSrcs.push(c);
  }

  if (freeBelow.length < relocatedSrcs.length) {
    throw new ShrinkUnsupportedError(
      `Not enough free space below the new boundary: ${relocatedSrcs.length} cluster(s) must move but only ` +
        `${freeBelow.length} free cluster(s) remain below it`
    );
  }

  // Destination pool: free clusters below the boundary, ascending. Sources are
  // already ascending, so the mapping is monotonic and adjacent sources land on
  // adjacent destinations, letting runs coalesce into single moves.
  const dsts = freeBelow.slice(0, relocatedSrcs.length);
  const mapping = new Map<number, number>();
  for (let i = 0; i < relocatedSrcs.length; i++) mapping.set(relocatedSrcs[i], dsts[i]);
  const map = (c: number): number => mapping.get(c) ?? c;

  // Coalesce ascending (src, dst) pairs into contiguous runs (both sides).
  const moves: Fat32ShrinkMove[] = [];
  let i = 0;
  while (i < relocatedSrcs.length) {
    const src = relocatedSrcs[i];
    const dst = dsts[i];
    let count = 1;
    while (
      i + count < relocatedSrcs.length &&
      relocatedSrcs[i + count] === src + count &&
      dsts[i + count] === dst + count
    ) {
      count++;
    }
    moves.push({
      srcCluster: src,
      dstCluster: dst,
      clusterCount: count,
      srcOffset: clusterToOffset(layout, src),
      dstOffset: clusterToOffset(layout, dst)
    });
    i += count;
  }

  // Collect every chain (root + all directories + files) with its directory
  // entries, so moved heads can be patched.
  const children: DirChild[] = [];
  walkDirectory(reader, layout, fat, layout.rootDirCluster, children, new Set([layout.rootDirCluster]));
  const chainMap = new Map<number, number[]>();
  chainMap.set(layout.rootDirCluster, readChain(fat, layout.rootDirCluster, scan.oldTotalClusters));
  for (const child of children) {
    if (!chainMap.has(child.startCluster)) {
      chainMap.set(child.startCluster, readChain(fat, child.startCluster, scan.oldTotalClusters));
    }
  }

  // Re-link the FAT: every cluster's next pointer becomes the mapped location
  // of its successor; relocated source slots are freed.
  const fatChanges = new Map<number, number>();
  const setFat = (cluster: number, value: number): void => {
    const v = value & 0x0FFFFFFf;
    if (fatGet(fat, cluster) !== v) fatChanges.set(cluster, v);
  };
  for (const clusters of chainMap.values()) {
    const last = clusters[clusters.length - 1];
    const eof = fatGet(fat, last); // preserve the chain's end-of-chain marker
    for (let idx = 0; idx < clusters.length; idx++) {
      const cur = map(clusters[idx]);
      const nextVal = idx + 1 < clusters.length ? map(clusters[idx + 1]) : eof;
      setFat(cur, nextVal);
    }
  }
  for (const src of relocatedSrcs) setFat(src, 0);

  // Patch directory entries whose chain head moved (root is patched via the BPB).
  const dirPatchMap = new Map<number, Buffer>();
  for (const child of children) {
    if (!mapping.has(child.startCluster)) continue;
    const newStart = mapping.get(child.startCluster)!;
    const high = Buffer.alloc(2);
    high.writeUInt16LE((newStart >>> 16) & 0xffff, 0);
    const low = Buffer.alloc(2);
    low.writeUInt16LE(newStart & 0xffff, 0);
    dirPatchMap.set(child.patchHighOffset, high);
    dirPatchMap.set(child.patchLowOffset, low);
  }
  const dirPatches: Fat32ShrinkRegion[] = [...dirPatchMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([relativeOffset, data]) => ({ relativeOffset, data }));

  // Boot sector: new total sectors + relocated root cluster (if it moved).
  const bootSector = Buffer.from(reader.read(0, 512));
  bootSector.writeUInt32LE(newTotalSectors >>> 0, 0x20);
  const newRootCluster = map(layout.rootDirCluster);
  if (newRootCluster !== layout.rootDirCluster) {
    bootSector.writeUInt32LE(newRootCluster >>> 0, 0x2c);
  }

  // Backup boot sector: FAT32 keeps it at a fixed BPB slot (not the last sector).
  let backupBootRegion: Fat32ShrinkRegion | undefined;
  const backupSector = bootSector.readUInt16LE(0x32);
  if (backupSector > 0 && backupSector < layout.reservedSectors && backupSector !== 0xffff) {
    backupBootRegion = { relativeOffset: backupSector * layout.bytesPerSector, data: bootSector };
  }

  // FSInfo: free-cluster count and next-free hint.
  let fsInfoRegion: Fat32ShrinkRegion | undefined;
  const fsInfoSector = bootSector.readUInt16LE(0x30);
  if (fsInfoSector > 0 && fsInfoSector < layout.reservedSectors && fsInfoSector !== 0xffff) {
    const fsInfo = Buffer.from(reader.read(fsInfoSector * layout.bytesPerSector, 512));
    let freeCount = 0;
    let nextFree = 0xffffffff;
    for (let c = 2; c < boundaryCluster; c++) {
      const v = fatChanges.has(c) ? fatChanges.get(c)! : fatGet(fat, c);
      if (v === 0) {
        freeCount++;
        if (nextFree === 0xffffffff) nextFree = c;
      }
    }
    fsInfo.writeUInt32LE(freeCount >>> 0, 0x1e8);
    fsInfo.writeUInt32LE(nextFree >>> 0, 0x1ec);
    fsInfoRegion = { relativeOffset: fsInfoSector * layout.bytesPerSector, data: fsInfo };
  }

  // Rewrite only the changed FAT ranges (the whole FAT can be gigabytes).
  const sortedClusters = [...fatChanges.keys()].sort((a, b) => a - b);
  const fatRegions: Fat32ShrinkRegion[] = [];
  let ri = 0;
  while (ri < sortedClusters.length) {
    const start = sortedClusters[ri];
    let end = start + 1;
    ri++;
    while (ri < sortedClusters.length && sortedClusters[ri] === end) {
      end++;
      ri++;
    }
    const data = Buffer.alloc((end - start) * 4);
    for (let c = start; c < end; c++) {
      data.writeUInt32LE(fatChanges.get(c)! >>> 0, (c - start) * 4);
    }
    for (let f = 0; f < layout.numberOfFATs; f++) {
      const fatOffset = layout.fatStart + f * layout.sectorsPerFAT32 * layout.bytesPerSector;
      fatRegions.push({ relativeOffset: fatOffset + start * 4, data });
    }
  }

  const relocatedBytes = moves.reduce((sum, m) => sum + m.clusterCount * clusterSize, 0);

  return {
    oldTotalClusters: scan.oldTotalClusters,
    newTotalClusters,
    newTotalSectors,
    clusterSize,
    relocatedBytes,
    moves,
    bootSector,
    backupBootRegion,
    fsInfoRegion,
    fatRegions,
    dirPatches
  };
}
