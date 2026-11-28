import * as fs from 'fs';
import * as path from 'path';
import { loadHeader, resolveRepoKey, type RepoKeyOptions } from '../imaging/repository';
import {
  activeSnapshotRecords,
  appendFileCatalogRecord,
  loadFileCatalog,
  mirrorProtectedIds,
  verifyFileCatalogChain,
  verifyFileCatalogSignatures
} from './catalog';
import { deriveFileKeys, fileRoots, objectPath, snapshotPath } from './crypto';
import { readEncryptedManifest } from './manifest';
import { verifyFileSnapshots } from './verify';
import type {
  FileCatalogRecord,
  FilePrunePlanEntry,
  FilePruneResult,
  FileSnapshotEntry
} from './types';

/**
 * Retention for file snapshots. Pruning is opt-in (`apply: true`) and only
 * touches snapshots whose lock expired, that are not the active mirror state,
 * and that are not among the newest `keep` versions.
 */
export interface FilePruneOptions extends RepoKeyOptions {
  apply?: boolean;
  keep?: number;
}

export async function pruneFileSnapshots(
  repoDir: string,
  opts: FilePruneOptions = {}
): Promise<FilePruneResult> {
  const apply = opts.apply === true;
  const keep = opts.keep ?? 3;
  if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer');

  const records = loadFileCatalog(repoDir);
  const chainError = verifyFileCatalogChain(records);
  if (chainError) throw new Error(`Refusing to prune: ${chainError}`);
  const header = loadHeader(repoDir);
  const key = resolveRepoKey(header, opts);
  const keys = deriveFileKeys(key);
  const signatureError = verifyFileCatalogSignatures(records, keys.catalog);
  if (signatureError) throw new Error(`Refusing to prune: ${signatureError}`);

  const active = activeSnapshotRecords(records);
  const protectedIds = mirrorProtectedIds(records);
  const newest = [...active]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, keep)
    .map((record) => record.id);
  const keepIds = new Set(newest);
  const now = Date.now();

  const eligible: FilePrunePlanEntry[] = [];
  const skipped: FilePrunePlanEntry[] = [];
  for (const record of active) {
    const entry: FilePrunePlanEntry = {
      id: record.id,
      reason: '',
      bytes: record.bytes ?? 0
    };
    if (keepIds.has(record.id)) {
      skipped.push({ ...entry, reason: `one of the newest ${keep} versions` });
      continue;
    }
    if (protectedIds.has(record.id)) {
      skipped.push({ ...entry, reason: 'active one-way mirror state' });
      continue;
    }
    if (record.lockUntil && Date.parse(record.lockUntil) > now) {
      skipped.push({ ...entry, reason: `locked until ${record.lockUntil}` });
      continue;
    }
    eligible.push({ ...entry, reason: 'lock expired' });
  }

  if (!apply) {
    return { dryRun: true, eligible, skipped, removed: [], chunksRemoved: 0, bytesRemoved: 0 };
  }

  // Full verification before any deletion: a corrupt snapshot must not be
  // silently pruned away, and a corrupt sibling must not lose its last copy.
  for (const entry of eligible) {
    const report = await verifyFileSnapshots(repoDir, { ...opts, id: entry.id, fast: false });
    if (!report.ok) {
      throw new Error(
        `Refusing to prune ${entry.id}: ${report.problems.map((problem) => problem.detail).join('; ')}`
      );
    }
  }

  const removed: FilePrunePlanEntry[] = [];
  for (const entry of eligible) {
    const file = snapshotPath(repoDir, entry.id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    appendFileCatalogRecord(
      repoDir,
      { type: 'prune', at: new Date().toISOString(), id: entry.id, reason: entry.reason },
      keys.catalog
    );
    removed.push(entry);
  }

  const remainingIds = new Set(
    activeSnapshotRecords(loadFileCatalog(repoDir)).map((record) => record.id)
  );
  const referenced = new Set<string>();
  for (const id of remainingIds) {
    const decoded = readEncryptedManifest(repoDir, id, keys.enc);
    for (const chunk of decoded.manifest.entries.flatMap((entry: FileSnapshotEntry) => entry.chunks)) {
      referenced.add(chunk.sha256);
    }
  }

  let chunksRemoved = 0;
  let bytesRemoved = 0;
  const objects = fileRoots(repoDir).objects;
  if (fs.existsSync(objects)) {
    for (const bucket of fs.readdirSync(objects)) {
      const dir = path.join(objects, bucket);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.chunk')) continue;
        const sha = name.replace(/\.chunk$/i, '').toLowerCase();
        if (referenced.has(sha)) continue;
        const file = path.join(dir, name);
        try {
          bytesRemoved += fs.statSync(file).size;
          fs.unlinkSync(file);
          chunksRemoved++;
        } catch {
          // A chunk that vanished concurrently is already gone; do not fail GC.
        }
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        /* non-empty is fine */
      }
    }
  }
  if (chunksRemoved > 0 || bytesRemoved > 0) {
    appendFileCatalogRecord(
      repoDir,
      {
        type: 'gc',
        at: new Date().toISOString(),
        id: 'chunks',
        chunksRemoved,
        bytesRemoved
      },
      keys.catalog
    );
  }

  return { dryRun: false, eligible, skipped, removed, chunksRemoved, bytesRemoved };
}

/** Used by CLI list output; returns catalog records minus pruned snapshots. */
export function listFileSnapshots(repoDir: string): FileCatalogRecord[] {
  return activeSnapshotRecords(loadFileCatalog(repoDir));
}

/** Object path export for tooling and tests. */
export function fileObjectPath(repoDir: string, sha256Hex: string): string {
  return objectPath(repoDir, sha256Hex);
}
