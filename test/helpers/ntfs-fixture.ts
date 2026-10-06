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
  /** allocated_size (defaults to realSize). */
  allocatedSize?: number;
  /** initialized_size (defaults to 0). */
  initializedSize?: number;
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
      buf.writeBigUInt64LE(BigInt(a.allocatedSize ?? a.realSize ?? 0), pos + 0x28);
      buf.writeBigUInt64LE(BigInt(a.realSize ?? 0), pos + 0x30);
      buf.writeBigUInt64LE(BigInt(a.initializedSize ?? 0), pos + 0x38);
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

/** SHA-1 thumbprint (40 hex chars) whose private key would unwrap the EFEK. */
export const EFS_TEST_THUMBPRINT = 'aabbccddeeff00112233445566778899aabbccdd';

export interface EfsAttrEntry {
  name: string;
  /** Certificate thumbprint as lowercase hex (defaults to EFS_TEST_THUMBPRINT). */
  thumbprint?: string;
  /** RSA-wrapped file encryption key (defaults to a 128-byte placeholder). */
  efek?: Buffer;
}

/** One data decryption / recovery field in the canonical on-disk layout. */
function efsDfField(entry: EfsAttrEntry): Buffer {
  const thumbprint = Buffer.from(entry.thumbprint ?? EFS_TEST_THUMBPRINT, 'hex');
  const userName = Buffer.from(`${entry.name}\0`, 'utf16le');
  const efek = entry.efek ?? Buffer.alloc(128, 0x5a);

  const credHeaderOffset = 0x14; // DF header, then the credential header
  const certHeaderOffset = 0x14; // credential header, then the certificate header
  const thumbprintOffset = 0x14; // certificate header, then the thumbprint
  const userNameOffset = thumbprintOffset + thumbprint.length;
  const credLength = certHeaderOffset + thumbprintOffset + thumbprint.length + userName.length;
  const efekOffset = credHeaderOffset + credLength;

  const field = Buffer.alloc(efekOffset + efek.length);
  field.writeUInt32LE(field.length, 0); // df_length
  field.writeUInt32LE(credHeaderOffset, 4);
  field.writeUInt32LE(efek.length, 8);
  field.writeUInt32LE(efekOffset, 12);
  field.writeUInt32LE(0, 16); // unknown1

  field.writeUInt32LE(credLength, credHeaderOffset); // cred_length
  field.writeUInt32LE(0, credHeaderOffset + 4); // no SID
  field.writeUInt32LE(3, credHeaderOffset + 8); // certificate thumbprint
  field.writeUInt32LE(0, credHeaderOffset + 12);
  field.writeUInt32LE(certHeaderOffset, credHeaderOffset + 16);

  const cert = credHeaderOffset + certHeaderOffset;
  field.writeUInt32LE(thumbprintOffset, cert);
  field.writeUInt32LE(thumbprint.length, cert + 4);
  field.writeUInt32LE(0, cert + 8); // no container name
  field.writeUInt32LE(0, cert + 12); // no provider name
  field.writeUInt32LE(userNameOffset, cert + 16);
  thumbprint.copy(field, cert + thumbprintOffset);
  userName.copy(field, cert + userNameOffset);
  efek.copy(field, efekOffset);
  return field;
}

/**
 * Build the value of an `$EFS` attribute (type 0x100) in the layout Windows
 * writes: a 76-byte header, then a data decryption field (DDF) array and
 * optionally a recovery field (DRF) array, each an entry count followed by
 * chained fields. Follows the structure `parseEfsAttribute` decodes.
 */
export function efsAttrValue(entries: EfsAttrEntry[], recovery: EfsAttrEntry[] = []): Buffer {
  const HEADER_SIZE = 0x4c;
  const block = (fields: Buffer[]): Buffer =>
    fields.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat([(() => {
          const count = Buffer.alloc(4);
          count.writeUInt32LE(fields.length, 0);
          return count;
        })(), ...fields]);

  const ddf = block(entries.map(efsDfField));
  const drf = block(recovery.map(efsDfField));
  const blob = Buffer.alloc(HEADER_SIZE + ddf.length + drf.length);
  blob.writeUInt32LE(blob.length, 0x00); // length of the attribute value
  blob.writeUInt32LE(0, 0x04); // state
  blob.writeUInt32LE(2, 0x08); // version
  blob.writeUInt32LE(0, 0x0c); // crypto_api_version
  // unknown4/unknown5/unknown6 (three 16-byte GUID-ish fields) stay zero.
  blob.writeUInt32LE(ddf.length > 0 ? HEADER_SIZE : 0, 0x40); // offset_to_ddf_array
  blob.writeUInt32LE(drf.length > 0 ? HEADER_SIZE + ddf.length : 0, 0x44); // offset_to_drf_array
  blob.writeUInt32LE(0, 0x48); // reserved
  ddf.copy(blob, HEADER_SIZE);
  drf.copy(blob, HEADER_SIZE + ddf.length);
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

export interface NtfsEfsFileFixture {
  name: string;
  /** Real $EFS attribute value (as Windows wrote it). */
  efsValue: Buffer;
  /** Ciphertext written to the data runs. */
  data: Buffer;
  /** data_size: the plaintext length. */
  plainSize: number;
}

export function buildNtfsVolume(opts?: { includeEfsFile?: boolean; efsFile?: NtfsEfsFileFixture }): PartitionReader {  const totalClusters = 64;
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

  if (opts?.efsFile) {
    const efs = opts.efsFile;
    const runLength = Math.max(1, Math.ceil(efs.data.length / CLUSTER));
    const rec10 = buildFileRecord(10, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(7000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, efs.name, 1) },
        {
          type: 0x80,
          nonResident: true,
          runs: [{ startLcn: 40, runLength }],
          realSize: efs.plainSize,
          allocatedSize: runLength * CLUSTER,
          initializedSize: efs.data.length
        },
        { type: 0x100, nonResident: false, resident: efs.efsValue }
      ]
    });
    rec10.copy(data, mftBase + 10 * FILE_RECORD);
    efs.data.copy(data, 40 * CLUSTER);
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
