import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_FILE_CHUNK_SIZE,
  DEFAULT_MAX_DELETE_BYTES,
  DEFAULT_MAX_DELETE_FILES,
  MAX_FILE_CHUNK_SIZE,
  MIN_FILE_CHUNK_SIZE,
  type FileBackupConfig,
  type FileMirrorConfig
} from './types';

/** Validation for `files backup` JSON configs. */

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string, min: number, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < min || (max !== undefined && value > max)) {
    throw new Error(`${field} must be between ${min} and ${max ?? 'unlimited'}`);
  }
  return value;
}

function normalizeMirror(value: unknown): FileMirrorConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mirror must be an object');
  }
  const raw = value as Record<string, unknown>;
  const deletions = raw.deletions ?? 'off';
  if (deletions !== 'off' && deletions !== 'quarantine') {
    throw new Error('mirror.deletions must be "off" or "quarantine"');
  }
  const out: FileMirrorConfig = {
    enabled: raw.enabled === true,
    apply: raw.apply === true,
    deletions,
    maxDeleteFiles: optionalNumber(raw.maxDeleteFiles, 'mirror.maxDeleteFiles', 0) ?? DEFAULT_MAX_DELETE_FILES,
    maxDeleteBytes: optionalNumber(raw.maxDeleteBytes, 'mirror.maxDeleteBytes', 0) ?? DEFAULT_MAX_DELETE_BYTES
  };
  if (raw.path !== undefined) out.path = requireString(raw.path, 'mirror.path');
  if (raw.stagingPath !== undefined) out.stagingPath = requireString(raw.stagingPath, 'mirror.stagingPath');
  if (raw.quarantinePath !== undefined) {
    out.quarantinePath = requireString(raw.quarantinePath, 'mirror.quarantinePath');
  }
  if (out.enabled && !out.path) throw new Error('mirror.path is required when mirror.enabled is true');
  return out;
}

export function validateFileBackupConfig(input: unknown): FileBackupConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('File backup config must be a JSON object');
  }
  const raw = input as Record<string, unknown>;
  const type = raw.type ?? raw.kind;
  if (type !== 'backup-files') {
    throw new Error('File backup config type must be "backup-files"');
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    throw new Error('sources must be a non-empty array');
  }
  const sources = raw.sources.map((source, i) => requireString(source, `sources[${i}]`));
  const repo = requireString(raw.repo, 'repo');
  const excludes =
    raw.excludes === undefined
      ? []
      : Array.isArray(raw.excludes)
        ? raw.excludes.map((pattern, i) => requireString(pattern, `excludes[${i}]`))
        : (() => {
            throw new Error('excludes must be an array of strings');
          })();
  const onUnreadable = raw.onUnreadable ?? 'warn';
  if (onUnreadable !== 'warn' && onUnreadable !== 'fail') {
    throw new Error('onUnreadable must be "warn" or "fail"');
  }
  const chunkSize =
    optionalNumber(raw.chunkSize, 'chunkSize', MIN_FILE_CHUNK_SIZE, MAX_FILE_CHUNK_SIZE) ??
    DEFAULT_FILE_CHUNK_SIZE;
  const lockDays = optionalNumber(raw.lockDays, 'lockDays', 0) ?? 30;
  const mirror = normalizeMirror(raw.mirror);

  const config: FileBackupConfig = {
    type: 'backup-files',
    sources,
    repo,
    excludes,
    chunkSize,
    lockDays,
    onUnreadable
  };
  if (mirror) config.mirror = mirror;

  // Fail before any snapshot work when a configured source is missing.
  for (const source of sources) {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) throw new Error(`Source does not exist: ${source}`);
  }
  return config;
}

export function readFileBackupConfig(file: string): FileBackupConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    throw new Error(`Could not read config ${file}: ${(error as Error).message}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config is not valid JSON: ${file}`);
  }
  return validateFileBackupConfig(parsed);
}
