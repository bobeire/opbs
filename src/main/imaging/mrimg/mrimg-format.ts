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
// Delta-incremental (.mrimg) index: a chain member stores only blocks that
// changed since its base. Each delta record is the 30-byte base record plus a
// 4-byte logical-block index inserted after the 6-byte prefix, and a 4-byte
// flag word (0x00020100) in place of the base record's count/flags word.
// Records are terminated by a sentinel whose file offset is the metadata
// offset and whose "md5" is the v7 magic ASCII.
export const MR_V7_DELTA_RECORD_SIZE = 34;
export const MR_V7_DELTA_FLAGS = 0x00020100;

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
  /**
   * v7 chain members only, on a differential's full-extent index: this block
   * is unchanged since the base image, so its content resolves from the base's
   * block at the same index. Absent on a full image and on an incremental,
   * whose delta index names the changed blocks directly.
   */
  carry?: boolean;
}

/**
 * A single parsed v7 chain member. The full image's full-extent index is the
 * root; each later member resolves against its base (the previous member):
 *  - a differential carries the full image forward, marking unchanged blocks
 *    `carry` and storing only the changed ones.
 *  - an incremental stores only the blocks that changed since its base (its
 *    delta index); every other block resolves from the base.
 */
export interface MacriumV7ChainMember {
  role: 'full' | 'differential' | 'incremental';
  /** Filename increment number (`00` for a full image). */
  incrementNo: number;
  /** Path of the base image, resolved from the filename pattern. */
  basePath?: string;
  /**
   * Incremental only: the delta records, keyed by the logical block index they
   * address in the BASE's block array. Absent for a full/differential, whose
   * full-extent index already covers every block.
   */
  delta?: Array<{ logicalIndex: number; filePosition: number; md5: Buffer }>;
  /** Parsed base member, filled in when the base image is present on disk. */
  base?: MacriumV7ChainMember;
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
  /**
   * Absolute byte offset of this partition on the source disk when the
   * container records one: the mrimgx `$JSON` geometry (bytes per the
   * published spec) or the v7 footer's MBR/GPT table matched by extent.
   * 0/undefined = unknown; a restore then needs an explicit targetLayout
   * offset for this partition.
   */
  offsetOnDisk?: number;
  blocks: MacriumIndexElement[];
  /**
   * v7 chain members only (differential and incremental). Set on the member
   * being parsed, carrying its role, resolved base path, base member and —
   * for an incremental — its delta index. `blocks` for a differential is its
   * full-extent index with `carry` markers; an incremental has empty `blocks`
   * and is described entirely by `chain.delta`.
   */
  chain?: MacriumV7ChainMember;
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
  /**
   * v7 chain members only: this file's role and the resolved base path. A
   * differential carries a full-extent index with per-block `carry` markers;
   * an incremental stores only the changed blocks (its delta index).
   */
  chain?: MacriumV7ChainMember;
  disks: Array<{ diskNumber?: number; diskSignature?: string; diskFormat?: string; size?: number }>;
  partitions: MacriumPartitionInfo[];
}

/** Raised when a Macrium image is structurally supported but not yet readable. */
export class MacriumUnsupportedError extends Error {}

/**
 * First unsupported-container reason for a parsed Macrium image, or null when
 * the container itself is readable. Detection is format-agnostic (both the
 * Reflect X `$JSON` header and the v7 footer XML feed it) so the partition
 * reader, the filesystem probe and `mrimg info` all report the same verdict.
 */
export function macriumUnsupportedReason(info: MacriumImageInfo): string | null {
  if (info.encryption.enable) {
    return `${info.imagePath}: password-protected Macrium images are not supported yet.`;
  }
  if (info.splitFile) {
    return `${info.imagePath}: split Macrium images (multi-part .mrimgx/.0001 files) are not supported yet.`;
  }
  // A v7 chain member (differential/incremental) browses and restores once
  // its base image is on disk: the reader resolves carried-forward and delta
  // blocks against it. Without the base the member cannot stand alone.
  const chain = info.chain ?? info.partitions.find((p) => p.chain)?.chain;
  if (chain?.basePath) {
    if (!fs.existsSync(chain.basePath)) {
      return `${info.imagePath}: base image ${path.basename(chain.basePath)} not found; restore or merge the chain in Reflect first.`;
    }
    return null;
  }
  if (info.deltaIndex) {
    return `${info.imagePath}: delta-incremental Macrium chains are not supported yet; restore or merge the chain in Reflect first.`;
  }
  if (/incremental|differential/i.test(info.backupType ?? '')) {
    return `${info.imagePath}: ${info.backupType} Macrium images are not supported yet; restore or merge the chain in Reflect first.`;
  }
  return null;
}

/**
 * First reason this Macrium image cannot be RESTORED onto a disk, or null when
 * the container is restorable. Extends the read-side verdict with refusals
 * that browsing tolerates but a restore must not (file-and-folder backups,
 * differential/incremental members).
 */
export function macriumRestoreRefusal(info: MacriumImageInfo): string | null {
  const unsupported = macriumUnsupportedReason(info);
  if (unsupported) return unsupported;
  if (info.backupFormat === 'file_and_folder' || info.backupType === 'file backup') {
    return `${info.imagePath}: file and folder backups cannot be restored as a disk image.`;
  }
  if (/^(diff|inc)$/i.test(info.backupType ?? '')) {
    const kind = /^diff$/i.test(info.backupType) ? 'differential' : 'incremental';
    return `${info.imagePath}: ${kind} Macrium images cannot be restored independently; restore or merge the chain in Reflect first.`;
  }
  return null;
}

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

/**
 * On-disk byte extent of an imaged partition: the recorded partition-table
 * size when known (mrimgx `$JSON` geometry, matched v7 MBR/GPT entry) or the
 * covered data bytes otherwise (may round the true partition size up to the
 * block size).
 */
export function macriumPartitionSize(part: MacriumPartitionInfo): number {
  return part.geometry.length > 0 ? part.geometry.length : part.blockCount * part.blockSize;
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

/** Role and filename increment number for a v7 chain member. */
function v7ChainRole(
  incrementNo: number,
  methodValue: number
): MacriumV7ChainMember['role'] {
  if (incrementNo > 0) {
    // A differential is the first non-full member of a set (it carries the
    // full image forward); every later member is incremental.
    return incrementNo === 1 || methodValue === 2 ? 'differential' : 'incremental';
  }
  return 'full';
}

/**
 * Resolve the base image for a v7 chain member from its filename. Reflect
 * names members `<imageid>-<increment:00=full>-<file#>.mrimg` with the file#
 * repeating the increment, so the base of member N is the file whose two
 * numbers are both N-1 in the same directory.
 */
function v7ChainBasePath(imagePath: string, incrementNo: number): string | undefined {
  if (incrementNo <= 0) return undefined;
  const base = String(incrementNo - 1).padStart(2, '0');
  const dir = path.dirname(imagePath);
  const imageId = /^([^.]+)/.exec(path.basename(imagePath))?.[1] ?? '';
  // imageId itself carries the full `<id>-<NN>-<NN>` stem; replace trailing
  // `-NN-NN` with the base's pair.
  const stem = imageId.replace(/-\d{2}-\d{2}$/, '');
  const candidate = path.join(dir, `${stem}-${base}-${base}.mrimg`);
  return fs.existsSync(candidate) ? candidate : candidate;
}

/**
 * Load the base image's per-block md5s so a differential can tell which of its
 * blocks are carried forward (md5 unchanged from the base) versus freshly
 * stored. Returns undefined when the base image is missing or unreadable —
 * the differential then resolves only what it stores locally.
 */
function loadChainBaseBlocks(
  basePath: string | undefined
): Array<{ md5: Buffer }> | undefined {
  if (!basePath || !fs.existsSync(basePath)) return undefined;
  try {
    const base = readMacriumImage(basePath);
    // The base's first partition is what a chain member's index describes.
    const p = base.partitions[0];
    return p ? p.blocks : undefined;
  } catch {
    return undefined;
  }
}

/** A detected v7 index section: full-extent records or an incremental delta. */
interface V7Section {
  rec0: number;
  count: number;
  delta: boolean;
}

/**
 * Detect a chain member's index section in the footer.
 *
 * Full images and differentials use the standard 30-byte record layout and are
 * found by the existing marker/fallback scans. Incrementals replace that with
 * 34-byte delta records (MR_V7_DELTA_FLAGS at rec+2) whose first record starts
 * 30 bytes after a `{u16 pad, u32 count, pad[8], md5[16]}` header. Candidates
 * are located with a native search for the flag word (a differential's footer
 * can be tens of megabytes), then validated structurally.
 */
function detectV7DeltaSection(
  imagePath: string,
  footer: Buffer,
  bound: number,
  metaOff: number
): V7Section | undefined {
  const flagNeedle = Buffer.alloc(4);
  flagNeedle.writeUInt32LE(MR_V7_DELTA_FLAGS, 0);
  let search = 0;
  while (search + 4 <= bound) {
    const at = footer.indexOf(flagNeedle, search);
    if (at === -1) break;
    search = at + 1;
    const rec0 = at - 2; // the flag word lives at rec+2
    if (rec0 < MR_V7_DELTA_RECORD_SIZE - 4) continue;
    const headerStart = rec0 - (MR_V7_DELTA_RECORD_SIZE - 4);
    const count = footer.readUInt32LE(headerStart + 2);
    if (count === 0 || count > 100_000) continue;
    const need = rec0 + count * MR_V7_DELTA_RECORD_SIZE;
    if (need > bound + MR_V7_DELTA_RECORD_SIZE) continue;
    // Every record must carry the delta flag word at rec+2.
    let flagsOk = true;
    for (let r = 0; r < count; r++) {
      if (footer.readUInt32LE(rec0 + r * MR_V7_DELTA_RECORD_SIZE + 2) !== MR_V7_DELTA_FLAGS) {
        flagsOk = false;
        break;
      }
    }
    if (!flagsOk) continue;
    // Real delta records: stored positions strictly inside the data region and
    // monotonically increasing. The terminating sentinel is exempt — its
    // "position" is the metadata offset itself and its md5 is the v7 magic.
    let prevPos = -1;
    let posOk = true;
    for (let r = 0; r < count; r++) {
      const rec = rec0 + r * MR_V7_DELTA_RECORD_SIZE;
      const pos = Number(footer.readBigUInt64LE(rec + 10));
      if (r === count - 1) break; // sentinel
      if (pos <= 0 || pos >= metaOff || pos <= prevPos) {
        posOk = false;
        break;
      }
      prevPos = pos;
    }
    if (!posOk) continue;
    // Definitive check: the first stored block must be a readable QuickLZ frame.
    const firstOff = Number(footer.readBigUInt64LE(rec0 + 10));
    if (!(firstOff > 0 && firstOff < metaOff)) continue;
    try {
      const hdr = readFileRange(imagePath, firstOff, MR_V7_HEADER_LEN);
      const frame = parseQuickLzFrame(hdr);
      const stored = readFileRange(imagePath, firstOff, frame.compressedSize);
      decompressQuickLz(stored);
    } catch {
      continue;
    }
    return { rec0, count, delta: true };
  }
  return undefined;
}

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

  // Parse the backup-definition XML and its disk descriptor up front: the
  // encryption/method markers it carries (together with the on-disk filename)
  // decide how the block-index scan below is read, and failures must surface
  // as MacriumUnsupportedError instead of generic parse errors.
  // The XML is u16 length-prefixed immediately before "<?xml" (u32 when the
  // prefix is 0xFFFF, past 64 KiB).
  let netbiosName: string | undefined;
  let backupFormat = 'disk';
  let isFileBackup = false;
  let diskFormat = '';
  let diskSignature: string | undefined;
  let diskSizeBytes = 0;
  // Source-disk partition-table entries from the footer's MBR/GPT copy, used
  // to pair each imaged partition with its on-disk offset for restores.
  const tableEntries: Array<{ offset: number; size: number }> = [];
  let backupTime: number | undefined;
  let aesValue = 0;
  let methodValue = -1;
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
        // <aes>: 0 = none, 1-3 = AES variants (image is password-protected).
        const aes = /<aes>(\d+)<\/aes>/.exec(xmlText);
        if (aes) aesValue = Number(aes[1]);
        // <method>: 0 = full, 1 = incremental, 2 = differential, 3 = auto.
        const method = /<method>(\d+)<\/method>/.exec(xmlText);
        if (method) methodValue = Number(method[1]);

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
            // Entry array position is header-defined (normally LBA 2).
            const entriesLba = footer.readBigUInt64LE(gptOff + 72);
            const entrySize = footer.readUInt32LE(gptOff + 84) || 128;
            if (entriesLba >= 1n && entriesLba < 4096n && entrySize >= 128 && entrySize <= 4096) {
              const base = mbr + Number(entriesLba) * 512;
              for (let i = 0; i < 256 && base + (i + 1) * entrySize <= footer.length; i++) {
                const e = base + i * entrySize;
                let empty = true;
                for (let b = 0; b < 16; b++) {
                  if (footer[e + b] !== 0) {
                    empty = false;
                    break;
                  }
                }
                if (empty) continue;
                const firstLba = footer.readBigUInt64LE(e + 32);
                const lastLba = footer.readBigUInt64LE(e + 40);
                if (lastLba < firstLba || lastLba >= 1n << 32n) continue;
                tableEntries.push({ offset: Number(firstLba) * 512, size: Number(lastLba - firstLba + 1n) * 512 });
              }
            }
          } else {
            for (let i = 0; i < 4; i++) {
              const e = mbr + 446 + i * 16;
              const type = footer[e + 4];
              if (type === 0) continue;
              const sectors = footer.readUInt32LE(e + 12);
              if (sectors === 0 || sectors === 0xffffffff) continue;
              const startLba = footer.readUInt32LE(e + 8);
              const endByte = (startLba + sectors) * 512;
              if (endByte > diskSizeBytes) diskSizeBytes = endByte;
              // Extended containers (0x05/0x0F/0x85) do not map 1:1 onto
              // imaged partitions — logical drives live in EBR chains — so
              // they are excluded from extent matching below.
              if (type === 0x05 || type === 0x0f || type === 0x85) continue;
              tableEntries.push({ offset: startLba * 512, size: sectors * 512 });
            }
          }
        }
      }
    }
  }

  // Filename shape: <imageid>-<increment>-<file#>.mrimg.
  //   increment 00          -> full image.
  //   increment > 0, matching file# (e.g. -01-01, -02-02) -> chain member:
  //     a differential (carries the full image forward) or an incremental
  //     (carries the previous member forward).
  //   file# > 0 with increment 00 (e.g. -00-01) -> one part of a split set.
  // The old heuristic (`file# !== '00'` => split) misclassified every chain
  // member, since real chain names repeat the increment as the file#.
  const nameParts = /-(\d{2})-(\d{2})\.mrimg$/i.exec(path.basename(imagePath));
  const incrementNo = nameParts ? Number(nameParts[1]) : 0;
  const filePartNo = nameParts ? Number(nameParts[2]) : 0;
  let splitBySibling = false;
  if (nameParts && filePartNo === 0 && incrementNo === 0) {
    const prefix = path.basename(imagePath).replace(/-\d{2}\.mrimg$/i, '');
    for (let f = 1; f <= 99 && !splitBySibling; f++) {
      const sibling = `${prefix}-${String(f).padStart(2, '0')}.mrimg`;
      if (fs.existsSync(path.join(path.dirname(imagePath), sibling))) splitBySibling = true;
    }
  }
  const encryptedVariant = aesValue > 0;
  const isChainMember = nameParts !== null && incrementNo > 0 && filePartNo === incrementNo;
  const splitVariant = !isChainMember && (filePartNo !== 0 || splitBySibling);
  const deltaVariant =
    isChainMember || incrementNo > 0 || methodValue === 1 || methodValue === 2;

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

  const sections: V7Section[] = [];
  for (let k = 0; k < markers.length; k++) {
    const rec0 = markers[k] + pathLen + MR_V7_PART_REC_TAIL;
    const sectionEnd = k + 1 < markers.length ? markers[k + 1] - 1 : bound;
    if (rec0 + MR_V7_RECORD_SIZE > sectionEnd) continue;
    const count = footer.readUInt32LE(rec0 + 2);
    const need = rec0 + count * MR_V7_RECORD_SIZE;
    if (count === 0 || need > sectionEnd || sectionEnd - need > 4096) continue;
    sections.push({ rec0, count, delta: false });
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
        sections.push({ rec0: rec0 + 4, count, delta: false });
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
        sections.push({ rec0, count, delta: false });
        break;
      }
      if (sections.length > 0) break;
    }
  }

  // Chain members (differential/incremental): the incremental's 34-byte delta
  // index uses a different header, so the scans above miss it. Try the delta
  // layout first for a chain member (the generic fallback below can latch onto
  // a coincidental 30-byte run of decompressible footer bytes), else as a
  // last resort.
  let deltaSection: V7Section | undefined;
  if (sections.length === 0 || deltaVariant) {
    deltaSection = detectV7DeltaSection(imagePath, footer, bound, metaOff);
    if (deltaSection) sections.unshift(deltaSection);
  }

  if (sections.length === 0) {
    // The footer XML/filename already told us which unsupported variant this
    // is — report that instead of a generic "no index" parse failure.
    if (encryptedVariant) {
      throw new MacriumUnsupportedError(
        `${imagePath}: password-protected Macrium images are not supported yet.`
      );
    }
    if (splitVariant) {
      throw new MacriumUnsupportedError(
        `${imagePath}: split Macrium images (multi-part .mrimgx/.0001 files) are not supported yet.`
      );
    }
    if (deltaVariant) {
      throw new MacriumUnsupportedError(
        `${imagePath}: delta-incremental Macrium chains are not supported yet; restore or merge the chain in Reflect first.`
      );
    }
    const isChain = /-\d{2}-\d{2}\.mrimg$/i.test(imagePath);
    if (isChain) {
      throw new MacriumUnsupportedError(
        `No partition block index found in ${path.basename(imagePath)}. This may be a chain segment or differential/incremental image that cannot be browsed independently.`
      );
    }
    throw new MacriumUnsupportedError(
      `No partition block index found in ${imagePath}. The image may be a differential/incremental backup or use an unsupported Macrium format.`
    );
  }

  // A chain member resolves against its base (the previous member): a full
  // image is the chain root, a differential carries the full image forward,
  // and an incremental carries its base forward. Resolving needs the base's
  // own index, so record the role and base path here; the reader walks the
  // chain when a block is not stored locally.
  const chainRole = v7ChainRole(incrementNo, methodValue);
  const basePath = v7ChainBasePath(imagePath, incrementNo);

  // Incremental members keep their changed-block list (the delta index) in
  // the chain record instead of a full-extent `blocks` array.
  const chainDelta: MacriumV7ChainMember['delta'] = [];
  for (const { rec0, count, delta } of sections) {
    if (!delta) continue;
    // Each 34-byte record names one logical block of the BASE that changed
    // and where its compressed frame lives in this file. The last record is a
    // sentinel whose position is the metadata offset — skip it.
    for (let i = 0; i < count; i++) {
      const rec = rec0 + i * MR_V7_DELTA_RECORD_SIZE;
      const logicalIndex = footer.readUInt32LE(rec + 6);
      const filePosition = Number(footer.readBigUInt64LE(rec + 10));
      const md5 = Buffer.from(footer.subarray(rec + 18, rec + 34));
      if (filePosition >= metaOff) continue;
      chainDelta.push({ logicalIndex, filePosition, md5 });
    }
  }
  const chain: MacriumV7ChainMember | undefined =
    chainRole === 'full'
      ? undefined
      : { role: chainRole, incrementNo, basePath, delta: chainDelta };

  const partitions: MacriumPartitionInfo[] = [];
  for (let k = 0; k < sections.length; k++) {
    const { rec0, count, delta } = sections[k];
    const blocks: MacriumIndexElement[] = [];
    if (!delta) {
      // A differential stores only its CHANGED blocks in its own data region;
      // every other record is a copy of the base's full-extent record, so its
      // file position names a location in the BASE file, not this one (the
      // two files' data regions are independent). The discriminator is the
      // md5: equal to the base's block md5 -> unchanged, resolve from the
      // base; different -> changed, stored in THIS file. Zero md5 is always
      // unallocated zeroes.
      const baseBlocks = chainRole === 'differential' ? loadChainBaseBlocks(basePath) : undefined;
      for (let i = 0; i < count; i++) {
        const rec = rec0 + i * MR_V7_RECORD_SIZE;
        const md5 = Buffer.from(footer.subarray(rec + 14, rec + 30));
        const filePosition = Number(footer.readBigUInt64LE(rec + 6));
        const base = baseBlocks?.[i];
        if (md5.equals(ZERO_HASH)) {
          blocks.push({ filePosition: -1, md5, storedLength: 0, fileNumber: 0 });
        } else if (base && base.md5.equals(md5)) {
          // Unchanged since the base: `carry` makes the reader resolve the
          // block from the base image at the same logical index.
          blocks.push({ filePosition: -1, md5, storedLength: 0, fileNumber: 0, carry: true });
        } else if (base && (filePosition < 0 || filePosition >= metaOff)) {
          // Changed but not stored in this file — unusable record; zeroes
          // rather than a wild read.
          blocks.push({ filePosition: -1, md5, storedLength: 0, fileNumber: 0 });
        } else {
          // Changed (or no base to compare against): stored in THIS file.
          // storedLength -1 means "resolve from the block's QuickLZ header".
          blocks.push({ filePosition, md5, storedLength: -1, fileNumber: 0 });
        }
      }
    }
    partitions.push({
      diskIndex: 0,
      partitionIndex: k,
      partitionNumber: k + 1,
      blockSize: 1 << 16,
      // An incremental has no full-extent index of its own: its extent is the
      // base's, resolved below from the base image on disk.
      blockCount: delta ? 0 : count,
      dataStart: 0,
      fsType: '',
      fsStart: 0,
      lcn0Offset: 0,
      sectorsPerCluster: 0,
      volumeLabel: '',
      geometry: { start: 0, end: 0, length: count * (1 << 16), bootSectorOffset: 0 },
      blocks,
      chain
    });
  }

  // A chain member inherits facts its own index cannot state: an incremental
  // has no full-extent index (its extent is the base's), and a boot sector
  // that is carried forward leaves `fsType` blank until the base fills it.
  // The base may itself be a chain member; readMacriumImage resolves it
  // recursively and caches the result.
  if (chainRole !== 'full' && basePath && fs.existsSync(basePath)) {
    try {
      const bp = readMacriumImage(basePath).partitions[0];
      if (bp) {
        for (const p of partitions) {
          if (chainRole === 'incremental') p.blockCount = bp.blockCount;
          if (!p.fsType && bp.fsType) p.fsType = bp.fsType;
        }
      }
    } catch {
      // Missing/unreadable base: keep the zero extent; the reader and
      // openMacriumPartitionReader refuse the image with a clear message.
    }
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
  // An incremental has no full-extent index: its only stored frames are the
  // delta records, which still carry real QuickLZ blocks of the base's size.
  if (candidateBlocks.length === 0) {
    for (const d of chain?.delta ?? []) {
      candidateBlocks.push({ filePosition: d.filePosition, md5: d.md5, storedLength: -1, fileNumber: 0 });
      if (candidateBlocks.length >= 8) break;
    }
  }
  if (candidateBlocks.length === 0) {
    if (encryptedVariant) {
      throw new MacriumUnsupportedError(
        `${imagePath}: password-protected Macrium images are not supported yet.`
      );
    }
    if (deltaVariant || splitVariant) {
      throw new MacriumUnsupportedError(
        `${imagePath}: delta-incremental or split Macrium chains are not supported yet; restore or merge the chain in Reflect first.`
      );
    }
    throw new Error(`No stored data block in ${imagePath}.`);
  }

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

  // Pair each imaged partition with its source-disk table entry by extent so
  // a restore knows where the partition belongs on the target. Matching by
  // size (within one block of rounding) rather than by position keeps partial
  // images correct: unimaged partitions simply leave their entry unused.
  const usedEntries = new Set<number>();
  for (const p of partitions) {
    const dataBytes = p.blockCount * blockSize;
    const j = tableEntries.findIndex(
      (entry, idx) => !usedEntries.has(idx) && Math.abs(entry.size - dataBytes) <= blockSize
    );
    if (j >= 0) {
      usedEntries.add(j);
      p.offsetOnDisk = tableEntries[j].offset;
      // The entry's sector span is the true partition extent; the data-block
      // extent rounds it up to the block size.
      p.geometry.length = tableEntries[j].size;
    }
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
    encryption: { enable: encryptedVariant, keyIterations: 0 },
    splitFile: splitVariant,
    deltaIndex: deltaVariant,
    chain,
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
      // Delta containers store a different payload shape ($INDEX count +
      // per-record block_index) that parseIndexPayload would misread, so the
      // walk is skipped and the reader gate refuses the image instead.
      if (!info.splitFile && !info.deltaIndex) {
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
        // Partition geometry and file-system start are absolute bytes on the
        // source disk (published mrimgx spec), either of which places the
        // partition on a restore target.
        offsetOnDisk: num(partGeometry.start, 0) || num(partFs.start, 0),
        blocks
      });
    });
  });

  return info;
}