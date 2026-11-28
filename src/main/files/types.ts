/**
 * Versioned file/folder backup formats.
 *
 * These artifacts are deliberately separate from disk images: an `.opbsfiles`
 * snapshot is not a restorable `.opbs` volume, and the file catalog is not the
 * disk-image journal. They share only the repository's signing key, with
 * domain-separated derived keys so a record cannot be replayed across formats.
 */

export const FILE_CATALOG_VERSION = 1;
export const FILE_SNAPSHOT_FORMAT = 'opbs-files/v1';
export const FILE_CHUNK_FORMAT = 1;
export const DEFAULT_FILE_CHUNK_SIZE = 1024 * 1024;
export const MIN_FILE_CHUNK_SIZE = 64 * 1024;
export const MAX_FILE_CHUNK_SIZE = 64 * 1024 * 1024;
export const DEFAULT_MAX_DELETE_FILES = 10;
export const DEFAULT_MAX_DELETE_BYTES = 100 * 1024 * 1024;

export type FileMirrorDeletionPolicy = 'off' | 'quarantine';
export type FileUnreadablePolicy = 'warn' | 'fail';
export type FileOverwritePolicy = 'skip' | 'replace' | 'rename';

export interface FileMirrorConfig {
  /** Mirror planning/applying is opt-in; a backup never mirrors by default. */
  enabled?: boolean;
  /** Even when enabled, planning is the default; this must be set to apply. */
  apply?: boolean;
  path?: string;
  deletions?: FileMirrorDeletionPolicy;
  maxDeleteFiles?: number;
  maxDeleteBytes?: number;
  stagingPath?: string;
  quarantinePath?: string;
}

/** JSON config accepted by `files backup`. */
export interface FileBackupConfig {
  type: 'backup-files';
  sources: string[];
  repo: string;
  excludes?: string[];
  chunkSize?: number;
  lockDays?: number;
  onUnreadable?: FileUnreadablePolicy;
  mirror?: FileMirrorConfig;
}

export interface FileChunkRef {
  /** SHA-256 of the plaintext chunk; also the object's basename. */
  sha256: string;
  size: number;
}

export type FileEntryKind = 'file' | 'dir' | 'symlink';

export interface FileSnapshotEntry {
  /** Always a forward-slash relative path; absolute paths never enter a manifest. */
  path: string;
  kind: FileEntryKind;
  size: number;
  mtime: string;
  /** Permission bits only. ACLs, ADS and ownership are out of scope for v1. */
  mode: number;
  sha256: string;
  chunks: FileChunkRef[];
  linkTarget?: string;
  skipped?: boolean;
}

export interface FileSnapshotWarning {
  path: string;
  message: string;
}

export interface FileSnapshotSource {
  /** Safe path segment prefixing every entry from this source. */
  label: string;
  path: string;
}

export interface FileSnapshotStats {
  files: number;
  directories: number;
  symlinks: number;
  logicalBytes: number;
  storedBytes: number;
  uniqueChunks: number;
}

export interface FileSnapshotManifest {
  format: typeof FILE_SNAPSHOT_FORMAT;
  id: string;
  createdAt: string;
  chunkSize: number;
  sources: FileSnapshotSource[];
  entries: FileSnapshotEntry[];
  warnings: FileSnapshotWarning[];
  stats: FileSnapshotStats;
}

export type FileBackupPhase =
  | 'preparing'
  | 'scanning'
  | 'reading'
  | 'writing'
  | 'catalog'
  | 'mirroring'
  | 'completed';

export interface FileBackupProgress {
  phase: FileBackupPhase;
  percent: number;
  bytesDone: number;
  totalBytes: number;
  currentPath: string;
}

export type FileCatalogRecordType = 'snapshot' | 'prune' | 'mirror' | 'mirror-state' | 'gc';

/** One signed file-catalog record. Key order is the canonical signing order. */
export interface FileCatalogRecord {
  /** Reserved for forward compatibility; v1 records omit it. */
  schema?: number;
  seq: number;
  type: FileCatalogRecordType;
  at: string;
  id: string;
  snapshotFile?: string;
  manifestSha256?: string;
  encryptedSha256?: string;
  files?: number;
  bytes?: number;
  lockUntil?: string;
  reason?: string;
  targetKey?: string;
  run?: string;
  report?: string;
  policy?: string;
  dryRun?: boolean;
  added?: number;
  changed?: number;
  deleted?: number;
  quarantined?: number;
  chunksRemoved?: number;
  bytesRemoved?: number;
  prev: string;
  sig: string;
}

export interface FileMirrorChange {
  path: string;
  action: 'add' | 'change' | 'delete' | 'replace';
  size: number;
}

export interface FileMirrorReport {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  snapshotId: string;
  target: string;
  policy: FileMirrorDeletionPolicy;
  deletionsAllowed: boolean;
  confirmationRequired: boolean;
  added: FileMirrorChange[];
  changed: FileMirrorChange[];
  deleted: FileMirrorChange[];
  replaced: FileMirrorChange[];
  quarantined: number;
  thresholds: { maxDeleteFiles: number; maxDeleteBytes: number };
  problems: string[];
  reportPath?: string;
}

export interface FileBackupResult {
  ok: boolean;
  dryRun: boolean;
  snapshotId?: string;
  manifest: FileSnapshotManifest;
  bytesRead: number;
  filesRead: number;
  warnings: string[];
  mirror?: FileMirrorReport;
}

export interface FileRestoreResult {
  ok: boolean;
  snapshotId: string;
  target: string;
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
  reportPath?: string;
}

export type FileVerifyProblemKind =
  | 'catalog'
  | 'signature'
  | 'manifest'
  | 'chunk'
  | 'missing'
  | 'orphan';

export interface FileVerifyProblem {
  kind: FileVerifyProblemKind;
  detail: string;
}

export interface FileSnapshotSummary {
  id: string;
  createdAt: string;
  files: number;
  bytes: number;
  lockUntil?: string;
}

export interface FileVerifyResult {
  ok: boolean;
  problems: FileVerifyProblem[];
  snapshots: FileSnapshotSummary[];
  signaturesVerified: boolean;
}

export interface FilePrunePlanEntry {
  id: string;
  reason: string;
  bytes: number;
}

export interface FilePruneResult {
  dryRun: boolean;
  eligible: FilePrunePlanEntry[];
  skipped: FilePrunePlanEntry[];
  removed: FilePrunePlanEntry[];
  chunksRemoved: number;
  bytesRemoved: number;
}
