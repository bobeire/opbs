import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { openAnyBrowse, listDirectory, extractPath, readPath, type BrowseSession } from '../fs/file-browse';
import type { MigrateSource, MigrateSourceEntry, WalkStats } from './types';

/** Image-source verify buffers whole files — above this size, verify falls back to size-only. */
export const IMAGE_VERIFY_BUFFER_LIMIT = 512 * 1024 * 1024;

/** MD5 hex of a local file, streamed. */
export function hashFileMd5(absPath: string): string {
  const hash = crypto.createHash('md5');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Default live-system root (the system drive). */
export function defaultLiveRoot(): string {
  return process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\';
}

/** Read-only source backed by a live filesystem root. */
export class LiveSource implements MigrateSource {
  readonly kind = 'live' as const;
  readonly label: string;

  constructor(private readonly root: string) {
    this.label = `live:${root}`;
  }

  private toFs(relPath: string): string {
    const clean = relPath.replace(/\//g, path.sep).replace(/^\//, '');
    return path.join(this.root, clean);
  }

  list(relPath: string): MigrateSourceEntry[] {
    const dir = this.toFs(relPath);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot list ${dir}: ${msg}`, { cause: error });
    }
    const out: MigrateSourceEntry[] = [];
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      let isDirectory = dirent.isDirectory();
      let size = 0;
      if (dirent.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDirectory = st.isDirectory();
          size = st.isFile() ? st.size : 0;
        } catch {
          continue; // broken link — skip
        }
      } else if (dirent.isFile()) {
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
      } else if (!dirent.isDirectory()) {
        continue; // sockets/pipes/devices
      }
      out.push({ name: dirent.name, isDirectory, size, isSymlink: dirent.isSymbolicLink() || undefined });
    }
    return out;
  }

  copyFileTo(relPath: string, destAbsPath: string): void {
    fs.copyFileSync(this.toFs(relPath), destAbsPath);
    // Best-effort mtime preservation; failures (ACLs) never fail the copy.
    try {
      const st = fs.statSync(this.toFs(relPath));
      fs.utimesSync(destAbsPath, st.atime, st.mtime);
    } catch {
      /* keep default timestamps */
    }
  }

  hashFile(relPath: string, _size: number): string | null {
    return hashFileMd5(this.toFs(relPath));
  }

  close(): void {
    /* nothing to release */
  }
}

/** Read-only source backed by an image partition via the browse session. */
export class ImageSource implements MigrateSource {
  readonly kind = 'image' as const;
  readonly label: string;
  private readonly session: BrowseSession;

  constructor(imagePath: string, partitionIndex: number, passphrase?: string) {
    this.session = openAnyBrowse(imagePath, partitionIndex, passphrase);
    this.label = `image:${imagePath} (partition ${partitionIndex})`;
  }

  list(relPath: string): MigrateSourceEntry[] {
    return listDirectory(this.session, relPath).map((node) => ({
      name: node.name,
      isDirectory: node.isDirectory,
      size: node.size,
      isEncrypted: node.isEncrypted || undefined
    }));
  }

  copyFileTo(relPath: string, destAbsPath: string): void {
    extractPath(this.session, relPath, destAbsPath);
  }

  hashFile(relPath: string, size: number): string | null {
    if (size > IMAGE_VERIFY_BUFFER_LIMIT) return null;
    const buf = readPath(this.session, relPath);
    return crypto.createHash('md5').update(buf).digest('hex');
  }

  close(): void {
    const closer = this.session as { close?: () => void };
    if (typeof closer.close === 'function') closer.close();
  }
}

export interface WalkOptions {
  maxDepth?: number;
  /** Exclude profile-relative subtrees (matched at any depth prefix, `/`-separated). */
  excludeRelPaths?: string[];
  /** Stop after this many visited files (safety cap; stats flagged `capped`). */
  maxFiles?: number;
}

const DEFAULT_MAX_DEPTH = 14;
const DEFAULT_MAX_FILES = 500_000;

/**
 * Recursively walks `relPath` on a source, aggregating file sizes and counts.
 * Directory sizes are never counted (only files), symlinks to files count
 * once via the source listing. Excluded subtrees are skipped entirely.
 */
export function walkSource(source: MigrateSource, relPath: string, options: WalkOptions = {}): WalkStats {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const excludes = (options.excludeRelPaths ?? []).map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  const stats: WalkStats = { totalBytes: 0, itemCount: 0, capped: false };
  const base = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  const recurse = (rel: string, depth: number): void => {
    if (stats.capped) return;
    if (depth > maxDepth) {
      stats.capped = true;
      return;
    }
    let entries: MigrateSourceEntry[];
    try {
      entries = source.list(rel);
    } catch {
      return; // unreadable directory — treat as empty, keep going
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (excludes.includes(childRel)) continue;
      if (entry.isDirectory) {
        recurse(childRel, depth + 1);
      } else {
        stats.totalBytes += entry.size;
        stats.itemCount += 1;
        if (stats.itemCount >= maxFiles) {
          stats.capped = true;
          return;
        }
      }
    }
  };

  recurse(base, 0);
  return stats;
}

/** Returns true when the relative path exists on the source (as directory or file). */
export function sourcePathExists(source: MigrateSource, relPath: string): boolean {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return true;
  const parts = clean.split('/');
  let current = '';
  for (const part of parts) {
    const parent = current;
    current = parent ? `${parent}/${part}` : part;
    let entries: MigrateSourceEntry[];
    try {
      entries = source.list(parent);
    } catch {
      return false;
    }
    const hit = entries.find((e) => e.name === part);
    if (!hit) return false;
    if (current !== clean && !hit.isDirectory) return false;
  }
  return true;
}

export function openMigrateSource(opts: { live?: boolean; liveRoot?: string; imagePath?: string; partitionIndex?: number; passphrase?: string }): MigrateSource {
  if (opts.live) return new LiveSource(opts.liveRoot ?? defaultLiveRoot());
  if (!opts.imagePath) throw new Error('migrate source required: --live or <image path>');
  return new ImageSource(opts.imagePath, opts.partitionIndex ?? 0, opts.passphrase);
}
