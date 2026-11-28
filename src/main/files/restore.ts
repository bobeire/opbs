import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadHeader, resolveRepoKey, type RepoKeyOptions } from '../imaging/repository';
import { chunkAad, decryptBuffer, deriveFileKeys, objectPath, sha256 } from './crypto';
import { readEncryptedManifest, writeFileReport } from './manifest';
import {
  assertRealPathInside,
  matchesAnyGlob,
  normalizeRelativePath,
  resolveWithinTarget,
  toPosix
} from './paths';
import type {
  FileOverwritePolicy,
  FileRestoreResult,
  FileSnapshotEntry
} from './types';

/** Restore one encrypted file snapshot to a plain destination folder. */
export interface RestoreFileSnapshotOptions extends RepoKeyOptions {
  repoDir: string;
  id: string;
  target: string;
  include?: readonly string[];
  overwrite?: FileOverwritePolicy;
  isCancelled?: () => boolean;
}

export function restoreFileSnapshot(opts: RestoreFileSnapshotOptions): FileRestoreResult {
  const target = path.resolve(opts.target);
  const repoDir = path.resolve(opts.repoDir);
  if (target === repoDir || target.startsWith(repoDir + path.sep)) {
    throw new Error('Restore target must not be inside the backup repository');
  }
  const overwrite = opts.overwrite ?? 'skip';
  const key = resolveRepoKey(loadHeader(repoDir), opts);
  const keys = deriveFileKeys(key);
  const { manifest } = readEncryptedManifest(repoDir, opts.id, keys.enc);
  fs.mkdirSync(target, { recursive: true });
  const targetReal = fs.realpathSync.native(target);
  const includes = (opts.include ?? []).map((pattern) => toPosix(pattern));

  const result: FileRestoreResult = {
    ok: true,
    snapshotId: manifest.id,
    target,
    restored: [],
    skipped: [],
    warnings: []
  };

  for (const entry of manifest.entries) {
    if (opts.isCancelled?.()) throw new Error('File restore cancelled');
    if (entry.skipped || entry.kind === 'dir') continue;
    if (includes.length > 0 && !matchesAnyGlob(entry.path, includes)) continue;

    const destination = resolveWithinTarget(target, entry.path);
    assertRealPathInside(targetReal, destination);

    if (entry.kind === 'symlink') {
      restoreSymlink(entry, destination, overwrite, targetReal, result);
      continue;
    }
    restoreFile(entry, destination, overwrite, repoDir, keys.enc, targetReal, result);
  }

  const reportName = `restore-${manifest.id}-${Date.now()}.json`;
  result.reportPath = writeFileReport(repoDir, reportName, result);
  return result;
}

function restoreFile(
  entry: FileSnapshotEntry,
  destination: string,
  overwrite: FileOverwritePolicy,
  repoDir: string,
  encKey: Buffer,
  targetReal: string,
  result: FileRestoreResult
): void {
  const decision = prepareDestination(destination, overwrite, targetReal, result);
  if (decision === 'skip') return;

  const tmp = `${destination}.opbs-restore-${process.pid}-${Date.now()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'w');
    const hash = crypto.createHash('sha256');
    for (const chunk of entry.chunks) {
      const blob = fs.readFileSync(objectPath(repoDir, chunk.sha256));
      const plaintext = decryptBuffer(blob, encKey, chunkAad(chunk.sha256));
      if (plaintext.length !== chunk.size || sha256(plaintext) !== chunk.sha256) {
        throw new Error(`Chunk ${chunk.sha256} does not match the manifest`);
      }
      fs.writeSync(fd, plaintext);
      hash.update(plaintext);
    }
    fs.closeSync(fd);
    fd = undefined;
    const actual = hash.digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`Restored file ${entry.path} failed its SHA-256 check`);
    }
    fs.renameSync(tmp, decision);
    const mtime = new Date(entry.mtime);
    if (!Number.isNaN(mtime.getTime())) fs.utimesSync(decision, mtime, mtime);
    result.restored.push(entry.path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function restoreSymlink(
  entry: FileSnapshotEntry,
  destination: string,
  overwrite: FileOverwritePolicy,
  targetReal: string,
  result: FileRestoreResult
): void {
  const linkTarget = entry.linkTarget;
  if (!linkTarget) {
    result.warnings.push(`${entry.path}: symlink target was not recorded; skipped`);
    return;
  }
  try {
    normalizeRelativePath(toPosix(linkTarget));
  } catch {
    result.warnings.push(`${entry.path}: absolute or unsafe symlink target skipped`);
    return;
  }
  const decision = prepareDestination(destination, overwrite, targetReal, result);
  if (decision === 'skip') return;
  try {
    fs.symlinkSync(linkTarget, decision);
    result.restored.push(entry.path);
  } catch (error) {
    result.warnings.push(`${entry.path}: could not create symlink: ${(error as Error).message}`);
  }
}

function prepareDestination(
  destination: string,
  overwrite: FileOverwritePolicy,
  targetReal: string,
  result: FileRestoreResult
): string | 'skip' {
  let exists: boolean;
  try {
    fs.lstatSync(destination);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    assertRealPathInside(targetReal, path.join(parent, '.opbs-probe'));
    return destination;
  }
  if (overwrite === 'skip') {
    result.skipped.push({ path: path.relative(targetReal, destination), reason: 'already exists' });
    return 'skip';
  }
  if (overwrite === 'rename') {
    const renamed = `${destination}.opbs-restored-${Date.now()}`;
    assertRealPathInside(targetReal, renamed);
    return renamed;
  }
  const stat = fs.lstatSync(destination);
  if (stat.isDirectory()) {
    result.skipped.push({ path: path.relative(targetReal, destination), reason: 'destination is a directory' });
    return 'skip';
  }
  assertRealPathInside(targetReal, destination);
  fs.rmSync(destination, { force: true });
  return destination;
}
