/** User-state migration — Phase 0 spike types (see MIGRATE.md). */

export type AppClass = 'data' | 'data+settings' | 'reinstall-only' | 'ignore';

/** One curated application in the open app knowledge base. */
export interface AppKnowledgeEntry {
  /** Stable identifier (kebab-case), used in JSON output and --include/--exclude. */
  id: string;
  /** Display name. */
  name: string;
  /** Profile-relative data locations; tokens `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%` are resolved per profile. */
  data: string[];
  /** Per-user registry subtrees planned for transplant (tier 2 — listed, not executed, in the spike). */
  registry?: string[];
  /** winget package id for the reinstall manifest, when known. */
  winget?: string;
  /** Migration class; `reinstall-only` data paths are ignored, `ignore` is skipped entirely. */
  class: AppClass;
}

/** One directory entry as seen by a migrate source. */
export interface MigrateSourceEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * Read-only view of a Windows volume to migrate *from* — a live system
 * drive or a mounted image partition. Relative paths use `/` separators;
 * `''` is the volume root.
 */
export interface MigrateSource {
  kind: 'live' | 'image';
  /** Human-readable source label for reports (e.g. `live:C:` or `image:… (partition 0)`). */
  label: string;
  list(relPath: string): MigrateSourceEntry[];
  close(): void;
}

export interface WalkStats {
  totalBytes: number;
  itemCount: number;
  /** True when the walk stopped at the depth/entry cap (numbers are lower bounds). */
  capped: boolean;
}

/** A detected per-user application data store. */
export interface MigrateStoreMatch {
  appId: string;
  appName: string;
  class: AppClass;
  /** Profile-relative path with `/` separators. */
  relPath: string;
  bytes: number;
  itemCount: number;
  registry?: string[];
  winget?: string;
}

export interface MigrateProfileInventory {
  name: string;
  /** Profile path relative to the volume root, e.g. `Users/Alice`. */
  profileRelPath: string;
  totalBytes: number;
  itemCount: number;
  capped: boolean;
  standardFolders: { name: string; bytes: number; itemCount: number }[];
  stores: MigrateStoreMatch[];
}

export interface MigrateInventory {
  sourceKind: 'live' | 'image';
  sourceLabel: string;
  generatedAt: string;
  profiles: MigrateProfileInventory[];
  excludedProfileDirs: string[];
}

export interface MigratePlanEntry {
  profile: string;
  sourceRelPath: string;
  category: 'standard-folder' | 'app-store';
  appId?: string;
  appName?: string;
  bytes: number;
  itemCount: number;
  registry?: string[];
  registryExecuted: boolean;
}

export interface MigrateReinstallHint {
  appId: string;
  name: string;
  winget?: string;
  class: AppClass;
}

export interface MigrateRefusal {
  reason: string;
  detail: string;
}

export interface MigratePlan {
  sourceKind: 'live' | 'image';
  sourceLabel: string;
  generatedAt: string;
  profile: string;
  profileRelPath: string;
  entries: MigratePlanEntry[];
  totalBytes: number;
  totalItems: number;
  stores: MigrateStoreMatch[];
  reinstallHints: MigrateReinstallHint[];
  refusals: MigrateRefusal[];
  phaseNotes: string[];
}

/** Profile directories on a Windows volume that are never user profiles. */
export const EXCLUDED_PROFILE_DIRS = ['Public', 'Default', 'Default User', 'All Users', 'defaultuser0'];

/** Profile-relative standard folders offered for migration when present. */
export const STANDARD_FOLDERS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Music',
  'Pictures',
  'Videos',
  'Links',
  'Favorites',
  'Contacts',
  'Searches',
  'Saved Games',
  'OneDrive',
  'AppData'
];

/** Profile-relative subtrees excluded from totals and plans (scratch/temp data). */
export const EXCLUDED_PROFILE_SUBTREES = ['AppData/Local/Temp', 'AppData/Local/INetCache', 'AppData/Local/Microsoft/Windows/INetCache'];
