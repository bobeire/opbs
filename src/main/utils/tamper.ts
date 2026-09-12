import * as fs from 'fs';
import { scanBackupDirectory, manifestFilePath, BackupManifest } from '../backup/retention';

/**
 * Tamper / drift detection against the last-known-good manifest.
 *
 * The manifest (`opbs-manifest.json`) is rewritten after every backup and every
 * retention pass, so it is the best available snapshot of "what the backup set
 * is supposed to look like". Comparing the live directory to it catches silent
 * deletion (missing images), external modification (size changes), and injected
 * or renamed files (unexpected images) — the signature of a ransomware process
 * that also scrubbed the backup sidecars.
 */

export interface TamperDiff {
  /** Images listed in the manifest but gone from the directory. */
  missing: Array<{ name: string; manifestSize: number }>;
  /** Images present in both but with different sizes (modified). */
  sizeChanged: Array<{ name: string; manifestSize: number; diskSize: number }>;
  /** `.opbs` files on disk that the manifest does not know about. */
  unexpected: Array<{ name: string; size: number }>;
}

export interface TamperReport {
  directory: string;
  manifestPresent: boolean;
  manifestUpdatedAt?: string;
  /** True when no drift was detected (or consistent with the manifest). */
  ok: boolean;
  diff: TamperDiff;
}

export function readBackupManifest(dir: string): BackupManifest | null {
  const file = manifestFilePath(dir);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && Array.isArray(parsed.images) && typeof parsed.updatedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function detectTamper(dir: string): TamperReport {
  const manifest = readBackupManifest(dir);
  if (!manifest) {
    return {
      directory: dir,
      manifestPresent: false,
      ok: false,
      diff: { missing: [], sizeChanged: [], unexpected: [] }
    };
  }

  const onDisk = new Map(scanBackupDirectory(dir).map((e) => [e.name, e.size]));
  const manifestByName = new Map(manifest.images.map((i) => [i.name, i.size]));

  const missing: TamperDiff['missing'] = [];
  const sizeChanged: TamperDiff['sizeChanged'] = [];
  for (const [name, manifestSize] of manifestByName) {
    if (!onDisk.has(name)) {
      missing.push({ name, manifestSize });
    } else if (onDisk.get(name) !== manifestSize) {
      sizeChanged.push({ name, manifestSize, diskSize: onDisk.get(name)! });
    }
  }

  const unexpected: TamperDiff['unexpected'] = [];
  for (const [name, size] of onDisk) {
    if (!manifestByName.has(name)) {
      unexpected.push({ name, size });
    }
  }

  const diff: TamperDiff = { missing, sizeChanged, unexpected };
  return {
    directory: dir,
    manifestPresent: true,
    manifestUpdatedAt: manifest.updatedAt,
    ok: missing.length === 0 && sizeChanged.length === 0 && unexpected.length === 0,
    diff
  };
}