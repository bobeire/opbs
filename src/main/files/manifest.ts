import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomic-write';
import { decryptBuffer, encryptBuffer, fileRoots, manifestAad, sha256, snapshotPath } from './crypto';
import type { FileSnapshotManifest } from './types';

/** Encrypted, versioned manifest for one file snapshot. */

export interface EncodedManifest {
  plaintextSha256: string;
  encrypted: Buffer;
  encryptedSha256: string;
}

export function encodeManifest(manifest: FileSnapshotManifest, encKey: Buffer): EncodedManifest {
  const plaintext = Buffer.from(JSON.stringify(manifest), 'utf8');
  const encrypted = encryptBuffer(plaintext, encKey, manifestAad(manifest.id));
  return {
    plaintextSha256: sha256(plaintext),
    encrypted,
    encryptedSha256: sha256(encrypted)
  };
}

export function writeEncryptedManifest(
  repoDir: string,
  manifest: FileSnapshotManifest,
  encKey: Buffer
): EncodedManifest {
  const encoded = encodeManifest(manifest, encKey);
  const file = snapshotPath(repoDir, manifest.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, encoded.encrypted);
  return encoded;
}

export function readEncryptedManifest(
  repoDir: string,
  id: string,
  encKey: Buffer
): { manifest: FileSnapshotManifest; plaintextSha256: string; encryptedSha256: string } {
  const file = snapshotPath(repoDir, id);
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File snapshot not found: ${id}`, { cause: error });
    }
    throw error;
  }
  const plaintext = decryptBuffer(encrypted, encKey, manifestAad(id));
  let manifest: FileSnapshotManifest;
  try {
    manifest = JSON.parse(plaintext.toString('utf8')) as FileSnapshotManifest;
  } catch {
    throw new Error(`Corrupt manifest in file snapshot ${id}`);
  }
  if (manifest.format !== 'opbs-files/v1' || manifest.id !== id) {
    throw new Error(`File snapshot ${id} has a mismatched or unsupported manifest`);
  }
  return { manifest, plaintextSha256: sha256(plaintext), encryptedSha256: sha256(encrypted) };
}

export function writeFileReport(repoDir: string, name: string, report: unknown): string {
  const dir = fileRoots(repoDir).reports;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileAtomic(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}
