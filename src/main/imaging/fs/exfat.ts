/**
 * Minimal exFAT filesystem reader for browsing backup images.
 *
 * Implements: VBR parsing, FAT chain walking, directory entry listing
 * (file + stream-extension + filename entry sets), and file data reading.
 * Does NOT implement: write support, allocation bitmap, up-case tables, or
 * TexFAT.
 */

import type { PartitionReader } from '../image-browse';
import { logger } from '../../utils/logger';

/** Parsed exFAT Volume Boot Record. */
export interface ExfatLayout {
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  /** Byte offset of the FAT from partition start. */
  fatStart: number;
  /** Byte offset of the cluster heap (cluster 2) from partition start. */
  heapStart: number;
  clusterCount: number;
  rootDirCluster: number;
  volumeLabel: string;
}

/** A directory entry returned by the parser. */
export interface ExfatEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  startCluster: number;
  modified?: number;
}

const EXFAT_EOF_MIN = 0xFFFFFFF8;
const ATTR_DIRECTORY = 0x10;

/**
 * Detect whether a boot sector is exFAT (OEM name "EXFAT   " and the
 * characteristic zeroed fields).
 */
export function detectExfat(bpb: Buffer): boolean {
  if (bpb.length < 512) return false;
  if (bpb.toString('ascii', 3, 11) !== 'EXFAT   ') return false;
  if (bpb[510] !== 0x55 || bpb[511] !== 0xAA) return false;
  // BytesPerSectorShift / SectorsPerClusterShift are at 0x6C / 0x6D.
  // (0x6A is VolumeFlags; 0x6E is NumberOfFats.)
  const sectorShift = bpb.readUInt8(0x6c);
  const clusterShift = bpb.readUInt8(0x6d);
  return sectorShift >= 9 && sectorShift <= 12 && clusterShift <= 25;
}

/**
 * Parse the exFAT boot sector (VBR).
 */
export function parseExfatBootSector(reader: PartitionReader): ExfatLayout {
  const bpb = reader.read(0, 512);
  if (!detectExfat(bpb)) {
    throw new Error('Not an exFAT volume');
  }
  const sectorShift = bpb.readUInt8(0x6c);
  const clusterShift = bpb.readUInt8(0x6d);
  const bytesPerSector = 1 << sectorShift;
  const sectorsPerCluster = 1 << clusterShift;
  const clusterSize = bytesPerSector * sectorsPerCluster;
  const fatOffsetSectors = bpb.readUInt32LE(0x50);
  const clusterHeapOffsetSectors = bpb.readUInt32LE(0x58);
  const clusterCount = bpb.readUInt32LE(0x5C);
  const rootDirCluster = bpb.readUInt32LE(0x60);

  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSize,
    fatStart: fatOffsetSectors * bytesPerSector,
    heapStart: clusterHeapOffsetSectors * bytesPerSector,
    clusterCount,
    rootDirCluster,
    volumeLabel: ''
  };
}

/** Convert a cluster number to its byte offset within the partition. */
export function exfatClusterToOffset(layout: ExfatLayout, cluster: number): number {
  return layout.heapStart + (cluster - 2) * layout.clusterSize;
}

/** Read one FAT entry (4 bytes) for the given cluster. */
function readExfatFatEntry(reader: PartitionReader, layout: ExfatLayout, cluster: number): number {
  const buf = reader.read(layout.fatStart + cluster * 4, 4);
  return buf.readUInt32LE(0);
}

/** Walk the exFAT FAT chain from `startCluster` to the end-of-chain marker. */
export function readExfatChain(
  reader: PartitionReader,
  layout: ExfatLayout,
  startCluster: number,
  maxClusters = 4_000_000
): number[] {
  const chain: number[] = [];
  let current = startCluster;
  const seen = new Set<number>();
  while (current >= 2 && current < EXFAT_EOF_MIN && current <= layout.clusterCount + 1) {
    if (seen.has(current)) {
      throw new Error(`exFAT chain cycle detected at cluster ${current}`);
    }
    if (chain.length >= maxClusters) {
      throw new Error(`exFAT chain too long (>${maxClusters} clusters); the volume may be corrupt`);
    }
    seen.add(current);
    chain.push(current);
    current = readExfatFatEntry(reader, layout, current);
  }
  return chain;
}

/** Read raw bytes from a chain of clusters. */
function readExfatChainData(
  reader: PartitionReader,
  layout: ExfatLayout,
  clusters: number[],
  maxBytes = 1 << 30
): Buffer {
  const totalBytes = clusters.length * layout.clusterSize;
  if (totalBytes > maxBytes) {
    throw new Error(`exFAT chain spans ${Math.round(totalBytes / (1024 * 1024))} MB (limit ${Math.round(maxBytes / (1024 * 1024))} MB); the volume may be corrupt`);
  }
  const buffers: Buffer[] = [];
  for (const cluster of clusters) {
    buffers.push(reader.read(exfatClusterToOffset(layout, cluster), layout.clusterSize));
  }
  return Buffer.concat(buffers);
}

/**
 * Parse a run of exFAT directory entries into files/directories.
 *
 * Each file is a set: 1 File entry (0x85) + 1 Stream extension (0xC0) +
 * N FileName entries (0xC1). Directory entries are collected across the set.
 */
export function parseExfatDirectory(data: Buffer): ExfatEntry[] {
  const entries: ExfatEntry[] = [];
  let pendingFile: { attrs: number; modified?: number } | null = null;
  let pendingStream: { nameLength: number; startCluster: number; dataLength: number } | null = null;
  let nameParts: string[] = [];

  for (let off = 0; off + 32 <= data.length; off += 32) {
    const type = data[off];
    if (type === 0x00) break; // end of directory

    if (type === 0x85) {
      // File entry — start of a new set.
      const attrs = data.readUInt16LE(off + 4);
      const modTime = data.readUInt16LE(off + 0x0C);
      const modDate = data.readUInt16LE(off + 0x0E);
      pendingFile = { attrs, modified: exfatDateTimeToTimestamp(modDate, modTime) };
      pendingStream = null;
      nameParts = [];
      continue;
    }

    if (type === 0xC0 && pendingFile) {
      // Stream extension.
      const nameLength = data[off + 3];
      const firstCluster = data.readUInt32LE(off + 0x14);
      const dataLength = Number(data.readBigUInt64LE(off + 0x18));
      pendingStream = { nameLength, startCluster: firstCluster, dataLength };
      continue;
    }

    if (type === 0xC1 && pendingStream && pendingFile) {
      // FileName entry — 15 UTF-16LE chars.
      for (let c = 0; c < 15; c++) {
        const code = data.readUInt16LE(off + 2 + c * 2);
        if (code !== 0) nameParts.push(String.fromCharCode(code));
      }
      // When the name is complete, emit the entry.
      const name = nameParts.join('').slice(0, pendingStream.nameLength);
      if (name.length >= pendingStream.nameLength) {
        const file = pendingFile;
        const stream = pendingStream;
        entries.push({
          name,
          isDirectory: (file.attrs & ATTR_DIRECTORY) !== 0,
          size: (file.attrs & ATTR_DIRECTORY) !== 0 ? 0 : stream.dataLength,
          startCluster: stream.startCluster,
          modified: file.modified
        });
        pendingFile = null;
        pendingStream = null;
        nameParts = [];
      }
      continue;
    }

    // Allocation bitmap (0x81), up-case table (0x82), volume label (0x83),
    // vendor extension (0xA0-0xA3), etc. — ignore.
  }

  return entries;
}

/** Convert an exFAT timestamp (same layout as FAT) to a Unix timestamp. */
function exfatDateTimeToTimestamp(date: number, time: number): number {
  if (date === 0 && time === 0) return 0;
  const year = 1980 + ((date >> 9) & 0x7F);
  const month = ((date >> 5) & 0x0F) - 1;
  const day = date & 0x1F;
  const hours = (time >> 11) & 0x1F;
  const minutes = (time >> 5) & 0x3F;
  const seconds = (time & 0x1F) * 2;
  return Math.floor(new Date(year, month, day, hours, minutes, seconds).getTime() / 1000);
}

/** Read a file's data by following its FAT chain, capped at `size` bytes. */
export function readExfatFileData(
  reader: PartitionReader,
  layout: ExfatLayout,
  startCluster: number,
  size: number
): Buffer {
  if (startCluster < 2 || size === 0) return Buffer.alloc(0);
  const chain = readExfatChain(reader, layout, startCluster);
  const raw = readExfatChainData(reader, layout, chain);
  return size < raw.length ? raw.subarray(0, size) : raw;
}

/** List a directory's entries (given its start cluster). */
export function listExfatDirectory(
  reader: PartitionReader,
  layout: ExfatLayout,
  startCluster: number
): ExfatEntry[] {
  // Directories are small; cap at 256 MB to avoid an unbounded allocation on
  // a corrupt chain.
  const chain = readExfatChain(reader, layout, startCluster, 65_536);
  const data = readExfatChainData(reader, layout, chain, 256 << 20);
  return parseExfatDirectory(data).filter((e) => e.name !== '.' && e.name !== '..');
}

/**
 * Compute the set of block indices that contain allocated clusters, using the
 * exFAT allocation bitmap (directory entry 0x81). Blocks over the metadata
 * region (boot sector, FAT, cluster heap header) are always included. Returns
 * null when the bitmap cannot be resolved, so the caller falls back to a full
 * capture.
 */
export function readExfatUsedBlocks(
  reader: PartitionReader,
  partitionSize: number,
  blockSize: number
): Set<number> | null {
  let layout: ExfatLayout;
  try {
    layout = parseExfatBootSector(reader);
  } catch (e) {
    logger.warn(`exFAT used-blocks: boot sector parse failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  // Locate the allocation bitmap entry in the root directory.
  let bitmap: Buffer | null = null;
  try {
    const rootChain = readExfatChain(reader, layout, layout.rootDirCluster, 65_536);
    const root = readExfatChainData(reader, layout, rootChain, 16 << 20);
    for (let off = 0; off + 32 <= root.length; off += 32) {
      const type = root[off];
      if (type === 0x00) break;
      if (type === 0x81) {
        const firstCluster = root.readUInt32LE(off + 0x14);
        const dataLength = Number(root.readBigUInt64LE(off + 0x18));
        if (dataLength > 0 && dataLength <= 64 * 1024 * 1024) {
          const chain = readExfatChain(reader, layout, firstCluster, 65_536);
          bitmap = readExfatChainData(reader, layout, chain, dataLength + layout.clusterSize).subarray(0, dataLength);
        }
        break;
      }
    }
  } catch (e) {
    logger.warn(`exFAT used-blocks: bitmap read failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  if (!bitmap) {
    logger.warn('exFAT used-blocks: no allocation bitmap (0x81) entry found in the root directory');
    return null;
  }

  const clusterSize = layout.clusterSize;
  const heapStart = layout.heapStart;
  const used = new Set<number>();
  const blockCount = Math.ceil(partitionSize / blockSize);
  for (let b = 0; b < blockCount; b++) {
    const start = b * blockSize;
    const end = Math.min((b + 1) * blockSize, partitionSize);
    // Metadata region (boot sector, FAT, heap header) — always capture.
    if (start < heapStart) {
      used.add(b);
      continue;
    }
    const clusterStart = 2 + Math.floor((start - heapStart) / clusterSize);
    const clusterEnd = 2 + Math.ceil((end - heapStart) / clusterSize);
    let touched = false;
    for (let c = clusterStart; c < clusterEnd; c++) {
      const bitIndex = c - 2;
      const byteIndex = bitIndex >> 3;
      // Bits past the end of a short/truncated bitmap mean "unknown" — treat
      // as allocated so a deep directory whose clusters sit beyond the bitmap
      // is still captured (browsing would otherwise hit "No block N").
      if (byteIndex >= bitmap.length || (bitmap[byteIndex] & (1 << (bitIndex & 7))) !== 0) {
        touched = true;
        break;
      }
    }
    if (touched) used.add(b);
  }
  return used;
}
