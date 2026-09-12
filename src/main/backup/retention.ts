import * as fs from 'fs';
import * as path from 'path';
import { readImageInfo, FLAG_INCREMENTAL, FLAG_VERIFIED, ImageInfo } from '../imaging/image-format';
import { logger } from '../utils/logger';

export interface BackupImageEntry {
  path: string;
  name: string;
  timestamp: number;
  size: number;
  incremental: boolean;
  baseImagePath?: string;
  encrypted: boolean;
  verified: boolean;
}

export interface RetentionOptions {
  /** Number of most recent full-image chains to keep intact. */
  keepFull: number;
  /** Max number of trailing deltas kept per retained chain. */
  keepDeltasPerFull: number;
  /** Never delete images newer than this many days. */
  retentionDays?: number;
  /** Simulate without touching the filesystem. */
  dryRun?: boolean;
}

export interface RetentionChain {
  root: BackupImageEntry;
  items: BackupImageEntry[];
  complete: boolean;
  newestTimestamp: number;
}

export interface RetentionPlan {
  keep: BackupImageEntry[];
  prune: BackupImageEntry[];
  chains: RetentionChain[];
  reason: Record<string, string>;
  reminders: string[];
}

export function scanBackupDirectory(dir: string): BackupImageEntry[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Backup directory does not exist: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.opbs'));
  const entries: BackupImageEntry[] = [];
  for (const name of files) {
    const filePath = path.join(dir, name);
    let info: ImageInfo;
    try {
      info = readImageInfo(filePath);
    } catch (err) {
      logger.warn(`Skipping invalid image ${filePath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    entries.push({
      path: filePath,
      name,
      timestamp: info.header.timestamp,
      size: fs.statSync(filePath).size,
      incremental: (info.header.flags & FLAG_INCREMENTAL) !== 0,
      baseImagePath: info.header.baseImagePath || undefined,
      encrypted: info.header.cipherId !== 0,
      verified: (info.header.flags & FLAG_VERIFIED) !== 0
    });
  }
  return entries;
}

function canonical(p: string): string {
  return path.resolve(p);
}

export function groupIntoChains(entries: BackupImageEntry[]): RetentionChain[] {
  const byCanon = new Map<string, BackupImageEntry>();
  for (const entry of entries) {
    byCanon.set(canonical(entry.path), entry);
  }

  // parent -> children (deltas that point at a base file present in the scan)
  const children = new Map<string, BackupImageEntry[]>();
  const roots = new Set<string>();
  for (const entry of entries) {
    if (entry.incremental && entry.baseImagePath) {
      const baseCanon = canonical(entry.baseImagePath);
      if (byCanon.has(baseCanon)) {
        const list = children.get(baseCanon) ?? [];
        list.push(entry);
        children.set(baseCanon, list);
        continue;
      }
    }
    roots.add(canonical(entry.path));
  }

  // Walking down from a root yields every descendant delta (sorted by time).
  const visit = (root: BackupImageEntry): { items: BackupImageEntry[]; complete: boolean } => {
    const items: BackupImageEntry[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      items.push(current);
      const kids = children.get(canonical(current.path)) ?? [];
      for (const kid of kids) {
        pending.push(kid);
      }
    }
    // complete if every delta in the chain could be linked back to a root.
    const complete = items.every((item) => !item.incremental || (item.baseImagePath && byCanon.has(canonical(item.baseImagePath))));
    return { items, complete };
  };

  const chains: RetentionChain[] = [];
  for (const rootKey of roots) {
    const root = byCanon.get(rootKey)!;
    const { items, complete } = visit(root);
    items.sort((a, b) => a.timestamp - b.timestamp);
    chains.push({
      root,
      items,
      complete,
      newestTimestamp: Math.max(...items.map((i) => i.timestamp))
    });
  }

  chains.sort((a, b) => b.newestTimestamp - a.newestTimestamp);
  return chains;
}

export function planRetention(input: BackupImageEntry[] | string, options: RetentionOptions): RetentionPlan {
  const entries = typeof input === 'string' ? scanBackupDirectory(input) : input;
  const chains = groupIntoChains(entries);

  const now = Date.now();
  const retentionWindowMs = options.retentionDays != null ? options.retentionDays * 24 * 60 * 60 * 1000 : 0;

  const keep = new Set<string>();
  const reason: Record<string, string> = {};
  const markKeep = (entry: BackupImageEntry, why: string): void => {
    keep.add(canonical(entry.path));
    reason[canonical(entry.path)] = why;
  };

  const retainedChains = chains.slice(0, options.keepFull);
  const keptChains = new Set<string>();
  for (const chain of retainedChains) {
    keptChains.add(canonical(chain.root.path));
  }

  for (const chain of chains) {
    const isRetained = keptChains.has(canonical(chain.root.path));

    // Grace window: never prune anything newer than retentionDays.
    for (const item of chain.items) {
      if (retentionWindowMs > 0 && item.timestamp >= now - retentionWindowMs) {
        markKeep(item, 'within retention window');
      }
    }

    if (!isRetained) continue;

    // Root of a retained chain is always kept.
    markKeep(chain.root, `full image kept (chain ${chain.items.indexOf(chain.root) + 1}/${chain.items.length})`);
    const deltas = chain.items.filter((item) => item !== chain.root).sort((a, b) => a.timestamp - b.timestamp);
    const trailing = deltas.slice(Math.max(0, deltas.length - options.keepDeltasPerFull));
    for (const delta of trailing) {
      markKeep(delta, 'trailing delta kept');
    }
  }

  const prune: BackupImageEntry[] = [];
  for (const entry of entries) {
    if (!keep.has(canonical(entry.path))) {
      prune.push(entry);
      reason[canonical(entry.path)] = reason[canonical(entry.path)] ?? 'excess chain or delta beyond retention policy';
    }
  }

  // Age-aware lineage guard: never let retention delete the *last surviving
  // restore point* of a source disk. Chains are grouped by the root full's
  // source identity (serial, else model). If every chain of a lineage would be
  // pruned entirely, the newest chain's root full is rescued. Unidentified
  // images (no serial/model, or synthetic entries passed to this planner) are
  // never guarded, so this never blocks on legacy or test data.
  const reminders: string[] = [];
  {
    const resolutionCache = new Map<string, string | undefined>();
    const identityOf = (rootPath: string): string | undefined => {
      const key = canonical(rootPath);
      const hit = resolutionCache.get(key);
      if (hit !== undefined) return hit;
      let id: string | undefined;
      try {
        const info = readImageInfo(rootPath);
        id = info.header.sourceDiskSerial || info.header.sourceDiskModel || undefined;
      } catch {
        id = undefined;
      }
      resolutionCache.set(key, id);
      return id;
    };

    const lineageChains = new Map<string, RetentionChain[]>();
    for (const chain of chains) {
      const id = identityOf(chain.root.path);
      if (id == null) continue;
      const list = lineageChains.get(id) ?? [];
      list.push(chain);
      lineageChains.set(id, list);
    }

    for (const [id, group] of lineageChains) {
      const anySurvivor = group.some((chain) => chain.items.some((item) => keep.has(canonical(item.path))));
      if (anySurvivor) continue;
      const newestChain = [...group].sort((a, b) => b.newestTimestamp - a.newestTimestamp)[0];
      const rootKey = canonical(newestChain.root.path);
      keep.add(rootKey);
      reason[rootKey] = `last surviving backup of source disk ${id} — pruning would leave no restore point for it`;
      reminders.push(
        `Retained ${newestChain.root.name}: lone surviving restore point of source disk ${id}.`
      );
    }

    if (options.keepFull === 0) {
      reminders.push('keepFull is 0 — chain retention is disabled; only the age-based grace window protects images from pruning.');
    }
  }

  // Invariant: never delete a base image that a kept delta still references.
  // Promote such bases into the keep set until stable.
  const byCanon = new Map(entries.map((e) => [canonical(e.path), e]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!keep.has(canonical(entry.path))) continue;
      if (entry.incremental && entry.baseImagePath) {
        const baseKey = canonical(entry.baseImagePath);
        if (byCanon.has(baseKey) && !keep.has(baseKey)) {
          keep.add(baseKey);
          reason[baseKey] = 'kept as base of a retained delta';
          changed = true;
        }
      }
    }
  }

  const finalPrune: BackupImageEntry[] = [];
  for (const entry of entries) {
    if (!keep.has(canonical(entry.path))) {
      finalPrune.push(entry);
    }
  }

  // Leaf-first deletion: newest images reference no later images, so dropping
  // them first never orphanes a still-kept base chain.
  finalPrune.sort((a, b) => b.timestamp - a.timestamp);

  // Soft reminder: never silently delete unverified images (encrypted images
  // may legitimately lack the flag, so they are excluded from the reminder).
  const unverifiedPruned = finalPrune.filter((e) => !e.verified && !e.encrypted).length;
  if (unverifiedPruned > 0) {
    reminders.push(
      `${unverifiedPruned} unverified image(s) are scheduled for deletion — run 'opbs verify --dir ${typeof input === 'string' ? input : '<destination>'} --scope all' first if any of them should be preserved.`
    );
  }

  const keepList = entries.filter((e) => keep.has(canonical(e.path)));
  return { keep: keepList, prune: finalPrune, chains, reason, reminders };
}

export async function applyRetention(dir: string, options: RetentionOptions): Promise<RetentionPlan> {
  const plan = planRetention(dir, options);
  if (options.dryRun) {
    return plan;
  }

  for (const entry of plan.prune) {
    await fs.promises.unlink(entry.path).catch((err) => {
      logger.warn(`Failed to prune ${entry.path}: ${err}`);
    });
    logger.info(`Pruned ${entry.name} (${plan.reason[canonical(entry.path)]})`);
  }

  await writeManifest(dir);
  return plan;
}

export interface BackupManifest {
  updatedAt: string;
  directory: string;
  images: Array<{
    name: string;
    timestamp: string;
    size: number;
    incremental: boolean;
    baseImagePath?: string;
    encrypted: boolean;
    verified: boolean;
    inChain: boolean;
  }>;
}

const MANIFEST_NAME = 'opbs-manifest.json';

export async function writeManifest(dir: string): Promise<BackupManifest> {
  const entries = scanBackupDirectory(dir);
  const chains = groupIntoChains(entries);
  const chainRoots = new Set(chains.map((c) => canonical(c.root.path)));

  const manifest: BackupManifest = {
    updatedAt: new Date().toISOString(),
    directory: dir,
    images: entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((entry) => ({
        name: entry.name,
        timestamp: new Date(entry.timestamp).toISOString(),
        size: entry.size,
        incremental: entry.incremental,
        baseImagePath: entry.baseImagePath,
        encrypted: entry.encrypted,
        verified: entry.verified,
        inChain: chainRoots.has(canonical(entry.path))
      }))
  };

  const manifestPath = path.join(dir, MANIFEST_NAME);
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifest;
}

export function manifestFilePath(dir: string): string {
  return path.join(dir, MANIFEST_NAME);
}

/** Newest valid image in a directory, useful as an incremental base. */
export function findNewestImage(dir: string): string | undefined {
  const entries = scanBackupDirectory(dir);
  if (entries.length === 0) {
    return undefined;
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries[0].path;
}

/**
 * Select which images should be verified for a scope. Always sorts newest
 * first; encrypted images are returned separately by the caller.
 */
export function selectImagesForVerify(entries: BackupImageEntry[], scope: 'newest' | 'all'): BackupImageEntry[] {
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
  return scope === 'newest' ? sorted.slice(0, 1) : sorted;
}