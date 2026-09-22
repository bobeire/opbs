/**
 * Minimal FAT32 filesystem reader for browsing backup images.
 *
 * Implements: BPB parsing, FAT chain walking, directory entry listing
 * (8.3 short names + LFN long names), and file data reading. Does NOT
 * implement: FAT12/FAT16, exFAT, write support, or ACLs.
 */

import type { PartitionReader } from '../image-browse';

/** Parsed FAT32 BIOS Parameter Block. */
export interface Fat32Layout {
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  reservedSectors: number;
  numberOfFATs: number;
  sectorsPerFAT32: number;
  rootDirCluster: number;
  /** Byte offset of the first FAT from partition start. */
  fatStart: number;
  /** Byte offset of the first data cluster (cluster 2) from partition start. */
  dataStart: number;
  /** Total number of data clusters. */
  totalClusters: number;
}

/** A single entry returned by the directory parser. */
export interface Fat32Entry {
  name: string;
  isDirectory: boolean;
  size: number;
  startCluster: number;
  modified?: number;
}

const FAT32_EOF_MIN = 0x0FFFFFF8;
const FAT32_EOF_MAX = 0x0FFFFFFF;
const FAT32_BAD = 0x0FFFFFF7;
const ATTR_DIRECTORY = 0x10;
const ATTR_LFN = 0x0F;

/**
 * Detect the FAT flavor (FAT12/FAT16/FAT32) from a boot sector's BPB.
 *
 * The OEM name string ("FAT32   ", "MSDOS5.0") is NOT reliable — many FAT32
 * volumes carry an "MSDOS5.0" OEM id. Use the BPB fields instead: FAT32 has
 * a zero root-entry count, zero sectors-per-FAT16, and a non-zero
 * sectors-per-FAT32. FAT12/FAT16 are distinguished by their data-cluster count.
 *
 * Returns null when the sector doesn't look like a FAT volume at all.
 */
export function detectFatType(bpb: Buffer): 'FAT12' | 'FAT16' | 'FAT32' | null {
  if (bpb.length < 512) return null;
  // Valid boot-sector signature.
  if (bpb[510] !== 0x55 || bpb[511] !== 0xAA) return null;
  const bytesPerSector = bpb.readUInt16LE(0x0B);
  const sectorsPerCluster = bpb.readUInt8(0x0D);
  if (bytesPerSector === 0 || sectorsPerCluster === 0) return null;

  const reservedSectors = bpb.readUInt16LE(0x0E);
  const numberOfFATs = bpb.readUInt8(0x10);
  const rootEntryCount = bpb.readUInt16LE(0x11);
  const totalSectors16 = bpb.readUInt16LE(0x13);
  const sectorsPerFat16 = bpb.readUInt16LE(0x16);
  const totalSectors32 = bpb.readUInt32LE(0x20);
  const sectorsPerFat32 = bpb.readUInt32LE(0x24);

  // FAT32 signature fields.
  if (rootEntryCount === 0 && sectorsPerFat16 === 0 && sectorsPerFat32 > 0) {
    return 'FAT32';
  }

  // FAT12/FAT16: count data clusters.
  const totalSectors = totalSectors16 > 0 ? totalSectors16 : totalSectors32;
  const rootDirSectors = Math.ceil((rootEntryCount * 32) / bytesPerSector);
  const dataSectors = totalSectors - (reservedSectors + numberOfFATs * sectorsPerFat16 + rootDirSectors);
  if (dataSectors <= 0) return null;
  const clusterCount = Math.floor(dataSectors / sectorsPerCluster);
  if (clusterCount < 4085) return 'FAT12';
  if (clusterCount < 65525) return 'FAT16';
  return 'FAT32';
}

/**
 * Parse the FAT32 boot sector (BPB). Returns the layout or throws if the
 * volume is not FAT32.
 */
export function parseFat32BootSector(reader: PartitionReader): Fat32Layout {
  const bpb = reader.read(0, 512);
  const fatType = detectFatType(bpb);
  if (fatType !== 'FAT32') {
    const oem = bpb.toString('ascii', 3, 11);
    throw new Error(`Not a FAT32 volume (detected ${fatType ?? 'unknown'}, OEM id: "${oem}")`);
  }
  const bytesPerSector = bpb.readUInt16LE(0x0B);
  const sectorsPerCluster = bpb.readUInt8(0x0D);
  const reservedSectors = bpb.readUInt16LE(0x0E);
  const numberOfFATs = bpb.readUInt8(0x10);
  const sectorsPerFAT32 = bpb.readUInt32LE(0x24);
  const rootDirCluster = bpb.readUInt32LE(0x2C);

  if (bytesPerSector === 0 || sectorsPerCluster === 0) {
    throw new Error('Invalid FAT32 boot sector parameters');
  }

  const clusterSize = bytesPerSector * sectorsPerCluster;
  const fatStart = reservedSectors * bytesPerSector;
  const dataStart = (reservedSectors + numberOfFATs * sectorsPerFAT32) * bytesPerSector;
  const totalSectors = bpb.readUInt32LE(0x20);
  const dataSectors = totalSectors - (reservedSectors + numberOfFATs * sectorsPerFAT32);
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster);

  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSize,
    reservedSectors,
    numberOfFATs,
    sectorsPerFAT32,
    rootDirCluster,
    fatStart,
    dataStart,
    totalClusters
  };
}

/**
 * Convert a cluster number to its byte offset within the partition.
 */
export function clusterToOffset(layout: Fat32Layout, cluster: number): number {
  return layout.dataStart + (cluster - 2) * layout.clusterSize;
}

/**
 * Read a single FAT32 entry (4 bytes) for the given cluster from the FAT.
 */
function readFatEntry(reader: PartitionReader, layout: Fat32Layout, cluster: number): number {
  const fatOffset = layout.fatStart + cluster * 4;
  const buf = reader.read(fatOffset, 4);
  return buf.readUInt32LE(0) & 0x0FFFFFFF; // mask out top4 reserved bits
}

/**
 * Walk the FAT chain starting at `startCluster` and return all cluster
 * numbers in order. Stops at the end-of-chain marker.
 *
 * `maxClusters` guards against corrupt chains that would otherwise allocate
 * gigabytes (a cycle is detected separately).
 */
export function readFatChain(
  reader: PartitionReader,
  layout: Fat32Layout,
  startCluster: number,
  maxClusters = 4_000_000
): number[] {
  const chain: number[] = [];
  let current = startCluster;
  const seen = new Set<number>();
  while (current >= 2 && current < FAT32_EOF_MIN) {
    if (seen.has(current)) {
      throw new Error(`FAT chain cycle detected at cluster ${current}`);
    }
    if (chain.length >= maxClusters) {
      throw new Error(`FAT chain too long (>${maxClusters} clusters); the volume may be corrupt`);
    }
    seen.add(current);
    chain.push(current);
    current = readFatEntry(reader, layout, current);
  }
  return chain;
}

/**
 * Read raw bytes from a chain of clusters.
 */
export function readClusterChain(
  reader: PartitionReader,
  layout: Fat32Layout,
  clusters: number[],
  maxBytes = 1 << 30
): Buffer {
  const totalBytes = clusters.length * layout.clusterSize;
  if (totalBytes > maxBytes) {
    throw new Error(`FAT chain spans ${Math.round(totalBytes / (1024 * 1024))} MB (limit ${Math.round(maxBytes / (1024 * 1024))} MB); the volume may be corrupt`);
  }
  const buffers: Buffer[] = [];
  for (const cluster of clusters) {
    const offset = clusterToOffset(layout, cluster);
    buffers.push(reader.read(offset, layout.clusterSize));
  }
  return Buffer.concat(buffers);
}

/**
 * Parse FAT32 directory entries from raw cluster data.
 * Handles both 8.3 short names and LFN (Long File Name) entries.
 */
export function parseDirectoryEntries(data: Buffer): Fat32Entry[] {
  const entries: Fat32Entry[] = [];
  let lfnParts: Array<{ seq: number; chars: string }> = [];

  for (let off = 0; off + 32 <= data.length; off += 32) {
    const firstByte = data[off];
    if (firstByte === 0x00) break; // end of directory
    if (firstByte === 0xE5) { lfnParts = []; continue; } // deleted entry

    const attr = data[off + 0x0B];
    if (attr === 0x0F) {
      // LFN entry
      const seq = data[off] & 0x3F;
      const chars = readLfnChars(data, off);
      lfnParts.push({ seq, chars });
      continue;
    }

    // Skip volume labels and non-file entries
    if (attr & 0x08) { lfnParts = []; continue; }

    // 8.3 short name
    const rawName = data.toString('ascii', off, off + 11).trim();
    const name = lfnParts.length > 0
      ? assembleLfn(lfnParts)
      : formatShortName(rawName);
    lfnParts = [];

    const isDirectory = !!(attr & ATTR_DIRECTORY);
    const startClusterHigh = data.readUInt16LE(off + 20);
    const startClusterLow = data.readUInt16LE(off + 26);
    const startCluster = (startClusterHigh << 16) | startClusterLow;
    const size = data.readUInt32LE(off + 28);

    // Parse modified date/time
    const modTime = data.readUInt16LE(off + 22);
    const modDate = data.readUInt16LE(off + 24);
    const modified = fatDateTimeToTimestamp(modDate, modTime);

    entries.push({
      name,
      isDirectory,
      size: isDirectory ? 0 : size,
      startCluster,
      modified
    });
  }
  return entries;
}

/** Read the UTF-16LE characters from an LFN entry (3 name regions). */
function readLfnChars(data: Buffer, off: number): string {
  const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  let chars = '';
  for (const pos of positions) {
    const code = data.readUInt16LE(off + pos);
    if (code === 0x0000 || code === 0xFFFF) break;
    chars += String.fromCharCode(code);
  }
  return chars;
}

/** Assemble LFN parts into a single filename (sorted by sequence number). */
function assembleLfn(parts: Array<{ seq: number; chars: string }>): string {
  parts.sort((a, b) => a.seq - b.seq);
  return parts.map((p) => p.chars).join('');
}

/** Format an 8.3 short name into a readable string. */
function formatShortName(raw: string): string {
  const name = raw.slice(0, 8).trim();
  const ext = raw.slice(8, 11).trim();
  return ext ? `${name}.${ext}` : name;
}

/** Convert FAT date (days since1980-01-01) + time (2-second resolution) to Unix timestamp. */
function fatDateTimeToTimestamp(date: number, time: number): number {
  if (date === 0 && time === 0) return 0;
  const year = 1980 + ((date >> 9) & 0x7F);
  const month = ((date >> 5) & 0x0F) - 1;
  const day = date & 0x1F;
  const hours = (time >> 11) & 0x1F;
  const minutes = (time >> 5) & 0x3F;
  const seconds = (time & 0x1F) * 2;
  return Math.floor(new Date(year, month, day, hours, minutes, seconds).getTime() / 1000);
}

/**
 * Read a file's data by following its FAT cluster chain.
 */
export function readFileData(
  reader: PartitionReader,
  layout: Fat32Layout,
  startCluster: number,
  size: number
): Buffer {
  if (startCluster < 2 || size === 0) return Buffer.alloc(0);
  const chain = readFatChain(reader, layout, startCluster);
  const raw = readClusterChain(reader, layout, chain);
  return size < raw.length ? raw.subarray(0, size) : raw;
}

/**
 * List directory entries from a FAT32 directory (given its start cluster).
 * For the root directory, pass `layout.rootDirCluster`.
 */
export function listFat32Directory(
  reader: PartitionReader,
  layout: Fat32Layout,
  startCluster: number
): Fat32Entry[] {
  // Directories are small; a multi-hundred-MB "directory" means a corrupt
  // chain. Cap at 256 MB to avoid an unbounded allocation.
  const chain = readFatChain(reader, layout, startCluster, 65_536);
  const data = readClusterChain(reader, layout, chain, 256 << 20);
  return parseDirectoryEntries(data).filter(
    (e) => e.name !== '.' && e.name !== '..' && !e.name.startsWith('\x00')
  );
}

/**
 * Compute the set of block indices that contain allocated clusters, using the
 * FAT allocation table. Blocks over the metadata region (boot sector, FATs,
 * reserved) are always included. Returns null when the FAT is unreadable or
 * implausibly large, so the caller falls back to a full capture.
 */
export function readFat32UsedBlocks(
  reader: PartitionReader,
  partitionSize: number,
  blockSize: number
): Set<number> | null {
  let layout: Fat32Layout;
  try {
    layout = parseFat32BootSector(reader);
  } catch {
    return null;
  }
  const totalClusters = layout.totalClusters;
  const fatBytes = totalClusters * 4;
  if (fatBytes <= 0 || fatBytes > 256 * 1024 * 1024) return null;
  let fat: Buffer;
  try {
    fat = reader.read(layout.fatStart, fatBytes);
  } catch {
    return null;
  }
  const clusterSize = layout.clusterSize;
  const dataStart = layout.dataStart;
  const used = new Set<number>();
  const blockCount = Math.ceil(partitionSize / blockSize);
  for (let b = 0; b < blockCount; b++) {
    const start = b * blockSize;
    const end = Math.min((b + 1) * blockSize, partitionSize);
    // Metadata region (boot sector, FATs, reserved) — always capture.
    if (start < dataStart) {
      used.add(b);
      continue;
    }
    const clusterStart = 2 + Math.floor((start - dataStart) / clusterSize);
    const clusterEnd = Math.min(2 + Math.ceil((end - dataStart) / clusterSize), totalClusters + 2);
    let touched = false;
    for (let c = clusterStart; c < clusterEnd; c++) {
      const off = c * 4;
      // FAT entries past a short read are unknown — capture the block.
      if (off + 4 > fat.length || fat.readUInt32LE(off) !== 0) {
        touched = true;
        break;
      }
    }
    if (touched) used.add(b);
  }
  return used;
}
