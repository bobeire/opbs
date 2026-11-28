import * as crypto from 'crypto';
import * as path from 'path';
import { FILE_CHUNK_FORMAT } from './types';

/**
 * File-snapshot crypto uses the repository key, but under domain-separated
 * subkeys. Nothing here reads or writes an `ImageHeader`; file snapshots are a
 * distinct format and are never accepted by the disk restore path.
 */
export interface FileKeys {
  /** AES-256-GCM key for chunk and manifest payloads. */
  enc: Buffer;
  /** HMAC-SHA256 key for the append-only file catalog. */
  catalog: Buffer;
}

export function deriveFileKeys(repoKey: Buffer): FileKeys {
  return {
    enc: crypto.createHmac('sha256', repoKey).update('opbs-files/enc/v1').digest(),
    catalog: crypto.createHmac('sha256', repoKey).update('opbs-files/catalog/v1').digest()
  };
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function chunkAad(sha256Hex: string): string {
  return `opbs-files-chunk-v${FILE_CHUNK_FORMAT}:${sha256Hex}`;
}

export function manifestAad(id: string): string {
  return `opbs-files-manifest-v1:${id}`;
}

/**
 * Encrypted blob layout: 1 version byte | 12-byte IV | 16-byte GCM tag |
 * ciphertext. The AAD binds a blob to its content-addressed name, so the same
 * key can decrypt a chunk from any snapshot without reusing an IV.
 */
export function encryptBuffer(data: Buffer, key: Buffer, aad: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([FILE_CHUNK_FORMAT]), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBuffer(blob: Buffer, key: Buffer, aad: string): Buffer {
  if (blob.length < 29) throw new Error('Truncated encrypted file-snapshot blob');
  if (blob[0] !== FILE_CHUNK_FORMAT) {
    throw new Error(`Unsupported encrypted file-snapshot blob version: ${blob[0]}`);
  }
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ciphertext = blob.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Encrypted file-snapshot blob failed authentication (corrupt or wrong key)');
  }
}

export function fileRoots(repoDir: string): {
  files: string;
  catalog: string;
  snapshots: string;
  objects: string;
  reports: string;
  staging: string;
  quarantine: string;
} {
  const files = path.join(repoDir, 'files');
  return {
    files,
    catalog: path.join(files, 'catalog'),
    snapshots: path.join(files, 'snapshots'),
    objects: path.join(files, 'objects'),
    reports: path.join(files, 'reports'),
    staging: path.join(files, 'staging'),
    quarantine: path.join(files, 'quarantine')
  };
}

export function objectPath(repoDir: string, sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) throw new Error(`Invalid chunk hash: ${sha256Hex}`);
  return path.join(fileRoots(repoDir).objects, sha256Hex.slice(0, 2), `${sha256Hex.toLowerCase()}.chunk`);
}

export function snapshotPath(repoDir: string, id: string): string {
  assertSnapshotId(id);
  return path.join(fileRoots(repoDir).snapshots, `${id}.opbsfiles`);
}

export function assertSnapshotId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid file snapshot id: ${id}`);
  }
}
