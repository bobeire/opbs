import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomic-write';
import { loadHeader, resolveRepoKey, type RepoKeyOptions } from '../imaging/repository';
import { validateFileBackupConfig } from './config';
import { appendFileCatalogRecord } from './catalog';
import {
  chunkAad,
  deriveFileKeys,
  encryptBuffer,
  fileRoots,
  objectPath,
  sha256,
  snapshotPath
} from './crypto';
import { writeEncryptedManifest } from './manifest';
import { runFileMirror } from './mirror';
import {
  matchesAnyGlob,
  normalizeRelativePath,
  safeSegment,
  toPosix
} from './paths';
import {
  DEFAULT_FILE_CHUNK_SIZE,
  FILE_SNAPSHOT_FORMAT,
  type FileBackupConfig,
  type FileBackupProgress,
  type FileBackupResult,
  type FileChunkRef,
  type FileMirrorDeletionPolicy,
  type FileMirrorReport,
  type FileSnapshotEntry,
  type FileSnapshotManifest,
  type FileSnapshotWarning
} from './types';

const MS_PER_DAY = 86_400_000;
const ENCRYPTED_OVERHEAD = 1 + 12 + 16;

interface PendingEntry extends FileSnapshotEntry {
  sourcePath?: string;
}

interface SourceDescriptor {
  label: string;
  path: string;
}

export interface RunFileBackupOptions extends RepoKeyOptions {
  dryRun?: boolean;
  /** Overrides the config's mirror destination, if any. */
  mirrorTarget?: string;
  applyMirror?: boolean;
  allowDeletes?: boolean;
  confirmDeletes?: boolean;
  deletions?: FileMirrorDeletionPolicy;
  stagingPath?: string;
  quarantinePath?: string;
  maxDeleteFiles?: number;
  maxDeleteBytes?: number;
  onProgress?: (progress: FileBackupProgress) => void;
  isCancelled?: () => boolean;
}

/** Create one encrypted, content-addressed, versioned file snapshot. */
export async function runFileBackup(
  input: unknown,
  opts: RunFileBackupOptions = {}
): Promise<FileBackupResult> {
  const config = validateFileBackupConfig(input);
  const header = loadHeader(config.repo);
  const repoKey = resolveRepoKey(header, opts);
  const keys = deriveFileKeys(repoKey);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const sources = describeSources(config);
  const warnings: FileSnapshotWarning[] = [];
  const pending: PendingEntry[] = [];
  const progress = opts.onProgress;

  const emit = (
    phase: FileBackupProgress['phase'],
    bytesDone: number,
    totalBytes: number,
    currentPath: string
  ): void => {
    progress?.({
      phase,
      percent: totalBytes > 0 ? Math.min(100, (bytesDone / totalBytes) * 100) : 100,
      bytesDone,
      totalBytes,
      currentPath
    });
  };

  emit('preparing', 0, 0, '');

  for (const source of sources) {
    const stat = fs.statSync(source.path);
    if (stat.isDirectory()) {
      pending.push(directoryEntry(source.label, source.label, stat.mtimeMs, stat.mode));
      walkDirectory(source.path, source.label, '', config.excludes ?? [], pending, warnings);
    } else {
      pending.push({
        path: source.label,
        kind: 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        mode: stat.mode & 0o777,
        sha256: '',
        chunks: [],
        sourcePath: source.path
      });
    }
  }

  const totalBytes = pending.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0);
  const storeState = { bytesRead: 0, storedBytes: 0, uniqueChunks: new Set<string>() };
  const entries: FileSnapshotEntry[] = [];
  let filesRead = 0;

  emit('scanning', 0, totalBytes, '');

  for (const item of pending) {
    checkCancelled(opts.isCancelled);
    if (item.kind !== 'file') {
      entries.push(toManifestEntry(item));
      continue;
    }
    const outcome = await readFileEntry(
      item,
      config,
      config.repo,
      keys.enc,
      opts.dryRun === true,
      storeState,
      warnings,
      emit,
      totalBytes,
      opts.isCancelled
    );
    if (outcome.entry) {
      const entry = toManifestEntry(outcome.entry);
      entries.push(entry);
      if (!entry.skipped) filesRead++;
    }
  }

  const manifest: FileSnapshotManifest = {
    format: FILE_SNAPSHOT_FORMAT,
    id,
    createdAt,
    chunkSize: config.chunkSize ?? DEFAULT_FILE_CHUNK_SIZE,
    sources: sources.map((source) => ({ label: source.label, path: source.path })),
    entries,
    warnings,
    stats: {
      files: filesRead,
      directories: entries.filter((entry) => entry.kind === 'dir').length,
      symlinks: entries.filter((entry) => entry.kind === 'symlink' && !entry.skipped).length,
      logicalBytes: entries.reduce((sum, entry) => sum + (entry.skipped ? 0 : entry.size), 0),
      storedBytes: storeState.storedBytes,
      uniqueChunks: storeState.uniqueChunks.size
    }
  };

  let mirror: FileMirrorReport | undefined;
  const mirrorTarget = opts.mirrorTarget ?? config.mirror?.path;
  if (mirrorTarget || config.mirror?.enabled) {
    if (!mirrorTarget) throw new Error('Mirror path is required when mirror.enabled is true');
    emit('mirroring', storeState.bytesRead, totalBytes, mirrorTarget);
    mirror = await runFileMirror({
      repoDir: config.repo,
      manifest,
      target: mirrorTarget,
      apply: opts.applyMirror === true || config.mirror?.apply === true,
      allowDeletes: opts.allowDeletes === true,
      confirmDeletes: opts.confirmDeletes === true,
      deletions: opts.deletions ?? config.mirror?.deletions ?? 'off',
      stagingPath: opts.stagingPath ?? config.mirror?.stagingPath,
      quarantinePath: opts.quarantinePath ?? config.mirror?.quarantinePath,
      maxDeleteFiles: opts.maxDeleteFiles ?? config.mirror?.maxDeleteFiles,
      maxDeleteBytes: opts.maxDeleteBytes ?? config.mirror?.maxDeleteBytes,
      repoKey,
      onProgress: (phase, currentPath) => emit(phase, storeState.bytesRead, totalBytes, currentPath),
      isCancelled: opts.isCancelled
    });
  }

  if (opts.dryRun) {
    emit('completed', storeState.bytesRead, totalBytes, '');
    return {
      ok: mirror ? mirror.ok : true,
      dryRun: true,
      manifest,
      bytesRead: storeState.bytesRead,
      filesRead,
      warnings: warnings.map((warning) => `${warning.path}: ${warning.message}`),
      ...(mirror ? { mirror } : {})
    };
  }

  emit('catalog', storeState.bytesRead, totalBytes, '');
  const encoded = writeEncryptedManifest(config.repo, manifest, keys.enc);
  appendFileCatalogRecord(
    config.repo,
    {
      type: 'snapshot',
      at: createdAt,
      id,
      snapshotFile: path.basename(snapshotPath(config.repo, id)),
      manifestSha256: encoded.plaintextSha256,
      encryptedSha256: encoded.encryptedSha256,
      files: manifest.stats.files,
      bytes: manifest.stats.logicalBytes,
      lockUntil: new Date(Date.now() + (config.lockDays ?? 30) * MS_PER_DAY).toISOString()
    },
    keys.catalog
  );

  emit('completed', storeState.bytesRead, totalBytes, '');
  return {
    ok: mirror ? mirror.ok : true,
    dryRun: false,
    snapshotId: id,
    manifest,
    bytesRead: storeState.bytesRead,
    filesRead,
    warnings: warnings.map((warning) => `${warning.path}: ${warning.message}`),
    ...(mirror ? { mirror } : {})
  };
}

function checkCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new Error('File backup cancelled');
}

function describeSources(config: FileBackupConfig): SourceDescriptor[] {
  const used = new Set<string>();
  return config.sources.map((source, index) => {
    const resolved = path.resolve(source);
    let label = safeSegment(resolved, `source-${index + 1}`);
    let suffix = 2;
    while (used.has(label.toLowerCase())) {
      label = `${safeSegment(resolved, `source-${index + 1}`)}-${suffix++}`;
    }
    used.add(label.toLowerCase());
    return { label, path: resolved };
  });
}

function toManifestEntry(item: PendingEntry): FileSnapshotEntry {
  return {
    path: item.path,
    kind: item.kind,
    size: item.size,
    mtime: item.mtime,
    mode: item.mode,
    sha256: item.sha256,
    chunks: item.chunks,
    ...(item.linkTarget !== undefined ? { linkTarget: item.linkTarget } : {}),
    ...(item.skipped !== undefined ? { skipped: item.skipped } : {})
  };
}

function directoryEntry(relative: string, manifestPath: string, mtimeMs: number, mode: number): PendingEntry {
  return {
    path: normalizeRelativePath(manifestPath),
    kind: 'dir',
    size: 0,
    mtime: new Date(mtimeMs).toISOString(),
    mode: mode & 0o777,
    sha256: '',
    chunks: [],
    ...(relative === manifestPath ? {} : {})
  };
}

function walkDirectory(
  absoluteDir: string,
  label: string,
  relativeDir: string,
  excludes: readonly string[],
  pending: PendingEntry[],
  warnings: FileSnapshotWarning[]
): void {
  const children = fs.readdirSync(absoluteDir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const childRelative = relativeDir ? `${relativeDir}/${toPosix(child.name)}` : toPosix(child.name);
    const manifestPath = `${label}/${childRelative}`;
    if (matchesAnyGlob(manifestPath, excludes)) continue;
    const absolute = path.join(absoluteDir, child.name);
    const stat = fs.lstatSync(absolute);
    const mtime = stat.mtime.toISOString();
    if (stat.isDirectory()) {
      pending.push(directoryEntry(childRelative, manifestPath, stat.mtimeMs, stat.mode));
      walkDirectory(absolute, label, childRelative, excludes, pending, warnings);
      continue;
    }
    if (stat.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.readlinkSync(absolute);
      } catch (error) {
        warnings.push({ path: manifestPath, message: `Could not read symlink target: ${(error as Error).message}` });
      }
      pending.push({
        path: normalizeRelativePath(manifestPath),
        kind: 'symlink',
        size: 0,
        mtime,
        mode: stat.mode & 0o777,
        sha256: '',
        chunks: [],
        linkTarget: target
      });
      warnings.push({ path: manifestPath, message: 'Symlink recorded but not followed; link target is not verified' });
      continue;
    }
    if (stat.isFile()) {
      pending.push({
        path: normalizeRelativePath(manifestPath),
        kind: 'file',
        size: stat.size,
        mtime,
        mode: stat.mode & 0o777,
        sha256: '',
        chunks: [],
        sourcePath: absolute
      });
      continue;
    }
    warnings.push({ path: manifestPath, message: 'Unsupported entry type skipped' });
  }
}

interface ReadOutcome {
  entry?: PendingEntry;
  bytesRead: number;
}

async function readFileEntry(
  item: PendingEntry,
  config: FileBackupConfig,
  repoDir: string,
  encKey: Buffer,
  dryRun: boolean,
  storeState: { bytesRead: number; storedBytes: number; uniqueChunks: Set<string> },
  warnings: FileSnapshotWarning[],
  emit: (
    phase: FileBackupProgress['phase'],
    bytesDone: number,
    totalBytes: number,
    currentPath: string
  ) => void,
  totalBytes: number,
  isCancelled?: () => boolean
): Promise<ReadOutcome> {
  const sourcePath = item.sourcePath;
  if (!sourcePath) throw new Error(`Missing source path for ${item.path}`);
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    let attemptBytes = 0;
    try {
      checkCancelled(isCancelled);
      const before = fs.statSync(sourcePath);
      const chunks: FileChunkRef[] = [];
      const fileHash = crypto.createHash('sha256');
      fd = fs.openSync(sourcePath, 'r');
      let offset = 0;
      while (offset < before.size) {
        checkCancelled(isCancelled);
        const want = Math.min(config.chunkSize ?? DEFAULT_FILE_CHUNK_SIZE, before.size - offset);
        const buffer = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buffer, 0, want, offset);
        if (read === 0) break;
        const chunk = buffer.subarray(0, read);
        fileHash.update(chunk);
        const sha = sha256(chunk);
        if (!storeState.uniqueChunks.has(sha)) {
          storeState.uniqueChunks.add(sha);
          if (dryRun) {
            storeState.storedBytes += read + ENCRYPTED_OVERHEAD;
          } else {
            storeState.storedBytes += writeChunkObject(repoDir, sha, chunk, encKey);
          }
        }
        chunks.push({ sha256: sha, size: read });
        attemptBytes += read;
        offset += read;
        emit('reading', storeState.bytesRead + attemptBytes, totalBytes, item.path);
      }
      const after = fs.statSync(sourcePath);
      fs.closeSync(fd);
      fd = undefined;
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('Source file changed while it was being read');
      }
      storeState.bytesRead += attemptBytes;
      return {
        entry: {
          ...item,
          size: after.size,
          mtime: after.mtime.toISOString(),
          sha256: fileHash.digest('hex'),
          chunks
        },
        bytesRead: attemptBytes
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
      }
    }
  }

  if (config.onUnreadable === 'fail') {
    throw new Error(`Could not capture ${item.path}: ${lastError}`);
  }
  warnings.push({ path: item.path, message: `File skipped after read failure: ${lastError}` });
  return {
    entry: { ...item, skipped: true, sha256: '', chunks: [] },
    bytesRead: 0
  };
}

function writeChunkObject(repoDir: string, sha: string, plaintext: Buffer, encKey: Buffer): number {
  const file = objectPath(repoDir, sha);
  const blob = encryptBuffer(plaintext, encKey, chunkAad(sha));
  let alreadyPresent: boolean;
  try {
    alreadyPresent = fs.statSync(file).size === blob.length;
  } catch {
    alreadyPresent = false;
  }
  if (alreadyPresent) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, blob);
  return blob.length;
}

/** Directory for transient file-backup artifacts, used by tests and tooling. */
export function fileBackupRoots(repoDir: string): ReturnType<typeof fileRoots> {
  return fileRoots(repoDir);
}
