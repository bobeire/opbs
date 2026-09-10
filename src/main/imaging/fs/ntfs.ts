import { PartitionReader } from '../image-browse';
import { decompressLznt1 } from './lznt1';

/**
 * A minimal NTFS reader. It does not require a mounted volume: it reads bytes
 * from a `PartitionReader` (which decompresses the covering .opbs blocks on
 * demand) and parses the boot sector, the $MFT, and file records directly.
 *
 * Supported: directory tree traversal and reading the unnamed $DATA stream of
 * regular files (resident + non-resident with data runlists). Not supported:
 * compression, encryption, EFS, sparse attributes, $ATTRIBUTE_LIST continuation
 * across records, alternate data streams, or reparse points.
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
  /** Named (alternate) data streams, keyed by stream name. */
  streams: Map<string, NtfsStream>;
  /** Resident $INDEX_ROOT value for the "$I30" directory index. */
  indexRoot?: Buffer;
  /** Non-resident $INDEX_ALLOCATION (data runlist + size) for the "$I30" index. */
  indexAllocation?: { dataRuns: DataRun[]; size: number };
  /** Resident $BITMAP for the "$I30" index. */
  indexBitmap?: Buffer;
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

/**
 * A single EFS user / recovery-agent entry extracted from the $EFS attribute.
 * `containerGuid` identifies the certificate (or key-context) whose public key
 * wraps the file's FEK. Key info is parsed best-effort: type 0 = legacy CAPI
 * key, 1 = CNG key; `algId` is the CALG identifier for the data cipher.
 */
export interface EfsKeyEntry {
  name: string;
  containerGuid: string;
  keyType: number;
  algId: number;
  fekBits: number;
  keyInfoOffset: number;
}

/** Decoded $EFS attribute metadata (detection + key ownership, not the FEK). */
export interface EfsInfo {
  version: number;
  entries: EfsKeyEntry[];
}

/**
 * Raised when reading the $DATA stream of an EFS-encrypted file. Offline
 * decryption requires the owning user's private key (DPAPI-protected), which
 * is not available from the image itself, so the ciphertext must never be
 * handed to the caller as if it were plaintext.
 */
export class EfsEncryptedError extends Error {
  readonly code = 'EFS_ENCRYPTED';
}

function formatGuid(bytes: Buffer): string {
  const h = (b: Buffer, o: number, n: number) => b.subarray(o, o + n).toString('hex');
  return `${h(bytes, 0, 4)}-${h(bytes, 4, 2)}-${h(bytes, 6, 2)}-${h(bytes, 8, 2)}-${h(bytes, 10, 6)}`;
}

/**
 * Parse the value of an $EFS attribute (type 0x100). The blob is a version/
 * end-of-blob header followed by one entry per principal (file owner +
 * recovery agents). Parsing is intentionally defensive: the presence of the
 * attribute alone marks the file as encrypted, so malformed metadata must not
 * abort the read of an otherwise-valid volume.
 */
export function parseEfsAttribute(value: Buffer): EfsInfo {
  const entries: EfsKeyEntry[] = [];
  if (value.length < 0x18) {
    return { version: 0, entries };
  }
  const version = value.readUInt32LE(0x00);
  let end = value.length;
  const blobEnd = value.readUInt32LE(0x04);
  if (blobEnd >= 0x18 && blobEnd <= value.length) {
    end = blobEnd;
  }
  let pos = 0x18;
  while (pos + 0x18 <= end) {
    const entryLen = value.readUInt32LE(pos);
    const keyInfoOffset = value.readUInt32LE(pos + 4);
    if (entryLen < 0x18 || pos + entryLen > end) break;

    const nameStart = pos + 0x18;
    const nameEnd = pos + entryLen;
    let charsEnd = nameEnd;
    while (charsEnd - nameStart >= 2 && value.readUInt16LE(charsEnd - 2) === 0) charsEnd -= 2;
    let name = '';
    if (charsEnd > nameStart) {
      // Trim trailing UTF-16 NUL; strip a trailing length word if present.
      let candidate = value.toString('utf16le', nameStart, charsEnd);
      if (candidate.length > 0 && candidate.charCodeAt(candidate.length - 1) === 0) {
        candidate = candidate.slice(0, -1);
      }
      name = candidate;
    }
    // The key info usually lives at an absolute offset; fall back to treating
    // the offset as relative to this entry.
    let keyType = 0;
    let algId = 0;
    let fekBits = 0;
    const keyInfoPos =
      keyInfoOffset >= 0x18 && keyInfoOffset + 0x10 <= end
        ? keyInfoOffset
        : pos + keyInfoOffset + 0x10 <= end
          ? pos + keyInfoOffset
          : -1;
    if (keyInfoPos >= 0) {
      keyType = value.readUInt32LE(keyInfoPos);
      algId = value.readUInt32LE(keyInfoPos + 4);
      fekBits = value.readUInt32LE(keyInfoPos + 8);
    }
    entries.push({
      name,
      containerGuid: formatGuid(value.subarray(pos + 8, pos + 24)),
      keyType,
      algId,
      fekBits,
      keyInfoOffset: keyInfoPos
    });
    pos += entryLen;
  }
  return { version, entries };
}

/** A single $I30 index entry (a directory child). */
export interface IndexEntry {
  fileReference: number;
  name: string;
  hasSubnode: boolean;
  lastEntry: boolean;
  subnodeVcn?: number;
}

const ATTR_STANDARD_INFORMATION = 0x10;
const ATTR_ATTRIBUTE_LIST = 0x20;
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;
const ATTR_INDEX_ROOT = 0x90;
const ATTR_INDEX_ALLOCATION = 0xa0;
const ATTR_BITMAP = 0xb0;
const ATTR_EFS = 0x100;

const NTFS_SIGNATURE = 'NTFS    ';

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
    let runLength = 0;
    for (let i = 0; i < lenField; i++) runLength |= buf[pos++] << (8 * i);
    // A zero-length offset field means the run is sparse (not allocated): the
    // clusters are logically zero-filled.
    if (offField === 0) {
      relative += 0;
      runs.push({ startLcn: relative, runLength, sparse: true });
      continue;
    }
    let runOffset = 0;
    for (let i = 0; i < offField; i++) runOffset |= buf[pos++] << (8 * i);
    if (offField > 0 && runOffset & (1 << (8 * offField - 1))) {
      runOffset -= 1 << (8 * offField);
    }
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
 */
export function resolveAttributeLists(records: NtfsFile[]): NtfsFile[] {
  const byRec = new Map<number, NtfsFile>();
  for (const rec of records) byRec.set(rec.recordNumber, rec);

  for (const rec of records) {
    if (!rec.attributeList || rec.attributeList.length === 0) continue;
    const segments: Array<{ vcn: number; runs: DataRun[]; size: number }> = [];
    let mergedSegmentsEncrypted = false;
    if (rec.dataRuns.length > 0) {
      segments.push({ vcn: rec.dataVcn, runs: rec.dataRuns, size: rec.size });
      mergedSegmentsEncrypted ||= rec.isEncrypted ?? false;
    }
    for (const entry of rec.attributeList) {
      if (entry.type !== ATTR_DATA) continue;
      const ref = byRec.get(entry.fileReference);
      if (ref && ref.dataRuns.length > 0) {
        segments.push({ vcn: ref.dataVcn, runs: ref.dataRuns, size: ref.size });
        mergedSegmentsEncrypted ||= ref.isEncrypted ?? false;
      }
    }
    if (segments.length === 0) continue;
    segments.sort((a, b) => a.vcn - b.vcn);
    const merged: DataRun[] = [];
    let size = 0;
    for (const seg of segments) {
      merged.push(...seg.runs);
      if (seg.size > size) size = seg.size;
    }
    rec.dataRuns = merged;
    rec.size = size;
    rec.dataVcn = 0;
    rec.attributeList = [];
    rec.isEncrypted = rec.isEncrypted || mergedSegmentsEncrypted;
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
  for (let i = 0; i < recordCount; i++) {
    let raw: Buffer;
    try {
      if (mftFile.dataRuns.length > 0) {
        raw = readRuns(reader, layout.clusterSize, mftFile.dataRuns, i * layout.fileRecordSize, layout.fileRecordSize);
      } else {
        raw = reader.read(layout.mftStartCluster * layout.clusterSize + i * layout.fileRecordSize, layout.fileRecordSize);
      }
    } catch {
      // A corrupt/sparse record at the end of the MFT; stop reading.
      break;
    }
    try {
      records.push(parseFileRecord(raw, i));
    } catch {
      // Skip invalid records (e.g. sparse/unallocated MFT slots).
      continue;
    }
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

/** Read the unnamed $DATA stream of a file record (cluster-based). */
export function readFileData(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): Buffer {
  if (file.isEncrypted) {
    throw new EfsEncryptedError(
      `"${file.name?.name ?? `record ${file.recordNumber}`}" is EFS-encrypted; its bytes are ciphertext ` +
        'and cannot be decrypted offline from the image without the owner\'s private key'
    );
  }
  if (file.residentData.length > 0) {
    return Buffer.from(file.residentData);
  }
  if (file.dataRuns.length === 0) {
    return Buffer.alloc(0);
  }
  if (file.compressionUnit && file.compressionUnit > 0) {
    return readCompressedFileData(reader, layout, file);
  }
  return readRuns(reader, layout.clusterSize, file.dataRuns, 0, file.size);
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
    throw new EfsEncryptedError(
      `"${file.name?.name ?? `record ${file.recordNumber}`}" is EFS-encrypted; its bytes are ciphertext ` +
        'and cannot be decrypted offline from the image without the owner\'s private key'
    );
  }
  if (length <= 0 || offset >= file.size) return Buffer.alloc(0);
  const start = offset < 0 ? 0 : offset;
  const end = Math.min(start + length, file.size);
  if (file.compressionUnit && file.compressionUnit > 0) {
    return readCompressedFileData(reader, layout, file).subarray(start, end);
  }
  if (file.residentData.length > 0) {
    return Buffer.from(file.residentData.subarray(start, end));
  }
  if (file.dataRuns.length === 0) {
    return Buffer.alloc(Math.max(0, end - start));
  }
  return readRuns(reader, layout.clusterSize, file.dataRuns, start, end - start);
}

/**
 * Read an NTFS-compressed (LZNT1) file. The data is stored as independent
 * compression units of `1 << compressionUnit` clusters; each unit is either a
 * full raw data run (uncompressed), a short data run followed by a sparse fill
 * (compressed, decoded via LZNT1), or sparse (zeros).
 */
function readCompressedFileData(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): Buffer {
  const cuClusters = 1 << (file.compressionUnit ?? 4);
  const cuSize = cuClusters * layout.clusterSize;
  const out = Buffer.alloc(file.size);
  let outPos = 0;
  let vcn = 0;
  const runs = file.dataRuns;
  let ri = 0;

  while (outPos < file.size && ri < runs.length) {
    const run = runs[ri];
    const cuRemaining = cuClusters - (vcn % cuClusters);
    if (run.sparse) {
      const take = Math.min(run.runLength, cuRemaining);
      out.fill(0, outPos, Math.min(outPos + take * layout.clusterSize, file.size));
      outPos += Math.min(take * layout.clusterSize, file.size - outPos);
      vcn += take;
      if (take === run.runLength) ri++;
      continue;
    }

    const take = Math.min(run.runLength, cuRemaining);
    const data = readRuns(reader, layout.clusterSize, [run], vcn * layout.clusterSize, take * layout.clusterSize);
    if (take === cuClusters) {
      // Full CU: uncompressed raw data.
      data.copy(out, outPos, 0, Math.min(data.length, file.size - outPos));
      outPos += Math.min(take * layout.clusterSize, file.size - outPos);
      vcn += take;
      if (take === run.runLength) ri++;
      continue;
    }

    // Partial CU: compressed. Decompress the `take` clusters to a full CU.
    const decompressed = decompressLznt1(data, cuSize);
    const copyLen = Math.min(decompressed.length, file.size - outPos);
    decompressed.copy(out, outPos, 0, copyLen);
    outPos += copyLen;
    vcn += take;
    if (take === run.runLength) ri++;

    // The remainder of this CU is a sparse fill; consume it.
    const cuEndVcn = (Math.floor(vcn / cuClusters) + 1) * cuClusters;
    while (vcn < cuEndVcn && ri < runs.length && runs[ri].sparse) {
      const takeFill = Math.min(runs[ri].runLength, cuEndVcn - vcn);
      vcn += takeFill;
      if (takeFill === runs[ri].runLength) ri++;
      else runs[ri].runLength -= takeFill;
    }
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
    let name = '';
    let validName = false;
    if (entryLength >= 0x10 + 0x42) {
      const keyOffset = 0x10;
      const nameLength = buf.readUInt8(pos + keyOffset + 0x40);
      const nameStart = pos + keyOffset + 0x42;
      if (nameLength > 0 && nameStart + nameLength * 2 <= pos + entryLength) {
        name = buf.toString('utf16le', nameStart, nameStart + nameLength * 2);
        validName = true;
      }
    }
    if (validName) {
      const subnodeVcn = hasSubnode ? Number(buf.readBigUInt64LE(pos + entryLength - 8) & 0xffffffffffffn) : undefined;
      entries.push({ fileReference, name, hasSubnode, lastEntry, subnodeVcn });
    }
    if (lastEntry) break;
    pos += entryLength;
  }
  return entries;
}

/**
 * Read a directory's children via the "$I30" index ($INDEX_ROOT, and
 * $INDEX_ALLOCATION buffers for large directories). Falls back to an empty list
 * when the directory has no index root (e.g. non-directories).
 */
export function readDirectoryIndex(reader: PartitionReader, layout: NtfsLayout, file: NtfsFile): IndexEntry[] {
  if (!file.indexRoot) return [];
  const entries: IndexEntry[] = [];

  // $INDEX_ROOT: 0x10 index-root header, then a 0x10 INDEX_HEADER, then entries.
  const rootEntriesOffset = file.indexRoot.readUInt32LE(0x10);
  const rootTotal = file.indexRoot.readUInt32LE(0x14);
  const rootStart = 0x10 + rootEntriesOffset;
  const rootEnd = Math.min(rootStart + rootTotal, file.indexRoot.length);
  entries.push(...parseIndexEntries(file.indexRoot, rootStart, rootEnd));

  // $INDEX_ALLOCATION: a series of index buffers for large directories.
  if (file.indexAllocation && file.indexAllocation.dataRuns.length > 0) {
    const clustersPerBuffer = file.indexRoot.readUInt8(0x0c);
    const bufferSize = Math.max(512, clustersPerBuffer * layout.clusterSize);
    const bitmap = file.indexBitmap;
    const bufferCount = Math.ceil(file.indexAllocation.size / bufferSize);
    for (let i = 0; i < bufferCount; i++) {
      if (bitmap && !(bitmap[i >> 3] & (1 << (i & 7)))) continue;
      const buf = readRuns(reader, layout.clusterSize, file.indexAllocation.dataRuns, i * bufferSize, bufferSize);
      const entriesOffset = buf.readUInt32LE(0x00);
      const totalSize = buf.readUInt32LE(0x04);
      const start = entriesOffset;
      const end = Math.min(start + totalSize, buf.length);
      entries.push(...parseIndexEntries(buf, start, end));
    }
  }

  return entries;
}
