import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadHeader, resolveRepoKey, type RepoKeyOptions } from '../imaging/repository';
import { appendFileCatalogRecord } from './catalog';
import {
  chunkAad,
  decryptBuffer,
  deriveFileKeys,
  objectPath,
  sha256
} from './crypto';
import { writeFileReport } from './manifest';
import {
  assertRealPathInside,
  movePath,
  pathsOverlap,
  resolveWithinTarget,
  safeSegment,
  toPosix
} from './paths';
import {
  DEFAULT_MAX_DELETE_BYTES,
  DEFAULT_MAX_DELETE_FILES,
  type FileMirrorDeletionPolicy,
  type FileMirrorReport,
  type FileSnapshotEntry,
  type FileSnapshotManifest
} from './types';

/**
 * One-way mirror. This is never a two-way sync: the snapshot is the single
 * source of truth and the destination is made to match it. Planning is the
 * default; applying requires an explicit opt-in, and deletions additionally
 * require an explicit allowance plus recovery through quarantine.
 */
export interface FileMirrorOptions extends RepoKeyOptions {
  repoDir: string;
  manifest: FileSnapshotManifest;
  target: string;
  apply?: boolean;
  allowDeletes?: boolean;
  confirmDeletes?: boolean;
  deletions?: FileMirrorDeletionPolicy;
  stagingPath?: string;
  quarantinePath?: string;
  maxDeleteFiles?: number;
  maxDeleteBytes?: number;
  /** Pre-resolved repository key; otherwise resolved from keyfile/passphrase. */
  repoKey?: Buffer;
  onProgress?: (phase: 'mirroring', currentPath: string) => void;
  isCancelled?: () => boolean;
}

interface TargetEntry {
  path: string;
  kind: 'file' | 'symlink';
  size: number;
  sha256: string;
}

export async function runFileMirror(opts: FileMirrorOptions): Promise<FileMirrorReport> {
  const manifest = opts.manifest;
  const target = path.resolve(opts.target);
  const policy = opts.deletions ?? 'off';
  const apply = opts.apply === true;
  const maxDeleteFiles = opts.maxDeleteFiles ?? DEFAULT_MAX_DELETE_FILES;
  const maxDeleteBytes = opts.maxDeleteBytes ?? DEFAULT_MAX_DELETE_BYTES;
  const problems: string[] = [];
  const report: FileMirrorReport = {
    ok: true,
    dryRun: !apply,
    applied: false,
    snapshotId: manifest.id,
    target,
    policy,
    deletionsAllowed: opts.allowDeletes === true && policy === 'quarantine',
    confirmationRequired: false,
    added: [],
    changed: [],
    deleted: [],
    replaced: [],
    quarantined: 0,
    thresholds: { maxDeleteFiles, maxDeleteBytes },
    problems
  };

  const runId = crypto.randomUUID();
  const stagingRoot = path.resolve(
    opts.stagingPath ?? siblingPath(target, 'stage', manifest.id)
  );
  const quarantineRoot = path.resolve(
    opts.quarantinePath ?? siblingPath(target, 'quarantine', manifest.id)
  );
  validatePaths(opts.repoDir, manifest, target, stagingRoot, quarantineRoot, apply);

  const expected = expectedEntries(manifest);
  const targetEntries = scanTarget(target);

  for (const [relative, expectedEntry] of expected) {
    const actual = targetEntries.get(relative);
    if (!actual) {
      report.added.push({ path: relative, action: 'add', size: expectedEntry.size });
    } else if (actual.sha256 !== expectedEntry.sha256 || actual.size !== expectedEntry.size) {
      report.changed.push({ path: relative, action: 'change', size: expectedEntry.size });
    }
  }
  for (const [relative, actual] of targetEntries) {
    if (!expected.has(relative)) {
      report.deleted.push({ path: relative, action: 'delete', size: actual.size });
    }
  }

  const deleteBytes = report.deleted.reduce((sum, change) => sum + change.size, 0);
  report.confirmationRequired =
    report.deleted.length > maxDeleteFiles || deleteBytes > maxDeleteBytes;

  if (report.deleted.length > 0 && !report.deletionsAllowed) {
    problems.push(
      `Mirror would remove ${report.deleted.length} destination item(s), but deletions are disabled. ` +
        'Use deletions="quarantine" and explicitly allow deletions.'
    );
  }
  if (apply && report.confirmationRequired && opts.confirmDeletes !== true) {
    problems.push(
      `Mirror deletions exceed the safety threshold (${maxDeleteFiles} files / ${maxDeleteBytes} bytes). ` +
        'Pass --confirm-deletes to proceed.'
    );
  }
  if (apply && problems.length > 0) {
    report.ok = false;
    return report;
  }
  if (!apply) return report;

  const repoKey = opts.repoKey ?? resolveRepoKey(loadHeader(opts.repoDir), opts);
  const keys = deriveFileKeys(repoKey);
  const targetReal = ensureTargetAndRealPath(target);
  if (fs.existsSync(stagingRoot)) {
    throw new Error(`Mirror staging path already exists: ${stagingRoot}`);
  }
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagingReal = fs.realpathSync.native(stagingRoot);

  try {
    const fileChanges = [...report.added, ...report.changed].filter((change) => {
      const entry = expected.get(change.path);
      return entry?.kind === 'file';
    });
    for (const change of fileChanges) {
      checkCancelled(opts.isCancelled);
      opts.onProgress?.('mirroring', change.path);
      const entry = expected.get(change.path);
      if (!entry || entry.kind !== 'file') continue;
      const stagedFile = resolveWithinTarget(stagingRoot, change.path);
      fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
      assertRealPathInside(stagingReal, stagedFile);
      writeStagedFile(entry, opts.repoDir, keys.enc, stagedFile);
    }

    // Create directories before moving files. Empty directories in the source
    // are reproduced too, but no destination directory is removed by a mirror.
    for (const entry of manifest.entries) {
      if (entry.kind !== 'dir' || entry.skipped) continue;
      const dir = resolveWithinTarget(target, entry.path);
      assertRealPathInside(targetReal, path.join(dir, '.opbs-probe'));
      fs.mkdirSync(dir, { recursive: true });
    }

    const quarantineDir = path.join(quarantineRoot, runId);
    fs.mkdirSync(quarantineDir, { recursive: true });

    for (const change of report.changed) {
      checkCancelled(opts.isCancelled);
      const existing = resolveWithinTarget(target, change.path);
      if (!lstatExists(existing)) continue;
      report.replaced.push({ ...change, action: 'replace' });
      movePath(existing, resolveWithinTarget(quarantineDir, path.join('replaced', change.path)));
    }
    for (const change of report.deleted) {
      checkCancelled(opts.isCancelled);
      const existing = resolveWithinTarget(target, change.path);
      if (!lstatExists(existing)) continue;
      movePath(existing, resolveWithinTarget(quarantineDir, path.join('deleted', change.path)));
    }

    for (const change of fileChanges) {
      checkCancelled(opts.isCancelled);
      const stagedFile = resolveWithinTarget(stagingRoot, change.path);
      const destination = resolveWithinTarget(target, change.path);
      assertRealPathInside(targetReal, destination);
      movePath(stagedFile, destination);
    }
    for (const change of report.changed) {
      const entry = expected.get(change.path);
      if (!entry || entry.kind !== 'symlink' || !entry.linkTarget) continue;
      const destination = resolveWithinTarget(target, change.path);
      assertRealPathInside(targetReal, destination);
      fs.symlinkSync(entry.linkTarget, destination);
    }
    for (const change of report.added) {
      const entry = expected.get(change.path);
      if (!entry || entry.kind !== 'symlink' || !entry.linkTarget) continue;
      const destination = resolveWithinTarget(target, change.path);
      assertRealPathInside(targetReal, destination);
      fs.symlinkSync(entry.linkTarget, destination);
    }

    report.quarantined = report.replaced.length + report.deleted.length;
    const reportName = `mirror-${manifest.id}-${runId}.json`;
    report.reportPath = writeFileReport(opts.repoDir, reportName, report);
    const at = new Date().toISOString();
    const targetKey = sha256(path.resolve(target));
    const keysCatalog = keys;
    appendFileCatalogRecord(
      opts.repoDir,
      {
        type: 'mirror',
        at,
        id: manifest.id,
        targetKey,
        run: runId,
        report: reportName,
        policy,
        dryRun: false,
        added: report.added.length,
        changed: report.changed.length,
        deleted: report.deleted.length,
        quarantined: report.quarantined
      },
      keysCatalog.catalog
    );
    appendFileCatalogRecord(
      opts.repoDir,
      {
        type: 'mirror-state',
        at,
        id: manifest.id,
        targetKey,
        run: runId,
        report: reportName
      },
      keysCatalog.catalog
    );
    report.applied = true;
  } finally {
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      /* best effort; staging never holds unique data */
    }
  }

  return report;
}

function checkCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new Error('File mirror cancelled');
}

function siblingPath(target: string, kind: 'stage' | 'quarantine', id: string): string {
  const resolved = path.resolve(target);
  const name = safeSegment(resolved, 'mirror-target');
  return path.join(path.dirname(resolved), `.${name}.opbs-${kind}-${id}`);
}

function validatePaths(
  repoDir: string,
  manifest: FileSnapshotManifest,
  target: string,
  staging: string,
  quarantine: string,
  apply: boolean
): void {
  if (pathsOverlap(target, repoDir)) {
    throw new Error('Mirror target must not overlap the backup repository');
  }
  for (const source of manifest.sources) {
    if (pathsOverlap(target, source.path)) {
      throw new Error('Mirror target must not overlap a backup source');
    }
    if (apply && (pathsOverlap(staging, source.path) || pathsOverlap(quarantine, source.path))) {
      throw new Error('Mirror staging/quarantine must not overlap a backup source');
    }
  }
  if (pathsOverlap(target, staging) || pathsOverlap(target, quarantine)) {
    throw new Error('Mirror staging and quarantine must be outside the target');
  }
  if (pathsOverlap(staging, quarantine) || pathsOverlap(staging, repoDir) || pathsOverlap(quarantine, repoDir)) {
    throw new Error('Mirror staging and quarantine must be outside each other and the repository');
  }
}

function expectedEntries(manifest: FileSnapshotManifest): Map<string, FileSnapshotEntry> {
  const expected = new Map<string, FileSnapshotEntry>();
  for (const entry of manifest.entries) {
    if (entry.skipped || entry.kind === 'dir') continue;
    expected.set(entry.path, entry);
  }
  return expected;
}

function scanTarget(target: string): Map<string, TargetEntry> {
  const found = new Map<string, TargetEntry>();
  if (!fs.existsSync(target)) return found;
  walk(target, '');
  return found;

  function walk(absoluteDir: string, relativeDir: string): void {
    for (const child of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir ? `${relativeDir}/${toPosix(child.name)}` : toPosix(child.name);
      const absolute = path.join(absoluteDir, child.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isSymbolicLink()) {
        let targetValue: string;
        try {
          targetValue = fs.readlinkSync(absolute);
        } catch {
          targetValue = '<unreadable>';
        }
        found.set(relative, { path: relative, kind: 'symlink', size: 0, sha256: sha256(targetValue) });
      } else if (stat.isFile()) {
        found.set(relative, {
          path: relative,
          kind: 'file',
          size: stat.size,
          sha256: hashFile(absolute)
        });
      }
    }
  }
}

function hashFile(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function ensureTargetAndRealPath(target: string): string {
  fs.mkdirSync(target, { recursive: true });
  return fs.realpathSync.native(target);
}

function lstatExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function writeStagedFile(entry: FileSnapshotEntry, repoDir: string, encKey: Buffer, destination: string): void {
  const tmp = `${destination}.opbs-stage-${process.pid}-${Date.now()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'w');
    const hash = crypto.createHash('sha256');
    for (const chunk of entry.chunks) {
      const blob = fs.readFileSync(objectPath(repoDir, chunk.sha256));
      const plaintext = decryptBuffer(blob, encKey, chunkAad(chunk.sha256));
      if (plaintext.length !== chunk.size || sha256(plaintext) !== chunk.sha256) {
        throw new Error(`Chunk ${chunk.sha256} does not match the snapshot manifest`);
      }
      fs.writeSync(fd, plaintext);
      hash.update(plaintext);
    }
    fs.closeSync(fd);
    fd = undefined;
    if (hash.digest('hex') !== entry.sha256) {
      throw new Error(`Staged file ${entry.path} does not match the snapshot manifest`);
    }
    fs.renameSync(tmp, destination);
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
