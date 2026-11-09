import { PartitionReader } from '../image-browse';
import { decompressLznt1 } from './lznt1';
import { logger } from '../../utils/logger';
import {
  decryptEfsStream,
  efsStreamSizes,
  EfsEncryptedError,
  obtainFileKey,
  parseEfsAttribute
} from './efs';
import type { EfsInfo } from './efs';

export { EfsEncryptedError, parseEfsAttribute };
export type { EfsInfo, EfsKeyEntry } from './efs';

/** Stop reading the MFT after this many consecutive record-read failures. */
const MAX_CONSECUTIVE_MFT_READ_FAILURES = 16;

/**
 * A minimal NTFS reader. It does not require a mounted volume: it reads bytes
 * from a `PartitionReader` (which decompresses the covering .opbs blocks on
 * demand) and parses the boot sector, the $MFT, and file records directly.
 *
 * Supported: directory tree traversal, reading the unnamed $DATA stream of
 * regular files (resident + non-resident with data runlists), LZNT1
 * compression, and EFS decryption when the machine holds a matching private
 * key (see ./efs.ts). Not supported: sparse attributes, $ATTRIBUTE_LIST
 * continuation across records, reparse points.
 */

export interface NtfsLayout {
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  mftStartCluster: number;
  mftMirrStartCluster: number;
  fileRecordSize: number;
}

export interface DataRun {
  /** Starting LCN (cluster number within the volume), absolute. Ignored for
   *  sparse runs (offset field length 0), which are implicitly zero-filled. */
  startLcn: number;
  /** Number of clusters. */
  runLength: number;
  /** Sparse run: the clusters are not allocated and read as zeros. */
  sparse?: boolean;
}

export interface NtfsFile {
  recordNumber: number;
  inUse: boolean;
  isDirectory: boolean;
  hardLinkCount: number;
  /** Preferred display name (Win32 namespace) and its parent record. */
  name?: { name: string; parentRecord: number; namespace: number };
  size: number;
  allocatedSize: number;
  /** $DATA initialized_size (valid data length) for non-resident streams. */
  initializedSize?: number;
  modified?: number;
  created?: number;
  /** Non-resident $DATA runlist (empty if resident / no data). */
  dataRuns: DataRun[];
  /** Resident $DATA bytes (empty if non-resident). */
  residentData: Buffer;
  /** Starting VCN of the unnamed $DATA (0 for resident or whole-file). */
  dataVcn: number;
  /** NTFS compression unit (log2 of clusters per CU); > 0 means compressed. */
  compressionUnit?: number;
  /** $ATTRIBUTE_LIST entries when a file's attributes span multiple records. */
  attributeList?: Array<{ type: number; lowestVcn: number; fileReference: number }>;
  /**
   * True when another record's $ATTRIBUTE_LIST named this record as the home
   * of one of its attributes. Such a record is part of its base file, not a
   * file of its own: it has no `$FILE_NAME` and its runlist is already merged
   * into the base record by `resolveAttributeLists`. Callers that walk every
   * record (notably the allocation-map consistency check) must not count it a
   * second time.
   */
  attributeListExtension?: boolean;
  /** Named (alternate) data streams, keyed by stream name. */
  streams: Map<string, NtfsStream>;
  /** Resident $INDEX_ROOT value for the "$I30" directory index. */
  indexRoot?: Buffer;
  /** Non-resident $INDEX_ALLOCATION (data runlist + size) for the "$I30" index. */
  indexAllocation?: { dataRuns: DataRun[]; size: number };
  /** Resident $BITMAP for the "$I30" index. */
  indexBitmap?: Buffer;
  /**
   * Reparse tag from $REPARSE_POINT. Tags that redirect a file's data elsewhere
   * (Compact OS / WOF, Data Deduplication, cloud placeholders) leave the main
   * stream empty or sparse, which reads as zeros unless it is recognised.
   */
  reparseTag?: number;
  /** Set when the file carries an $EFS attribute (Encrypting File System). */
  isEncrypted?: boolean;
  /** Parseable ownership metadata from the $EFS attribute, when present. */
  efs?: EfsInfo;
}

/** An alternate data stream (named $DATA attribute). */
export interface NtfsStream {
  name: string;
  size: number;
  dataRuns: DataRun[];
  residentData: Buffer;
  dataVcn: number;
}

/** A single $I30 index entry (a directory child). */
export interface IndexEntry {
  fileReference: number;
  name: string;
  hasSubnode: boolean;
  lastEntry: boolean;
  subnodeVcn?: number;
  /** $FILE_NAME namespace from the key: 1=Win32, 2=DOS, 3=Win32&DOS, 0=POSIX. */
  namespace?: number;
}

const ATTR_STANDARD_INFORMATION = 0x10;
const ATTR_ATTRIBUTE_LIST = 0x20;
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;
const ATTR_INDEX_ROOT = 0x90;
const ATTR_INDEX_ALLOCATION = 0xa0;
const ATTR_BITMAP = 0xb0;
const ATTR_REPARSE_POINT = 0xc0;
const ATTR_EFS = 0x100;

export function parseBootSector(reader: PartitionReader): NtfsLayout {
  const bpb = reader.read(0, 512);
  const oem = bpb.toString('ascii', 3, 11);
  if (oem !== 'NTFS    ') {
    throw new Error(`Not an NTFS volume (OEM id: "${oem}")`);
  }
  // Canonical NTFS BPB offsets: total sectors (u64) at 0x28, $MFT LCN at 0x30,
  // $MFTMirr LCN at 0x38, and clusters-per-file-record (int8, negative => power
  // of two) at 0x40.
  const bytesPerSector = bpb.readUInt16LE(0x0b);
  const sectorsPerCluster = bpb.readUInt8(0x0d);
  const mftStartCluster = Number(bpb.readBigUInt64LE(0x30));
  const mftMirrStartCluster = Number(bpb.readBigUInt64LE(0x38));
  const clustersPerRecord = bpb.readInt8(0x40);
  const fileRecordSize = clustersPerRecord < 0 ? 1 << -clustersPerRecord : clustersPerRecord * bytesPerSector * sectorsPerCluster;
  if (bytesPerSector === 0 || sectorsPerCluster === 0 || fileRecordSize === 0) {
    throw new Error('Invalid boot sector parameters');
  }

  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSize: bytesPerSector * sectorsPerCluster,
    mftStartCluster,
    mftMirrStartCluster,
    fileRecordSize
  };
}

/** Read a byte range from the volume via a list of data runs. */
function readRuns(reader: PartitionReader, clusterSize: number, runs: DataRun[], byteOffset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let written = 0;
  let pos = byteOffset;
  while (written < length) {
    let fileStart = 0;
    let found = false;
    let volumeStart = 0;
    let runBytes = 0;
    let sparse = false;
    for (const run of runs) {
      const runEnd = fileStart + run.runLength * clusterSize;
      if (pos >= fileStart && pos < runEnd) {
        volumeStart = run.startLcn * clusterSize;
        runBytes = run.runLength * clusterSize;
        sparse = !!run.sparse;
        found = true;
        break;
      }
      fileStart = runEnd;
    }
    if (!found) {
      throw new Error(`Data run list does not cover offset ${pos}`);
    }
    const withinRun = pos - fileStart;
    const avail = Math.min(runBytes - withinRun, length - written);
    if (sparse) {
      // Sparse runs are logically zero-filled; no disk read is needed.
      out.fill(0, written, written + avail);
    } else {
      const chunk = reader.read(volumeStart + withinRun, avail);
      chunk.copy(out, written);
    }
    written += avail;
    pos += avail;
  }
  return out;
}

/** Apply the NTFS update-sequence fixup to a record buffer (in place copy). */
function applyFixup(buf: Buffer): Buffer {
  if (buf.length < 8) return buf;
  const usOffset = buf.readUInt16LE(4);
  const usCount = buf.readUInt16LE(6);
  if (usCount < 1 || usOffset + usCount * 2 > buf.length) return buf;
  const out = Buffer.from(buf);
  for (let i = 0; i < usCount - 1; i++) {
    const sectorStart = i * 512;
    const end = sectorStart + 512 - 2;
    if (end + 2 > out.length) break;
    const replacement = buf.readUInt16LE(usOffset + (i + 1) * 2);
    out.writeUInt16LE(replacement, end);
  }
  return out;
}

/** Parse the data-runlist at `offset` in `buf`. */
function parseRunlist(buf: Buffer, offset: number): DataRun[] {
  const runs: DataRun[] = [];
  let pos = offset;
  let relative = 0;
  while (pos < buf.length) {
    const header = buf[pos++];
    if (header === 0) break;
    const lenField = header & 0x0f;
    const offField = (header >> 4) & 0x0f;
    if (lenField === 0) break;
    // Accumulate with multiplication, not `<<`: JavaScript's bitwise operators
    // are 32-bit, so a 4-byte offset field with the high bit set (a backwards
    // jump, which fragmented files make all the time) was sign-extended by
    // subtracting 1 instead of 2^32, and fields of 5+ bytes wrapped entirely.
    // That put the run at a nonsense LCN, so its clusters were never counted.
    let runLength = 0;
    let scale = 1;
    for (let i = 0; i < lenField; i++) {
      runLength += buf[pos++] * scale;
      scale *= 256;
    }
    // A zero-length offset field means the run is sparse (not allocated): the
    // clusters are logically zero-filled.
    if (offField === 0) {
      runs.push({ startLcn: relative, runLength, sparse: true });
      continue;
    }
    let runOffset = 0;
    scale = 1;
    for (let i = 0; i < offField; i++) {
      runOffset += buf[pos++] * scale;
      scale *= 256;
    }
    // `scale` is now 2^(8*offField); an offset at or above half of it is a
    // two's-complement negative value relative to the previous run's LCN.
    if (runOffset >= scale / 2) runOffset -= scale;
    relative += runOffset;
    runs.push({ startLcn: relative, runLength });
  }
  return runs;
}

/** Parse an $ATTRIBUTE_LIST value into { type, lowestVcn, fileReference }. */
function parseAttributeList(buf: Buffer): Array<{ type: number; lowestVcn: number; fileReference: number }> {
  const entries: Array<{ type: number; lowestVcn: number; fileReference: number }> = [];
  let pos = 0;
  while (pos + 0x10 <= buf.length) {
    const type = buf.readUInt32LE(pos);
    if (type === 0) break;
    const recordLen = buf.readUInt16LE(pos + 4);
    if (recordLen < 0x18 || pos + recordLen > buf.length) break;
    const lowestVcn = Number(buf.readBigUInt64LE(pos + 0x08));
    const fileReference = Number(buf.readBigUInt64LE(pos + 0x10) & 0xffffffffffffn);
    entries.push({ type, lowestVcn, fileReference });
    pos += recordLen;
  }
  return entries;
}

/**
 * When a file's attributes span multiple MFT records (an $ATTRIBUTE_LIST), merge
 * the unnamed $DATA runlists from every referenced record (plus the base record
 * itself), sorted by starting VCN, so `readFileData` can read the whole file.
 *
 * Two pitfalls, both seen on real volumes:
 *
 *  - A real $ATTRIBUTE_LIST lists *every* attribute, including the ones stored
 *    in the base record itself. Appending the base runlist first and then again
 *    for each self-reference duplicated the first segment, which shifted every
 *    later segment's file offset — reads returned the wrong clusters.
 *  - The records named by the list are extension records, not files. They stay
 *    in the array (the browser resolves by record number), but are marked so
 *    the allocation-map check does not count their clusters a second time.
 */
export function resolveAttributeLists(records: NtfsFile[]): NtfsFile[] {
  const byRec = new Map<number, NtfsFile>();
  for (const rec of records) byRec.set(rec.recordNumber, rec);

  interface Segment {
    vcn: number;
    runs: DataRun[];
    size: number;
  }
  /** Keyed by starting VCN so a self-referencing entry cannot duplicate one. */
  const addSegment = (
    segments: Map<number, Segment>,
    vcn: number,
    runs: DataRun[],
    size: number
  ): void => {
    if (runs.length === 0 || segments.has(vcn)) return;
    segments.set(vcn, { vcn, runs, size });
  };

  for (const rec of records) {
    if (!rec.attributeList || rec.attributeList.length === 0) continue;
    const segments = new Map<number, Segment>();
    let mergedSegmentsEncrypted = false;
    if (rec.dataRuns.length > 0) {
      addSegment(segments, rec.dataVcn, rec.dataRuns, rec.size);
      mergedSegmentsEncrypted ||= rec.isEncrypted ?? false;
    }
    const indexSegs = new Map<number, Segment>();
    if (rec.indexAllocation && rec.indexAllocation.dataRuns.length > 0) {
      addSegment(indexSegs, 0, rec.indexAllocation.dataRuns, rec.indexAllocation.size);
    }
    for (const entry of rec.attributeList) {
      const ref = byRec.get(entry.fileReference);
      if (!ref) continue;
      // The list also names the attributes stored in the base record itself.
      // Those are already parsed above; handling the self-reference again is
      // what duplicated the first segment.
      if (entry.fileReference === rec.recordNumber) continue;
      // Any other record this list points at is an extension of this file.
      ref.attributeListExtension = true;
      if (entry.type === ATTR_DATA) {
        addSegment(segments, entry.lowestVcn, ref.dataRuns, ref.size);
        if (ref.dataRuns.length > 0) mergedSegmentsEncrypted ||= ref.isEncrypted ?? false;
      } else if (entry.type === ATTR_INDEX_ALLOCATION && ref.indexAllocation?.dataRuns.length) {
        addSegment(
          indexSegs,
          entry.lowestVcn,
          ref.indexAllocation.dataRuns,
          ref.indexAllocation.size
        );
      } else if (entry.type === ATTR_INDEX_ROOT && ref.indexRoot && !rec.indexRoot) {
        rec.indexRoot = ref.indexRoot;
      } else if (entry.type === ATTR_BITMAP && ref.indexBitmap && !rec.indexBitmap) {
        rec.indexBitmap = ref.indexBitmap;
      }
    }
    if (indexSegs.size > 0) {
      const merged: DataRun[] = [];
      let size = 0;
      for (const seg of [...indexSegs.values()].sort((a, b) => a.vcn - b.vcn)) {
        merged.push(...seg.runs);
        if (seg.size > size) size = seg.size;
      }
      rec.indexAllocation = { dataRuns: merged, size };
    }
    if (segments.size > 0) {
      const merged: DataRun[] = [];
      let size = 0;
      for (const seg of [...segments.values()].sort((a, b) => a.vcn - b.vcn)) {
        merged.push(...seg.runs);
        if (seg.size > size) size = seg.size;
      }
      rec.dataRuns = merged;
      rec.size = size;
      rec.dataVcn = 0;
      rec.isEncrypted = rec.isEncrypted || mergedSegmentsEncrypted;
    }
    rec.attributeList = [];
  }
  return records;
}

/** Parse a single FILE record. `recordNumber` is its index in the MFT. */
export function parseFileRecord(raw: Buffer, recordNumber: number): NtfsFile {
  if (raw.length < 0x2c || raw.toString('ascii', 0, 4) !== 'FILE') {
    throw new Error(`Not a valid MFT FILE record at index ${recordNumber}`);
  }
  const buf = applyFixup(raw);
  const firstAttrOffset = buf.readUInt16LE(0x14);
  const flags = buf.readUInt16LE(0x16);
  const inUse = (flags & 0x0001) !== 0;
  const isDirectory = (flags & 0x0002) !== 0;
  const hardLinkCount = buf.readUInt16LE(0x12);

  const file: NtfsFile = {
    recordNumber,
    inUse,
    isDirectory,
    hardLinkCount,
    size: 0,
    allocatedSize: 0,
    dataRuns: [],
    residentData: Buffer.alloc(0),
    dataVcn: 0,
    streams: new Map<string, NtfsStream>()
  };

  let pos = firstAttrOffset;
  while (pos + 8 <= buf.length) {
    const attrType = buf.readUInt32LE(pos);
    if (attrType === 0xffffffff) break;
    const attrLength = buf.readUInt32LE(pos + 4);
    if (attrLength < 8 || pos + attrLength > buf.length) break;

    const nonResident = buf.readUInt8(pos + 8) !== 0;
    const nameLen = buf.readUInt8(pos + 9);
    const nameOffset = buf.readUInt16LE(pos + 0x0a);

    if (attrType === ATTR_STANDARD_INFORMATION) {
      if (nonResident) {
        // unlikely; skip
      } else {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const valLen = buf.readUInt32LE(pos + 0x10);
        if (valLen >= 8 && valOffset + 8 <= buf.length) {
          file.created = Number(buf.readBigUInt64LE(pos + valOffset));
          file.modified = Number(buf.readBigUInt64LE(pos + valOffset + 8));
        }
      }
    } else if (attrType === ATTR_ATTRIBUTE_LIST) {
      if (!nonResident) {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const valLen = buf.readUInt32LE(pos + 0x10);
        file.attributeList = parseAttributeList(buf.subarray(pos + valOffset, pos + valOffset + valLen));
      }
    } else if (attrType === ATTR_FILE_NAME) {
      if (!nonResident) {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const parentRef = buf.readBigUInt64LE(pos + valOffset);
        const parentRecord = Number(parentRef & 0xffffffffffffn);
        const nameLength = buf.readUInt8(pos + valOffset + 0x40);
        const namespace = buf.readUInt8(pos + valOffset + 0x41);
        const nameStart = pos + valOffset + 0x42;
        const name = buf.toString('utf16le', nameStart, nameStart + nameLength * 2);
        // Prefer the Win32 namespace (1) or Win32&DOS (3) over DOS (2).
        const prefer =
          namespace === 1 || namespace === 3 || !file.name;
        if (prefer) {
          file.name = { name, parentRecord, namespace };
        }
      }
    } else if (attrType === ATTR_DATA) {
      const isUnnamed = nameLen === 0;
      if (isUnnamed) {
        if (nonResident) {
          const runlistOffset = buf.readUInt16LE(pos + 0x20);
          const realSize = Number(buf.readBigUInt64LE(pos + 0x30));
          const allocatedSize = Number(buf.readBigUInt64LE(pos + 0x28));
          file.dataRuns = parseRunlist(buf, pos + runlistOffset);
          file.size = realSize;
          file.allocatedSize = allocatedSize;
          if (pos + 0x40 <= buf.length) {
            file.initializedSize = Number(buf.readBigUInt64LE(pos + 0x38));
          }
          file.dataVcn = Number(buf.readBigUInt64LE(pos + 0x10));
          file.compressionUnit = buf.readUInt16LE(pos + 0x22);
        } else {
          const valOffset = buf.readUInt16LE(pos + 0x14);
          const valLen = buf.readUInt32LE(pos + 0x10);
          if (valOffset + valLen <= buf.length) {
            file.residentData = Buffer.from(buf.subarray(pos + valOffset, pos + valOffset + valLen));
            file.size = valLen;
            file.allocatedSize = valLen;
          }
        }
      } else {
        // Named (alternate) data stream.
        const streamName = buf.toString('utf16le', pos + nameOffset, pos + nameOffset + nameLen * 2);
        let stream: NtfsStream | undefined = file.streams.get(streamName);
        if (!stream) {
          stream = { name: streamName, size: 0, dataRuns: [], residentData: Buffer.alloc(0), dataVcn: 0 };
          file.streams.set(streamName, stream);
        }
        if (nonResident) {
          const runlistOffset = buf.readUInt16LE(pos + 0x20);
          stream.dataRuns = parseRunlist(buf, pos + runlistOffset);
          stream.size = Number(buf.readBigUInt64LE(pos + 0x30));
          stream.dataVcn = Number(buf.readBigUInt64LE(pos + 0x10));
        } else {
          const valOffset = buf.readUInt16LE(pos + 0x14);
          const valLen = buf.readUInt32LE(pos + 0x10);
          if (valOffset + valLen <= buf.length) {
            stream.residentData = Buffer.from(buf.subarray(pos + valOffset, pos + valOffset + valLen));
            stream.size = valLen;
          }
        }
      }
    } else if (attrType === ATTR_INDEX_ROOT) {
      // Resident "$I30" index root: the value holds the index entries.
      if (!nonResident) {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const valLen = buf.readUInt32LE(pos + 0x10);
        if (valOffset + valLen <= buf.length) {
          file.indexRoot = Buffer.from(buf.subarray(pos + valOffset, pos + valOffset + valLen));
        }
      }
    } else if (attrType === ATTR_INDEX_ALLOCATION) {
      // Non-resident "$I30" index allocation (large directories).
      if (nonResident) {
        const runlistOffset = buf.readUInt16LE(pos + 0x20);
        const realSize = Number(buf.readBigUInt64LE(pos + 0x30));
        file.indexAllocation = { dataRuns: parseRunlist(buf, pos + runlistOffset), size: realSize };
      }
    } else if (attrType === ATTR_BITMAP) {
      if (!nonResident) {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const valLen = buf.readUInt32LE(pos + 0x10);
        if (valOffset + valLen <= buf.length) {
          file.indexBitmap = Buffer.from(buf.subarray(pos + valOffset, pos + valOffset + valLen));
        }
      }
    } else if (attrType === ATTR_REPARSE_POINT) {
      if (!nonResident) {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const valLen = buf.readUInt32LE(pos + 0x10);
        if (valLen >= 4 && pos + valOffset + 4 <= buf.length) {
          file.reparseTag = buf.readUInt32LE(pos + valOffset);
        }
      }
    } else if (attrType === ATTR_EFS) {
      // Encrypting File System: the presence of the attribute marks the file,
      // and its value records which principals' keys wrap the file's FEK.
      file.isEncrypted = true;
      if (!nonResident) {
        const valOffset = buf.readUInt16LE(pos + 0x14);
        const valLen = buf.readUInt32LE(pos + 0x10);
        if (valOffset + valLen <= buf.length) {
          file.efs = parseEfsAttribute(buf.subarray(pos + valOffset, pos + valOffset + valLen));
        }
      }
    }

    pos += attrLength;
  }

  return file;
}

/** Read and parse every MFT record in the volume. */
export function readFileRecords(reader: PartitionReader, layout: NtfsLayout): NtfsFile[] {
  // $MFT's own FILE record (record 0) lives at a fixed location. If it is
  // corrupt, fall back to $MFTMirr (a mirror of the first MFT records).
  let mftFile: NtfsFile;
  try {
    mftFile = parseFileRecord(
      reader.read(layout.mftStartCluster * layout.clusterSize, layout.fileRecordSize),
      0
    );
  } catch {
    mftFile = parseFileRecord(
      reader.read(layout.mftMirrStartCluster * layout.clusterSize, layout.fileRecordSize),
      0
    );
  }
  const records: NtfsFile[] = [];

  const recordCount = Math.floor(mftFile.size / layout.fileRecordSize);
  let consecutiveFailures = 0;
  let firstFailure = '';
  for (let i = 0; i < recordCount; i++) {
    let raw: Buffer;
    try {
      if (mftFile.dataRuns.length > 0) {
        raw = readRuns(reader, layout.clusterSize, mftFile.dataRuns, i * layout.fileRecordSize, layout.fileRecordSize);
      } else {
        raw = reader.read(layout.mftStartCluster * layout.clusterSize + i * layout.fileRecordSize, layout.fileRecordSize);
      }
      consecutiveFailures = 0;
    } catch (error) {
      // A single bad record (hole, corruption) must not abort the whole MFT —
      // stopping on the first error truncated the cache, so every later
      // directory index entry failed to resolve and the browser showed an
      // empty folder. Only give up after many failures in a row, which means
      // the runlist itself no longer covers the offset.
      consecutiveFailures++;
      if (!firstFailure) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_MFT_READ_FAILURES) {
        logger.warn(
          `readFileRecords: stopping after ${consecutiveFailures} consecutive read failures at record ` +
            `${i}/${recordCount} (first: ${firstFailure}); ${records.length} records loaded`
        );
        break;
      }
      continue;
    }
    try {
      records.push(parseFileRecord(raw, i));
    } catch {
      // Skip invalid records (e.g. sparse/unallocated MFT slots).
      continue;
    }
  }
  if (records.length === 0 && recordCount > 0) {
    logger.warn(`readFileRecords: loaded 0 of ${recordCount} MFT records (first failure: ${firstFailure || 'none'})`);
  }
  return resolveAttributeLists(records);
}

/**
 * Read the FILE record at `recordNumber` from the $MFT. The $MFT's own record
 * (0) carries the data-runlist for the whole MFT; falls back to $MFTMirr when
 * record 0 cannot be parsed.
 */
function readFileRecordRaw(reader: PartitionReader, layout: NtfsLayout, recordNumber: number): Buffer {
  let mft: NtfsFile;
  try {
    mft = parseFileRecord(
      reader.read(layout.mftStartCluster * layout.clusterSize, layout.fileRecordSize),
      0
    );
  } catch {
    mft = parseFileRecord(
      reader.read(layout.mftMirrStartCluster * layout.clusterSize, layout.fileRecordSize),
      0
    );
  }
  if (mft.dataRuns.length > 0) {
    return readRuns(
      reader,
      layout.clusterSize,
      mft.dataRuns,
      recordNumber * layout.fileRecordSize,
      layout.fileRecordSize
    );
  }
  return reader.read(
    layout.mftStartCluster * layout.clusterSize + recordNumber * layout.fileRecordSize,
    layout.fileRecordSize
  );
}

/** $Volume's VOLUME_INFORMATION attribute (type 0x70) in FILE record 3. */
const ATTR_VOLUME_INFORMATION = 0x70;
/** VOLUME_INFORMATION.Flags bit 0: the volume is dirty. */
export const VOLUME_FLAG_DIRTY = 0x0001;

export interface VolumeFlags {
  majorVersion: number;
  minorVersion: number;
  flags: number;
  /** VOLUME_IS_DIRTY — Windows runs a repair on the next boot when it is set. */
  dirty: boolean;
}

/**
 * Parse the VOLUME_INFORMATION attribute out of a $Volume FILE record
 * (record 3).
 *
 * The dirty bit is the whole point. NTFS sets it while the volume is mounted
 * and clears it on a clean dismount, so every image captured from a running
 * Windows carries it set. Restoring that image puts back a volume Windows
 * considers dirty, the first boot schedules a repair, and the user is told to
 * "Restart to repair drive errors" — which reads like the restore broke
 * something (field report 2026-11-02). Knowing it before the restore is the
 * difference between "expected" and "alarming".
 */
export function parseVolumeFlags(raw: Buffer): VolumeFlags | null {
  if (raw.length < 0x30 || raw.toString('ascii', 0, 4) !== 'FILE') return null;
  const buf = applyFixup(raw);
  let pos = buf.readUInt16LE(0x14);
  while (pos + 8 <= buf.length) {
    const attrType = buf.readUInt32LE(pos);
    if (attrType === 0xffffffff) break;
    const attrLength = buf.readUInt32LE(pos + 4);
    if (attrLength < 8 || pos + attrLength > buf.length) break;
    const nonResident = buf.readUInt8(pos + 8) !== 0;
    if (attrType === ATTR_VOLUME_INFORMATION && !nonResident) {
      const valLen = buf.readUInt32LE(pos + 0x10);
      const valOffset = buf.readUInt16LE(pos + 0x14);
      if (valLen < 4 || valOffset + 4 > buf.length) return null;
      const majorVersion = buf.readUInt8(pos + valOffset);
      const minorVersion = buf.readUInt8(pos + valOffset + 1);
      const flags = buf.readUInt16LE(pos + valOffset + 2);
      return { majorVersion, minorVersion, flags, dirty: (flags & VOLUME_FLAG_DIRTY) !== 0 };
    }
    pos += attrLength;
  }
  return null;
}

/**
 * The warning for restoring an image whose NTFS volume is marked dirty.
 *
 * Shared by the plan and the restore so the two can never drift, and it must
 * name the consequence rather than only the symptom: a tester (2026-11-02)
 * lost a browser profile to the repair this warning announces, and the
 * earlier wording said a repair would run without saying what it could take
 * with it.
 */
export function dirtyVolumeWarning(label: string): string {
  return (
    `${label}: the image was captured from a running Windows, so its volume is marked dirty. ` +
    `Windows will run a repair at first boot and may say "Restart to repair drive errors" — that ` +
    `prompt is the live capture, not the restore. The repair can also discard files that were still ` +
    `being written when the backup was taken (a browser profile captured mid-write is the usual ` +
    `case). Close open applications before taking a backup you mean to restore in place.`
  );
}

/**
 * Read $Volume's flags straight from a partition, without loading the whole
 * MFT. Returns `null` when the volume is not NTFS or the record cannot be
 * read — callers treat that as "unknown", never as "clean".
 */
export function readVolumeFlags(reader: PartitionReader, layout: NtfsLayout): VolumeFlags | null {
  try {
    return parseVolumeFlags(readFileRecordRaw(reader, layout, 3));
  } catch {
    return null;
  }
}

export interface NtfsBitmapInfo {
  clusterSize: number;
  /** Number of clusters covered by the $Bitmap (its logical size in bits). */
  totalClusters: number;
  bitmapBytes: Buffer;
}

/**
 * Read the NTFS $Bitmap (file record 6): the cluster allocation map used to
 * determine which clusters hold allocated data. `totalClusters` is derived from
 * the $Bitmap's own length, `bitmapBytes` the raw bit map (bit N = cluster N).
 */
export function readNtfsBitmap(reader: PartitionReader, layout: NtfsLayout): NtfsBitmapInfo {
  const record = parseFileRecord(readFileRecordRaw(reader, layout, 6), 6);
  let bytes: Buffer;
  if (record.residentData.length > 0) {
    bytes = record.residentData;
  } else if (record.dataRuns.length > 0) {
    bytes = readRuns(reader, layout.clusterSize, record.dataRuns, 0, record.size);
  } else {
    bytes = Buffer.alloc(0);
  }
  const totalClusters = Math.floor(record.size * 8);
  return { clusterSize: layout.clusterSize, totalClusters, bitmapBytes: bytes };
}

export interface NtfsNode {
  recordNumber: number;
  name: string;
  parentRecord: number;
  isDirectory: boolean;
  size: number;
  modified?: number;
  /** True for EFS-encrypted files (cannot be read from the image directly). */
  isEncrypted?: boolean;
}

/**
 * Build a directory tree from parsed file records, rooted at record 5 ($Root).
 * Files that do not resolve to an existing parent are left as roots.
 */
export function buildTree(records: NtfsFile[]): Map<number, NtfsNode[]> {
  const nodes = new Map<number, NtfsNode>();
  for (const rec of records) {
    if (!rec.inUse || !rec.name) continue;
    nodes.set(rec.recordNumber, {
      recordNumber: rec.recordNumber,
      name: rec.name.name,
      parentRecord: rec.name.parentRecord,
      isDirectory: rec.isDirectory,
      size: rec.size,
      modified: rec.modified,
      isEncrypted: rec.isEncrypted
    });
  }

  const children = new Map<number, NtfsNode[]>();
  for (const node of nodes.values()) {
    if (!children.has(node.parentRecord)) children.set(node.parentRecord, []);
    children.get(node.parentRecord)!.push(node);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return children;
}

/**
 * Decrypted plaintext per record. A mounted view issues many small reads, so
 * the result is kept (for reasonably sized files) rather than re-unwrapping
 * the FEK and re-decrypting the whole stream on every request.
 */
const efsPlainCache = new WeakMap<NtfsFile, Buffer>();
const EFS_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Read and decrypt an EFS file's unnamed $DATA stream. The ciphertext extent
 * is read first, its plaintext length resolved, and each 512-byte sector
 * decrypted with the unwrapped file encryption key. Throws
 * `EfsEncryptedError` when no local private key can unwrap the key.
 */
function readEfsFileData(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): Buffer {
  const cached = efsPlainCache.get(file);
  if (cached) return cached;

  const label = file.name?.name ?? `record ${file.recordNumber}`;
  if (!file.efs) {
    throw new EfsEncryptedError(
      `"${label}" is EFS-encrypted but the $EFS attribute is missing from its file record`
    );
  }
  const fek = obtainFileKey(file.efs, label);

  const want = Math.max(file.size, Math.ceil((file.size + 2) / 512) * 512);
  let raw: Buffer;
  if (file.residentData.length > 0) {
    raw = Buffer.from(file.residentData);
  } else {
    // Read the whole ciphertext extent: the pad field (when present) lives
    // just past data_size and the last sector always has to be complete.
    const length = file.allocatedSize > 0 ? Math.min(want, Math.max(file.allocatedSize, file.size)) : want;
    raw = readRuns(reader, layout.clusterSize, file.dataRuns, 0, length);
  }
  const { plain, cipher } = efsStreamSizes(raw, file.size, file.initializedSize);
  const out = decryptEfsStream(raw, cipher, plain, fek);
  if (out.length <= EFS_CACHE_MAX_BYTES) efsPlainCache.set(file, out);
  return out;
}

/**
 * The file's data is not in its main stream, so reading that stream would hand
 * back zeros (or nothing) that look like real content. Raised instead of
 * returning them, so an extraction can say which files it could not recover.
 */
export class NtfsDataUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NtfsDataUnavailableError';
  }
}

const REPARSE_TAG_DEDUP = 0x80000013;
const REPARSE_TAG_WOF = 0x80000017;
/** IO_REPARSE_TAG_CLOUD and CLOUD_1..CLOUD_F (0x9000_X01A). */
const isCloudReparseTag = (tag: number): boolean => ((tag & 0xffff0fff) >>> 0) === 0x9000001a;

/**
 * Why a file's data cannot be read from its main stream, or undefined when it can.
 *
 * A file whose main stream has no allocated clusters but a non-zero size is either
 * redirected elsewhere by a reparse point (Compact OS keeps the bytes in a separate
 * compressed stream; a cloud placeholder keeps them off the disk; Data Deduplication
 * keeps them in a chunk store) or has a record that is incomplete. Reading the stream
 * as if it were sparse returns zeros that look real, and the old code returned an empty
 * file when there were no runs at all. A file that is genuinely sparse (no reparse
 * point, runs present) really is zeros, and stays readable.
 */
export function dataUnavailableReason(file: NtfsFile): string | undefined {
  if (file.isEncrypted || file.residentData.length > 0 || file.size === 0) return undefined;
  if (file.dataRuns.some((run) => !run.sparse)) return undefined;
  const tag = file.reparseTag;
  if (tag === REPARSE_TAG_WOF) {
    return 'The file is stored with Windows Compact OS (WOF) compression, which OPBS cannot decompress yet.';
  }
  if (tag === REPARSE_TAG_DEDUP) {
    return 'The file is stored by Windows Data Deduplication, which OPBS cannot reassemble.';
  }
  if (tag !== undefined && isCloudReparseTag(tag)) {
    return 'The file is an online-only cloud file (for example OneDrive): its data was never on this disk.';
  }
  if (file.dataRuns.length === 0) {
    return "The file's data runs could not be located (the record is incomplete or damaged).";
  }
  return undefined;
}

function assertDataAvailable(file: NtfsFile): void {
  const reason = dataUnavailableReason(file);
  if (reason) throw new NtfsDataUnavailableError(reason);
}

/** Zero the bytes of `buf` (which starts at file offset `from`) that lie past the valid data length. */
function zeroPastValidData(buf: Buffer, from: number, file: NtfsFile): void {
  const valid = file.initializedSize;
  if (valid === undefined || valid >= file.size) return;
  if (from + buf.length > valid) buf.fill(0, Math.max(0, valid - from));
}

/** Read the unnamed $DATA stream of a file record (cluster-based). */
export function readFileData(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): Buffer {
  if (file.isEncrypted) {
    return readEfsFileData(reader, layout, file);
  }
  if (file.residentData.length > 0) {
    return Buffer.from(file.residentData);
  }
  if (file.size === 0) {
    return Buffer.alloc(0);
  }
  assertDataAvailable(file);
  // Bytes past the valid data length read as zero (clusters can hold stale data from
  // a preallocated or extended file); both readers below return a fresh buffer.
  const out =
    file.compressionUnit && file.compressionUnit > 0
      ? readCompressedFileData(reader, layout, file)
      : readRuns(reader, layout.clusterSize, file.dataRuns, 0, file.size);
  zeroPastValidData(out, 0, file);
  return out;
}

/**
 * Read a byte range of a file's unnamed $DATA stream. The range is clamped to
 * the stream length. Compressed files are decoded whole and then sliced (their
 * compression units are independent, so this is always safe).
 */
export function readFileRange(
  reader: PartitionReader,
  layout: NtfsLayout,
  file: NtfsFile,
  offset: number,
  length: number
): Buffer {
  if (file.isEncrypted) {
    const plain = readEfsFileData(reader, layout, file);
    if (length <= 0 || offset >= plain.length) return Buffer.alloc(0);
    const start = offset < 0 ? 0 : offset;
    return Buffer.from(plain.subarray(start, Math.min(start + length, plain.length)));
  }
  if (length <= 0 || offset >= file.size) return Buffer.alloc(0);
  const start = offset < 0 ? 0 : offset;
  const end = Math.min(start + length, file.size);
  if (file.residentData.length > 0) {
    return Buffer.from(file.residentData.subarray(start, end));
  }
  assertDataAvailable(file);
  const out =
    file.compressionUnit && file.compressionUnit > 0
      ? readCompressedFileData(reader, layout, file).subarray(start, end)
      : readRuns(reader, layout.clusterSize, file.dataRuns, start, end - start);
  zeroPastValidData(out, start, file);
  return out;
}

/** Default size of the pieces a file is streamed in. */
export const NTFS_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Hand a file's bytes to `onChunk` in order, a piece at a time. Plain files are read
 * range by range, so a file of any size (a Node 18 Buffer tops out at 4 GiB) can be
 * copied without holding it in memory. Resident, compressed and EFS files are decoded
 * whole, as their formats require.
 */
export function forEachNtfsFileChunk(
  reader: PartitionReader,
  layout: NtfsLayout,
  file: NtfsFile,
  onChunk: (chunk: Buffer) => void,
  chunkBytes = NTFS_STREAM_CHUNK_BYTES
): void {
  const decodedWhole =
    file.isEncrypted || file.residentData.length > 0 || (file.compressionUnit ?? 0) > 0 || file.size <= chunkBytes;
  if (decodedWhole) {
    const whole = readFileData(reader, layout, file);
    if (whole.length > 0) onChunk(whole);
    return;
  }
  assertDataAvailable(file);
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    onChunk(readFileRange(reader, layout, file, offset, Math.min(chunkBytes, file.size - offset)));
  }
}

/**
 * Read an NTFS-compressed (LZNT1) file. The data is stored as independent
 * compression units of `1 << compressionUnit` clusters. Each unit is one of:
 *  - entirely sparse: zeros;
 *  - allocated in full: stored raw;
 *  - partly allocated, the rest sparse: compressed, decoded via LZNT1.
 *
 * Works unit by unit from each run's absolute position in the file. The old
 * version asked `readRuns` for a file-level offset inside a list holding only
 * the current run, which only worked for the very first unit, so any compressed
 * file larger than one unit failed with "Data run list does not cover offset".
 * It also shortened runs in place, corrupting the cached record.
 */
function readCompressedFileData(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): Buffer {
  const clusterSize = layout.clusterSize;
  const cuClusters = 1 << (file.compressionUnit ?? 4);
  const cuSize = cuClusters * clusterSize;
  const out = Buffer.alloc(file.size);
  const fileClusters = Math.ceil(file.size / clusterSize);

  // Where each run starts in the file, in clusters. Not mutated afterwards.
  const runs: Array<{ vcn: number; length: number; startLcn: number; sparse: boolean }> = [];
  let next = 0;
  for (const run of file.dataRuns) {
    runs.push({ vcn: next, length: run.runLength, startLcn: run.startLcn, sparse: !!run.sparse });
    next += run.runLength;
  }

  let ri = 0;
  for (let cuStart = 0; cuStart < fileClusters; cuStart += cuClusters) {
    const cuEnd = cuStart + cuClusters;
    while (ri < runs.length && runs[ri].vcn + runs[ri].length <= cuStart) ri++;

    // The allocated pieces of this unit, in order, and how much of it is sparse.
    const pieces: Buffer[] = [];
    let allocated = 0;
    let sparse = 0;
    for (let k = ri; k < runs.length && runs[k].vcn < cuEnd; k++) {
      const run = runs[k];
      const from = Math.max(run.vcn, cuStart);
      const to = Math.min(run.vcn + run.length, cuEnd);
      if (run.sparse) {
        sparse += to - from;
      } else {
        pieces.push(reader.read((run.startLcn + (from - run.vcn)) * clusterSize, (to - from) * clusterSize));
        allocated += to - from;
      }
    }
    if (allocated === 0) continue; // all sparse, or past the run list: zeros

    const raw = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    // Compressed only when part of the unit is explicitly sparse. A unit allocated in full is raw,
    // and so is a short last unit whose run list simply ends (no sparse fill follows it).
    const data = sparse > 0 ? decompressLznt1(raw, cuSize) : raw;
    const at = cuStart * clusterSize;
    data.copy(out, at, 0, Math.min(data.length, file.size - at));
  }
  return out;
}

/** Read a named (alternate) data stream of a file record. */
export function readStreamData(reader: PartitionReader, layout: NtfsLayout, stream: NtfsStream): Buffer {
  if (stream.residentData.length > 0) {
    return Buffer.from(stream.residentData);
  }
  if (stream.dataRuns.length === 0) {
    return Buffer.alloc(0);
  }
  return readRuns(reader, layout.clusterSize, stream.dataRuns, 0, stream.size);
}

/**
 * Parse a run of $I30 index entries from `buf` starting at `entriesStart`.
 *
 * Each entry's key is a $FILE_NAME structure: parent reference, timestamps,
 * sizes, then name length (0x40), name namespace (0x41) and the UTF-16 name
 * (0x42). The name is extracted from the key, not from the entry header.
 */
function parseIndexEntries(buf: Buffer, entriesStart: number, end: number): IndexEntry[] {
  const entries: IndexEntry[] = [];
  let pos = entriesStart;
  while (pos + 0x10 <= end) {
    const fileReference = Number(buf.readBigUInt64LE(pos) & 0xffffffffffffn);
    const entryLength = buf.readUInt16LE(pos + 0x08);
    const flags = buf.readUInt16LE(pos + 0x0c);
    if (entryLength === 0 || pos + entryLength > end) break;
    const hasSubnode = (flags & 0x01) !== 0;
    const lastEntry = (flags & 0x02) !== 0;
    // The key is a $FILE_NAME structure; skip entries without a parseable one.
    const keyOffset = 0x10;
    let name = '';
    let validName = false;
    let namespace: number | undefined;
    if (entryLength >= 0x10 + 0x42) {
      const nameLength = buf.readUInt8(pos + keyOffset + 0x40);
      const nameStart = pos + keyOffset + 0x42;
      if (nameLength > 0 && nameStart + nameLength * 2 <= pos + entryLength) {
        name = buf.toString('utf16le', nameStart, nameStart + nameLength * 2);
        namespace = buf.readUInt8(pos + keyOffset + 0x41);
        validName = true;
      }
    }
    if (validName) {
      const subnodeVcn = hasSubnode ? Number(buf.readBigUInt64LE(pos + entryLength - 8) & 0xffffffffffffn) : undefined;
      entries.push({ fileReference, name, hasSubnode, lastEntry, subnodeVcn, namespace });
    }
    if (lastEntry) break;
    pos += entryLength;
  }
  return entries;
}

/**
 * Parse one INDEX_HEADER region (resident $INDEX_ROOT body, or the header
 * inside an INDX allocation buffer). `headerOffset` is where the INDEX_HEADER
 * sits; `entriesOffset`/`totalSize` are relative to that header, and
 * `totalSize` runs from the header start through the last entry.
 */
function parseIndexHeader(buf: Buffer, headerOffset: number): IndexEntry[] {
  if (headerOffset < 0 || headerOffset + 0x10 > buf.length) return [];
  const entriesOffset = buf.readUInt32LE(headerOffset);
  const totalSize = buf.readUInt32LE(headerOffset + 4);
  const start = headerOffset + entriesOffset;
  const end = Math.min(headerOffset + totalSize, buf.length);
  if (start >= end) return [];
  return parseIndexEntries(buf, start, end);
}

/**
 * Parse an $INDEX_ALLOCATION buffer. Real on-disk buffers are INDX records
 * (magic + update sequence + LSN + VCN, INDEX_HEADER at 0x18). Some fixtures
 * place a bare INDEX_HEADER at offset 0 — accept that too.
 */
function parseIndexAllocationBuffer(raw: Buffer): IndexEntry[] {
  if (raw.length >= 0x28 && raw.toString('ascii', 0, 4) === 'INDX') {
    const buf = applyFixup(raw);
    return parseIndexHeader(buf, 0x18);
  }
  if (raw.length >= 0x10) {
    return parseIndexHeader(raw, 0);
  }
  return [];
}

/**
 * Read a directory's children via the "$I30" index ($INDEX_ROOT, and
 * $INDEX_ALLOCATION buffers for large directories). Falls back to an empty list
 * when the directory has no index root (e.g. non-directories).
 */
export function readDirectoryIndex(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): IndexEntry[] {
  if (!file.indexRoot) return [];
  const entries: IndexEntry[] = [];

  // $INDEX_ROOT: 0x10 INDEX_ROOT header, then INDEX_HEADER, then entries.
  entries.push(...parseIndexHeader(file.indexRoot, 0x10));

  // $INDEX_ALLOCATION: a series of index buffers for large directories.
  if (file.indexAllocation && file.indexAllocation.dataRuns.length > 0) {
    const clustersPerBuffer = file.indexRoot.readUInt8(0x0c);
    const bufferSize = Math.max(512, clustersPerBuffer * layout.clusterSize);
    const bitmap = file.indexBitmap;
    const bufferCount = Math.ceil(file.indexAllocation.size / bufferSize);
    let buffersRead = 0;
    for (let i = 0; i < bufferCount; i++) {
      if (bitmap && i >> 3 < bitmap.length && !(bitmap[i >> 3] & (1 << (i & 7)))) continue;
      const raw = readRuns(reader, layout.clusterSize, file.indexAllocation.dataRuns, i * bufferSize, bufferSize);
      const parsed = parseIndexAllocationBuffer(raw);
      if (parsed.length > 0) buffersRead++;
      entries.push(...parsed);
    }
    if (entries.length === 0 && bufferCount > 0) {
      logger.warn(
        `readDirectoryIndex: record ${file.recordNumber} has ${bufferCount} index buffer(s) ` +
          `(${buffersRead} with entries) but no children parsed`
      );
    }
  }

  return entries;
}
