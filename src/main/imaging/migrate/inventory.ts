import type { AppKnowledgeEntry, MigrateInventory, MigrateProfileInventory, MigrateStoreMatch } from './types';
import { EXCLUDED_PROFILE_DIRS, EXCLUDED_PROFILE_SUBTREES, STANDARD_FOLDERS } from './types';
import { resolveKbPath } from './apps-db';
import { sourcePathExists, walkSource, type WalkOptions } from './source';
import type { MigrateSource } from './types';

/** Enumerates user profiles on a source volume (directory-based, spike scope). */
export function listProfileNames(source: MigrateSource): string[] {
  let entries;
  try {
    entries = source.list('Users');
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory && !EXCLUDED_PROFILE_DIRS.includes(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Builds the store matches for one profile against the app knowledge base. */
export function matchStores(source: MigrateSource, profileRelPath: string, appsDb: AppKnowledgeEntry[]): MigrateStoreMatch[] {
  const matches: MigrateStoreMatch[] = [];
  for (const app of appsDb) {
    if (app.class === 'ignore' || app.class === 'reinstall-only' || app.data.length === 0) continue;
    for (const template of app.data) {
      const relPath = resolveKbPath(template, profileRelPath);
      if (!sourcePathExists(source, relPath)) continue;
      const stats = walkSource(source, relPath, walkOptionsForProfile(profileRelPath));
      matches.push({
        appId: app.id,
        appName: app.name,
        class: app.class,
        relPath,
        bytes: stats.totalBytes,
        itemCount: stats.itemCount,
        registry: app.registry,
        winget: app.winget
      });
    }
  }
  return matches;
}

function walkOptionsForProfile(profileRelPath: string): WalkOptions {
  return { excludeRelPaths: EXCLUDED_PROFILE_SUBTREES.map((p) => `${profileRelPath}/${p}`) };
}

/** Inventories one profile: totals, standard folders, and KB store matches. */
export function inventoryProfile(source: MigrateSource, profileName: string, appsDb: AppKnowledgeEntry[]): MigrateProfileInventory {
  const profileRelPath = `Users/${profileName}`;
  const total = walkSource(source, profileRelPath, walkOptionsForProfile(profileRelPath));
  const standardFolders: MigrateProfileInventory['standardFolders'] = [];
  for (const folder of STANDARD_FOLDERS) {
    const rel = `${profileRelPath}/${folder}`;
    if (!sourcePathExists(source, rel)) continue;
    const stats = walkSource(source, rel, walkOptionsForProfile(profileRelPath));
    if (stats.itemCount === 0 && stats.totalBytes === 0) continue;
    standardFolders.push({ name: folder, bytes: stats.totalBytes, itemCount: stats.itemCount });
  }
  return {
    name: profileName,
    profileRelPath,
    totalBytes: total.totalBytes,
    itemCount: total.itemCount,
    capped: total.capped,
    standardFolders,
    stores: matchStores(source, profileRelPath, appsDb)
  };
}

/** Full inventory of a source: every user profile plus excluded-dir accounting. */
export function buildInventory(source: MigrateSource, appsDb: AppKnowledgeEntry[]): MigrateInventory {
  const profiles = listProfileNames(source).map((name) => inventoryProfile(source, name, appsDb));
  return {
    sourceKind: source.kind,
    sourceLabel: source.label,
    generatedAt: new Date().toISOString(),
    profiles,
    excludedProfileDirs: EXCLUDED_PROFILE_DIRS.slice()
  };
}
