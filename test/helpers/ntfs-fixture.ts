import { PartitionReader } from '../../src/main/imaging/image-browse';
import { DataRun } from '../../src/main/imaging/fs/ntfs';

export const SECTOR = 512;
export const CLUSTER = 4096;
export const FILE_RECORD = 1024;
export const MFT_CLUSTER = 4;
export const SPC = CLUSTER / SECTOR;

interface AttrDef {
  type: number;
  nonResident: boolean;
  resident?: Buffer;
  runs?: DataRun[];
  realSize?: number;
  vcn?: number;
  compressionUnit?: number;
  parentRecord?: number;
  fileName?: string;
  namespace?: number;
}

function countBytes(v: number): number {
  if (v === 0) return 1;
  let n = 0;
  let x = v;
  while (x !== 0 && n < 8) {
    n++;
    x = Math.floor(x / 256);
  }
  return n;
}

function leBytes(v: number, n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = v;
  for (let i = 0; i < n; i++) {
    b.writeUInt8(x & 0xff, i);
    x = Math.floor(x / 256);
  }
  return b;
}

function buildRunlist(runs: DataRun[]): Buffer {
  const chunks: Buffer[] = [];
  let prevOffset = 0;
  for (const run of runs) {
    if (run.sparse) {
      // Sparse run: length field only (offset field length 0).
      const lenBytes = countBytes(run.runLength);
      chunks.push(Buffer.from([lenBytes]), leBytes(run.runLength, lenBytes));
      continue;
    }
    const offset = run.startLcn - prevOffset;
    const lenBytes = countBytes(run.runLength);
    const offBytes = countBytes(offset);
    chunks.push(Buffer.from([(offBytes << 4) | lenBytes]), leBytes(run.runLength, lenBytes), leBytes(offset, offBytes));
    prevOffset = run.startLcn;
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function standardInfo(created: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeBigUInt64LE(BigInt(created), 0);
  b.writeBigUInt64LE(BigInt(created + 1), 8);
  return b;
}

export function fileNameAttr(parentRecord: number, name: string, namespace: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf16le');
  const b = Buffer.alloc(0x42 + nameBuf.length);
  b.writeBigUInt64LE(BigInt(parentRecord) & 0xffffffffffffn, 0);
  b.writeBigUInt64LE(100n, 8);
  b.writeBigUInt64LE(101n, 16);
  b.writeBigUInt64LE(102n, 24);
  b.writeBigUInt64LE(103n, 32);
  b.writeBigUInt64LE(4096n, 40);
  b.writeBigUInt64LE(4096n, 48);
  b.writeUInt32LE(0, 56);
  b.writeUInt32LE(0, 60);
  b.writeUInt8(nameBuf.length / 2, 0x40);
  b.writeUInt8(namespace, 0x41);
  nameBuf.copy(b, 0x42);
  return b;
}

export function buildFileRecord(recordNumber: number, opts: { inUse?: boolean; directory?: boolean; attrs: AttrDef[] }): Buffer {
  const buf = Buffer.alloc(FILE_RECORD);
  buf.write('FILE', 0, 'ascii');
  buf.writeUInt16LE(0x30, 4);
  buf.writeUInt16LE(3, 6);
  buf.writeUInt16LE(1, 0x12);
  const flags = (opts.inUse === false ? 0 : 0x0001) | (opts.directory ? 0x0002 : 0);
  buf.writeUInt16LE(flags, 0x16);

  const attrStart = 0x38;
  buf.writeUInt16LE(attrStart, 0x14);
  let pos = attrStart;
  for (const a of opts.attrs) {
    const nameBuf = a.fileName ? Buffer.from(a.fileName, 'utf16le') : Buffer.alloc(0);
    const nameLenChars = nameBuf.length / 2;
    if (a.nonResident) {
      const runlist = buildRunlist(a.runs ?? []);
      const headerLen = 0x40;
      const nameOff = nameLenChars > 0 ? headerLen : 0;
      const total = headerLen + nameBuf.length + runlist.length;
      buf.writeUInt32LE(a.type, pos);
      buf.writeUInt32LE(total, pos + 4);
      buf.writeUInt8(1, pos + 8);
      buf.writeUInt8(nameLenChars, pos + 9);
      buf.writeUInt16LE(nameOff, pos + 0x0a);
      buf.writeUInt16LE(0, pos + 0x0e);
      buf.writeBigUInt64LE(BigInt(a.vcn ?? 0), pos + 0x10);
      buf.writeBigUInt64LE(BigInt((a.runs?.reduce((s, r) => s + r.runLength, 0) ?? 1) - 1), pos + 0x18);
      const runlistOffset = 0x40 + nameBuf.length;
      buf.writeUInt16LE(runlistOffset, pos + 0x20);
      buf.writeUInt16LE(a.compressionUnit ?? 0, pos + 0x22);
      buf.writeBigUInt64LE(BigInt(a.realSize ?? 0), pos + 0x28);
      buf.writeBigUInt64LE(BigInt(a.realSize ?? 0), pos + 0x30);
      if (nameBuf.length > 0) nameBuf.copy(buf, pos + headerLen);
      runlist.copy(buf, pos + headerLen + nameBuf.length);
      pos += total;
    } else {
      const val = a.resident ?? Buffer.alloc(0);
      const headerLen = 0x18;
      const nameOff = nameLenChars > 0 ? headerLen : 0;
      const total = headerLen + nameBuf.length + val.length;
      buf.writeUInt32LE(a.type, pos);
      buf.writeUInt32LE(total, pos + 4);
      buf.writeUInt8(0, pos + 8);
      buf.writeUInt8(nameLenChars, pos + 9);
      buf.writeUInt16LE(nameOff, pos + 0x0a);
      buf.writeUInt16LE(0, pos + 0x0e);
      buf.writeUInt32LE(val.length, pos + 0x10);
      buf.writeUInt16LE(headerLen + nameBuf.length, pos + 0x14);
      if (nameBuf.length > 0) nameBuf.copy(buf, pos + headerLen);
      val.copy(buf, pos + headerLen + nameBuf.length);
      pos += total;
    }
  }
  buf.writeUInt32LE(pos, 0x18);
  buf.writeUInt32LE(FILE_RECORD, 0x1c);

  const usn = 0xaaaa;
  buf.writeUInt16LE(usn, 0x30);
  for (let i = 0; i < 2; i++) {
    buf.writeUInt16LE(0x5678 + i, 0x30 + (i + 1) * 2);
    buf.writeUInt16LE(usn, i * SECTOR + SECTOR - 2);
  }
  return buf;
}

/** Build a deterministic synthetic NTFS volume as an in-memory PartitionReader. */
/** Build the value of an $ATTRIBUTE_LIST attribute (type 0x20). */
export function attributeListValue(entries: Array<{ type: number; lowestVcn: number; fileReference: number }>): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const b = Buffer.alloc(0x18);
    b.writeUInt32LE(e.type, 0);
    b.writeUInt16LE(0x18, 4); // record length
    b.writeUInt8(0, 6); // name length
    b.writeUInt8(0, 7); // name offset
    b.writeBigUInt64LE(BigInt(e.lowestVcn), 0x08);
    b.writeBigUInt64LE(BigInt(e.fileReference) & 0xffffffffffffn, 0x10);
    chunks.push(b);
  }
  chunks.push(Buffer.alloc(4)); // terminator (type 0)
  return Buffer.concat(chunks);
}

/**
 * Build the value of an $EFS attribute (type 0x100): a 0x18 header followed by
 * one entry per principal, then the key-info blobs. Follows the canonical blob
 * layout so `parseEfsAttribute` can decode it.
 */
export function efsAttrValue(entries: Array<{ name: string; guid?: number[]; algId?: number; fekBits?: number }>): Buffer {
  const GUID = (idx: number) => {
    const g = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) g[i] = (entries[idx].guid?.[i] ?? i + 1 + idx * 16) & 0xff;
    return g;
  };
  const entryOffsets: number[] = [];
  const entryLens: number[] = [];
  let pos = 0x18;
  for (let i = 0; i < entries.length; i++) {
    entryOffsets.push(pos);
    const nameBytes = entries[i].name.length * 2 + 2; // include a UTF-16 NUL
    const entryLen = 0x18 + nameBytes;
    entryLens.push(entryLen);
    pos += entryLen;
  }
  const keyOffsets: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    keyOffsets.push(pos);
    pos += 0x10;
  }
  const blob = Buffer.alloc(pos);
  blob.writeUInt32LE(0, 0x00); // version
  blob.writeUInt32LE(blob.length, 0x04); // end of blob
  // header GUID (foEfsCheck) at 0x08 left zeroed.
  for (let i = 0; i < entries.length; i++) {
    const off = entryOffsets[i];
    blob.writeUInt32LE(entryLens[i], off);
    blob.writeUInt32LE(keyOffsets[i], off + 4);
    GUID(i).copy(blob, off + 8);
    blob.write(entries[i].name, off + 0x18, 'utf16le');
    const ko = keyOffsets[i];
    blob.writeUInt32LE(0, ko); // key type (CAPI)
    blob.writeUInt32LE(entries[i].algId ?? 0x6610, ko + 4); // CALG_AES_256
    blob.writeUInt32LE(entries[i].fekBits ?? 256, ko + 8);
    blob.writeUInt32LE(0, ko + 12); // encrypted-FEK length (placeholder)
  }
  return blob;
}

/** Build the value of a resident $INDEX_ROOT ($I30) attribute (type 0x90). */
export function indexRootValue(entries: Array<{ fileReference: number; name: string; last?: boolean }>): Buffer {
  const entryBufs = entries.map((e) => {
    // Real $I30 keys are full $FILE_NAME structures (name at 0x42).
    const key = fileNameAttr(0, e.name, 1);
    const entryLength = 0x10 + key.length;
    const b = Buffer.alloc(entryLength);
    b.writeBigUInt64LE(BigInt(e.fileReference) & 0xffffffffffffn, 0);
    b.writeUInt16LE(entryLength, 0x08);
    b.writeUInt16LE(key.length, 0x0a);
    b.writeUInt16LE(e.last ? 0x02 : 0x00, 0x0c);
    key.copy(b, 0x10);
    return b;
  });
  const entriesBuf = Buffer.concat(entryBufs);
  const value = Buffer.alloc(0x20 + entriesBuf.length);
  value.writeUInt32LE(1, 0x00); // index type (directory)
  value.writeUInt32LE(1, 0x04); // collation rule
  value.writeUInt32LE(4096, 0x08); // index allocation size
  value.writeUInt8(1, 0x0c); // clusters per index buffer
  value.writeUInt32LE(0x10, 0x10); // INDEX_HEADER entries offset
  // INDEX_HEADER.totalSize runs from the header start (0x10) through the entries.
  value.writeUInt32LE(0x10 + entriesBuf.length, 0x14);
  value.writeUInt32LE(0x10 + entriesBuf.length, 0x18); // allocated size
  value.writeUInt8(0, 0x1c); // flags
  entriesBuf.copy(value, 0x20);
  return value;
}

export function buildNtfsVolume(opts?: { includeEfsFile?: boolean }): PartitionReader {  const totalClusters = 64;
  const data = Buffer.alloc(totalClusters * CLUSTER);

  data.write('NTFS    ', 3, 'ascii');
  data.writeUInt16LE(SECTOR, 0x0b);
  data.writeUInt8(SPC, 0x0d);
  data.writeBigUInt64LE(BigInt(totalClusters * SPC), 0x28);
  data.writeBigUInt64LE(BigInt(MFT_CLUSTER), 0x30);
  data.writeBigUInt64LE(BigInt(MFT_CLUSTER + 1), 0x38);
  data.writeInt8(-10, 0x40);

  const mftBase = MFT_CLUSTER * CLUSTER;

  const rec0 = buildFileRecord(0, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(1000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFT', 1) },
      { type: 0x80, nonResident: true, runs: [{ startLcn: MFT_CLUSTER, runLength: 12 }], realSize: 12 * CLUSTER }
    ]
  });
  rec0.copy(data, mftBase);

  const rec1 = buildFileRecord(1, {
    inUse: true,
    attrs: [
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFTMirr', 1) },
      { type: 0x80, nonResident: true, runs: [{ startLcn: 16, runLength: 1 }], realSize: CLUSTER }
    ]
  });
  rec1.copy(data, mftBase + 1 * FILE_RECORD);

  const rec5 = buildFileRecord(5, {
    inUse: true,
    directory: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(2000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '.', 1) }
    ]
  });
  rec5.copy(data, mftBase + 5 * FILE_RECORD);

  const rec6 = buildFileRecord(6, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(3000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'hello.txt', 1) },
      { type: 0x80, nonResident: false, resident: Buffer.from('Hello, OPBS world!', 'utf8') }
    ]
  });
  rec6.copy(data, mftBase + 6 * FILE_RECORD);

  const rec7 = buildFileRecord(7, {
    inUse: true,
    directory: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(4000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'docs', 1) }
    ]
  });
  rec7.copy(data, mftBase + 7 * FILE_RECORD);

  const rec8 = buildFileRecord(8, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(5000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(7, 'big.bin', 1) },
      { type: 0x80, nonResident: true, runs: [{ startLcn: 32, runLength: 2 }], realSize: 2 * CLUSTER }
    ]
  });
  rec8.copy(data, mftBase + 8 * FILE_RECORD);

  if (opts?.includeEfsFile) {
    const rec9 = buildFileRecord(9, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(6000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'secret.txt', 1) },
        {
          type: 0x80,
          nonResident: false,
          resident: Buffer.from([
            0x13, 0x37, 0x51, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
          ])
        },
        { type: 0x100, nonResident: false, resident: efsAttrValue([{ name: 'alice@example' }]) }
      ]
    });
    rec9.copy(data, mftBase + 9 * FILE_RECORD);
  }

  for (let c = 32; c < 34; c++) {
    const base = c * CLUSTER;
    for (let i = 0; i < CLUSTER; i++) {
      data[base + i] = (c * 31 + i * 7) & 0xff;
    }
  }

  return {
    size: data.length,
    read: (offset: number, length: number) => data.subarray(offset, offset + length)
  };
}

/** Build the raw NTFS volume bytes (exposed for corrupt/fallback tests). */
export function buildNtfsVolumeData(): Buffer {
  const reader = buildNtfsVolume();
  const out = Buffer.alloc(reader.size);
  for (let i = 0; i < reader.size; i += CLUSTER) {
    reader.read(i, Math.min(CLUSTER, reader.size - i)).copy(out, i);
  }
  return out;
}
