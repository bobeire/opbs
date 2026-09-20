import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fzstd from 'fzstd';
import { loadNative } from '../utils/native-loader';

/**
 * zstdify ships ESM-only ("type": "module"), which Electron 28's Node 18
 * cannot `require()`. The build bundles it to dist/zstdify.cjs (CJS) for the
 * desktop app; where that bundle is absent (vitest source runs, fresh tree)
 * the ESM package itself still loads under the bundled stock Node. Prefer the
 * bundle so every runtime resolves the codec synchronously.
 */
function loadZstdify(): typeof import('zstdify') {
  const bundle = path.resolve(__dirname, '../zstdify.cjs');
  if (fs.existsSync(bundle)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(bundle) as typeof import('zstdify');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('zstdify') as typeof import('zstdify');
}

const zstdify = loadZstdify();

export const IMAGE_MAGIC = 'OPBS';
export const IMAGE_VERSION = 2;
export const HEADER_SIZE = 256;
export const PARTITION_TABLE_ENTRY_SIZE = 64;
export const BLOCK_INDEX_ENTRY_SIZE = 32;
export const BLOCK_INDEX_ENTRY_SIZE_V1 = 28;

export const COMPRESSION_NONE = 0;
export const COMPRESSION_DEFLATE = 1;
export const COMPRESSION_ZSTD = 2;

export type CompressionType = 'none' | 'deflate' | 'zstd';

export const FLAG_HAS_BLOCK_INDEX = 0x1;
export const FLAG_VERIFIED = 0x2;
export const FLAG_INCREMENTAL = 0x4;
export const FLAG_RESUMED = 0x8;
export const FLAG_MULTI_VOLUME = 0x10;

/** Byte offset of the flags field inside the 256-byte image header. */
export const FLAGS_OFFSET = 36;

export const CIPHER_NONE = 0;
export const CIPHER_AES256_GCM = 1;
export const GCM_IV_LENGTH = 12;
export const GCM_TAG_LENGTH = 16;
export const SALT_LENGTH = 16;
export const KEY_LENGTH = 32;
export const KDF_ITERATIONS_DEFAULT = 210000;

/** Byte offset of the fixed-size base-image path field inside the header. */
export const BASE_IMAGE_PATH_OFFSET = 128;
export const BASE_IMAGE_PATH_LENGTH = 128;

/** Source-disk identity fields inside the header (used for same-disk restore guards). */
export const SOURCE_DISK_MODEL_OFFSET = 72;
export const SOURCE_DISK_SERIAL_OFFSET = 100;
export const SOURCE_DISK_IDENTITY_LENGTH = 28;

export const DEFAULT_BLOCK_SIZE = 1024 * 1024;
const CRC_TABLE = buildCrcTable();

export interface ImageHeader {
  version: number;
  timestamp: number;
  totalBytes: number;
  blockSize: number;
  compressionId: number;
  partitionCount: number;
  flags: number;
  blockIndexOffset: number;
  cipherId: number;
  kdfIterations: number;
  salt: Buffer;
  baseImagePath: string;
  /** Model/serial of the disk the image was taken from ('' when unavailable or on old images). */
  sourceDiskModel: string;
  sourceDiskSerial: string;
  /** Maximum size in bytes for each volume file (0 = single volume, no splitting).
   *  Stored as uint16 MB in the header at offset 6. */
  maxVolumeSize?: number;
}

export interface PartitionEntryMeta {
  partitionIndex: number;
  size: number;
  offsetOnDisk: number;
  firstBlockFileOffset: number;
  blockCount: number;
}

export interface BlockRecord {
  partitionIndex: number;
  blockIndex: number;
  fileOffset: number;
  rawSize: number;
  compSize: number;
  rawCrc32: number;
  /** Volume index for multi-volume images (0 for single-volume). */
  volumeIndex?: number;
}

export interface ImageInfo {
  header: ImageHeader;
  partitions: PartitionEntryMeta[];
  blocks: BlockRecord[];
  dataOffset: number;
}

/** Cipher parameters for writing a new image (key derived from passphrase). */
export interface ImageCipher {
  cipherId: number;
  salt: Buffer;
  kdfIterations: number;
  key: Buffer;
}

export interface EncryptionMetadata {
  cipherId: number;
  saltHex: string;
  kdfIterations: number;
  keyHex: string;
}

export function metadataFromCipher(cipher: ImageCipher): EncryptionMetadata {
  return {
    cipherId: cipher.cipherId,
    saltHex: cipher.salt.toString('hex'),
    kdfIterations: cipher.kdfIterations,
    keyHex: cipher.key.toString('hex')
  };
}

export function cipherFromMetadata(meta: EncryptionMetadata): ImageCipher {
  return {
    cipherId: meta.cipherId,
    salt: Buffer.from(meta.saltHex, 'hex'),
    kdfIterations: meta.kdfIterations,
    key: Buffer.from(meta.keyHex, 'hex')
  };
}

/** Key needed to read an encrypted image, derived from its stored KDF params. */
export function deriveImageKey(passphrase: string, salt: Buffer, kdfIterations: number): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, kdfIterations, KEY_LENGTH, 'sha256');
}

export function newImageCipher(passphrase: string): ImageCipher {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const cipherId = passphrase ? CIPHER_AES256_GCM : CIPHER_NONE;
  if (!passphrase) {
    return { cipherId, salt, kdfIterations: 0, key: Buffer.alloc(KEY_LENGTH) };
  }
  return {
    cipherId,
    salt,
    kdfIterations: KDF_ITERATIONS_DEFAULT,
    key: deriveImageKey(passphrase, salt, KDF_ITERATIONS_DEFAULT)
  };
}

/** Encode a base image path into the fixed-size header field (asscii, truncated). */
export function encodeBaseImagePath(value: string | undefined): Buffer {
  const buf = Buffer.alloc(BASE_IMAGE_PATH_LENGTH);
  if (value) {
    buf.write(value.slice(0, BASE_IMAGE_PATH_LENGTH - 1), 0, 'ascii');
  }
  return buf;
}

export function decodeBaseImagePath(buf: Buffer): string {
  const end = buf.indexOf(0);
  const len = end === -1 ? buf.length : end;
  return buf.toString('ascii', 0, len);
}

/** Encode a string into a fixed-size ASCII field (truncated, NUL-padded). */
function encodeAsciiField(value: string | undefined, size: number): Buffer {
  const buf = Buffer.alloc(size);
  if (value) {
    buf.write(value.slice(0, size - 1), 0, 'ascii');
  }
  return buf;
}

function decodeAsciiField(buf: Buffer): string {
  const end = buf.indexOf(0);
  const len = end === -1 ? buf.length : end;
  return buf.toString('ascii', 0, len);
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

interface NativeCrc32Function {
  crc32?: (data: Uint8Array, seed?: number) => number;
}

let nativeCrc32: ((data: Uint8Array, seed?: number) => number) | null | undefined;

function getNativeCrc32(): ((data: Uint8Array, seed?: number) => number) | null {
  if (nativeCrc32 === undefined) {
    try {
      // Lazy: only load the addon when a CRC is computed, and fall back to the
      // JS table if it is unavailable (e.g. tests, non-native contexts).
      nativeCrc32 = loadNative<NativeCrc32Function>().crc32 ?? null;
    } catch {
      nativeCrc32 = null;
    }
  }
  return nativeCrc32;
}

interface NativeZstdFunctions {
  zstdCompress?: (data: Uint8Array, level?: number) => Uint8Array;
  zstdDecompress?: (data: Uint8Array, maxOutput?: number) => Uint8Array;
}

let nativeZstd: NativeZstdFunctions | null | undefined;

function getNativeZstdFunctions(): NativeZstdFunctions | null {
  if (nativeZstd === undefined) {
    try {
      const mod = loadNative<NativeZstdFunctions>();
      nativeZstd =
        typeof mod.zstdCompress === 'function' && typeof mod.zstdDecompress === 'function'
          ? { zstdCompress: mod.zstdCompress, zstdDecompress: mod.zstdDecompress }
          : null;
    } catch {
      nativeZstd = null;
    }
  }
  return nativeZstd;
}

export function crc32(data: Uint8Array, seed = 0): number {
  const native = getNativeCrc32();
  if (native) {
    try {
      return native(data, seed) >>> 0;
    } catch {
      /* fall back to the JS implementation */
    }
  }
  let crc = seed ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

export function encodeHeader(header: ImageHeader): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.write(IMAGE_MAGIC, 0, 'ascii');
  buf.writeUInt16LE(header.version, 4);
  buf.writeUInt16LE(header.maxVolumeSize ? Math.ceil(header.maxVolumeSize / (1024 * 1024)) : 0, 6);
  buf.writeBigUInt64LE(BigInt(header.timestamp), 8);
  buf.writeBigUInt64LE(BigInt(header.totalBytes), 16);
  buf.writeUInt32LE(header.blockSize, 24);
  buf.writeUInt32LE(header.compressionId, 28);
  buf.writeUInt32LE(header.partitionCount, 32);
  buf.writeUInt32LE(header.flags, 36);
  buf.writeBigUInt64LE(BigInt(header.blockIndexOffset), 40);
  buf.writeUInt32LE(header.cipherId, 48);
  buf.writeUInt32LE(header.kdfIterations, 52);
  const salt = header.salt ?? Buffer.alloc(SALT_LENGTH);
  salt.copy(buf, 56, 0, SALT_LENGTH);
  encodeSourceDiskIdentity(header.sourceDiskModel ?? '', header.sourceDiskSerial ?? '').copy(buf, SOURCE_DISK_MODEL_OFFSET);
  encodeBaseImagePath(header.baseImagePath ?? '').copy(buf, BASE_IMAGE_PATH_OFFSET, 0, BASE_IMAGE_PATH_LENGTH);
  return buf;
}

export function encodeSourceDiskIdentity(model: string, serial: string): Buffer {
  const buf = Buffer.alloc(SOURCE_DISK_SERIAL_OFFSET + SOURCE_DISK_IDENTITY_LENGTH - SOURCE_DISK_MODEL_OFFSET);
  encodeAsciiField(model, SOURCE_DISK_IDENTITY_LENGTH).copy(buf, 0);
  encodeAsciiField(serial, SOURCE_DISK_IDENTITY_LENGTH).copy(buf, SOURCE_DISK_IDENTITY_LENGTH);
  return buf;
}

export function parseHeader(buf: Buffer): ImageHeader {
  if (buf.length < HEADER_SIZE) {
    throw new Error('Image header is truncated');
  }
  if (buf.toString('ascii', 0, 4) !== IMAGE_MAGIC) {
    throw new Error('Not an OPBS image (bad magic)');
  }
  return {
    version: buf.readUInt16LE(4),
    timestamp: Number(buf.readBigUInt64LE(8)),
    totalBytes: Number(buf.readBigUInt64LE(16)),
    blockSize: buf.readUInt32LE(24),
    compressionId: buf.readUInt32LE(28),
    partitionCount: buf.readUInt32LE(32),
    flags: buf.readUInt32LE(36),
    blockIndexOffset: Number(buf.readBigUInt64LE(40)),
    cipherId: buf.readUInt32LE(48),
    kdfIterations: buf.readUInt32LE(52),
    salt: Buffer.from(buf.subarray(56, 56 + SALT_LENGTH)),
    baseImagePath: decodeBaseImagePath(buf.subarray(BASE_IMAGE_PATH_OFFSET, BASE_IMAGE_PATH_OFFSET + BASE_IMAGE_PATH_LENGTH)),
    sourceDiskModel: decodeAsciiField(buf.subarray(SOURCE_DISK_MODEL_OFFSET, SOURCE_DISK_MODEL_OFFSET + SOURCE_DISK_IDENTITY_LENGTH)),
    sourceDiskSerial: decodeAsciiField(buf.subarray(SOURCE_DISK_SERIAL_OFFSET, SOURCE_DISK_SERIAL_OFFSET + SOURCE_DISK_IDENTITY_LENGTH)),
    maxVolumeSize: (() => { const mb = buf.readUInt16LE(6); return mb > 0 ? mb * 1024 * 1024 : undefined; })()
  };
}

export function encodePartitionEntry(entry: PartitionEntryMeta): Buffer {
  const buf = Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE);
  buf.writeUInt32LE(Math.max(0, entry.partitionIndex), 0);
  buf.writeUInt32LE(0, 4);
  buf.writeBigUInt64LE(BigInt(Math.max(0, entry.size)), 8);
  buf.writeBigUInt64LE(BigInt(Math.max(0, entry.offsetOnDisk)), 16);
  buf.writeBigUInt64LE(BigInt(Math.max(0, entry.firstBlockFileOffset)), 24);
  buf.writeUInt32LE(Math.max(0, entry.blockCount), 32);
  buf.writeUInt32LE(0, 36);
  return buf;
}

export function parsePartitionEntry(buf: Buffer): PartitionEntryMeta {
  return {
    partitionIndex: buf.readUInt32LE(0),
    size: Number(buf.readBigUInt64LE(8)),
    offsetOnDisk: Number(buf.readBigUInt64LE(16)),
    firstBlockFileOffset: Number(buf.readBigUInt64LE(24)),
    blockCount: buf.readUInt32LE(32)
  };
}

export function encodeBlockIndexEntry(record: BlockRecord): Buffer {
  const buf = Buffer.alloc(BLOCK_INDEX_ENTRY_SIZE);
  buf.writeUInt32LE(record.partitionIndex, 0);
  buf.writeUInt32LE(record.blockIndex, 4);
  buf.writeBigUInt64LE(BigInt(record.fileOffset), 8);
  buf.writeUInt32LE(record.rawSize, 16);
  buf.writeUInt32LE(record.compSize, 20);
  buf.writeUInt32LE(record.rawCrc32, 24);
  buf.writeUInt32LE(record.volumeIndex ?? 0, 28);
  return buf;
}

export function parseBlockIndexEntry(buf: Buffer, version: number = IMAGE_VERSION): BlockRecord {
  const entrySize = version >= 2 ? BLOCK_INDEX_ENTRY_SIZE : BLOCK_INDEX_ENTRY_SIZE_V1;
  const raw = buf.length >= entrySize ? buf : Buffer.concat([buf, Buffer.alloc(entrySize - buf.length)]);
  const record: BlockRecord = {
    partitionIndex: raw.readUInt32LE(0),
    blockIndex: raw.readUInt32LE(4),
    fileOffset: Number(raw.readBigUInt64LE(8)),
    rawSize: raw.readUInt32LE(16),
    compSize: raw.readUInt32LE(20),
    rawCrc32: raw.readUInt32LE(24)
  };
  if (version >= 2 && buf.length >= BLOCK_INDEX_ENTRY_SIZE) {
    record.volumeIndex = raw.readUInt32LE(28) || undefined;
  }
  return record;
}

export function encodeBlockFrame(
  raw: Uint8Array,
  compressed: Uint8Array,
  cipher?: ImageCipher | null,
  precomputed?: { rawSize: number; rawCrc: number }
): Buffer {
  const encrypted = cipher && cipher.cipherId !== CIPHER_NONE;
  const extra = encrypted ? GCM_IV_LENGTH + GCM_TAG_LENGTH : 0;
  const rawSize = precomputed?.rawSize ?? raw.length;
  const rawCrc = precomputed?.rawCrc ?? crc32(raw);
  const frame = Buffer.alloc(16 + extra + compressed.length);
  frame.writeUInt32LE(rawSize, 0);
  frame.writeUInt32LE(compressed.length, 4);
  frame.writeUInt32LE(rawCrc, 8);
  frame.writeUInt32LE(crc32(compressed), 12);

  if (!encrypted) {
    Buffer.from(compressed).copy(frame, 16);
    return frame;
  }

  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const gcm = crypto.createCipheriv('aes-256-gcm', cipher!.key, iv);
  const ciphertext = Buffer.concat([gcm.update(compressed), gcm.final()]);
  const tag = gcm.getAuthTag();
  if (tag.length !== GCM_TAG_LENGTH) {
    throw new Error('Unexpected GCM tag length');
  }
  iv.copy(frame, 16);
  tag.copy(frame, 16 + GCM_IV_LENGTH);
  ciphertext.copy(frame, 16 + GCM_IV_LENGTH + GCM_TAG_LENGTH);
  return frame;
}

/**
 * Read and decrypt a single frame's payload at `dataPos` (the start of the
 * variable-length area after the 16-byte frame header). Returns the compressed
 * plaintext buffer, throwing on auth failure (corrupted/tampered data).
 */
export function readFrameCompressed(
  fd: number,
  compSize: number,
  dataPos: number,
  cipherId: number,
  key?: Buffer
): Buffer {
  if (cipherId === CIPHER_NONE) {
    const comp = Buffer.alloc(compSize);
    const dataRead = fs.readSync(fd, comp, 0, compSize, dataPos);
    if (dataRead !== compSize) {
      throw new Error(`Truncated frame data at offset ${dataPos}`);
    }
    return comp;
  }

  if (!key || key.length !== KEY_LENGTH) {
    throw new Error('Image is encrypted; a passphrase is required');
  }
  if (cipherId !== CIPHER_AES256_GCM) {
    throw new Error(`Unsupported cipher id: ${cipherId}`);
  }

  const iv = Buffer.alloc(GCM_IV_LENGTH);
  const ivRead = fs.readSync(fd, iv, 0, GCM_IV_LENGTH, dataPos);
  if (ivRead !== GCM_IV_LENGTH) {
    throw new Error(`Truncated frame IV at offset ${dataPos}`);
  }
  const tag = Buffer.alloc(GCM_TAG_LENGTH);
  const tagRead = fs.readSync(fd, tag, 0, GCM_TAG_LENGTH, dataPos + GCM_IV_LENGTH);
  if (tagRead !== GCM_TAG_LENGTH) {
    throw new Error(`Truncated frame auth tag at offset ${dataPos}`);
  }
  const ctextStart = dataPos + GCM_IV_LENGTH + GCM_TAG_LENGTH;
  const ciphertext = Buffer.alloc(compSize);
  const cRead = fs.readSync(fd, ciphertext, 0, compSize, ctextStart);
  if (cRead !== compSize) {
    throw new Error(`Truncated frame ciphertext at offset ${ctextStart}`);
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(`Frame authentication failed at offset ${dataPos}`);
  }
}

/**
 * Read an image's header, partition table and block index.
 */
export function readImageInfo(imagePath: string): ImageInfo {
  const fd = fs.openSync(imagePath, 'r');
  try {
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, headerBuf, 0, HEADER_SIZE, 0);
    const header = parseHeader(headerBuf);

    if (header.version !== IMAGE_VERSION && header.version !== 1) {
      throw new Error(`Unsupported image version: ${header.version}`);
    }
    if (
      header.compressionId !== COMPRESSION_NONE &&
      header.compressionId !== COMPRESSION_DEFLATE &&
      header.compressionId !== COMPRESSION_ZSTD
    ) {
      throw new Error(`Unsupported compression id: ${header.compressionId}`);
    }
    if (header.cipherId !== CIPHER_NONE && header.cipherId !== CIPHER_AES256_GCM) {
      throw new Error(`Unsupported cipher id: ${header.cipherId}`);
    }

    const partitions: PartitionEntryMeta[] = [];
    for (let i = 0; i < header.partitionCount; i++) {
      const entryBuf = Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE);
      fs.readSync(fd, entryBuf, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE + i * PARTITION_TABLE_ENTRY_SIZE);
      partitions.push(parsePartitionEntry(entryBuf));
    }

    const dataOffset = HEADER_SIZE + header.partitionCount * PARTITION_TABLE_ENTRY_SIZE;

    let blocks: BlockRecord[] = [];
    if (header.blockIndexOffset > 0) {
      const countBuf = Buffer.alloc(8);
      fs.readSync(fd, countBuf, 0, 8, header.blockIndexOffset);
      const count = Number(countBuf.readBigUInt64LE(0));
      const entrySize = header.version >= 2 ? BLOCK_INDEX_ENTRY_SIZE : BLOCK_INDEX_ENTRY_SIZE_V1;
      blocks = new Array<BlockRecord>(count);
      for (let i = 0; i < count; i++) {
        const entryBuf = Buffer.alloc(entrySize);
        fs.readSync(
          fd,
          entryBuf,
          0,
          entrySize,
          header.blockIndexOffset + 8 + i * entrySize
        );
        blocks[i] = parseBlockIndexEntry(entryBuf, header.version);
      }
    }

    return { header, partitions, blocks, dataOffset };
  } finally {
    fs.closeSync(fd);
  }
}

export interface ResumeScanResult {
  header: ImageHeader;
  /** Valid block frames found, in file order (pre-resume records). */
  blocks: BlockRecord[];
  /** File offset of the first invalid/truncated frame (the resume cursor). */
  cursor: number;
  /** Number of fully-written partitions (frames cover every block). */
  completedPartitions: number;
  /** Frames belonging to the last (partially written) partition, if any. */
  resumePartitionFrames: number;
  /** File offset where each partition's frames start. */
  partitionStartOffsets: number[];
  /** True if the image has a complete block index (i.e. not a partial image). */
  complete: boolean;
}

/**
 * Scan a (possibly partial) image file to recover the exact resume position
 * and the block records already written. Frames are self-describing (raw size,
 * compressed size and both CRCs in the 16-byte header), so a valid prefix can
 * be walked without the block index that is only written at the very end.
 *
 * Frame headers are decoded structurally (no key required even for encrypted
 * images, whose payload is opaque) and, for plaintext images, the stored
 * compressed CRC is cross-checked so a truncated tail frame is rejected.
 */
export function scanPartialImage(
  imagePath: string,
  partitions: Array<{ size: number; partitionIndex?: number }>,
  blockSize: number
): ResumeScanResult {
  const fd = fs.openSync(imagePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < HEADER_SIZE) {
      throw new Error(`Image file too small to be a partial backup: ${imagePath}`);
    }
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, headerBuf, 0, HEADER_SIZE, 0);
    const header = parseHeader(headerBuf);
    if (header.version !== IMAGE_VERSION) {
      throw new Error(`Unsupported image version: ${header.version}`);
    }

    const encrypted = header.cipherId === CIPHER_AES256_GCM;
    const frameExtra = encrypted ? GCM_IV_LENGTH + GCM_TAG_LENGTH : 0;
    const dataOffset = HEADER_SIZE + header.partitionCount * PARTITION_TABLE_ENTRY_SIZE;

    if (dataOffset > fileSize) {
      throw new Error(`Image header/table extends past the end of the file: ${imagePath}`);
    }

    const complete = header.blockIndexOffset > 0 && (header.flags & FLAG_HAS_BLOCK_INDEX) !== 0;
    if (complete) {
      return { header, blocks: [], cursor: dataOffset, completedPartitions: 0, resumePartitionFrames: 0, partitionStartOffsets: [], complete: true };
    }

    // Expected frame count per partition, in job order.
    const perPartitionBlocks = partitions.map((p) => Math.ceil(p.size / blockSize));
    const blocks: BlockRecord[] = [];
    const partitionStartOffsets: number[] = [];
    let cursor = dataOffset;
    let partIndex = 0;
    let framesInPart = 0;
    let sawValidFrame = false;

    while (partIndex < partitions.length) {
      if (cursor + 16 > fileSize) break;
      const head = Buffer.alloc(16);
      const headRead = fs.readSync(fd, head, 0, 16, cursor);
      if (headRead < 16) break;

      const rawSize = head.readUInt32LE(0);
      const compSize = head.readUInt32LE(4);
      const rawCrc = head.readUInt32LE(8);
      const compCrc = head.readUInt32LE(12);

      // Structural sanity: a raw block can never exceed blockSize, and an
      // implausible compressed size means garbage or a torn tail.
      if (rawSize === 0 || rawSize > blockSize * 4 || compSize === 0 || compSize > 1024 * 1024 * 1024) break;

      const frameEnd = cursor + 16 + frameExtra + compSize;
      if (frameEnd > fileSize) break;

      if (!encrypted) {
        const comp = Buffer.alloc(compSize);
        const compRead = fs.readSync(fd, comp, 0, compSize, cursor + 16);
        if (compRead !== compSize || crc32(comp) !== compCrc) break;
      }

      if (!sawValidFrame) {
        partitionStartOffsets[0] = cursor;
        sawValidFrame = true;
      }

      blocks.push({
        partitionIndex: partitions[partIndex]?.partitionIndex ?? partIndex,
        blockIndex: framesInPart,
        fileOffset: cursor,
        rawSize,
        compSize,
        rawCrc32: rawCrc
      });
      cursor = frameEnd;
      framesInPart++;

      if (framesInPart >= (perPartitionBlocks[partIndex] ?? Infinity)) {
        partIndex++;
        framesInPart = 0;
        if (partIndex < partitions.length) {
          partitionStartOffsets[partIndex] = cursor;
        }
      }
    }

    return {
      header,
      blocks,
      cursor,
      completedPartitions: Math.min(partIndex, partitions.length),
      resumePartitionFrames: partIndex < partitions.length ? framesInPart : 0,
      partitionStartOffsets,
      complete: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compress a raw block using the given compression id. `level` is only used
 * for deflate/zstd (ignored when compressionId is NONE).
 */
export function compressBlock(raw: Uint8Array, compressionId: number, level = 0): Buffer {
  if (compressionId === COMPRESSION_NONE) {
    return Buffer.from(raw);
  }
  if (compressionId === COMPRESSION_DEFLATE) {
    return zlib.deflateRawSync(raw, { level });
  }
  if (compressionId === COMPRESSION_ZSTD) {
    const useLevel = level > 0 ? level : 3;
    const native = getNativeZstdFunctions();
    if (native?.zstdCompress) {
      try {
        return Buffer.from(native.zstdCompress(raw, useLevel));
      } catch {
        /* fall back to the JS encoder below */
      }
    }
    try {
      return Buffer.from(zstdify.compress(raw, { level: useLevel }));
    } catch {
      // zstdify's encoder has a bug that throws `corruption_detected` on some
      // content at certain levels (observed at levels 2-3, e.g. boot-sector
      // data). The level is not part of the frame's decode contract, so a block
      // compressed at any other level still decodes with fzstd. Retry at a
      // known-safe level before giving up.
      for (const fallbackLevel of [1, 4, 6]) {
        if (fallbackLevel === useLevel) continue;
        try {
          return Buffer.from(zstdify.compress(raw, { level: fallbackLevel }));
        } catch {
          /* try next */
        }
      }
      throw new Error(`zstdify could not compress a block at level ${useLevel}`);
    }
  }
  throw new Error(`Unsupported compression id: ${compressionId}`);
}

/**
 * Decompress a stored block.
 */
export function decompressBlock(compressed: Uint8Array, compressionId: number): Buffer {
  if (compressionId === COMPRESSION_NONE) {
    return Buffer.from(compressed);
  }
  if (compressionId === COMPRESSION_DEFLATE) {
    return zlib.inflateRawSync(compressed);
  }
  if (compressionId === COMPRESSION_ZSTD) {
    const native = getNativeZstdFunctions();
    if (native?.zstdDecompress) {
      try {
        return Buffer.from(native.zstdDecompress(compressed));
      } catch {
        /* fall back to fzstd */
      }
    }
    return Buffer.from(fzstd.decompress(compressed));
  }
  throw new Error(`Unsupported compression id: ${compressionId}`);
}

export interface VerifyResult {
  ok: boolean;
  blocksVerified: number;
  error?: string;
}

/**
 * Verify an image by streaming through all block frames from the data offset
 * and re-checking frame CRCs (decrypting encrypted frames first), then matching
 * the frame count/positions against the stored block index.
 *
 * `key` is optional and required only for encrypted images.
 */
export async function verifyImage(imagePath: string, key?: Buffer): Promise<VerifyResult> {
  const info = readImageInfo(imagePath);
  const hasIndex = info.header.blockIndexOffset > 0;
  const cipherId = info.header.cipherId;

  if (cipherId !== CIPHER_NONE && (!key || key.length !== KEY_LENGTH)) {
    return { ok: false, blocksVerified: 0, error: 'Image is encrypted; a passphrase is required' };
  }

  if (hasIndex && info.blocks.length === 0) {
    return {
      ok: false,
      blocksVerified: 0,
      error: `Image flags indicate a block index but the index is empty at offset ${info.header.blockIndexOffset}`
    };
  }

  const fd = fs.openSync(imagePath, 'r');
  let verified = 0;
  try {
    let pos = info.dataOffset;
    const limit = hasIndex ? info.header.blockIndexOffset : Number.MAX_SAFE_INTEGER;
    while (pos + 16 <= limit) {
      const head = Buffer.alloc(16);
      const read = fs.readSync(fd, head, 0, 16, pos);
      if (read < 16) break;

      const rawSize = head.readUInt32LE(0);
      const compSize = head.readUInt32LE(4);
      const rawCrc = head.readUInt32LE(8);
      const compCrc = head.readUInt32LE(12);

      if (compSize > 1024 * 1024 * 1024) {
        return { ok: false, blocksVerified: verified, error: `Implausible frame size at offset ${pos}` };
      }

      let comp: Buffer;
      try {
        comp = readFrameCompressed(fd, compSize, pos + 16, cipherId, key);
      } catch (error) {
        return {
          ok: false,
          blocksVerified: verified,
          error: `${error instanceof Error ? error.message : String(error)} at offset ${pos}`
        };
      }

      if (crc32(comp) !== compCrc) {
        return { ok: false, blocksVerified: verified, error: `Compressed data CRC mismatch at offset ${pos}` };
      }

      let raw: Buffer;
      try {
        raw = decompressBlock(comp, info.header.compressionId);
      } catch (error) {
        return {
          ok: false,
          blocksVerified: verified,
          error: `Failed to decompress block at offset ${pos}: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      if (raw.length !== rawSize) {
        return { ok: false, blocksVerified: verified, error: `Decompressed size mismatch at offset ${pos}` };
      }
      if (crc32(raw) !== rawCrc) {
        return { ok: false, blocksVerified: verified, error: `Raw data CRC mismatch at offset ${pos}` };
      }

      verified++;
      pos += 16 + (cipherId !== CIPHER_NONE ? GCM_IV_LENGTH + GCM_TAG_LENGTH : 0) + compSize;
    }
  } finally {
    fs.closeSync(fd);
  }

  if (hasIndex && verified !== info.blocks.length) {
    return {
      ok: false,
      blocksVerified: verified,
      error: `Verified ${verified} blocks but the index expects ${info.blocks.length}`
    };
  }

  return { ok: verified > 0, blocksVerified: verified };
}

export function defaultImagePath(destinationDirectory: string, diskIndex: number, timestamp = Date.now()): string {
  const date = new Date(timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(destinationDirectory, `opbs-disk${diskIndex}-${date}.opbs`);
}

export function getCompressionId(level: number, type?: CompressionType): number {
  if (level <= 0) {
    return COMPRESSION_NONE;
  }
  if (type === 'zstd') {
    return COMPRESSION_ZSTD;
  }
  return COMPRESSION_DEFLATE;
}

/** Map a compression id back to its symbolic type (default deflate fallback). */
export function compressionTypeOf(compressionId: number): CompressionType {
  if (compressionId === COMPRESSION_ZSTD) {
    return 'zstd';
  }
  if (compressionId === COMPRESSION_NONE) {
    return 'none';
  }
  return 'deflate';
}

/**
 * Read, decrypt, decompress and CRC-check a single stored block frame at the
 * given file offset. Returns the raw data buffer.
 *
 * `cipherId`/`key` describe the image cipher (key optional for plain images).
 */
export function readBlockDataFromImage(
  imagePath: string,
  fileOffset: number,
  compressionId: number,
  cipherId: number = CIPHER_NONE,
  key?: Buffer
): Buffer {
  const frame = readFrameFromImage(imagePath, fileOffset, cipherId, key);
  const raw = decompressBlock(frame.comp, compressionId);
  if (raw.length !== frame.rawSize) {
    throw new Error(`Decompressed size mismatch at offset ${fileOffset}`);
  }
  if (crc32(raw) !== frame.rawCrc) {
    throw new Error(`Raw data CRC mismatch at offset ${fileOffset}`);
  }
  return raw;
}

export interface ReadFrameResult {
  rawSize: number;
  compSize: number;
  rawCrc: number;
  compCrc: number;
  comp: Buffer;
}

/**
 * Resolve the file path for a specific volume of a multi-volume image.
 * Volume 0 is the base image path; volumes 1+ are `.001`, `.002`, etc.
 */
export function resolveVolumePath(baseImagePath: string, volumeIndex: number): string {
  if (volumeIndex === 0) return baseImagePath;
  return `${baseImagePath}.${String(volumeIndex).padStart(3, '0')}`;
}

/**
 * Read a block frame header + compressed (and possibly decrypted) payload from
 * an image, validating the compressed-frame CRC. Decompression is left to the
 * caller so it can be parallelised.
 */
export function readFrameFromImage(
  imagePath: string,
  fileOffset: number,
  cipherId: number = CIPHER_NONE,
  key?: Buffer
): ReadFrameResult {
  if (cipherId !== CIPHER_NONE && (!key || key.length !== KEY_LENGTH)) {
    throw new Error('Image is encrypted; a passphrase is required');
  }

  const fd = fs.openSync(imagePath, 'r');
  try {
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, fileOffset);
    if (read < 16) {
      throw new Error(`Truncated frame at offset ${fileOffset}`);
    }

    const rawSize = head.readUInt32LE(0);
    const compSize = head.readUInt32LE(4);
    const rawCrc = head.readUInt32LE(8);
    const compCrc = head.readUInt32LE(12);

    const comp = readFrameCompressed(fd, compSize, fileOffset + 16, cipherId, key);
    if (crc32(comp) !== compCrc) {
      throw new Error(`Compressed data CRC mismatch at offset ${fileOffset}`);
    }

    return { rawSize, compSize, rawCrc, compCrc, comp };
  } finally {
    fs.closeSync(fd);
  }
}