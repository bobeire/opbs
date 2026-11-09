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
  /**
   * How each subdirectory is stored, learned while its parent is listed. A
   * directory flagged NoFatChain is one contiguous run whose FAT entries are not
   * valid, so opening it needs this and not the FAT.
   */
  dirExtents?: Map<number, { noFatChain: boolean; dataLength: number }>;
}

/** A directory entry returned by the parser. */
export interface ExfatEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  startCluster: number;
  modified?: number;
  /**
   * Stream extension flag NoFatChain: the data is one contiguous run of
   * clusters from `startCluster` and the FAT entries for it are not maintained,
   * so following the FAT reads the first cluster and stops. Windows sets it on
   * contiguous files, which is most large files on a freshly written card.
   */
  noFatChain?: boolean;
  /** ValidDataLength: bytes at or past this offset read as zero. Undefined means all of `size`. */
  validDataLength?: number;
  /** The stream's DataLength. `size` is 0 for directories, so their length lives here. */
  dataLength?: number;
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
  let pendingStream: {
    nameLength: number;
    startCluster: number;
    dataLength: number;
    noFatChain: boolean;
    validDataLength: number;
  } | null = null;
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
      // GeneralSecondaryFlags (byte 1): bit 0 AllocationPossible, bit 1 NoFatChain.
      const noFatChain = (data[off + 1] & 0x02) !== 0;
      const nameLength = data[off + 3];
      const validDataLength = Number(data.readBigUInt64LE(off + 0x08));
      const firstCluster = data.readUInt32LE(off + 0x14);
      const dataLength = Number(data.readBigUInt64LE(off + 0x18));
      pendingStream = { nameLength, startCluster: firstCluster, dataLength, noFatChain, validDataLength };
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
          modified: file.modified,
          noFatChain: stream.noFatChain,
          // A ValidDataLength of 0 with data present is how some writers leave it for
          // untouched preallocation; only a value below DataLength means "zero past here".
          validDataLength: stream.validDataLength < stream.dataLength ? stream.validDataLength : undefined,
          dataLength: stream.dataLength
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

/** Default size of the pieces a file is streamed in. */
export const EXFAT_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

export interface ExfatFileOptions {
  /** The stream is one contiguous run and its FAT entries are not valid (NoFatChain). */
  noFatChain?: boolean;
  /** Bytes at or past this offset read as zero (ValidDataLength). */
  validDataLength?: number;
  /** Piece size for streaming; a multiple of the cluster size is used. */
  chunkBytes?: number;
}

/**
 * Hand a file's bytes to `onChunk` in order, a piece at a time, so a file of any
 * size can be copied without holding it in memory. Follows the FAT chain, or
 * reads one contiguous run when the stream is flagged NoFatChain. Zeroes bytes
 * past ValidDataLength, as Windows does. Throws if the chain ends before `size`
 * bytes have been read, instead of returning a silently short file.
 */
export function forEachExfatFileChunk(
  reader: PartitionReader,
  layout: ExfatLayout,
  startCluster: number,
  size: number,
  onChunk: (chunk: Buffer) => void,
  opts: ExfatFileOptions = {}
): void {
  if (startCluster < 2 || size <= 0) return;
  const chunkBytes = Math.max(layout.clusterSize, opts.chunkBytes ?? EXFAT_STREAM_CHUNK_BYTES);
  const clustersPerChunk = Math.max(1, Math.floor(chunkBytes / layout.clusterSize));
  const validLength = opts.validDataLength;
  let emitted = 0;

  const emit = (chunk: Buffer): void => {
    let piece = chunk;
    if (piece.length > size - emitted) piece = piece.subarray(0, size - emitted);
    if (validLength !== undefined && emitted + piece.length > validLength) {
      // Copy before zeroing: a reader may hand back a view into its backing store.
      piece = Buffer.from(piece);
      piece.fill(0, Math.max(0, validLength - emitted));
    }
    emitted += piece.length;
    onChunk(piece);
  };

  if (opts.noFatChain) {
    const totalClusters = Math.ceil(size / layout.clusterSize);
    if (startCluster + totalClusters - 1 > layout.clusterCount + 1) {
      throw new Error(
        `exFAT file runs past the end of the volume (cluster ${startCluster}, ${totalClusters} clusters); the volume may be corrupt`
      );
    }
    for (let done = 0; done < totalClusters; done += clustersPerChunk) {
      const count = Math.min(clustersPerChunk, totalClusters - done);
      emit(reader.read(exfatClusterToOffset(layout, startCluster + done), count * layout.clusterSize));
    }
    return;
  }

  let current = startCluster;
  let followed = 0;
  let parts: Buffer[] = [];
  let queued = 0;
  while (emitted + queued < size) {
    if (current < 2 || current >= EXFAT_EOF_MIN || current > layout.clusterCount + 1) {
      throw new Error(
        `exFAT chain ends ${size - emitted - queued} bytes before the end of the file; the file is cut short or the volume is corrupt`
      );
    }
    if (++followed > layout.clusterCount) {
      throw new Error('exFAT chain is longer than the volume (cycle or corruption)');
    }
    parts.push(reader.read(exfatClusterToOffset(layout, current), layout.clusterSize));
    queued += layout.clusterSize;
    current = readExfatFatEntry(reader, layout, current);
    if (parts.length >= clustersPerChunk || emitted + queued >= size) {
      emit(Buffer.concat(parts));
      parts = [];
      queued = 0;
    }
  }
}

/** Read a whole file into memory, capped at `size` bytes. Prefer the chunked reader for large files. */
export function readExfatFileData(
  reader: PartitionReader,
  layout: ExfatLayout,
  startCluster: number,
  size: number,
  opts: ExfatFileOptions = {}
): Buffer {
  const pieces: Buffer[] = [];
  forEachExfatFileChunk(reader, layout, startCluster, size, (chunk) => pieces.push(chunk), opts);
  return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
}


/**
 * List a directory's entries (given its start cluster).
 *
 * Walks the FAT chain one cluster at a time and stops as soon as the
 * end-of-directory marker (entry type 0x00 on a 32-byte boundary) appears,
 * so a long or corrupt chain that continues after the real directory data
 * does not fail the listing. Cluster sizes are always multiples of 32, so
 * checking each chunk in place covers every new entry boundary.
 *
 * A subdirectory flagged NoFatChain is read as one contiguous run instead,
 * using the extent recorded when its parent was listed: its FAT entries are
 * not valid, so following them would stop after the first cluster and the
 * rest of the directory would silently go missing.
 */
export function listExfatDirectory(
  reader: PartitionReader,
  layout: ExfatLayout,
  startCluster: number
): ExfatEntry[] {
  const entries = readExfatDirectoryEntries(reader, layout, startCluster);
  // Remember how each subdirectory is stored so opening it later reads it correctly.
  const extents = (layout.dirExtents ??= new Map());
  for (const e of entries) {
    if (e.isDirectory) extents.set(e.startCluster, { noFatChain: !!e.noFatChain, dataLength: e.dataLength ?? 0 });
  }
  return entries;
}

function readExfatDirectoryEntries(reader: PartitionReader, layout: ExfatLayout, startCluster: number): ExfatEntry[] {
  const extent = layout.dirExtents?.get(startCluster);
  if (extent?.noFatChain && extent.dataLength > 0) {
    const maxBytes = 256 << 20;
    if (extent.dataLength > maxBytes) {
      throw new Error(`exFAT directory is ${Math.round(extent.dataLength / (1024 * 1024))} MB (limit 256 MB); the volume may be corrupt`);
    }
    const clusters = Math.ceil(extent.dataLength / layout.clusterSize);
    if (startCluster < 2 || startCluster + clusters - 1 > layout.clusterCount + 1) {
      throw new Error(`exFAT directory runs past the end of the volume (cluster ${startCluster}); the volume may be corrupt`);
    }
    const data = reader.read(exfatClusterToOffset(layout, startCluster), clusters * layout.clusterSize);
    return parseExfatDirectory(data).filter((e) => e.name !== '.' && e.name !== '..');
  }
  const maxBytes = 256 << 20;
  // Align the chain cap with the byte cap: for 512-byte clusters the old
  // 65_536-cluster limit was only 32 MB, rejecting valid large directories
  // well before the 256 MB allocation limit.
  const maxClusters = Math.max(65_536, Math.ceil(maxBytes / layout.clusterSize));
  const buffers: Buffer[] = [];
  let bytes = 0;
  let current = startCluster;
  const seen = new Set<number>();

  while (current >= 2 && current < EXFAT_EOF_MIN && current <= layout.clusterCount + 1) {
    if (seen.has(current)) {
      throw new Error(`exFAT chain cycle detected at cluster ${current}`);
    }
    if (buffers.length >= maxClusters || bytes >= maxBytes) {
      throw new Error(
        `exFAT chain too long (>${maxClusters} clusters); the volume may be corrupt`
      );
    }
    seen.add(current);
    const chunk = reader.read(exfatClusterToOffset(layout, current), layout.clusterSize);

    let ended = false;
    for (let off = 0; off + 32 <= chunk.length; off += 32) {
      if (chunk[off] === 0) {
        ended = true;
        break;
      }
    }
    buffers.push(chunk);
    bytes += chunk.length;
    if (ended) break;
    current = readExfatFatEntry(reader, layout, current);
  }

  const data = Buffer.concat(buffers);
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
