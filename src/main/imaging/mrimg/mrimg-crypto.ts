import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'crypto';

/**
 * Macrium Reflect X (`.mrimgx`) encryption, implemented from Macrium's
 * published format documentation (github.com/macrium/mrimgx_file_layout,
 * MIT — `docs/ENCRYPTION.md` and `src/libs/encryption/encryption.cpp`).
 *
 * Summary:
 *  - Key: PBKDF2-HMAC-SHA256(password UTF-8, salt = SHA256(imageid bytes),
 *    key_iterations, 32 bytes).
 *  - Password check: HMAC-SHA256(key, empty message) equals `_encryption.hmac`.
 *  - Data blocks: AES-CBC, no padding, key = derived key (truncated to the
 *    AES variant's length), IV = AES-256-ECB(SHA256(derived key),
 *    imageid[8] | disk_number u16le | partition_number u16le | block_index u32le).
 *  - Metadata blocks: AES-ECB with the derived key (same truncation).
 *
 * Ciphertext is padded to the AES block size, so a decrypted zstd frame can
 * carry up to 15 trailing bytes; `zstdFrameLength` finds the exact frame end.
 */

export type MacriumAesVariant = 10 | 12 | 14;

export interface MacriumKeyMaterial {
  /** PBKDF2-derived key (32 bytes; AES-128/192 use a prefix). */
  key: Buffer;
  /** 10 = AES-128, 12 = AES-192, 14 = AES-256 (Macrium's numbering). */
  aes: MacriumAesVariant;
}

/** The image is password-protected and the supplied passphrase is wrong. */
export class MacriumPasswordError extends Error {}

const AES_ALGORITHM: Record<MacriumAesVariant, 'aes-128-cbc' | 'aes-192-cbc' | 'aes-256-cbc'> = {
  10: 'aes-128-cbc',
  12: 'aes-192-cbc',
  14: 'aes-256-cbc'
};

const AES_KEY_BYTES: Record<MacriumAesVariant, number> = { 10: 16, 12: 24, 14: 32 };

/** Parse Macrium's `aes_type` string ("aes-128" | "aes-192" | "aes-256"). */
export function macriumAesVariant(aesType: string | number | undefined): MacriumAesVariant | undefined {
  if (typeof aesType === 'number') {
    return aesType === 10 || aesType === 12 || aesType === 14 ? aesType : undefined;
  }
  switch ((aesType ?? '').toLowerCase()) {
    case 'aes-128':
      return 10;
    case 'aes-192':
      return 12;
    case 'aes-256':
      return 14;
    default:
      return undefined;
  }
}

function aesKey(material: MacriumKeyMaterial): Buffer {
  return material.key.subarray(0, AES_KEY_BYTES[material.aes]);
}

/**
 * Derive the AES key from a passphrase. `imageIdHex` is the `_header.imageid`
 * string (16 hex characters = the 8-byte image id).
 */
export function deriveMacriumKey(
  imageIdHex: string,
  passphrase: string,
  iterations: number,
  aes: MacriumAesVariant
): MacriumKeyMaterial {
  if (!/^[0-9a-fA-F]{16}$/.test(imageIdHex)) {
    throw new Error(`Macrium image id "${imageIdHex}" is not 8 bytes of hex; cannot derive an encryption key.`);
  }
  if (!Number.isFinite(iterations) || iterations <= 0) {
    throw new Error(`Macrium image records an invalid key derivation count (${iterations}).`);
  }
  const imageId = Buffer.from(imageIdHex, 'hex');
  const salt = createHash('sha256').update(imageId).digest();
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
  return { key, aes };
}

/** HMAC-SHA256(derived key, empty message) — Macrium's password verifier. */
export function macriumKeyHmac(material: MacriumKeyMaterial): Buffer {
  return createHmac('sha256', material.key).digest();
}

/** Whether the passphrase's HMAC matches the one recorded in the image. */
export function verifyMacriumHmac(material: MacriumKeyMaterial, expectedHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(expectedHex ?? '')) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = macriumKeyHmac(material);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The per-block CBC initialization vector: AES-256-ECB of
 * `imageid[8] | disk u16le | partition u16le | block index u32le`, keyed by
 * SHA256(derived key). Always AES-256-ECB regardless of the image's AES
 * variant (the reference implementation hard-codes it).
 */
export function macriumBlockIv(
  imageIdHex: string,
  diskNumber: number,
  partitionNumber: number,
  blockIndex: number,
  material: MacriumKeyMaterial
): Buffer {
  const data = Buffer.alloc(16);
  Buffer.from(imageIdHex, 'hex').copy(data, 0, 0, 8);
  data.writeUInt16LE(diskNumber & 0xffff, 8);
  data.writeUInt16LE(partitionNumber & 0xffff, 10);
  data.writeUInt32LE(blockIndex >>> 0, 12);
  const keyHash = createHash('sha256').update(material.key).digest();
  const cipher = createCipheriv('aes-256-ecb', keyHash, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** Decrypt one data block (AES-CBC, no padding). */
export function decryptMacriumBlock(
  stored: Buffer,
  material: MacriumKeyMaterial,
  iv: Buffer
): Buffer {
  if (stored.length === 0 || stored.length % 16 !== 0) {
    throw new Error(`Macrium encrypted block length ${stored.length} is not a multiple of the AES block size.`);
  }
  const decipher = createDecipheriv(AES_ALGORITHM[material.aes], aesKey(material), iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(stored), decipher.final()]);
}

/** Decrypt an encrypted metadata block payload (AES-ECB, no padding). */
export function decryptMacriumMetadata(stored: Buffer, material: MacriumKeyMaterial): Buffer {
  if (stored.length === 0 || stored.length % 16 !== 0) {
    throw new Error(`Macrium encrypted metadata length ${stored.length} is not a multiple of the AES block size.`);
  }
  const decipher = createDecipheriv(
    material.aes === 10 ? 'aes-128-ecb' : material.aes === 12 ? 'aes-192-ecb' : 'aes-256-ecb',
    aesKey(material),
    null
  );
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(stored), decipher.final()]);
}

/**
 * Length of the first zstd frame in `buf`, or undefined when it is not a
 * valid frame. Encrypted-then-compressed blocks are zero-padded to the AES
 * block size, so the stored length is a few bytes longer than the frame.
 */
export function zstdFrameLength(buf: Buffer): number | undefined {
  if (buf.length < 5) return undefined;
  if (buf.readUInt32LE(0) !== 0xfd2fb528) return undefined;
  const descriptor = buf[4];
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictIdFlag = descriptor & 3;
  let pos = 5;
  if (!singleSegment) pos += 1; // window descriptor
  pos += [0, 1, 2, 4][dictIdFlag];
  pos += singleSegment ? [1, 2, 4, 8][contentSizeFlag] : [0, 2, 4, 8][contentSizeFlag];
  for (;;) {
    if (pos + 3 > buf.length) return undefined;
    const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    pos += 3;
    if (type === 3) return undefined; // reserved block type
    pos += type === 1 ? 1 : size; // RLE blocks carry one byte
    if (last) break;
  }
  if (hasChecksum) pos += 4;
  return pos <= buf.length ? pos : undefined;
}

/**
 * Derived keys for unlocked images, keyed by image path. Key material is
 * deliberately kept out of `MacriumImageInfo` so it can never be serialized
 * to the renderer or written into a log/result file.
 */
const keyByImage = new Map<string, MacriumKeyMaterial>();

export function setMacriumKey(imagePath: string, material: MacriumKeyMaterial): void {
  keyByImage.set(imagePath, material);
}

export function getMacriumKey(imagePath: string): MacriumKeyMaterial | undefined {
  return keyByImage.get(imagePath);
}

/** Drop every cached key (and zero the buffers where possible). */
export function clearMacriumKeys(): void {
  for (const material of keyByImage.values()) {
    material.key.fill(0);
  }
  keyByImage.clear();
}
