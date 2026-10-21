/** User-state migration types (design: MIGRATE.md; phases 0-1 shipped). */

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
  /** True when the entry is a symlink/reparse point (live NTFS) — never followed on copy. */
  isSymlink?: boolean;
  /** True when the entry is EFS-encrypted (image sources). */
  isEncrypted?: boolean;
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
  /** Copies one source file to an absolute destination path (content only). */
  copyFileTo(relPath: string, destAbsPath: string): void;
  /**
   * MD5 hex of the source file's content, or `null` when not feasible
   * (image sources buffer whole files — callers fall back to a size check
   * above the buffer limit).
   */
  hashFile(relPath: string, size: number): string | null;
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
  standardFolders: { name: string; bytes: number; itemCount: number; capped?: boolean }[];
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
  /** Set when the sizing walk excluded deep subtrees or hit the file cap (plan counts are then partial). */
  capped?: boolean;
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
  /** sha256 over the plan's decision-relevant content (computed at CLI level, excluded from its own hash). */
  planHash?: string;
}

export type MigrateCopyAction = 'copied' | 'skipped-resume' | 'skipped-reparse' | 'skipped-depth' | 'failed';
export type MigrateVerifyState = 'ok' | 'mismatch' | 'size-only-ok' | 'not-checked' | 'failed';

/** Tier-2 registry transplant result for one curated knowledge-base key. */
export interface MigrateRegistryOutcome {
  appId?: string;
  appName?: string;
  /** Knowledge-base key as written (HKCU-style). */
  key: string;
  status: 'copied' | 'skipped-source-missing' | 'failed' | 'not-run';
  detail?: string;
  sourceSubkeys?: number;
  sourceValues?: number;
  targetSubkeys?: number;
  targetValues?: number;
}

/** Tier-2 owner/SID rewrite result for the copied tree (MIGRATE.md §9). */
export interface MigrateOwnerRewrite {
  status: 'ok' | 'partial' | 'failed' | 'skipped' | 'not-needed';
  /** Target profile SID the copied tree was handed to. */
  sid?: string;
  /** Number of copied folder roots rewritten. */
  roots: number;
  detail?: string;
}

/** Per-file outcome for everything that is not a plain successful copy+verify. */
export interface MigrateCopyOutcome {
  sourceRelPath: string;
  destPath: string;
  action: MigrateCopyAction;
  bytes?: number;
  error?: string;
  verify?: MigrateVerifyState;
}

/** Result of a `migrate run` — the migration report (tier 1). */
export interface MigrationReport {
  profile: string;
  sourceLabel: string;
  targetProfileDir: string;
  planHash: string;
  executed: boolean;
  startedAt: string;
  finishedAt: string;
  summary: {
    plannedFiles: number;
    plannedBytes: number;
    copied: number;
    skippedResume: number;
    skippedReparse: number;
    skippedDepth: number;
    failed: number;
    bytesCopied: number;
    verifyChecked: number;
    verifyMismatches: number;
    registryCopied: number;
    registryFailed: number;
  };
  /** Non-success outcomes only (plain copies are recorded in the journal). */
  outcomes: MigrateCopyOutcome[];
  /** App-store entries: data lives under AppData (already copied); registry/winget info carried for tier 2/3. */
  stores: MigrateStoreMatch[];
  /** Tier-2 registry transplant outcomes — present only when the run requested `--registry`. */
  registry?: MigrateRegistryOutcome[];
  /** Tier-2 owner rewrite result — present only when owner rewriting was requested. */
  owner?: MigrateOwnerRewrite;
  refusals: MigrateRefusal[];
  reinstallHints: MigrateReinstallHint[];
  artifacts: { reportPath?: string; wingetPath?: string; journalPath?: string };
  notes: string[];
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
