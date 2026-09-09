/**
 * NTFS grow-on-restore planner.
 *
 * When a partition is restored to a larger target, Windows's NTFS accepts a
 * volume whose boot sector reports more total sectors as long as the $Bitmap
 * covers the new clusters and $BadClus spans them. planNtfsGrow computes the
 * minimal set of byte regions to write *after* the partition data itself has
 * been restored:
 *
 *   1. boot sector  : total-sector count (offset 0x28)
 *   2. $Bitmap      : data-run length extended by the new clusters, the file's
 *                     allocated/valid sizes grown, and the newly-added bitmap
 *                     tail written (new clusters marked free)
 *   3. $BadClus     : single sparse run extended over the new clusters
 *
 * Shrinking is intentionally unsupported (it requires moving data).
 *
 * NOTE on BPB offsets: real NTFS stores total sectors at 0x28, $MFT LCN at
 * 0x30, $MFTMirr LCN at 0x38 and clusters-per-file-record at 0x40. Both this
 * module and `ntfs.ts` (read side of browse/extract/USN tracking) read the
 * canonical layout.
 *
 * Conservative restrictions (throws `GrowUnsupportedError`): $Bitmap must be a
 * single non-sparse data run of a single file record containing an unnamed
 * $DATA; the run must fit inside the old volume; the supplied metadata buffer
 * must cover the boot sector, the MFT records used and the first old bitmap
 * byte. Any other layout (multi-run, compressed, attribute lists, fragment)
 * is refused rather than risking a corrupt volume.
 */

/** Thrown when a partition cannot be safely grown. */
export class GrowUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowUnsupportedError';
  }
}

/**
 * Upper bound on the partition bytes read from the image to plan a filesystem
 * grow (boot sector, first MFT records and the first $Bitmap byte never live
 * far into the volume).
 */
export const MAX_METADATA_BYTES = 64 * 1024 * 1024;

/** One byte region to write on the target partition (partition-relative). */
export interface NtfsGrowRegion {
  relativeOffset: number;
  data: Buffer;
}

export interface NtfsGrowPlan {
  newTotalClusters: number;
  newTotalSectors: number;
  regions: NtfsGrowRegion[];
}

export interface NtfsBootSector {
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  totalSectors: number;
  mftLcn: number;
  mftMirrLcn: number;
  fileRecordSize: number;
}

const NTFS_SIGNATURE = 'NTFS    ';
const ATTR_DATA = 0x80;

export interface DataAttr {
  nonResident: boolean;
  lastVcn: number;
  allocatedSize: number;
  realSize: number;
  runs: Array<{ startLcn: number; runLength: number; sparse?: boolean }>;
}

export interface FileRecord {
  offset: number;
  inUse: boolean;
  data: DataAttr | null;
}

export function parseNtfsBootSector(buf: Buffer): NtfsBootSector {
  if (buf.length < 512) {
    throw new Error('Boot sector is truncated');
  }
  const oem = buf.toString('ascii', 3, 11);
  if (oem !== NTFS_SIGNATURE) {
    throw new Error(`Not an NTFS volume (OEM id: "${oem}")`);
  }
  const bytesPerSector = buf.readUInt16LE(0x0b);
  const sectorsPerCluster = buf.readUInt8(0x0d);
  const totalSectors = Number(buf.readBigUInt64LE(0x28));
  const mftLcn = Number(buf.readBigUInt64LE(0x30));
  const mftMirrLcn = Number(buf.readBigUInt64LE(0x38));
  const clustersPerRecord = buf.readInt8(0x40);
  const fileRecordSize =
    clustersPerRecord < 0 ? 1 << -clustersPerRecord : clustersPerRecord * bytesPerSector * sectorsPerCluster;
  if (bytesPerSector === 0 || sectorsPerCluster === 0) {
    throw new Error('Invalid boot sector parameters');
  }
  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSize: bytesPerSector * sectorsPerCluster,
    totalSectors,
    mftLcn,
    mftMirrLcn,
    fileRecordSize
  };
}

function countBytes(value: number): number {
  if (value === 0) return 1;
  let n = 0;
  let x = value;
  while (x !== 0 && n < 8) {
    n++;
    x = Math.floor(x / 256);
  }
  return n;
}

function leBytes(value: number, n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = value;
  for (let i = 0; i < n; i++) {
    b.writeUInt8(x & 0xff, i);
    x = Math.floor(x / 256);
  }
  return b;
}

/** Parse a data-runlist starting at `offset` (NTFS run encoding). */
function parseRunlist(buf: Buffer, offset: number): Array<{ startLcn: number; runLength: number; sparse?: boolean }> {
  const runs: Array<{ startLcn: number; runLength: number; sparse?: boolean }> = [];
  let pos = offset;
  let relative = 0;
  while (pos < buf.length) {
    const header = buf[pos++];
    if (header === 0) break;
    const lenBytes = header & 0x0f;
    const offBytes = header >> 4;
    if (lenBytes === 0 || pos + lenBytes + offBytes > buf.length) {
      throw new Error('Malformed data-runlist');
    }
    let runLength = 0;
    for (let i = 0; i < lenBytes; i++) {
      runLength += buf[pos + i] * Math.pow(256, i);
    }
    pos += lenBytes;
    const sparse = offBytes === 0;
    let startLcn = 0;
    if (!sparse) {
      let delta = 0;
      for (let i = 0; i < offBytes; i++) {
        delta += buf[pos + i] * Math.pow(256, i);
      }
      // Signed 64-bit little-endian delta (offsets are stored as two's complement).
      const signBit = 8 * offBytes - 1;
      if (offBytes > 0 && (delta & (1 << signBit)) !== 0) {
        delta -= 1 << (8 * offBytes);
      }
      pos += offBytes;
      relative += delta;
      startLcn = relative;
    }
    runs.push({ startLcn, runLength, sparse: sparse || undefined });
  }
  return runs;
}

/** Build a data-runlist buffer for a single run. */
function buildSingleRun(startLcn: number, runLength: number, sparse: boolean): Buffer {
  const lenBytes = countBytes(runLength);
  if (sparse) {
    const buf = Buffer.alloc(1 + lenBytes + 1);
    buf.writeUInt8(lenBytes, 0);
    leBytes(runLength, lenBytes).copy(buf, 1);
    buf.writeUInt8(0, 1 + lenBytes);
    return buf;
  }
  const offBytes = countBytes(startLcn);
  if (startLcn < 0 || startLcn >= 1 << (8 * offBytes - 1)) {
    throw new GrowUnsupportedError('Data run offset is too large for a single-run rebuild');
  }
  const buf = Buffer.alloc(1 + lenBytes + offBytes + 1);
  buf.writeUInt8((offBytes << 4) | lenBytes, 0);
  leBytes(runLength, lenBytes).copy(buf, 1);
  leBytes(startLcn, offBytes).copy(buf, 1 + lenBytes);
  buf.writeUInt8(0, 1 + lenBytes + offBytes);
  return buf;
}

/** Walk the attributes of a file record and locate the unnamed $DATA. */
export function parseUnnamedData(record: Buffer): DataAttr | null {
  let pos = 0x38;
  while (pos + 8 <= record.length) {
    const type = record.readUInt32LE(pos);
    const length = record.readUInt32LE(pos + 4);
    if (type === 0xffffffff || length === 0) break;
    if (pos + length > record.length) break;
    const nameLen = record.readUInt8(pos + 9);
    if (type === ATTR_DATA && nameLen === 0) {
      const nonResident = record.readUInt8(pos + 8) !== 0;
      if (!nonResident) {
        return { nonResident: false, lastVcn: 0, allocatedSize: 0, realSize: 0, runs: [] };
      }
      const lastVcn = Number(record.readBigUInt64LE(pos + 0x18));
      const allocatedSize = Number(record.readBigUInt64LE(pos + 0x28));
      const realSize = Number(record.readBigUInt64LE(pos + 0x30));
      const runOffset = record.readUInt16LE(pos + 0x20);
      const runs = parseRunlist(record.subarray(pos, pos + length), runOffset);
      return { nonResident: true, lastVcn, allocatedSize, realSize, runs };
    }
    pos += length;
  }
  return null;
}

/**
 * Find a file record by its record number inside the MFT region of `bytes`.
 * Returns the record's partition-relative offset and its parsed $DATA.
 */
export function findFileRecord(bytes: Buffer, layout: NtfsBootSector, recordNumber: number): FileRecord | null {
  const mftStart = layout.mftLcn * layout.clusterSize;
  const recordSize = layout.fileRecordSize;
  let recCount = 0;
  for (let offset = mftStart; offset + Math.min(recordSize, 0x100) <= bytes.length; offset += recordSize) {
    if (recCount++ > 1024) break;
    if (bytes.toString('ascii', offset, offset + 4) !== 'FILE') continue;
    // A file record's number equals its index inside the MFT region.
    const index = (offset - mftStart) / recordSize;
    if (!Number.isInteger(index) || index !== recordNumber) continue;
    const inUse = (bytes.readUInt16LE(offset + 0x16) & 0x0001) !== 0;
    const recordEnd = bytes.readUInt32LE(offset + 0x18);
    const slice = recordEnd > 0 ? bytes.subarray(offset, offset + recordEnd) : bytes.subarray(offset, offset + recordSize);
    return { offset, inUse, data: parseUnnamedData(slice) };
  }
  return null;
}

/**
 * Rebuild a file record whose unnamed $DATA is a single run, with a new run
 * length and sizes, preserving every other attribute byte. The returned buffer
 * is in on-disk form (sector-end fixup bytes set to the update-sequence USN).
 */
function rebuildRecordWithExtendedRun(
  record: Buffer,
  fileRecordSize: number,
  startLcn: number,
  newRunLength: number,
  newLastVcn: number,
  newAllocatedSize: number,
  newRealSize: number,
  sparse: boolean
): Buffer {
  let pos = 0x38;
  let dataPos = -1;
  let dataLen = 0;
  while (pos + 8 <= record.length) {
    const type = record.readUInt32LE(pos);
    const length = record.readUInt32LE(pos + 4);
    if (type === 0xffffffff || length === 0) break;
    if (pos + length > record.length) break;
    if (type === ATTR_DATA && record.readUInt8(pos + 9) === 0) {
      dataPos = pos;
      dataLen = length;
      break;
    }
    pos += length;
  }
  if (dataPos < 0) {
    throw new GrowUnsupportedError('Partition metadata contains no unnamed $DATA attribute');
  }
  // Anything after the $DATA attribute forces a rebuild we do not support.
  const after = record.length - (dataPos + dataLen);
  if (after > 0) {
    throw new GrowUnsupportedError('$DATA is not the last attribute in the record');
  }

  const prefix = record.subarray(0, dataPos);
  const runlist = buildSingleRun(startLcn, newRunLength, sparse);
  const attrLen = 0x40 + runlist.length;
  const attr = Buffer.alloc(attrLen);
  attr.writeUInt32LE(ATTR_DATA, 0);
  attr.writeUInt32LE(attrLen, 4);
  attr.writeUInt8(1, 8); // non-resident
  attr.writeUInt8(0, 9); // no name
  attr.writeUInt8(0, 0x0a); // name offset (unused)
  attr.writeUInt16LE(0, 0x0c);
  attr.writeUInt16LE(0, 0x0e);
  attr.writeBigUInt64LE(0n, 0x10); // lowest VCN
  attr.writeBigUInt64LE(BigInt(newLastVcn), 0x18);
  attr.writeUInt16LE(0x40, 0x20); // mapping-pairs offset
  attr.writeUInt16LE(0, 0x22); // no compression
  attr.writeBigUInt64LE(BigInt(newAllocatedSize), 0x28);
  attr.writeBigUInt64LE(BigInt(newRealSize), 0x30);
  attr.writeBigUInt64LE(BigInt(newRealSize), 0x38); // initialized size
  runlist.copy(attr, 0x40);

  const terminator = Buffer.alloc(4);
  const out = Buffer.alloc(fileRecordSize);
  out.fill(0);
  prefix.copy(out, 0);
  attr.copy(out, prefix.length);
  terminator.copy(out, prefix.length + attr.length);
  // "Bytes in use": the pre-$DATA length plus the new attribute (no trailing attrs).
  out.writeUInt32LE(prefix.length + attrLen, 0x18);

  // Restore the on-disk update-sequence fixup: preserve the original sector-end
  // words in the USN array and plant the USN back at every sector end, exactly
  // as the source record (captured in on-disk form) had them.
  const usOffset = out.readUInt16LE(0x04);
  const usCount = out.readUInt16LE(0x06);
  const usn = usCount > 0 ? out.readUInt16LE(usOffset) : 0;
  if (usCount > 1) {
    const sectors = Math.floor(fileRecordSize / 512);
    const count = Math.min(sectors, usCount - 1);
    for (let i = 0; i < count; i++) {
      const sectorEnd = i * 512 + 510;
      const original = sectorEnd + 2 <= record.length ? record.readUInt16LE(sectorEnd) : 0xffff;
      out.writeUInt16LE(original, usOffset + 2 * (i + 1));
      out.writeUInt16LE(usn, sectorEnd);
    }
  }
  return out;
}

/**
 * Compute the patch regions that grow an NTFS partition from its current
 * on-disk size to `newTotalSectors`.
 *
 * `bytes` is the partition's content read from the image, starting at byte 0,
 * and must cover at least the boot sector, the MFT up to file record 8, and
 * the first byte of the stored $Bitmap content.
 */
export function planNtfsGrow(bytes: Buffer, newTotalSectors: number): NtfsGrowPlan {
  if (bytes.length < 512) {
    throw new GrowUnsupportedError('Metadata read is too small to size the volumes filesystem');
  }
  const layout = parseNtfsBootSector(bytes.subarray(0, 512));
  const oldTotalSectors = layout.totalSectors;
  if (newTotalSectors < oldTotalSectors) {
    throw new GrowUnsupportedError(`Cannot shrink a partition (${newTotalSectors} < ${oldTotalSectors} sectors)`);
  }
  if (newTotalSectors === oldTotalSectors) {
    return { newTotalClusters: Math.floor(oldTotalSectors / layout.sectorsPerCluster), newTotalSectors, regions: [] };
  }
  if (newTotalSectors % layout.sectorsPerCluster !== 0) {
    throw new GrowUnsupportedError(
      `New partition size is not cluster-aligned (${newTotalSectors} sectors, ${layout.sectorsPerCluster} sectors per cluster)`
    );
  }

  const oldTotalClusters = Math.floor(oldTotalSectors / layout.sectorsPerCluster);
  const newTotalClusters = Math.floor(newTotalSectors / layout.sectorsPerCluster);
  const newBitmapBytes = Math.ceil(newTotalClusters / 8);

  // ---- $Bitmap (file record 6) -------------------------------------------
  const bitmapRecord = findFileRecord(bytes, layout, 6);
  if (!bitmapRecord) {
    throw new GrowUnsupportedError('Could not locate the $Bitmap file record in the read metadata');
  }
  const bitmapData = bitmapRecord.data;
  if (!bitmapData || !bitmapData.nonResident) {
    throw new GrowUnsupportedError('$Bitmap has no non-resident unnamed $DATA');
  }
  if (bitmapData.runs.length !== 1 || bitmapData.runs[0].sparse) {
    throw new GrowUnsupportedError('$Bitmap must be a single contiguous data run');
  }
  const bitmapRun = bitmapData.runs[0];
  if (bitmapRun.startLcn + bitmapRun.runLength > oldTotalClusters) {
    throw new GrowUnsupportedError('$Bitmap data run does not fit inside the old volume');
  }

  const oldBitmapBytes = Math.ceil(oldTotalClusters / 8);
  const oldBitmapClusters = Math.ceil(oldBitmapBytes / layout.clusterSize);
  const newRunClusters = Math.ceil(newBitmapBytes / layout.clusterSize);
  if (newRunClusters < bitmapRun.runLength) {
    throw new GrowUnsupportedError('$Bitmap allocation would shrink during grow');
  }
  if (bitmapRun.startLcn + newRunClusters > newTotalClusters) {
    throw new GrowUnsupportedError('Extended $Bitmap allocation does not fit in the new volume size');
  }
  const bitmapDataOffset = bitmapRun.startLcn * layout.clusterSize;
  const boundaryByteIndex = Math.floor(oldTotalClusters / 8);
  if (bitmapDataOffset + boundaryByteIndex >= bytes.length) {
    throw new GrowUnsupportedError('The $Bitmap bytes were not covered by the metadata read');
  }
  const oldBoundaryByte = bitmapDataOffset + boundaryByteIndex < bytes.length
    ? bytes[bitmapDataOffset + boundaryByteIndex]
    : 0xff;
  const partialBits = oldTotalClusters % 8;

  // New tail of the bitmap: cluster bits beyond the old end become free (0),
  // the final byte's bits beyond the new end stay marked in-use (1).
  const tailLength = newBitmapBytes - boundaryByteIndex;
  const tail = Buffer.alloc(tailLength, 0);
  if (partialBits !== 0) {
    tail[0] = oldBoundaryByte & ((1 << partialBits) - 1);
  }
  if (newTotalClusters % 8 !== 0) {
    tail[tailLength - 1] |= 0xff << (newTotalClusters % 8);
  }

  const newBitmapRecord = rebuildRecordWithExtendedRun(
    recordAt(bytes, layout, bitmapRecord.offset, layout.fileRecordSize),
    layout.fileRecordSize,
    bitmapRun.startLcn,
    newRunClusters,
    newRunClusters - 1,
    newRunClusters * layout.clusterSize,
    newBitmapBytes,
    false
  );

  const regions: NtfsGrowRegion[] = [];

  // Boot sector: total sectors, plus the same MFTMirr layout (mirror moves are
  // not needed for a grow; it simply stays where it was).
  const boot = Buffer.from(bytes.subarray(0, 512));
  boot.writeBigUInt64LE(BigInt(newTotalSectors), 0x28);
  regions.push({ relativeOffset: 0, data: boot });

  // Rewritten $Bitmap record.
  regions.push({ relativeOffset: bitmapRecord.offset, data: newBitmapRecord });

  // New $Bitmap content (tail). Only the boundary byte and appended bytes are
  // written; the rest of the bitmap is already correct on the target.
  regions.push({ relativeOffset: bitmapDataOffset + boundaryByteIndex, data: tail });

  // ---- $BadClus (file record 8) -------------------------------------------
  const badClus = findFileRecord(bytes, layout, 8);
  if (badClus && badClus.data?.nonResident) {
    const runs = badClus.data.runs;
    if (runs.length === 1 && runs[0].sparse && runs[0].runLength === oldTotalClusters) {
      const newBadRecord = rebuildRecordWithExtendedRun(
        recordAt(bytes, layout, badClus.offset, layout.fileRecordSize),
        layout.fileRecordSize,
        0,
        newTotalClusters,
        newTotalClusters - 1,
        newTotalClusters * layout.clusterSize,
        newTotalClusters * layout.clusterSize,
        true
      );
      regions.push({ relativeOffset: badClus.offset, data: newBadRecord });
    }
  }

  return { newTotalClusters, newTotalSectors, regions };
}

/** The full on-disk record buffer for a record located in `bytes`. */
function recordAt(bytes: Buffer, layout: NtfsBootSector, offset: number, fileRecordSize: number): Buffer {
  const end = bytes.readUInt32LE(offset + 0x18);
  const len = end > 0 && end <= fileRecordSize ? end : fileRecordSize;
  return bytes.subarray(offset, offset + len);
}