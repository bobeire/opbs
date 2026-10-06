import { createDecipheriv, createHash } from 'crypto';
import { loadNative } from '../../utils/native-loader';

/**
 * EFS (Encrypting File System) support: parsing the `$EFS` (logged utility
 * stream) attribute that names a file's decryption fields, unwrapping the file
 * encryption key (FEK) with a local private key, and decrypting the file's
 * `$DATA` stream sector by sector.
 *
 * Layout reference: ntfs-3g's `ntfsdecrypt.c` and the `$EFS` structures in its
 * `layout.h`. Parsing is deliberately defensive — the mere presence of the
 * attribute is what marks a file as encrypted, so malformed metadata must never
 * abort the read of an otherwise valid volume.
 */

/** Credential types recorded in an EFS credential header. */
const CRED_TYPE_CAPI_CONTAINER = 1;
const CRED_TYPE_CERT_THUMBPRINT = 3;

const EFS_HEADER_SIZE = 0x4c;
const EFS_DF_ARRAY_HEADER_SIZE = 4;
const EFS_DF_HEADER_SIZE = 0x14;
const EFS_SECTOR_SIZE = 512;

/** CALG identifiers used by EFS file encryption keys. */
const CALG_DESX = 0x6601;
const CALG_DES = 0x6602;
const CALG_3DES = 0x6603;
const CALG_AES_256 = 0x6610;

/** Per-sector IV constants (added to the byte offset of the sector). */
const AES_256_IV_LO = 0x5816657be9161312n;
const AES_256_IV_HI = 0x1989adbe44918961n;
const LEGACY_SECTOR_IV = 0x169119629891ad13n;

const ALGORITHMS: Record<number, { name: string; keyLength: number }> = {
  [CALG_DESX]: { name: 'desx', keyLength: 16 },
  [CALG_DES]: { name: 'des', keyLength: 8 },
  [CALG_3DES]: { name: 'des-ede3-cbc', keyLength: 24 },
  [CALG_AES_256]: { name: 'aes-256-cbc', keyLength: 32 }
};

/**
 * Raised when an EFS-encrypted file cannot be handed to the caller as
 * plaintext. Offline decryption needs the owning user's DPAPI-protected
 * private key; without it the ciphertext must never be presented as if it were
 * the file's contents.
 */
export class EfsEncryptedError extends Error {
  readonly code = 'EFS_ENCRYPTED';

  constructor(message: string) {
    super(message);
    this.name = 'EfsEncryptedError';
  }
}

/** One principal (file owner or recovery agent) recorded in a $EFS field. */
export interface EfsKeyEntry {
  /** User / container name recorded in the credential (may be empty). */
  name: string;
  /** SHA-1 thumbprint of the certificate that unwraps the FEK (lowercase hex). */
  thumbprint: string;
  /** RSA-wrapped file encryption key as stored in the field. */
  efek: Buffer;
  /** EFS credential type: 1 = CryptoAPI container, 3 = certificate thumbprint. */
  credentialType: number;
}

/** Decoded `$EFS` attribute: who may open the file and with which key. */
export interface EfsInfo {
  version: number;
  /** Data decryption fields (one per allowed principal). */
  entries: EfsKeyEntry[];
  /** Recovery fields (recovery agents), tried only after the DDFs fail. */
  recovery: EfsKeyEntry[];
}

/** An unwrapped file encryption key: the cipher id and raw key bytes. */
export interface EfsFileKey {
  algId: number;
  key: Buffer;
}

/** How many bytes of an encrypted extent are ciphertext vs plaintext. */
export interface EfsStreamSizes {
  /** Plaintext byte count to hand back to the caller. */
  plain: number;
  /** Ciphertext byte count to feed to the sector decryptor (multiple of 512). */
  cipher: number;
}

function readU32(buf: Buffer, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > buf.length) return undefined;
  return buf.readUInt32LE(offset);
}

function readUtf16z(buf: Buffer, offset: number, end: number): string {
  let out = '';
  for (let i = offset; i + 1 < Math.min(end, buf.length); i += 2) {
    const c = buf.readUInt16LE(i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function parseDf(
  buf: Buffer,
  df: number,
  dfLength: number,
  end: number
): EfsKeyEntry {
  const credOffset = readU32(buf, df + 4) ?? 0;
  const efekSize = readU32(buf, df + 8) ?? 0;
  const efekOffset = readU32(buf, df + 12) ?? 0;
  const dfEnd = Math.min(df + dfLength, end, buf.length);

  let name = '';
  let thumbprint = '';
  let credentialType = 0;

  const cred = df + credOffset;
  const credType = readU32(buf, cred + 8);
  if (credType !== undefined) {
    credentialType = credType;
    if (credType === CRED_TYPE_CERT_THUMBPRINT) {
      const certHeader = cred + (readU32(buf, cred + 16) ?? 0);
      const thumbOffset = readU32(buf, certHeader) ?? 0;
      const thumbSize = readU32(buf, certHeader + 4) ?? 0;
      const userNameOffset = readU32(buf, certHeader + 16) ?? 0;
      if (thumbSize > 0 && thumbSize <= 64 && certHeader + thumbOffset + thumbSize <= buf.length) {
        thumbprint = buf.toString('hex', certHeader + thumbOffset, certHeader + thumbOffset + thumbSize);
      }
      if (userNameOffset > 0) {
        name = readUtf16z(buf, certHeader + userNameOffset, Math.min(dfEnd + 64, buf.length));
      }
    } else if (credType === CRED_TYPE_CAPI_CONTAINER) {
      const containerOffset = readU32(buf, cred + 12) ?? 0;
      if (containerOffset > 0) name = readUtf16z(buf, cred + containerOffset, buf.length);
    }
  }

  const efek =
    efekSize > 0 && df + efekOffset >= 0 && df + efekOffset + efekSize <= buf.length
      ? Buffer.from(buf.subarray(df + efekOffset, df + efekOffset + efekSize))
      : Buffer.alloc(0);

  return { name, thumbprint, efek, credentialType };
}

function parseDfArray(buf: Buffer, arrayOffset: number, end: number): EfsKeyEntry[] {
  const out: EfsKeyEntry[] = [];
  if (arrayOffset < EFS_HEADER_SIZE || arrayOffset + EFS_DF_ARRAY_HEADER_SIZE > end) return out;
  const count = buf.readUInt32LE(arrayOffset);
  if (count === 0 || count > 1024) return out;
  let pos = arrayOffset + EFS_DF_ARRAY_HEADER_SIZE;
  for (let i = 0; i < count && pos + EFS_DF_HEADER_SIZE <= end; i++) {
    const dfLength = buf.readUInt32LE(pos);
    if (dfLength < EFS_DF_HEADER_SIZE || pos + dfLength > end) break;
    out.push(parseDf(buf, pos, dfLength, end));
    pos += dfLength;
  }
  return out;
}

/**
 * Parse the value of an `$EFS` attribute (type 0x100). Returns empty metadata
 * for anything that does not look like a well-formed blob.
 */
export function parseEfsAttribute(value: Buffer): EfsInfo {
  const empty: EfsInfo = { version: 0, entries: [], recovery: [] };
  if (value.length < EFS_HEADER_SIZE) return empty;
  const declaredLength = value.readUInt32LE(0);
  const version = value.readUInt32LE(8);
  const end = declaredLength >= EFS_HEADER_SIZE && declaredLength <= value.length ? declaredLength : value.length;
  return {
    version,
    entries: parseDfArray(value, value.readUInt32LE(64), end),
    recovery: parseDfArray(value, value.readUInt32LE(68), end)
  };
}

/** Look up the local EFS key container that unwraps a thumbprint's EFEK. */
export function unwrapFek(thumbprint: string, efek: Buffer): Buffer {
  const native = loadNative<{ unwrapEfsFek?: (thumbprint: string, efek: Buffer) => Buffer }>();
  if (typeof native.unwrapEfsFek !== 'function') {
    throw new Error('native module does not provide EFS key unwrapping');
  }
  return native.unwrapEfsFek(thumbprint, efek);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Obtain the plaintext file encryption key for a file, trying every data
 * decryption field (and finally the recovery fields). Throws
 * `EfsEncryptedError` when no local private key matches, which is the normal
 * case for images taken from other machines.
 */
export function obtainFileKey(info: EfsInfo, label: string): EfsFileKey {
  const candidates = [...info.entries, ...info.recovery];
  if (candidates.length === 0) {
    throw new EfsEncryptedError(
      `"${label}" is EFS-encrypted but its $EFS attribute lists no decryption fields`
    );
  }
  const failures: string[] = [];
  for (const entry of candidates) {
    if (!entry.thumbprint) {
      failures.push(`${entry.name || 'entry'}: unsupported credential type ${entry.credentialType}`);
      continue;
    }
    if (entry.efek.length === 0) {
      failures.push(`${entry.name || entry.thumbprint}: missing wrapped key`);
      continue;
    }
    try {
      return parseFek(unwrapFek(entry.thumbprint, entry.efek));
    } catch (err) {
      failures.push(`${entry.name || entry.thumbprint}: ${errorMessage(err)}`);
    }
  }
  throw new EfsEncryptedError(
    `"${label}" is EFS-encrypted and no local private key can unwrap its file encryption key ` +
      `(${failures.join('; ')})`
  );
}

/** Decode the plaintext FEK produced by the RSA unwrap. */
export function parseFek(fek: Buffer): EfsFileKey {
  if (fek.length < 16) throw new Error('EFS file encryption key is truncated');
  const keyLength = fek.readUInt32LE(0);
  const algId = fek.readUInt32LE(8);
  const algorithm = ALGORITHMS[algId];
  if (!algorithm) throw new Error(`unsupported EFS cipher algorithm 0x${algId.toString(16)}`);
  if (keyLength !== algorithm.keyLength) {
    throw new Error(`EFS key length ${keyLength} does not match ${algorithm.name}`);
  }
  if (16 + keyLength > fek.length) throw new Error('EFS file encryption key is truncated');
  return { algId, key: Buffer.from(fek.subarray(16, 16 + keyLength)) };
}

function roundUp512(value: number): number {
  return Math.ceil(value / EFS_SECTOR_SIZE) * EFS_SECTOR_SIZE;
}

/**
 * Decide how much of an encrypted `$DATA` extent is ciphertext and how many
 * plaintext bytes it decodes to.
 *
 * Windows and ntfs-3g have both been observed to describe an encrypted stream
 * in one of two ways, and neither is observable through the driver (it reports
 * the plaintext size to `stat`), so both are handled:
 *
 * - `data_size` spans the ciphertext plus a trailing `uint16` padding count
 *   (the extent is then `data_size ≡ 2 (mod 512)`); the padding tells us how
 *   many bytes of the last sector are zero padding rather than file data.
 * - `data_size` is the plaintext length itself and `initialized_size` holds the
 *   ciphertext extent.
 *
 * When `initialized_size` is known it decides which of the two applies.
 *
 * @param raw             bytes read from the runlist (or the resident value)
 * @param dataSize        `$DATA` data_size
 * @param initializedSize `$DATA` initialized_size, when the record carried one
 */
export function efsStreamSizes(
  raw: Buffer,
  dataSize: number,
  initializedSize?: number
): EfsStreamSizes {
  const data = Math.max(0, Math.floor(dataSize));
  const init = initializedSize === undefined ? undefined : Math.max(0, Math.floor(initializedSize));

  // Plaintext-length convention: data_size is the plain count and the extent
  // holds roundUp(data_size, 512) ciphertext bytes.
  if (init !== undefined && data < init) {
    return { plain: data, cipher: Math.min(roundUp512(data), raw.length) };
  }
  // Raw-extent convention: the trailing uint16 at data_size - 2 is the number
  // of padding bytes at the end of the last sector.
  if (data % EFS_SECTOR_SIZE === 2 && raw.length >= data) {
    const pad = raw.readUInt16LE(data - 2);
    return { plain: Math.max(0, data - 2 - pad), cipher: data - 2 };
  }
  return { plain: data, cipher: Math.min(roundUp512(data), raw.length) };
}

function le64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt.asUintN(64, value));
  return buf;
}

/**
 * Decrypt `cipherLength` ciphertext bytes into `plainLength` plaintext bytes.
 * Sectors are independent: each 512-byte block is decrypted with an IV derived
 * from its offset in the stream, and the sectors are not PKCS-padded.
 */
export function decryptEfsStream(
  raw: Buffer,
  cipherLength: number,
  plainLength: number,
  key: EfsFileKey
): Buffer {
  if (cipherLength % EFS_SECTOR_SIZE !== 0) {
    throw new Error(`EFS ciphertext length ${cipherLength} is not a multiple of ${EFS_SECTOR_SIZE}`);
  }
  if (plainLength > cipherLength) {
    throw new Error(`EFS plaintext length ${plainLength} exceeds ciphertext length ${cipherLength}`);
  }
  if (raw.length < cipherLength) {
    throw new Error(`EFS ciphertext is truncated (${raw.length} of ${cipherLength} bytes)`);
  }
  const out = Buffer.alloc(cipherLength);
  const sector = Buffer.alloc(EFS_SECTOR_SIZE);
  for (let offset = 0; offset < cipherLength; offset += EFS_SECTOR_SIZE) {
    raw.copy(sector, 0, offset, offset + EFS_SECTOR_SIZE);
    decryptSector(sector, offset, key);
    sector.copy(out, offset);
  }
  return out.subarray(0, plainLength);
}

function decryptSector(sector: Buffer, offset: number, key: EfsFileKey): void {
  switch (key.algId) {
    case CALG_AES_256: {
      const iv = Buffer.concat([le64(AES_256_IV_LO + BigInt(offset)), le64(AES_256_IV_HI + BigInt(offset))]);
      if (!applyCbc('aes-256-cbc', key.key, iv, sector)) {
        throw new Error('aes-256-cbc is unavailable in this runtime');
      }
      return;
    }
    case CALG_3DES: {
      const iv = BigInt.asUintN(64, LEGACY_SECTOR_IV + BigInt(offset));
      if (!applyCbc('des-ede3-cbc', key.key, le64(iv), sector)) {
        cbcDecrypt(ede3Decrypt, key.key, iv, sector);
      }
      return;
    }
    case CALG_DES: {
      const iv = BigInt.asUintN(64, LEGACY_SECTOR_IV + BigInt(offset));
      cbcDecrypt(desDecrypt, key.key, iv, sector);
      return;
    }
    case CALG_DESX: {
      desxDecrypt(sector, BigInt.asUintN(64, LEGACY_SECTOR_IV + BigInt(offset)), key.key);
      return;
    }
    default:
      throw new Error(`unsupported EFS cipher algorithm 0x${key.algId.toString(16)}`);
  }
}

function applyCbc(algorithm: string, key: Buffer, iv: Buffer, data: Buffer): boolean {
  try {
    const decipher = createDecipheriv(algorithm, key, iv);
    decipher.setAutoPadding(false);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    out.copy(data);
    return true;
  } catch {
    return false;
  }
}

function cbcDecrypt(
  blockDecrypt: (key: Buffer, block: bigint) => bigint,
  key: Buffer,
  iv: bigint,
  data: Buffer
): void {
  let previous = BigInt.asUintN(64, iv);
  for (let offset = 0; offset < data.length; offset += 8) {
    const current = data.readBigUInt64LE(offset);
    data.writeBigUInt64LE(BigInt.asUintN(64, blockDecrypt(key, current) ^ previous), offset);
    previous = current;
  }
}

/**
 * EFS's DESX variant: each block is whitened, run through a DES encryption
 * (EFS inverts the usual direction on disk), whitened again and chained. The
 * chain runs across the sector; the sector IV is applied to its first block.
 */
function desxDecrypt(data: Buffer, iv: bigint, onDiskKey: Buffer): void {
  const { desKey, outWhitening, inWhitening } = expandDesx(onDiskKey);
  let previous = 0n;
  for (let offset = 0; offset < data.length; offset += 8) {
    const current = data.readBigUInt64LE(offset);
    let value = desEncrypt(desKey, current ^ outWhitening) ^ inWhitening ^ previous;
    if (offset === 0) value ^= iv;
    data.writeBigUInt64LE(BigInt.asUintN(64, value), offset);
    previous = current;
  }
}

/** Expand EFS's 128-bit on-disk DESX key to the DES key plus whitening keys. */
export function expandDesx(onDiskKey: Buffer): { desKey: Buffer; outWhitening: bigint; inWhitening: bigint } {
  if (onDiskKey.length !== 16) throw new Error(`DESX key must be 16 bytes, got ${onDiskKey.length}`);
  const salt1 = Buffer.from('Dan Simon  \0', 'latin1');
  const salt2 = Buffer.from('Scott Field\0', 'latin1');
  const withSalt1 = createHash('md5').update(Buffer.concat([onDiskKey, salt1])).digest();
  const withSalt2 = createHash('md5').update(Buffer.concat([onDiskKey, salt2])).digest();
  const desKey = Buffer.alloc(8);
  desKey.writeUInt32LE(((withSalt1.readUInt32LE(0) ^ withSalt1.readUInt32LE(4)) >>> 0), 0);
  desKey.writeUInt32LE(((withSalt1.readUInt32LE(8) ^ withSalt1.readUInt32LE(12)) >>> 0), 4);
  return {
    desKey,
    outWhitening: withSalt2.readBigUInt64LE(0),
    inWhitening: withSalt2.readBigUInt64LE(8)
  };
}

function ede3Decrypt(key: Buffer, block: bigint): bigint {
  if (key.length !== 24) throw new Error('3DES key must be 24 bytes');
  const k1 = key.subarray(0, 8);
  const k2 = key.subarray(8, 16);
  const k3 = key.subarray(16, 24);
  return desEncrypt(k1, desDecrypt(k2, desEncrypt(k3, block)));
}

/** Single DES decryption of one 64-bit block. */
export function desDecrypt(key: Buffer, block: bigint): bigint {
  return desBlock(key, block, true);
}

/** Single DES encryption of one 64-bit block (EFS decrypts with this). */
export function desEncrypt(key: Buffer, block: bigint): bigint {
  return desBlock(key, block, false);
}

// ---------------------------------------------------------------------------
// DES (the single-DES primitive). Node's OpenSSL build does not ship the
// legacy single-DES provider, so the block cipher is implemented here; it is
// exercised by known-answer tests against ntfs-3g's vectors and against
// OpenSSL's 3DES with all three keys equal (which reduces to single DES).
// ---------------------------------------------------------------------------

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
];
const EXPANSION = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
];
const PERMUTATION = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
];
const KEY_PERMUTATION_1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
];
const KEY_PERMUTATION_2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
];
const KEY_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const S_BOXES = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11
  ]
];

function permute(value: bigint, table: readonly number[], inputBits: number): bigint {
  let out = 0n;
  for (let i = 0; i < table.length; i++) {
    const bit = (value >> BigInt(inputBits - table[i])) & 1n;
    out |= bit << BigInt(table.length - 1 - i);
  }
  return out;
}

function roundKeys(key: Buffer, decrypt: boolean): bigint[] {
  if (key.length !== 8) throw new Error('DES key must be 8 bytes');
  const permuted = permute(key.readBigUInt64BE(0), KEY_PERMUTATION_1, 64);
  let c = (permuted >> 28n) & 0xfffffffn;
  let d = permuted & 0xfffffffn;
  const keys: bigint[] = [];
  for (const shift of KEY_SHIFTS) {
    c = ((c << BigInt(shift)) | (c >> BigInt(28 - shift))) & 0xfffffffn;
    d = ((d << BigInt(shift)) | (d >> BigInt(28 - shift))) & 0xfffffffn;
    keys.push(permute((c << 28n) | d, KEY_PERMUTATION_2, 56));
  }
  return decrypt ? keys.reverse() : keys;
}

function feistel(right: bigint, subkey: bigint): bigint {
  const expanded = permute(right, EXPANSION, 32) ^ subkey;
  let substituted = 0n;
  for (let box = 0; box < 8; box++) {
    const chunk = Number((expanded >> BigInt(42 - 6 * box)) & 0x3fn);
    const row = ((chunk & 0x20) >> 4) | (chunk & 1);
    const column = (chunk >> 1) & 0x0f;
    substituted |= BigInt(S_BOXES[box][row * 16 + column]) << BigInt(28 - 4 * box);
  }
  return permute(substituted, PERMUTATION, 32);
}

function desBlock(key: Buffer, block: bigint, decrypt: boolean): bigint {
  const initial = permute(BigInt.asUintN(64, block), IP, 64);
  let left = initial >> 32n;
  let right = initial & 0xffffffffn;
  for (const subkey of roundKeys(key, decrypt)) {
    const next = left ^ feistel(right, subkey);
    left = right;
    right = next;
  }
  return permute(BigInt.asUintN(64, (right << 32n) | left), FP, 64);
}
