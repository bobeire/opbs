import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'crypto';
import { compressBlock, COMPRESSION_ZSTD } from '../../src/main/imaging/image-format';

/**
 * Shared builders for synthetic `.mrimgx` (Reflect X) containers. The layout
 * mirrors the real format: [data blocks] [root $JSON] [disk $TRACK0]
 * [partition $INDEX] [footer with metadata offset + magic].
 *
 * `opts.encrypt` builds a password-protected container with an independent
 * encryptor (node:crypto only) so the reader's decryption is validated against
 * a second implementation of Macrium's published scheme, not itself.
 */

export const MAGIC_X = 'MACRIUM_FILE';
export const BLOCK_JSON = '$JSON   ';
export const BLOCK_INDEX = '$INDEX  ';
/** Metadata-block flag: payload is AES-ECB encrypted. */
export const FLAG_ENCRYPTED = 0x04;

export function md5(buf: Buffer): Buffer {
  return createHash('md5').update(buf).digest();
}

export type TestAesVariant = 10 | 12 | 14;

const AES_CBC: Record<TestAesVariant, string> = {
  10: 'aes-128-cbc',
  12: 'aes-192-cbc',
  14: 'aes-256-cbc'
};
const AES_ECB: Record<TestAesVariant, string> = {
  10: 'aes-128-ecb',
  12: 'aes-192-ecb',
  14: 'aes-256-ecb'
};
const AES_KEY_BYTES: Record<TestAesVariant, number> = { 10: 16, 12: 24, 14: 32 };
const AES_NAME: Record<TestAesVariant, string> = { 10: 'aes-128', 12: 'aes-192', 14: 'aes-256' };

function pad16(buf: Buffer): Buffer {
  const rem = buf.length % 16;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(16 - rem)]);
}

/** AES-CBC, no PKCS padding (zero pad to the AES block size, like Macrium). */
export function encryptCbc(plain: Buffer, key: Buffer, aes: TestAesVariant, iv: Buffer): Buffer {
  const cipher = createCipheriv(AES_CBC[aes], key.subarray(0, AES_KEY_BYTES[aes]), iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pad16(plain)), cipher.final()]);
}

/** AES-ECB, no PKCS padding (metadata blocks). */
export function encryptEcb(plain: Buffer, key: Buffer, aes: TestAesVariant): Buffer {
  const cipher = createCipheriv(AES_ECB[aes], key.subarray(0, AES_KEY_BYTES[aes]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pad16(plain)), cipher.final()]);
}

/** Per-block CBC IV: AES-256-ECB(SHA256(key), imageid|disk|partition|index). */
export function blockIv(imageId: Buffer, disk: number, partition: number, index: number, key: Buffer): Buffer {
  const data = Buffer.alloc(16);
  imageId.copy(data, 0, 0, 8);
  data.writeUInt16LE(disk & 0xffff, 8);
  data.writeUInt16LE(partition & 0xffff, 10);
  data.writeUInt32LE(index >>> 0, 12);
  const cipher = createCipheriv('aes-256-ecb', createHash('sha256').update(key).digest(), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Derive Macrium's key: PBKDF2-HMAC-SHA256(passphrase, SHA256(imageid 8
 * bytes), iterations, 32 bytes). `imageIdHex` must be 16 hex characters.
 */
export function deriveTestKey(imageIdHex: string, passphrase: string, iterations: number): Buffer {
  const salt = createHash('sha256').update(Buffer.from(imageIdHex, 'hex')).digest();
  return pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
}

/** Macrium's password verifier: HMAC-SHA256(key, empty message). */
export function testKeyHmac(key: Buffer): string {
  return createHmac('sha256', key).digest('hex');
}

export function buildBlock(
  name: string,
  body: Buffer,
  last = true,
  flags = 0
): { header: Buffer; headerHash: Buffer } {
  const hdr = Buffer.alloc(32);
  Buffer.from(name, 'latin1').copy(hdr, 0);
  hdr.writeUInt32LE(body.length, 8);
  const digest = md5(body);
  digest.copy(hdr, 12);
  hdr[28] = (last ? 1 : 0) | flags;
  return { header: hdr, headerHash: digest };
}

export function buildMrimgIndex(
  blocks: Array<{ filePosition: number; md5: Buffer; storedLength: number }>,
  fileNumber = 0,
  reserved: Array<{ filePosition: number; md5: Buffer; storedLength: number }> = []
): Buffer {
  const buf = Buffer.alloc(4 + reserved.length * 30 + 4 + blocks.length * 30);
  let off = 0;
  buf.writeUInt32LE(reserved.length, off);
  off += 4;
  for (const b of reserved) {
    buf.writeBigInt64LE(BigInt(b.filePosition), off);
    b.md5.copy(buf, off + 8);
    buf.writeUInt32LE(b.storedLength, off + 24);
    buf.writeUInt16LE(fileNumber, off + 28);
    off += 30;
  }
  buf.writeUInt32LE(blocks.length, off);
  off += 4;
  for (const b of blocks) {
    buf.writeBigInt64LE(BigInt(b.filePosition), off);
    b.md5.copy(buf, off + 8);
    buf.writeUInt32LE(b.storedLength, off + 24);
    buf.writeUInt16LE(fileNumber, off + 28);
    off += 30;
  }
  return buf;
}

/**
 * $INDEX payload for a delta-incremental: u32 reserved count (0), u32 record
 * count, then 34-byte DeltaDataBlock records — the 30-byte element (position,
 * md5, length, file number) plus the u32 logical block slot it overlays.
 */
export function buildMrimgxDeltaIndex(
  records: Array<{ filePosition: number; md5: Buffer; storedLength: number; fileNumber: number; blockIndex: number }>
): Buffer {
  const buf = Buffer.alloc(4 + 4 + records.length * 34);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(records.length, 4);
  let off = 8;
  for (const r of records) {
    buf.writeBigInt64LE(BigInt(r.filePosition), off);
    r.md5.copy(buf, off + 8);
    buf.writeUInt32LE(r.storedLength, off + 24);
    buf.writeUInt16LE(r.fileNumber, off + 28);
    buf.writeUInt32LE(r.blockIndex, off + 30);
    off += 34;
  }
  return buf;
}

export function buildMrimgxImage(
  partitionBlocks: Buffer[],
  tweak?: (json: any) => void,
  opts?: {
    /**
     * Logical block indices stored locally: turns the container into a
     * delta-incremental. Only those blocks land in the data region, the
     * $INDEX becomes 34-byte delta records, and `delta_index` is forced on —
     * `partitionBlocks` remains the full logical volume (block_count).
     */
    delta?: number[];
    /**
     * Plaintext reserved-track blocks (a FAT32 volume's boot area + FATs,
     * stored before the first cluster). Their total length becomes
     * `dataStart`; each block is encrypted with its array position as the IV
     * counter, matching the reference restorer.
     */
    reserved?: Buffer[];
    /**
     * Build a password-protected Reflect X container. Data blocks are
     * AES-CBC encrypted with the per-block IV; the `$INDEX` metadata block is
     * AES-ECB encrypted unless `metadata: false`. `compress` zstd-compresses
     * each block before encryption (the reader must trim the AES padding to
     * the frame length). The image id must be 16 hex characters.
     */
    encrypt?: {
      passphrase: string;
      aes?: TestAesVariant;
      iterations?: number;
      metadata?: boolean;
      compress?: boolean;
    };
  }
): {
  buffer: Buffer;
  partitionSize: number;
  blockSize: number;
} {
  const blockSize = 8192;
  const json = {
    _header: {
      imageid: '00000001',
      backup_type: 'full',
      backup_format: 'file_level',
      backup_time: 1600000000,
      index_file_position: 0, // placeholder, will patch
      split_file: false,
      delta_index: false,
      file_number: 0,
      increment_number: 0,
      merged_files: []
    },
    _compression: { compression_method: 'zstd', compression_level: 'none' },
    _encryption: { enable: false },
    disks: [
      {
        _header: { disk_number: 0, disk_format: 'gpt' },
        _geometry: { disk_size: 500107862016 },
        partitions: [
          {
            _header: { block_size: blockSize, block_count: partitionBlocks.length, partition_number: 1 },
            _file_system: { type: 'NTFS', start: 0, lcn0_offset: 0, sectors_per_cluster: 8, volume_label: 'TEST' },
            _geometry: { start: 2048, end: 976768063, length: 976766016, boot_sector_offset: 0 },
            _partition_table_entry: { type: 7 }
          }
        ]
      }
    ]
  };

  tweak?.(json);
  if (opts?.delta) json._header.delta_index = true;

  const enc = opts?.encrypt;
  const aes: TestAesVariant = enc?.aes ?? 14;
  const imageIdHex = String(json._header.imageid ?? '');
  let key: Buffer | undefined;
  if (enc) {
    if (!/^[0-9a-fA-F]{16}$/.test(imageIdHex)) {
      throw new Error(`encrypted fixtures need a 16-hex-character imageid, got "${imageIdHex}"`);
    }
    const iterations = enc.iterations ?? 100000;
    key = deriveTestKey(imageIdHex, enc.passphrase, iterations);
    json._encryption = {
      enable: true,
      key_iterations: iterations,
      aes_type: AES_NAME[aes],
      hmac: testKeyHmac(key)
    } as typeof json._encryption & Record<string, unknown>;
    if (enc.compress) json._compression = { compression_method: 'zstd', compression_level: 'medium' };
  }

  const diskNumber = Number((json.disks[0] as { _header?: { disk_number?: number } })._header?.disk_number ?? 0);
  const partitionNumber = Number(
    (json.disks[0] as { partitions?: Array<{ _header?: { partition_number?: number } }> }).partitions?.[0]?._header
      ?.partition_number ?? 1
  );
  const imageId = Buffer.from(imageIdHex, 'hex');

  // Reserved track (FAT32 boot area + FATs): the file system's first cluster
  // sits after it, so `dataStart = lcn0_offset - start`.
  const reservedPlain = opts?.reserved ?? [];
  const reservedLen = reservedPlain.reduce((s, b) => s + b.length, 0);
  if (reservedLen > 0) {
    const part = (json.disks[0] as {
      partitions: Array<{
        _file_system: { type: string; start: number; lcn0_offset: number };
        _geometry: { length: number };
      }>;
    }).partitions[0];
    part._file_system.type = 'FAT32';
    part._file_system.start = 0;
    part._file_system.lcn0_offset = reservedLen;
    part._geometry.length = reservedLen + partitionBlocks.length * blockSize;
  }

  // Data blocks in storage order. A delta member stores only the selected
  // logical blocks; positions below walk the stored run.
  const sourceBlocks: Array<{ raw: Buffer; logical: number }> = opts?.delta
    ? opts.delta.map((i) => ({ raw: partitionBlocks[i], logical: i }))
    : partitionBlocks.map((raw, i) => ({ raw, logical: i }));

  const reservedStored = reservedPlain.map((raw, i) => {
    const plain = enc?.compress ? compressBlock(raw, COMPRESSION_ZSTD) : raw;
    if (!key) return plain;
    return encryptCbc(plain, key, aes, blockIv(imageId, diskNumber, partitionNumber, i, key));
  });
  const storedData = sourceBlocks.map(({ raw, logical }) => {
    const plain = enc?.compress ? compressBlock(raw, COMPRESSION_ZSTD) : raw;
    if (!key) return plain;
    return encryptCbc(plain, key, aes, blockIv(imageId, diskNumber, partitionNumber, logical, key));
  });

  // Layout order: reserved blocks, then data blocks. Positions are explicit in
  // the index, so the order only needs to match the copy loop below.
  let pos = 0;
  const reservedRecords = reservedStored.map((stored, i) => {
    const record = { filePosition: pos, md5: md5(reservedPlain[i]), storedLength: stored.length };
    pos += stored.length;
    return record;
  });
  const dataRecords = storedData.map((stored, k) => {
    const record = { filePosition: pos, md5: md5(sourceBlocks[k].raw), storedLength: stored.length };
    pos += stored.length;
    return record;
  });
  const storedBlocks = [...reservedStored, ...storedData];
  const totalDataLen = pos;
  let jsonBody = Buffer.from(JSON.stringify(json), 'utf8');

  // Layout: [data blocks] [root $JSON meta] [index metadata]:
  //   [disk meta group] [partition $INDEX meta group] [footer]
  const diskMetaBody = Buffer.alloc(16); // fake $TRACK0; unused by reader
  diskMetaBody.writeUInt32LE(0x55aa, 0);
  const diskMetaHeader = buildBlock('$TRACK0 ', diskMetaBody, true).header;

  // index_file_position points at the first index metadata group.
  let indexMetaStart = totalDataLen + 32 + jsonBody.length;
  json._header.index_file_position = indexMetaStart;
  jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  const shifted = totalDataLen + 32 + jsonBody.length;
  if (shifted !== indexMetaStart) {
    indexMetaStart = shifted;
    json._header.index_file_position = indexMetaStart;
    jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  }

  const rootMetaHeader = buildBlock(BLOCK_JSON, jsonBody, true).header;
  const rootMetaOff = totalDataLen;

  // Index with real stored positions and PLAINTEXT hashes.
  let partIndexBody: Buffer;
  const fileNumber = typeof json._header.file_number === 'number' ? json._header.file_number : 0;
  if (opts?.delta) {
    let dpos = 0;
    const records = sourceBlocks.map(({ raw, logical }, k) => {
      const record = {
        filePosition: dpos,
        md5: md5(raw),
        storedLength: storedData[k].length,
        fileNumber,
        blockIndex: logical
      };
      dpos += storedData[k].length;
      return record;
    });
    partIndexBody = buildMrimgxDeltaIndex(records);
  } else {
    partIndexBody = buildMrimgIndex(dataRecords, fileNumber, reservedRecords);
  }

  // Metadata blocks are AES-ECB encrypted when the container is encrypted
  // (unless the test asks for a plaintext index to exercise the "metadata is
  // encrypted" refusal path).
  let partIndexStored = partIndexBody;
  let partMetaFlags = 0;
  if (key && enc?.metadata !== false) {
    partIndexStored = encryptEcb(partIndexBody, key, aes);
    partMetaFlags = FLAG_ENCRYPTED;
  }
  const partMetaHeader = buildBlock(BLOCK_INDEX, partIndexStored, true, partMetaFlags).header;

  const fileSize =
    totalDataLen +
    32 + jsonBody.length +
    32 + diskMetaBody.length +
    32 + partIndexStored.length +
    20;
  const fileBuf = Buffer.alloc(fileSize);
  let off = 0;
  for (const stored of storedBlocks) {
    stored.copy(fileBuf, off);
    off += stored.length;
  }
  rootMetaHeader.copy(fileBuf, off); off += rootMetaHeader.length;
  jsonBody.copy(fileBuf, off); off += jsonBody.length;
  diskMetaHeader.copy(fileBuf, off); off += diskMetaHeader.length;
  diskMetaBody.copy(fileBuf, off); off += diskMetaBody.length;
  partMetaHeader.copy(fileBuf, off); off += partMetaHeader.length;
  partIndexStored.copy(fileBuf, off);

  // Footer
  const footerOff = fileBuf.length - 20;
  fileBuf.writeBigUInt64LE(BigInt(rootMetaOff), footerOff);
  Buffer.from(MAGIC_X, 'latin1').copy(fileBuf, footerOff + 8);

  return { buffer: fileBuf, partitionSize: partitionBlocks.length * blockSize, blockSize };
}
