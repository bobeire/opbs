import { PartitionReader } from '../image-browse';
import { DataRun } from './ntfs';
import { parseNtfsBootSector, NtfsBootSector } from './ntfs-resize';

/**
 * NTFS shrink planner (read-only).
 *
 * Shrink needs data relocation — unlike grow, which only patches metadata.
 * This module plans a shrink against a source volume (an image chain via
 * `ChainPartitionReader`, or any `PartitionReader`) and returns a fully
 * computed, serializable `NtfsShrinkPlan`: which clusters move where, which
 * MFT records need patched runlists, the truncated $Bitmap updates, the
 * rewritten $BadClus run, and the boot sector with the new total-sector
 * count. Applying the plan is the elevated helper's job (Phase 1); nothing
 * here writes.
 *
 * Conservative by design (same contract as the grow planner): anything it
 * cannot relocate safely — compressed, EFS-encrypted or attribute-listed
 * streams beyond the new boundary, OS-metadata extents beyond the boundary,
 * a dirty volume (bitmap/MFT disagreement), runlists that cannot be
 * re-encoded inside their record — throws `ShrinkUnsupportedError` with the
 * reason rather than risk a corrupt volume.
 *
 * Crash-safety contract for the applier (documented here because the plan is
 * shaped for it): write the boot sector FIRST (so the volume never advertises
 * a size larger than the partition), then relocated data, then MFT record
 * patches, then $Bitmap regions. The plan's `moves` are sparse and sorted;
 * `recordPatches` carry partition-relative offsets and on-disk (fixup)
 * record bytes; low-numbered patched records are mirrored by the applier to
 * `$MFTMirr` (see `mftMirrStartCluster` / `mirrorRecordCount`).
 */

/** Thrown when a volume cannot be safely shrunk to the requested size. */
export class ShrinkUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShrinkUnsupportedError';
  }
}

/** One relocation: volume clusters `[srcCluster, srcCluster + clusterCount)``
 *  move to `[dstCluster, dstCluster + clusterCount)`. Sparse runs never
 *  appear — holes need no move. */
export interface NtfsShrinkMove {
  srcCluster: number;
  dstCluster: number;
  clusterCount: number;
}

/** One patched MFT record, in on-disk form (update-sequence fixup planted),
 *  to write at `relativeOffset` after the relocated data is in place. */
export interface NtfsShrinkRecordPatch {
  recordNumber: number;
  relativeOffset: number;
  data: Buffer;
}

/** One byte region to write on the target partition (partition-relative). */
export interface NtfsShrinkRegion {
  relativeOffset: number;
  data: Buffer;
}

export interface NtfsShrinkPlan {
  oldTotalClusters: number;
  newTotalClusters: number;
  newTotalSectors: number;
  clusterSize: number;
  /** Sum of relocated clusters × cluster size. */
  relocatedBytes: number;
  moves: NtfsShrinkMove[];
  /** Boot sector (512 bytes) with the new total-sector count — write first. */
  bootSector: Buffer;
  /** $Bitmap prefix updates (dst clusters now used), partition-relative. */
  bitmapRegions: NtfsShrinkRegion[];
  /** Patched MFT records (on-disk form), partition-relative. */
  recordPatches: NtfsShrinkRecordPatch[];
  mftMirrStartCluster: number;
  mirrorRecordCount: number;
}

/** Feasibility numbers a preflight can show without building a full plan. */
export interface NtfsShrinkMinimum {
  clusterSize: number;
  oldTotalClusters: number;
  /** Clusters referenced by in-use MFT records (union of non-sparse runs). */
  usedClusters: number;
  /** Smallest cluster count a shrink can target (used + margin, aligned). */
  minTargetClusters: number;
  minTargetSectors: number;
}

const ATTR_ATTRIBUTE_LIST = 0x20;
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;
const ATTR_INDEX_ALLOCATION = 0xa0;
const ATTR_BITMAP = 0xb0;
const ATTR_EFS = 0x100;
const ATTR_COMPRESSED = 0x0001;

/** Records whose data must never move (special location/semantics), plus
 *  reserved slots 12-15. Root (5) and $Boot (7) are included defensively. */
const SYSTEM_RECORDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const EXTEND_RECORD = 11;

/** 1 MiB margin above the used bytes for metadata slack (per the design). */
const MIN_TARGET_MARGIN = 1024 * 1024;
const ALIGN_BYTES = 1024 * 1024;
/** Guard against absurd bitmap buffering (boundary/8 bytes held in memory). */
const MAX_BITMAP_PREFIX_BYTES = 512 * 1024 * 1024;
/** Guard against pathological MFTs stalling preflight. */
const MAX_MFT_RECORDS = 2_000_000;

// ---------------------------------------------------------------------------
// Runlist codec (self-contained, like ntfs-resize.ts; handles negative deltas)
// ---------------------------------------------------------------------------

function countLenBytes(v: number): number {
  if (v === 0) return 1;
  let n = 0;
  let x = v;
  while (x !== 0 && n < 8) {
    n++;
    x = Math.floor(x / 256);
  }
  return n;
}

/** Smallest byte count whose signed range covers `delta`. */
function countOffsetBytes(delta: number): number {
  for (let n = 1; n <= 8; n++) {
    const limit = Math.pow(2, 8 * n - 1);
    if (delta >= -limit && delta < limit) return n;
  }
  throw new ShrinkUnsupportedError('Data run offset is out of range');
}

function leUnsigned(v: number, n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = v;
  for (let i = 0; i < n; i++) {
    b.writeUInt8(x & 0xff, i);
    x = Math.floor(x / 256);
  }
  return b;
}

function leSigned(v: number, n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = v < 0 ? v + Math.pow(256, n) : v;
  for (let i = 0; i < n; i++) {
    b.writeUInt8(x & 0xff, i);
    x = Math.floor(x / 256);
  }
  return b;
}

function parseRunlist(buf: Buffer, offset: number): DataRun[] {
  const runs: DataRun[] = [];
  let pos = offset;
  let relative = 0;
  while (pos < buf.length) {
    const header = buf[pos++];
    if (header === 0) break;
    const lenBytes = header & 0x0f;
    const offBytes = header >> 4;
    if (lenBytes === 0 || pos + lenBytes + offBytes > buf.length) {
      throw new ShrinkUnsupportedError('Malformed data runlist');
    }
    let runLength = 0;
    for (let i = 0; i < lenBytes; i++) runLength += buf[pos + i] * Math.pow(256, i);
    pos += lenBytes;
    if (offBytes === 0) {
      runs.push({ startLcn: 0, runLength, sparse: true });
      continue;
    }
    let delta = 0;
    for (let i = 0; i < offBytes; i++) delta += buf[pos + i] * Math.pow(256, i);
    const signBit = 8 * offBytes - 1;
    if ((delta & Math.pow(2, signBit)) !== 0) delta -= Math.pow(2, 8 * offBytes);
    pos += offBytes;
    relative += delta;
    runs.push({ startLcn: relative, runLength });
  }
  return runs;
}

/** Encode runs (relative offsets, sparse runs have no offset field). */
function buildRunlist(runs: DataRun[]): Buffer {
  const chunks: Buffer[] = [];
  let prev = 0;
  for (const run of runs) {
    const lenBytes = countLenBytes(run.runLength);
    if (run.sparse) {
      chunks.push(Buffer.from([lenBytes]), leUnsigned(run.runLength, lenBytes));
      continue;
    }
    const delta = run.startLcn - prev;
    const offBytes = countOffsetBytes(delta);
    chunks.push(
      Buffer.from([(offBytes << 4) | lenBytes]),
      leUnsigned(run.runLength, lenBytes),
      leSigned(delta, offBytes)
    );
    prev = run.startLcn;
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Merge adjacent same-LCN runs to keep runlists short after relocation. */
function coalesceRuns(runs: DataRun[]): DataRun[] {
  const out: DataRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (
      last &&
      !last.sparse &&
      !run.sparse &&
      last.startLcn + last.runLength === run.startLcn
    ) {
      last.runLength += run.runLength;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record fixups + raw attribute walk
// ---------------------------------------------------------------------------

/** Apply the update-sequence fixup (sector-end words restored from the US
 *  array); the array itself is left intact, matching ntfs.ts. */
function applyRecordFixup(buf: Buffer): Buffer {
  if (buf.length < 8) return Buffer.from(buf);
  const usOffset = buf.readUInt16LE(4);
  const usCount = buf.readUInt16LE(6);
  if (usCount < 1 || usOffset + usCount * 2 > buf.length) return Buffer.from(buf);
  const out = Buffer.from(buf);
  for (let i = 0; i < usCount - 1; i++) {
    const end = i * 512 + 510;
    if (end + 2 > out.length) break;
    out.writeUInt16LE(buf.readUInt16LE(usOffset + (i + 1) * 2), end);
  }
  return out;
}

/** Plant the USN back at every sector end (on-disk form). */
function plantRecordFixup(record: Buffer): Buffer {
  const out = Buffer.from(record);
  const usOffset = out.readUInt16LE(4);
  const usCount = out.readUInt16LE(6);
  if (usCount > 1 && usOffset + usCount * 2 <= out.length) {
    const usn = out.readUInt16LE(usOffset);
    for (let i = 0; i < usCount - 1; i++) {
      const end = i * 512 + 510;
      if (end + 2 > out.length) break;
      out.writeUInt16LE(usn, end);
    }
  }
  return out;
}

interface RawAttr {
  attrType: number;
  name: string;
  pos: number;
  length: number;
  nonResident: boolean;
  flags: number;
  runOffset: number;
  runs: DataRun[];
  allocatedSize: number;
  realSize: number;
  initializedSize: number;
  /** Resident value (offsets into the record) for FILE_NAME / resident sizes. */
  residentOffset: number;
  residentLength: number;
  parentRecord?: number;
}

function parseRawAttrs(record: Buffer): RawAttr[] {
  const attrs: RawAttr[] = [];
  if (record.length < 0x38 || record.toString('ascii', 0, 4) !== 'FILE') return attrs;
  let pos = record.readUInt16LE(0x14);
  while (pos + 8 <= record.length) {
    const attrType = record.readUInt32LE(pos);
    if (attrType === 0xffffffff) break;
    const length = record.readUInt32LE(pos + 4);
    if (length < 8 || pos + length > record.length) break;
    const nonResident = record.readUInt8(pos + 8) !== 0;
    const nameLen = record.readUInt8(pos + 9);
    const nameOffset = record.readUInt16LE(pos + 0x0a);
    const name =
      nameLen > 0 && !nonResident && attrType === ATTR_DATA
        ? record.toString('utf16le', pos + nameOffset, pos + nameOffset + nameLen * 2)
        : nameLen > 0 && nonResident
          ? record.toString('utf16le', pos + nameOffset, pos + nameOffset + nameLen * 2)
          : '';
    const attr: RawAttr = {
      attrType,
      name,
      pos,
      length,
      nonResident,
      flags: record.readUInt16LE(pos + 0x0c),
      runOffset: 0,
      runs: [],
      allocatedSize: 0,
      realSize: 0,
      initializedSize: 0,
      residentOffset: 0,
      residentLength: 0
    };
    if (nonResident) {
      attr.runOffset = record.readUInt16LE(pos + 0x20);
      attr.runs = parseRunlist(record.subarray(pos, pos + length), attr.runOffset);
      attr.allocatedSize = Number(record.readBigUInt64LE(pos + 0x28));
      attr.realSize = Number(record.readBigUInt64LE(pos + 0x30));
      attr.initializedSize = Number(record.readBigUInt64LE(pos + 0x38));
    } else {
      attr.residentOffset = record.readUInt16LE(pos + 0x14);
      attr.residentLength = record.readUInt32LE(pos + 0x10);
      if (attrType === ATTR_FILE_NAME && attr.residentLength >= 8) {
        attr.parentRecord = Number(record.readBigUInt64LE(pos + attr.residentOffset) & 0xffffffffffffn);
      }
    }
    attrs.push(attr);
    pos += length;
  }
  return attrs;
}

function readRuns(reader: PartitionReader, clusterSize: number, runs: DataRun[], fileOffset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let pos = 0;
  let done = 0;
  for (const run of runs) {
    const runBytes = run.runLength * clusterSize;
    if (done + runBytes <= fileOffset) {
      done += runBytes;
      continue;
    }
    const startInRun = Math.max(0, fileOffset - done);
    const take = Math.min(runBytes - startInRun, length - pos);
    if (take > 0) {
      if (run.sparse) {
        out.fill(0, pos, pos + take);
      } else {
        reader.read(run.startLcn * clusterSize + startInRun, take).copy(out, pos);
      }
      pos += take;
    }
    done += runBytes;
    if (pos >= length) break;
  }
  if (pos < length) {
    throw new ShrinkUnsupportedError('A file runlist does not cover its recorded size');
  }
  return out;
}

/** Byte offset of a file offset inside a runlist (partition-relative). */
function runsToFileOffset(runs: DataRun[], clusterSize: number, fileOffset: number): number {
  let done = 0;
  for (const run of runs) {
    const runBytes = run.runLength * clusterSize;
    if (fileOffset < done + runBytes) {
      const startInRun = fileOffset - done;
      if (run.sparse) {
        throw new ShrinkUnsupportedError('Offset lands in a sparse run');
      }
      return run.startLcn * clusterSize + startInRun;
    }
    done += runBytes;
  }
  throw new ShrinkUnsupportedError('Offset is beyond the runlist');
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

interface Interval {
  start: number;
  end: number; // exclusive
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      out.push({ ...sorted[i] });
    }
  }
  return out;
}

function intervalSize(intervals: Interval[]): number {
  return intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

/** All bits in [start, end) set? Byte-wise scan of a bitmap prefix. */
function bitmapRangeAllSet(bitmap: Buffer, start: number, end: number): boolean {
  for (let cluster = start; cluster < end; ) {
    const byteIndex = cluster >> 3;
    if (byteIndex >= bitmap.length) return false;
    const bitInByte = cluster & 7;
    if (bitInByte === 0 && end - cluster >= 8) {
      if (bitmap[byteIndex] !== 0xff) {
        // Find the first clear bit to report a precise cluster.
        for (let b = 0; b < 8; b++) {
          if ((bitmap[byteIndex] & (1 << b)) === 0) return false;
        }
      }
      cluster += 8;
      continue;
    }
    if ((bitmap[byteIndex] & (1 << bitInByte)) === 0) return false;
    cluster++;
  }
  return true;
}

function setBitmapBits(bitmap: Buffer, start: number, end: number): void {
  for (let cluster = start; cluster < end; cluster++) {
    bitmap[cluster >> 3] |= 1 << (cluster & 7);
  }
}

function freeIntervalsBelow(bitmap: Buffer, boundary: number): Interval[] {
  const free: Interval[] = [];
  let runStart = -1;
  for (let cluster = 0; cluster < boundary; cluster++) {
    const isUsed = (bitmap[cluster >> 3] & (1 << (cluster & 7))) !== 0;
    if (!isUsed && runStart < 0) runStart = cluster;
    if (isUsed && runStart >= 0) {
      free.push({ start: runStart, end: cluster });
      runStart = -1;
    }
  }
  if (runStart >= 0) free.push({ start: runStart, end: boundary });
  return free;
}

// ---------------------------------------------------------------------------
// Volume scan
// ---------------------------------------------------------------------------

interface MftRecordScan {
  recordNumber: number;
  /** Raw record with fixups applied (logical bytes). */
  raw: Buffer;
  attrs: RawAttr[];
  hasAttributeList: boolean;
  hasEfs: boolean;
  isExtendChild: boolean;
}

interface VolumeScan {
  layout: NtfsBootSector;
  oldTotalClusters: number;
  mftRuns: DataRun[];
  mftRecordSize: number;
  mftRecordCount: number;
  /** In-use records (fixups applied) keyed by record number. */
  records: Map<number, MftRecordScan>;
  /** Merged non-sparse allocation of every in-use walkable attr. */
  usedIntervals: Interval[];
}

const WALKABLE_ATTRS = new Set([ATTR_DATA, ATTR_INDEX_ALLOCATION, ATTR_BITMAP]);

function walkableAttrs(rec: MftRecordScan): RawAttr[] {
  return rec.attrs.filter((a) => WALKABLE_ATTRS.has(a.attrType) && a.nonResident);
}

function scanVolume(reader: PartitionReader): VolumeScan {
  let layout: NtfsBootSector;
  try {
    layout = parseNtfsBootSector(reader.read(0, 512));
  } catch (error) {
    throw new ShrinkUnsupportedError(
      `Not a shrinkable NTFS volume: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (layout.fileRecordSize < 512 || layout.fileRecordSize > 64 * 1024) {
    throw new ShrinkUnsupportedError(`Unsupported MFT record size ${layout.fileRecordSize}`);
  }
  const oldTotalClusters = Math.floor(layout.totalSectors / layout.sectorsPerCluster);

  const recordSize = layout.fileRecordSize;
  let record0Raw: Buffer;
  try {
    record0Raw = applyRecordFixup(reader.read(layout.mftLcn * layout.clusterSize, recordSize));
  } catch (error) {
    throw new ShrinkUnsupportedError(
      `Cannot read $MFT record 0: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const record0Attrs = parseRawAttrs(record0Raw);
  const mftDataAttr = record0Attrs.find((a) => a.attrType === ATTR_DATA && a.name === '' && a.nonResident);
  if (!mftDataAttr || mftDataAttr.runs.length === 0) {
    throw new ShrinkUnsupportedError('$MFT has no usable non-resident $DATA stream');
  }
  const mftRuns = mftDataAttr.runs;
  const mftRecordCount = Math.floor(mftDataAttr.realSize / recordSize);
  if (mftRecordCount <= 0 || mftRecordCount > MAX_MFT_RECORDS) {
    throw new ShrinkUnsupportedError(`Implausible MFT record count ${mftRecordCount}`);
  }

  const records = new Map<number, MftRecordScan>();
  const usedRaw: Interval[] = [];
  for (let i = 0; i < mftRecordCount; i++) {
    let raw: Buffer;
    try {
      raw =
        i === 0
          ? record0Raw
          : applyRecordFixup(readRuns(reader, layout.clusterSize, mftRuns, i * recordSize, recordSize));
    } catch (error) {
      throw new ShrinkUnsupportedError(
        `MFT record ${i} cannot be read (${error instanceof Error ? error.message : String(error)}) — run chkdsk before shrinking`
      );
    }
    if (raw.length < 0x18 || raw.toString('ascii', 0, 4) !== 'FILE') continue; // free slot
    const inUse = (raw.readUInt16LE(0x16) & 0x0001) !== 0;
    if (!inUse) continue;
    const attrs = parseRawAttrs(raw);
    if (attrs.length === 0 && raw.readUInt16LE(0x14) + 8 <= recordSize) {
      throw new ShrinkUnsupportedError(`MFT record ${i} is corrupt — run chkdsk before shrinking`);
    }
    const rec: MftRecordScan = {
      recordNumber: i,
      raw,
      attrs,
      hasAttributeList: attrs.some((a) => a.attrType === ATTR_ATTRIBUTE_LIST),
      hasEfs: attrs.some((a) => a.attrType === ATTR_EFS),
      isExtendChild: attrs.some((a) => a.attrType === ATTR_FILE_NAME && a.parentRecord === EXTEND_RECORD)
    };
    records.set(i, rec);
    for (const a of walkableAttrs(rec)) {
      for (const run of a.runs) {
        if (run.sparse || run.runLength <= 0) continue;
        usedRaw.push({ start: run.startLcn, end: run.startLcn + run.runLength });
      }
    }
  }

  return {
    layout,
    oldTotalClusters,
    mftRuns,
    mftRecordSize: recordSize,
    mftRecordCount,
    records,
    usedIntervals: mergeIntervals(usedRaw)
  };
}

function computeMinimum(
  usedClusters: number,
  clusterSize: number,
  sectorsPerCluster: number
): NtfsShrinkMinimum {
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

// ---------------------------------------------------------------------------
// Run re-encoding
// ---------------------------------------------------------------------------

/** Re-encode one attribute's runlist, growing the record by splicing if the
 *  new runlist no longer fits in the attribute's original span. The returned
 *  record is in logical (fixup-applied) form. */
function rebuildRecordAttrRuns(record: Buffer, attr: RawAttr, newRuns: DataRun[]): Buffer {
  const runlist = buildRunlist(newRuns);
  const newAttrLen = (attr.runOffset + runlist.length + 7) & ~7;
  if (newAttrLen <= attr.length) {
    const out = Buffer.from(record);
    runlist.copy(out, attr.pos + attr.runOffset);
    out.fill(0, attr.pos + attr.runOffset + runlist.length, attr.pos + newAttrLen);
    return out;
  }
  const growth = newAttrLen - attr.length;
  // Find the attribute end marker (0xffffffff) following this attribute.
  let termPos = attr.pos + attr.length;
  while (termPos + 8 <= record.length) {
    const type = record.readUInt32LE(termPos);
    if (type === 0xffffffff) break;
    const len = record.readUInt32LE(termPos + 4);
    if (len < 8 || termPos + len > record.length) break;
    termPos += len;
  }
  const newTermPos = termPos + growth;
  if (newTermPos + 4 > record.length) {
    throw new ShrinkUnsupportedError('Re-encoded runlist does not fit inside its MFT record');
  }
  const out = Buffer.alloc(record.length);
  record.copy(out, 0, 0, attr.pos);
  record.copy(out, attr.pos, attr.pos, attr.pos + attr.runOffset);
  runlist.copy(out, attr.pos + attr.runOffset);
  out.writeUInt32LE(newAttrLen, attr.pos + 4);
  record.copy(out, attr.pos + newAttrLen, attr.pos + attr.length, termPos);
  out.writeUInt32LE(0xffffffff, newTermPos);
  out.writeUInt32LE(newTermPos + 4, 0x18); // bytes in use
  return out;
}

/** Stable identity for an attribute across record rebuilds (positions shift
 *  when an earlier attr grows; type + name + ordinal do not). */
function attrOrdinal(attrs: RawAttr[], index: number): number {
  const self = attrs[index];
  let ordinal = 0;
  for (let i = 0; i < index; i++) {
    if (attrs[i].attrType === self.attrType && attrs[i].name === self.name) ordinal++;
  }
  return ordinal;
}

function attrKey(attr: RawAttr, ordinal: number): string {
  return `${attr.attrType}|${attr.name}|${ordinal}`;
}

interface VacatedPiece {
  dstCluster: number;
  clusterCount: number;
}

interface VacatedSegment {
  srcCluster: number;
  clusterCount: number;
  pieces: VacatedPiece[];
}

function allocatedRunsAbove(runs: DataRun[], boundary: number): DataRun[] {
  return runs.filter((run) => !run.sparse && run.startLcn + run.runLength > boundary);
}

function recordRefusalForBoundary(rec: MftRecordScan): string | null {
  if (SYSTEM_RECORDS.has(rec.recordNumber)) return `OS metadata (record ${rec.recordNumber})`;
  if (rec.isExtendChild) return `$Extend object (record ${rec.recordNumber})`;
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Feasibility summary without building a full relocation plan. */
export function ntfsShrinkMinimum(reader: PartitionReader): NtfsShrinkMinimum {
  const scan = scanVolume(reader);
  const usedClusters = scan.usedIntervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  const min = computeMinimum(usedClusters, scan.layout.clusterSize, scan.layout.sectorsPerCluster);
  min.oldTotalClusters = scan.oldTotalClusters;
  return min;
}

/**
 * Plan a shrink of the NTFS volume readable through `reader` down to
 * `newTotalSectors` (partition-relative sector count). Throws
 * `ShrinkUnsupportedError` when the shrink cannot be planned safely; see the
 * module doc for the refusal matrix.
 */
export function planNtfsShrink(reader: PartitionReader, newTotalSectors: number): NtfsShrinkPlan {
  const scan = scanVolume(reader);
  const layout = scan.layout;
  const clusterSize = layout.clusterSize;

  if (!Number.isInteger(newTotalSectors) || newTotalSectors <= 0) {
    throw new ShrinkUnsupportedError(`Invalid target size ${newTotalSectors} sectors`);
  }
  if (newTotalSectors % layout.sectorsPerCluster !== 0) {
    throw new ShrinkUnsupportedError(
      `Target size ${newTotalSectors} sectors is not cluster-aligned (${layout.sectorsPerCluster} sectors/cluster)`
    );
  }
  const newTotalClusters = newTotalSectors / layout.sectorsPerCluster;
  if (newTotalClusters >= scan.oldTotalClusters) {
    throw new ShrinkUnsupportedError(
      `Target of ${newTotalClusters} clusters is not smaller than the current volume (${scan.oldTotalClusters} clusters)`
    );
  }

  const usedClusters = scan.usedIntervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  const min = computeMinimum(usedClusters, clusterSize, layout.sectorsPerCluster);
  if (newTotalClusters < min.minTargetClusters) {
    throw new ShrinkUnsupportedError(
      `Target of ${newTotalClusters} clusters (${newTotalSectors} sectors) is below the minimum ` +
        `${min.minTargetClusters} clusters (${usedClusters} clusters in use + 1 MiB margin, 1 MiB aligned)`
    );
  }

  const boundary = newTotalClusters;

  // System / reserved extents must stay below the boundary.
  for (const rec of scan.records.values()) {
    const reason = recordRefusalForBoundary(rec);
    if (!reason) continue;
    for (const a of walkableAttrs(rec)) {
      const over = allocatedRunsAbove(a.runs, boundary);
      if (over.length > 0) {
        const maxEnd = Math.max(...over.map((r) => r.startLcn + r.runLength));
        throw new ShrinkUnsupportedError(
          `${reason} has allocated clusters up to LCN ${maxEnd}, beyond the target size of ${boundary} clusters`
        );
      }
    }
  }

  // User streams: unmovable ones refuse; every other non-system record's
  // walkable attrs participate so sparse tails can be clamped too.
  interface AttrWork {
    attr: RawAttr;
    key: string;
  }
  const relocatable: Array<{ rec: MftRecordScan; attr: AttrWork }> = [];
  for (const rec of scan.records.values()) {
    if (SYSTEM_RECORDS.has(rec.recordNumber)) continue;
    const walkable = walkableAttrs(rec);
    const over = walkable.filter((a) => allocatedRunsAbove(a.runs, boundary).length > 0);
    if (over.length > 0) {
      if (rec.hasAttributeList) {
        throw new ShrinkUnsupportedError(
          `File record ${rec.recordNumber} uses an attribute list and cannot be relocated safely`
        );
      }
      if (rec.hasEfs) {
        throw new ShrinkUnsupportedError(
          `EFS-encrypted stream in record ${rec.recordNumber} extends beyond the target size`
        );
      }
      for (const a of over) {
        if ((a.flags & ATTR_COMPRESSED) !== 0) {
          throw new ShrinkUnsupportedError(
            `Compressed stream${a.name ? ` "${a.name}"` : ''} in record ${rec.recordNumber} extends beyond the target size`
          );
        }
      }
    }
    const ordinals = walkable.map((a) => attrOrdinal(rec.attrs, rec.attrs.indexOf(a)));
    walkable.forEach((attr, i) => relocatable.push({ rec, attr: { attr, key: attrKey(attr, ordinals[i]) } }));
  }

  // Read the $Bitmap prefix covering the target volume.
  const bitmapRec = scan.records.get(6);
  const bitmapData = bitmapRec?.attrs.find((a) => a.attrType === ATTR_DATA && a.name === '' && a.nonResident);
  if (!bitmapRec || !bitmapData || bitmapData.runs.length === 0) {
    throw new ShrinkUnsupportedError('Volume has no usable non-resident $Bitmap stream');
  }
  const prefixBytes = Math.ceil(boundary / 8);
  if (prefixBytes > MAX_BITMAP_PREFIX_BYTES) {
    throw new ShrinkUnsupportedError(
      `Bitmap prefix of ${prefixBytes} bytes exceeds the ${MAX_BITMAP_PREFIX_BYTES}-byte guard`
    );
  }
  let bitmapOld: Buffer;
  try {
    bitmapOld = readRuns(reader, clusterSize, bitmapData.runs, 0, prefixBytes);
  } catch (error) {
    throw new ShrinkUnsupportedError(
      `$Bitmap cannot be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // One-directional consistency: every allocated run below the boundary must
  // be marked used in the bitmap. (Bits set without a visible owner are
  // normal — freed-but-not-reused clusters — and are left untouched.)
  for (const iv of scan.usedIntervals) {
    const start = Math.max(iv.start, 0);
    const end = Math.min(iv.end, boundary);
    if (end <= start) continue;
    if (!bitmapRangeAllSet(bitmapOld, start, end)) {
      throw new ShrinkUnsupportedError(
        `Bitmap/MFT disagreement at clusters [${start}, ${end}) — run chkdsk before shrinking`
      );
    }
  }

  // Vacate every relocatable run above the boundary.
  const segments: VacatedSegment[] = [];
  const segmentsBySrc = new Map<number, VacatedSegment>();
  let claimed: Interval[] = [];
  for (const { rec, attr: work } of relocatable) {
    for (const run of work.attr.runs) {
      if (run.sparse || run.runLength <= 0) continue;
      const start = run.startLcn;
      const end = start + run.runLength;
      const vacStart = Math.max(start, boundary);
      if (end <= vacStart) continue;
      const vacCount = end - vacStart;
      const overlap = claimed.some((iv) => iv.start < vacStart + vacCount && vacStart < iv.end);
      if (overlap) {
        throw new ShrinkUnsupportedError(
          `Clusters [${vacStart}, ${vacStart + vacCount}) of record ${rec.recordNumber} are shared with another stream — run chkdsk`
        );
      }
      claimed = mergeIntervals([...claimed, { start: vacStart, end: vacStart + vacCount }]);
      const seg: VacatedSegment = { srcCluster: vacStart, clusterCount: vacCount, pieces: [] };
      segments.push(seg);
      segmentsBySrc.set(vacStart, seg);
    }
  }
  segments.sort((a, b) => a.srcCluster - b.srcCluster);

  // Free space below the boundary (bitmap-authoritative), first-fit packing.
  const freeBelow = freeIntervalsBelow(bitmapOld, boundary);
  const freeCapacity = intervalSize(freeBelow);
  const vacatedCapacity = segments.reduce((sum, s) => sum + s.clusterCount, 0);
  if (vacatedCapacity > freeCapacity) {
    throw new ShrinkUnsupportedError(
      `Not enough free space below the new boundary: ${vacatedCapacity} clusters must move but only ${freeCapacity} are free under ${boundary} clusters`
    );
  }
  let freeIdx = 0;
  let freeOffset = 0; // consumed clusters inside freeBelow[freeIdx]
  for (const seg of segments) {
    let remaining = seg.clusterCount;
    while (remaining > 0) {
      if (freeIdx >= freeBelow.length) {
        throw new ShrinkUnsupportedError(
          `Free space below the boundary is too fragmented to hold the relocated data (${seg.clusterCount}-cluster run from LCN ${seg.srcCluster})`
        );
      }
      const iv = freeBelow[freeIdx];
      const available = iv.end - iv.start - freeOffset;
      if (available <= 0) {
        freeIdx++;
        freeOffset = 0;
        continue;
      }
      const take = Math.min(available, remaining);
      seg.pieces.push({ dstCluster: iv.start + freeOffset, clusterCount: take });
      freeOffset += take;
      remaining -= take;
      if (freeOffset >= iv.end - iv.start) {
        freeIdx++;
        freeOffset = 0;
      }
    }
  }

  // Rebuild runlists per record, re-parsing after each splice so attr
  // positions stay valid when an earlier attr grows.
  const dirtyByRecord = new Map<number, Map<string, DataRun[]>>();
  for (const { rec, attr: work } of relocatable) {
    let changed = false;
    let vcn = 0;
    const newRuns: DataRun[] = [];
    for (const run of work.attr.runs) {
      if (run.sparse) {
        const len = vcn >= boundary ? 0 : Math.min(run.runLength, boundary - vcn);
        if (len > 0) newRuns.push({ startLcn: 0, runLength: len, sparse: true });
        if (len !== run.runLength) changed = true;
        vcn += run.runLength;
        continue;
      }
      const start = run.startLcn;
      const end = start + run.runLength;
      const vacStart = Math.max(start, boundary);
      if (end <= vacStart) {
        newRuns.push(run);
        vcn += run.runLength;
        continue;
      }
      changed = true;
      if (start < vacStart) {
        newRuns.push({ startLcn: start, runLength: vacStart - start });
      }
      const seg = segmentsBySrc.get(vacStart);
      if (!seg) {
        throw new ShrinkUnsupportedError(`Internal: no relocation segment for LCN ${vacStart}`);
      }
      let consumed = 0;
      for (const piece of seg.pieces) {
        newRuns.push({ startLcn: piece.dstCluster, runLength: piece.clusterCount });
        consumed += piece.clusterCount;
      }
      if (consumed !== end - vacStart) {
        throw new ShrinkUnsupportedError(`Internal: relocation piece mismatch for LCN ${vacStart}`);
      }
      vcn += run.runLength;
    }
    if (!changed) continue;
    let dirty = dirtyByRecord.get(rec.recordNumber);
    if (!dirty) {
      dirty = new Map();
      dirtyByRecord.set(rec.recordNumber, dirty);
    }
    dirty.set(work.key, coalesceRuns(newRuns));
  }

  const patchedRecords = new Map<number, Buffer>();
  for (const [recordNumber, dirty] of dirtyByRecord) {
    let current = scan.records.get(recordNumber)!.raw;
    while (dirty.size > 0) {
      const attrs = parseRawAttrs(current);
      let rebuilt = false;
      for (let i = 0; i < attrs.length && !rebuilt; i++) {
        const key = attrKey(attrs[i], attrOrdinal(attrs, i));
        const newRuns = dirty.get(key);
        if (!newRuns) continue;
        current = rebuildRecordAttrRuns(current, attrs[i], newRuns);
        dirty.delete(key);
        rebuilt = true;
      }
      if (!rebuilt) {
        throw new ShrinkUnsupportedError(`Internal: could not re-encode attribute ${[...dirty.keys()][0]} of record ${recordNumber}`);
      }
    }
    patchedRecords.set(recordNumber, current);
  }

  // $Bitmap record size fields follow the truncated prefix.
  const newBitmapBytes = Math.ceil(boundary / 8);
  const bitmapSizesChanged =
    Number(bitmapRec.raw.readBigUInt64LE(bitmapData.pos + 0x30)) !== newBitmapBytes ||
    Number(bitmapRec.raw.readBigUInt64LE(bitmapData.pos + 0x38)) !== newBitmapBytes;
  if (bitmapSizesChanged) {
    const sizePatched = Buffer.from(bitmapRec.raw);
    sizePatched.writeBigUInt64LE(BigInt(newBitmapBytes), bitmapData.pos + 0x30);
    sizePatched.writeBigUInt64LE(BigInt(newBitmapBytes), bitmapData.pos + 0x38);
    patchedRecords.set(6, sizePatched);
  }

  // $BadClus: one sparse run spanning the (new) volume.
  const badClusRec = scan.records.get(8);
  const badClusData = badClusRec?.attrs.find((a) => a.attrType === ATTR_DATA && a.name === '' && a.nonResident);
  if (!badClusRec || !badClusData) {
    throw new ShrinkUnsupportedError('Volume has no usable non-resident $BadClus stream');
  }
  const badRuns = badClusData.runs;
  if (badRuns.length !== 1 || !badRuns[0].sparse || badRuns[0].runLength !== scan.oldTotalClusters) {
    throw new ShrinkUnsupportedError('Unsupported $BadClus layout (expected one sparse run spanning the volume)');
  }
  // Rewrite the sparse run to span the new volume and update its size fields.
  const badClusNewRuns: DataRun[] = [{ startLcn: 0, runLength: boundary, sparse: true }];
  const badClusNewSize = boundary * clusterSize;
  const badClusRebuilt = rebuildRecordAttrRuns(badClusRec.raw, badClusData, badClusNewRuns);
  const badClusPatched = Buffer.from(badClusRebuilt);
  badClusPatched.writeBigUInt64LE(BigInt(badClusNewSize), badClusData.pos + 0x30);
  badClusPatched.writeBigUInt64LE(BigInt(badClusNewSize), badClusData.pos + 0x38);
  patchedRecords.set(8, badClusPatched);

  const recordPatches: NtfsShrinkRecordPatch[] = [];
  for (const [recordNumber, logical] of patchedRecords) {
    recordPatches.push({
      recordNumber,
      relativeOffset: runsToFileOffset(scan.mftRuns, clusterSize, recordNumber * scan.mftRecordSize),
      data: plantRecordFixup(logical)
    });
  }
  recordPatches.sort((a, b) => a.relativeOffset - b.relativeOffset);

  // $Bitmap content: set the bits of relocated destinations; bits beyond the
  // truncated prefix vanish with the truncation itself.
  const bitmapNew = Buffer.from(bitmapOld);
  for (const seg of segments) {
    for (const piece of seg.pieces) {
      setBitmapBits(bitmapNew, piece.dstCluster, piece.dstCluster + piece.clusterCount);
    }
  }
  const bitmapRegions: NtfsShrinkRegion[] = [];
  const bitmapFileOffset = runsToFileOffset(bitmapData.runs, clusterSize, 0);
  let byteStart = -1;
  for (let i = 0; i <= bitmapNew.length; i++) {
    const differs = i < bitmapNew.length && bitmapNew[i] !== bitmapOld[i];
    if (differs && byteStart < 0) byteStart = i;
    if (!differs && byteStart >= 0) {
      bitmapRegions.push({
        relativeOffset: bitmapFileOffset + byteStart,
        data: Buffer.from(bitmapNew.subarray(byteStart, i))
      });
      byteStart = -1;
    }
  }

  const moves: NtfsShrinkMove[] = [];
  let relocatedBytes = 0;
  for (const seg of segments) {
    let srcCursor = seg.srcCluster;
    for (const piece of seg.pieces) {
      moves.push({ srcCluster: srcCursor, dstCluster: piece.dstCluster, clusterCount: piece.clusterCount });
      relocatedBytes += piece.clusterCount * clusterSize;
      srcCursor += piece.clusterCount;
    }
  }

  const mirrorRec = scan.records.get(1);
  const mirrorData = mirrorRec?.attrs.find((a) => a.attrType === ATTR_DATA && a.name === '' && a.nonResident);
  let mirrorRecordCount = 0;
  if (mirrorData) {
    const mirrorClusters = mirrorData.runs.filter((r) => !r.sparse).reduce((sum, r) => sum + r.runLength, 0);
    mirrorRecordCount = Math.floor((mirrorClusters * clusterSize) / scan.mftRecordSize);
  }

  const bootSector = Buffer.from(reader.read(0, 512));
  bootSector.writeBigUInt64LE(BigInt(newTotalSectors), 0x28);

  return {
    oldTotalClusters: scan.oldTotalClusters,
    newTotalClusters,
    newTotalSectors,
    clusterSize,
    relocatedBytes,
    moves,
    bootSector,
    bitmapRegions,
    recordPatches,
    mftMirrStartCluster: layout.mftMirrLcn,
    mirrorRecordCount
  };
}
