import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { decompressBlock, COMPRESSION_ZSTD } from '../image-format';
import { decompressQuickLz, parseQuickLzFrame } from './quicklz';

/**
 * Cached read-only file descriptors for image files. Opening/closing the file
 * on every block read dominates browse latency for large images; keeping the
 * fd open makes repeated reads fast.
 */
const fdCache = new Map<string, number>();

function getCachedFd(imagePath: string): number {
  const existing = fdCache.get(imagePath);
  if (existing !== undefined) return existing;
  const fd = fs.openSync(imagePath, 'r');
  fdCache.set(imagePath, fd);
  return fd;
}

/** Close all cached image file descriptors (call when browsing ends). */
export function closeImageFds(): void {
  for (const fd of fdCache.values()) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  fdCache.clear();
}

/**
 * Macrium Reflect image container reader.
 *
 * Two on-disk formats exist:
 *  - `.mrimgx` (Reflect X): documented by Macrium (MIT, github.com/macrium/
 *    mrimgx_file_layout). Footer -> chained metadata blocks -> $JSON -> per
 *    partition $INDEX of data blocks; blocks are zstd frames (or raw) and are
 *    addressed by a per-partition index. Supported for browsing here.
 *  - `.mrimg` (Reflect 7/8): reverse-engineered QuickLZ container with a
 *    bespoke 54-byte trailer. Blocks are QuickLZ 1.31 frames addressed by a
 *    per-partition index of 30-byte records; the footer is the image's own
 *    backup-definition XML. Supported for browsing here.
 */

export const MRIMGX_MAGIC = 'MACRIUM_FILE';
export const MRIMG_V7_MAGIC = '__79241006_2651_11D4_';
export const MRIMGX_FOOTER_SIZE = 20; // u64 metadata offset + 12 byte magic
export const MRIMG_V7_TRAILER_SIZE = 54; // 14-byte offset pointer + 40-byte trailer
export const MR_BLOCK_HEADER_SIZE = 32;
export const MR_INDEX_ELEMENT_SIZE = 30;

// .mrimg (Reflect 7/8) index layout.
export const MR_V7_RECORD_SIZE = 30; // {6 bytes pad, u64 file offset, 16 bytes md5}
export const MR_V7_PART_REC_TAIL = 36; // gap between the path end and record 0
export const MR_V7_HEADER_LEN = 9; // QuickLZ frame header (flag + u32 csize + u32 dsize)

export const BLOCK_JSON = '$JSON   ';
export const BLOCK_AUXDATA = '$AUXDATA';
export const BLOCK_TRACK0 = '$TRACK0 ';
export const BLOCK_EPT = '$EPT    ';
export const BLOCK_BITMAP = '$BITMAP ';
export const BLOCK_INDEX = '$INDEX  ';

const FLAG_LAST = 0x01;
const FLAG_COMPRESSED = 0x02;
const FLAG_ENCRYPTED = 0x04;

export type MacriumFormat = 'mrimgx' | 'mrimg-v7';

/** A single entry of a partition $INDEX: where a block lives in the file. */
export interface MacriumIndexElement {
  filePosition: number;
  md5: Buffer;
  storedLength: number;
  fileNumber: number;
}

export interface MacriumPartitionInfo {
  /** Index within the image's `disks[]` array. */
  diskIndex: number;
  /** Index within `disks[diskIndex].partitions`. */
  partitionIndex: number;
  partitionNumber: number;
  blockSize: number;
  blockCount: number;
  /** Absolute partition start / data region start (reserved sectors). */
  dataStart: number;
  fsType: string;
  fsStart: number;
  lcn0Offset: number;
  sectorsPerCluster: number;
  volumeLabel: string;
  geometry: { start: number; end: number; length: number; bootSectorOffset: number };
  partitionTableType?: number;
  blocks: MacriumIndexElement[];
}

export interface MacriumImageInfo {
  imagePath: string;
  format: 'mrimgx' | 'mrimg-v7';
  imageId: string;
  backupType: string;
  backupFormat: string;
  backupTime?: number;
  netbiosName?: string;
  fileNumber: number;
  compression: { method?: string; level?: string };
  encryption: { enable: boolean; keyIterations: number; aesType?: number; hmac?: string };
  splitFile: boolean;
  deltaIndex: boolean;
  disks: Array<{ diskNumber?: number; diskSignature?: string; diskFormat?: string; size?: number }>;
  partitions: MacriumPartitionInfo[];
}

/** Raised when a Macrium image is structurally supported but not yet readable. */
export class MacriumUnsupportedError extends Error {}

function readFileRange(imagePath: string, offset: number, length: number): Buffer {
  const fd = getCachedFd(imagePath);
  const buf = Buffer.allocUnsafe(length);
  let pos = 0;
  while (pos < length) {
    const n = fs.readSync(fd, buf, pos, length - pos, offset + pos);
    if (n <= 0) throw new Error(`Unexpected end of file reading ${imagePath} at ${offset + pos}`);
    pos += n;
  }
  return buf;
}

/** Read an exact byte range from a file (used across the mrimg modules). */
export function readImageFileRange(imagePath: string, offset: number, length: number): Buffer {
  return readFileRange(imagePath, offset, length);
}

function hasMagic(buf: Buffer, magic: string, at: number): boolean {
  if (at + magic.length > buf.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[at + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/** Detect the container flavor by its trailing magic. Returns null for non-Macrium files. */
export function detectMacriumFormat(imagePath: string): MacriumFormat | null {
  const size = fs.statSync(imagePath).size;
  if (size >= MRIMGX_FOOTER_SIZE) {
    const footer = readFileRange(imagePath, size - MRIMGX_FOOTER_SIZE, MRIMGX_FOOTER_SIZE);
    if (hasMagic(footer, MRIMGX_MAGIC, 8)) return 'mrimgx';
  }
  if (size >= MRIMG_V7_TRAILER_SIZE) {
    const tail = readFileRange(imagePath, size - MRIMG_V7_TRAILER_SIZE, MRIMG_V7_TRAILER_SIZE);
    if (hasMagic(tail, MRIMG_V7_MAGIC, 14) && tail[35] === 0) return 'mrimg-v7';
  }
  return null;
}

/** A metadata block occurrence: name, on-disk position and payload location. */
interface MetaBlockRecord {
  name: string;
  position: number;
  bodyOffset: number;
  /** On-disk (possibly compressed) payload length. */
  bodyLength: number;
  flags: number;
  /** MD5 of the stored (on-disk) payload, from the block header. */
  hash: Buffer;
}

/**
 * Walk N metadata-block groups starting at `start`. Each group is a linked
 * list terminated by the `last_block` flag; the next group begins immediately
 * after the last block's payload.
 */
function walkMetaGroups(imagePath: string, start: number, expectedGroups: number, fileSize: number): MetaBlockRecord[][] {
  const groups: MetaBlockRecord[][] = [];
  let pos = start;
  for (let g = 0; g < expectedGroups; g++) {
    const group: MetaBlockRecord[] = [];
    for (let safety = 0; safety < 1000; safety++) {
      if (pos + MR_BLOCK_HEADER_SIZE > fileSize) {
        groups.push(group);
        return groups;
      }
      const hdr = readFileRange(imagePath, pos, MR_BLOCK_HEADER_SIZE);
      const len = hdr.readUInt32LE(8);
      const flags = hdr[28];
      group.push({
        name: hdr.subarray(0, 8).toString('latin1'),
        position: pos,
        bodyOffset: pos + MR_BLOCK_HEADER_SIZE,
        bodyLength: len,
        flags,
        hash: Buffer.from(hdr.subarray(12, 28))
      });
      pos = pos + MR_BLOCK_HEADER_SIZE + len;
      if ((flags & FLAG_LAST) !== 0) break;
    }
    groups.push(group);
  }
  return groups;
}

/** Read + validate + decompress a single metadata block payload per the reference reader. */
function readMetaBlockBody(imagePath: string, block: MetaBlockRecord): Buffer {
  const stored = readFileRange(imagePath, block.bodyOffset, block.bodyLength);
  const digest = createHash('md5').update(stored).digest();
  if (!digest.equals(block.hash)) {
    throw new Error(`Macrium metadata block ${block.name} failed metadata hash check in ${imagePath}.`);
  }
  if ((block.flags & FLAG_ENCRYPTED) !== 0) {
    throw new MacriumUnsupportedError(
      'Encrypted Macrium metadata blocks are not supported yet (passphrase-protected images).'
    );
  }
  if ((block.flags & FLAG_COMPRESSED) !== 0) {
    return decompressBlock(stored, COMPRESSION_ZSTD);
  }
  return stored;
}

function parseIndexElements(buf: Buffer, offset: number, count: number): MacriumIndexElement[] {
  const out: MacriumIndexElement[] = [];
  let off = offset;
  for (let i = 0; i < count; i++) {
    if (off + MR_INDEX_ELEMENT_SIZE > buf.length) {
      throw new Error('Truncated Macrium block index.');
    }
    out.push({
      filePosition: Number(buf.readBigInt64LE(off)),
      md5: Buffer.from(buf.subarray(off + 8, off + 24)),
      storedLength: buf.readUInt32LE(off + 24),
      fileNumber: buf.readUInt16LE(off + 28)
    });
    off += MR_INDEX_ELEMENT_SIZE;
  }
  return out;
}

/** Parse the $INDEX binary payload: reserved-sector elements then data blocks. */
export function parseIndexPayload(buf: Buffer): { reserved: MacriumIndexElement[]; blocks: MacriumIndexElement[] } {
  let off = 0;
  const reservedCount = buf.readUInt32LE(off);
  off += 4;
  const reserved = parseIndexElements(buf, off, reservedCount);
  off += reservedCount * MR_INDEX_ELEMENT_SIZE;
  const dataCount = buf.readUInt32LE(off);
  off += 4;
  const blocks = parseIndexElements(buf, off, dataCount);
  return { reserved, blocks };
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  return Number.isNaN(n) ? fallback : n;
}

function numOpt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const ZERO_HASH = Buffer.alloc(16);

/**
 * Open a `.mrimg` (Reflect 7/8) image and parse its footer and per-partition
 * block indexes. Blocks are QuickLZ 1.31 frames: each index record stores the
 * file offset of a block; the block's own header carries its compressed and
 * decompressed sizes.
 */
export function readMacriumV7Image(imagePath: string): MacriumImageInfo {
  const fileSize = fs.statSync(imagePath).size;
  const trailer = readFileRange(imagePath, fileSize - MRIMG_V7_TRAILER_SIZE, MRIMG_V7_TRAILER_SIZE);
  const metaOff = Number(trailer.readBigUInt64LE(6));
  if (!(metaOff > 0 && metaOff < fileSize - MRIMG_V7_TRAILER_SIZE)) {
    throw new Error(`Invalid .mrimg metadata offset in ${imagePath}.`);
  }

  // The footer holds the length-prefixed image path, the backup-definition
  // XML, and (after each occurrence of that path) a partition block index.
  const footer = readFileRange(imagePath, metaOff, fileSize - metaOff);
  const pathLen = footer[12];
  if (pathLen === 0 || 13 + pathLen > footer.length) {
    throw new Error(`Invalid .mrimg footer in ${imagePath}.`);
  }
  const pathText = footer.subarray(13, 13 + pathLen).toString('latin1');
  const bound = footer.length - MRIMG_V7_TRAILER_SIZE;

  const markers: number[] = [];
  {
    let pos = 0;
    for (;;) {
      pos = footer.indexOf(pathText, pos);
      if (pos === -1 || pos >= bound) break;
      if (pos !== 13 && pos >= 1 && footer[pos - 1] === pathLen) markers.push(pos);
      pos += 1;
    }
  }

  const sections: Array<{ rec0: number; count: number }> = [];
  for (let k = 0; k < markers.length; k++) {
    const rec0 = markers[k] + pathLen + MR_V7_PART_REC_TAIL;
    const sectionEnd = k + 1 < markers.length ? markers[k + 1] - 1 : bound;
    if (rec0 + MR_V7_RECORD_SIZE > sectionEnd) continue;
    const count = footer.readUInt32LE(rec0 + 2);
    const need = rec0 + count * MR_V7_RECORD_SIZE;
    if (count === 0 || need > sectionEnd || sectionEnd - need > 4096) continue;
    sections.push({ rec0, count });
  }

  // Fallback for chain segments and differential/incremental images: if the
  // length-prefixed path-text marker scan found nothing, try a broader search.
  // Chain segments may use a different prefix byte or footer layout, so scan
  // for ANY occurrence of the path text and validate the block-index section
  // that follows each one.
  if (sections.length === 0) {
    let pos = 13 + pathLen; // skip the first (header) occurrence
    while (pos < bound) {
      pos = footer.indexOf(pathText, pos);
      if (pos === -1 || pos >= bound) break;
      // Try multiple offsets after the path text for the section start.
      // The primary parser uses MR_V7_PART_REC_TAIL (36 bytes) + 2 pad,
      // but chain segments may use a different gap. Try common offsets.
      for (const gap of [MR_V7_PART_REC_TAIL + 2, 2, 4, 6, 8, 10, 12, 14, 16, 18]) {
        const rec0 = pos + pathLen + gap;
        if (rec0 + MR_V7_RECORD_SIZE > bound) continue;
        const count = footer.readUInt32LE(rec0);
        if (count === 0 || count > 100_000) continue;
        const need = rec0 + 4 + count * MR_V7_RECORD_SIZE;
        if (need > bound) continue;
        const maxOffset = fileSize - MRIMG_V7_TRAILER_SIZE;
        const firstOffset = Number(footer.readBigUInt64LE(rec0 + 4 + 6));
        if (firstOffset <= 0 || firstOffset >= maxOffset) continue;
        sections.push({ rec0: rec0 + 4, count });
        break;
      }
      if (sections.length > 0) break;
      pos += 1;
    }
  }

  // Fallback: scan the footer for the block-index record structure.
  // Validates by actually reading and decompressing the first block to confirm
  // the index is real (not random footer bytes).
  if (sections.length === 0) {
    for (let off = 13 + pathLen; off < bound - 12; off++) {
      for (const countOff of [off, off + 2]) {
        if (countOff + 4 > bound) continue;
        const count = footer.readUInt32LE(countOff);
        if (count === 0 || count > 100_000) continue;
        const rec0 = countOff + 4;
        const need = rec0 + count * MR_V7_RECORD_SIZE;
        if (need > bound) continue;
        // Validate offsets: within data region, monotonically non-decreasing.
        let prevOffset = -1;
        let valid = true;
        for (let r = 0; r < count; r++) {
          const rOff = Number(footer.readBigUInt64LE(rec0 + r * MR_V7_RECORD_SIZE + 6));
          if (rOff <= 0 || rOff >= metaOff) { valid = false; break; }
          if (rOff < prevOffset) { valid = false; break; }
          prevOffset = rOff;
        }
        if (!valid) continue;
        // Validate by actually decompressing the first block. If it produces
        // valid data, the index is real. This is expensive but definitive.
        try {
          const firstOff = Number(footer.readBigUInt64LE(rec0 + 6));
          const hdr = readFileRange(imagePath, firstOff, MR_V7_HEADER_LEN);
          const frame = parseQuickLzFrame(hdr);
          const stored = readFileRange(imagePath, firstOff, frame.compressedSize);
          decompressQuickLz(stored);
        } catch {
          // First block failed to decompress — not a real block index.
          continue;
        }
        sections.push({ rec0, count });
        break;
      }
      if (sections.length > 0) break;
    }
  }

  if (sections.length === 0) {
    const isChain = /-\d{2}-\d{2}\.mrimg$/i.test(imagePath);
    if (isChain) {
      throw new Error(
        `No partition block index found in ${path.basename(imagePath)}. This may be a chain segment or differential/incremental image that cannot be browsed independently.`
      );
    }
    throw new Error(`No partition block index found in ${imagePath}. The image may be a differential/incremental backup or use an unsupported Macrium format.`);
  }

  const partitions: MacriumPartitionInfo[] = [];
  for (let k = 0; k < sections.length; k++) {
    const { rec0, count } = sections[k];
    const blocks: MacriumIndexElement[] = [];
    for (let i = 0; i < count; i++) {
      const rec = rec0 + i * MR_V7_RECORD_SIZE;
      const md5 = Buffer.from(footer.subarray(rec + 14, rec + 30));
      const filePosition = Number(footer.readBigUInt64LE(rec + 6));
      if (md5.equals(ZERO_HASH) || filePosition >= metaOff) {
        // Unallocated region: covered by zeroes. storedLength 0 = zeros.
        blocks.push({ filePosition: -1, md5, storedLength: 0, fileNumber: 0 });
      } else {
        // storedLength -1 means "resolve from the block's QuickLZ header".
        blocks.push({ filePosition, md5, storedLength: -1, fileNumber: 0 });
      }
    }
    partitions.push({
      diskIndex: 0,
      partitionIndex: k,
      partitionNumber: k + 1,
      blockSize: 1 << 16,
      blockCount: count,
      dataStart: 0,
      fsType: '',
      fsStart: 0,
      lcn0Offset: 0,
      sectorsPerCluster: 0,
      volumeLabel: '',
      geometry: { start: 0, end: 0, length: count * (1 << 16), bootSectorOffset: 0 },
      blocks
    });
  }

  // Detect compression and block size from stored block frames. Scan several
  // blocks (not just the first) and use the most common decompressed size —
  // the first block can be a partial/edge block with a smaller size.
  const candidateBlocks: MacriumIndexElement[] = [];
  for (const p of partitions) {
    for (const b of p.blocks) {
      if (b.filePosition >= 0) candidateBlocks.push(b);
      if (candidateBlocks.length >= 8) break;
    }
    if (candidateBlocks.length >= 8) break;
  }
  if (candidateBlocks.length === 0) throw new Error(`No stored data block in ${imagePath}.`);

  const sizeCounts = new Map<number, number>();
  let compressed = false;
  for (const b of candidateBlocks) {
    try {
      const qh = readFileRange(imagePath, b.filePosition, MR_V7_HEADER_LEN);
      const flag = qh.readUInt8(0);
      if ((flag & 0x01) !== 0) compressed = true;
      const dsize = (flag & 0x02) !== 0 ? qh.readUInt32LE(5) : qh.readUInt8(2);
      if (dsize >= 4096 && dsize <= 256 << 20 && (dsize & 511) === 0) {
        sizeCounts.set(dsize, (sizeCounts.get(dsize) ?? 0) + 1);
      }
    } catch {
      // Skip unreadable frames.
    }
  }
  let blockSize = 1 << 16;
  let bestCount = 0;
  for (const [size, cnt] of sizeCounts) {
    if (cnt > bestCount || (cnt === bestCount && size > blockSize)) {
      bestCount = cnt;
      blockSize = size;
    }
  }
  for (const p of partitions) {
    p.blockSize = blockSize;
    p.geometry.length = p.blockCount * blockSize;
  }

  // Light filesystem sniff from each partition's first stored block (usually
  // the boot sector), purely to decorate `mrimg info`.
  for (const p of partitions) {
    const boot = p.blocks[0];
    if (!boot || boot.filePosition < 0) continue;
    try {
      const stored = readFileRange(
        imagePath,
        boot.filePosition,
        Math.min(fileSize - boot.filePosition, blockSize + 9)
      );
      const raw = decompressQuickLz(stored);
      const sig = raw.subarray(3, 11).toString('latin1');
      if (sig.startsWith('NTFS')) p.fsType = 'ntfs';
      else if (sig.startsWith('EXFAT')) p.fsType = 'exfat';
      else if (sig.startsWith('FAT32')) p.fsType = 'fat32';
      else if (sig.startsWith('FAT16')) p.fsType = 'fat16';
    } catch {
      // Not critical: leave fsType unknown.
    }
  }

  // Optional metadata from the embedded backup-definition XML and the disk
  // descriptor (u32 timestamp + the disk's raw MBR/GPT region) that ends it.
  // The XML is u16 length-prefixed immediately before "<?xml" (u32 when the
  // prefix is 0xFFFF, past 64 KiB).
  let netbiosName: string | undefined;
  let backupFormat = 'disk';
  let isFileBackup = false;
  let diskFormat = '';
  let diskSignature: string | undefined;
  let diskSizeBytes = 0;
  let backupTime: number | undefined;
  {
    const xmlStart = footer.indexOf('<?xml', 13 + pathLen);
    if (xmlStart >= 20 && xmlStart + 7 <= footer.length) {
      let xmlLen: number;
      if (footer.readUInt16LE(xmlStart - 6) === 0xffff && footer[xmlStart - 7] === 0xff) {
        xmlLen = footer.readUInt32LE(xmlStart - 4);
      } else {
        xmlLen = footer.readUInt16LE(xmlStart - 2);
      }
      if (xmlLen > 0 && xmlStart + xmlLen <= footer.length) {
        const xmlText = footer.subarray(xmlStart, xmlStart + xmlLen).toString('latin1');
        const netbios = /<netbios>([^<]*)<\/netbios>/.exec(xmlText);
        if (netbios) netbiosName = netbios[1];
        const bt = /<backup_type>(\d+)<\/backup_type>/.exec(xmlText);
        isFileBackup = !!(bt && bt[1] === '1');
        const dir = /<directory>([^<]*)<\/directory>/.exec(xmlText);
        backupFormat = isFileBackup
          ? dir
            ? `file_and_folder (${dir[1].replace(/[\\/:]/g, '/').replace(/\/+$/, '')})`
            : 'file_and_folder'
          : 'disk';

        // Descriptor: timestamp immediately after the XML, then the raw
        // 512-byte MBR (with its GPT header/entries when present).
        const desc = xmlStart + xmlLen;
        const ht = footer.readUInt32LE(desc);
        if (ht > 100000000) backupTime = ht;
        const scanEnd = Math.min(footer.length, desc + 2048);
        let mbr = -1;
        for (let k = desc; k + 512 <= scanEnd; k++) {
          if (footer[k + 510] === 0x55 && footer[k + 511] === 0xaa) {
            mbr = k;
            break;
          }
        }
        if (mbr >= 0) {
          diskSignature = footer.subarray(mbr + 440, mbr + 444).toString('hex');
          const gptOff = mbr + 512;
          const isGpt = gptOff + 92 <= footer.length && hasMagic(footer, 'EFI PART', gptOff);
          diskFormat = isGpt ? 'gpt' : 'mbr';
          if (isGpt) {
            const altLba = footer.readBigUInt64LE(gptOff + 32);
            if (altLba > 0n && altLba < 1n << 52n) diskSizeBytes = Number((altLba + 1n) << 9n);
          } else {
            for (let i = 0; i < 4; i++) {
              const e = mbr + 446 + i * 16;
              if (footer[e + 4] === 0) continue;
              const sectors = footer.readUInt32LE(e + 12);
              if (sectors === 0) continue;
              const endByte = (footer.readUInt32LE(e + 8) + sectors) * 512;
              if (endByte > diskSizeBytes) diskSizeBytes = endByte;
            }
          }
        }
      }
    }
  }
  if (!isFileBackup) backupFormat = `disk (${diskFormat || 'mbr'})`;

  return {
    imagePath,
    format: 'mrimg-v7',
    imageId: '',
    backupType: isFileBackup ? 'file backup' : 'disk image',
    backupFormat,
    backupTime,
    fileNumber: 0,
    compression: { method: 'quicklz', level: compressed ? 'high' : 'none' },
    encryption: { enable: false, keyIterations: 0 },
    splitFile: false,
    deltaIndex: false,
    disks: [
      {
        diskNumber: 0,
        diskSignature,
        diskFormat,
        size: diskSizeBytes || Math.max(...partitions.map((p) => p.geometry.length), 0)
      }
    ],
    netbiosName,
    partitions
  };
}

/**
 * Open a `.mrimgx` (Reflect X) image and parse its full structure: footer,
 * metadata chain, $JSON navigation data, and per-partition block indexes.
 */
const macriumInfoCache = new Map<string, MacriumImageInfo>();

/** Clear the cached Macrium image parses (call when browsing ends). */
export function clearMacriumInfoCache(): void {
  macriumInfoCache.clear();
}

export function readMacriumImage(imagePath: string): MacriumImageInfo {
  const cached = macriumInfoCache.get(imagePath);
  if (cached) return cached;
  const info = readMacriumImageUncached(imagePath);
  macriumInfoCache.set(imagePath, info);
  return info;
}

function readMacriumImageUncached(imagePath: string): MacriumImageInfo {
  const format = detectMacriumFormat(imagePath);
  if (format === 'mrimg-v7') {
    return readMacriumV7Image(imagePath);
  }
  if (format !== 'mrimgx') throw new Error(`Not a Macrium Reflect image: ${imagePath}`);

  const fileSize = fs.statSync(imagePath).size;
  const footer = readFileRange(imagePath, fileSize - MRIMGX_FOOTER_SIZE, MRIMGX_FOOTER_SIZE);
  const metaOff = Number(footer.readBigUInt64LE(0));
  if (!(metaOff > 0 && metaOff < fileSize - MRIMGX_FOOTER_SIZE)) {
    throw new Error(`Invalid Macrium metadata offset in ${imagePath}.`);
  }

  // Root metadata chain holds $JSON (+ optional $AUXDATA).
  const rootBlocks = walkMetaGroups(imagePath, metaOff, 1, fileSize)[0] ?? [];
  const jsonBlock = rootBlocks.find((b) => b.name === BLOCK_JSON);
  if (!jsonBlock) throw new Error(`No $JSON metadata block found in ${imagePath}.`);
  const jsonText = readMetaBlockBody(imagePath, jsonBlock).toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Invalid $JSON metadata in ${imagePath}.`);
  }
  const json = rec(parsed);
  const header = rec(json._header);
  const compression = rec(json._compression);
  const encryption = rec(json._encryption);
  const disksRaw = json.disks;
  const disksJson: unknown[] = Array.isArray(disksRaw) ? disksRaw : [];

  const info: MacriumImageInfo = {
    imagePath,
    format: 'mrimgx',
    imageId: str(header.imageid),
    backupType: str(header.backup_type),
    backupFormat: str(header.backup_format),
    backupTime: numOpt(header.backup_time),
    netbiosName: str(header.netbios_name),
    fileNumber: num(header.file_number, 0),
    compression: {
      method: str(compression.compression_method),
      level: str(compression.compression_level)
    },
    encryption: {
      enable: Boolean(encryption.enable),
      keyIterations: num(encryption.key_iterations, 0),
      aesType: numOpt(encryption.aes_type),
      hmac: str(encryption.hmac)
    },
    splitFile: Boolean(header.split_file),
    deltaIndex: Boolean(header.delta_index),
    disks: [],
    partitions: []
  };

  const indexFilePosition = num(header.index_file_position, -1);
  if (indexFilePosition < 0) throw new Error(`Missing index_file_position in ${imagePath}.`);
  const groupCount = disksJson.length + disksJson.reduce<number>((n, d) => {
    const disk = rec(d);
    return n + arr(disk.partitions).length;
  }, 0);
  const indexGroups = walkMetaGroups(imagePath, indexFilePosition, Math.max(groupCount, 1), fileSize);

  let g = 0;
  disksJson.forEach((diskRaw, diskIndex) => {
    const diskJson = rec(diskRaw);
    const diskHeader = rec(diskJson._header);
    const geometryJson = rec(diskJson._geometry);
    info.disks.push({
      diskNumber: numOpt(diskHeader.disk_number),
      diskSignature: str(diskHeader.disk_signature),
      diskFormat: str(diskHeader.disk_format),
      size: numOpt(geometryJson.disk_size)
    });
    g++; // the disk's metadata group ($TRACK0/$EPT)
    const partitionsRaw = diskJson.partitions;
    const partitionsJson: unknown[] = arr(partitionsRaw);
    partitionsJson.forEach((partRaw, partitionIndex) => {
      const partJson = rec(partRaw);
      const partHeader = rec(partJson._header);
      const partFs = rec(partJson._file_system);
      const partGeometry = rec(partJson._geometry);
      const partTable = rec(partJson._partition_table_entry);
      const blockSize = num(partHeader.block_size, 0);
      const blockCount = num(partHeader.block_count, 0);
      const fsStart = num(partFs.start, 0);
      const lcn0Offset = num(partFs.lcn0_offset, fsStart);
      const dataStart = lcn0Offset - fsStart;

      let blocks: MacriumIndexElement[] = [];
      if (!info.splitFile) {
        const group = indexGroups[g] ?? [];
        const indexBlock = group.find((b) => b.name === BLOCK_INDEX);
        if (indexBlock) {
          const payload = readMetaBlockBody(imagePath, indexBlock);
          blocks = parseIndexPayload(payload).blocks;
        }
        g++;
      }

      info.partitions.push({
        diskIndex,
        partitionIndex,
        partitionNumber: num(partHeader.partition_number, partitionIndex + 1),
        blockSize,
        blockCount,
        dataStart,
        fsType: str(partFs.type),
        fsStart,
        lcn0Offset,
        sectorsPerCluster: num(partFs.sectors_per_cluster, 0),
        volumeLabel: str(partFs.volume_label),
        geometry: {
          start: num(partGeometry.start, 0),
          end: num(partGeometry.end, 0),
          length: num(partGeometry.length, 0),
          bootSectorOffset: num(partGeometry.boot_sector_offset, 0)
        },
        partitionTableType: numOpt(partTable.type),
        blocks
      });
    });
  });

  return info;
}