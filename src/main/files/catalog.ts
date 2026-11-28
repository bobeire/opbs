import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileRoots } from './crypto';
import {
  FILE_CATALOG_VERSION,
  type FileCatalogRecord,
  type FileCatalogRecordType
} from './types';

/** Append-only signed catalog for file snapshots (kept out of the image journal). */

export const FILE_CATALOG_NAME = 'opbs-files.journal';

export function fileCatalogPath(repoDir: string): string {
  return path.join(fileRoots(repoDir).catalog, FILE_CATALOG_NAME);
}

export function fileCatalogExists(repoDir: string): boolean {
  return fs.existsSync(fileCatalogPath(repoDir));
}

export function loadFileCatalog(repoDir: string): FileCatalogRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(fileCatalogPath(repoDir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: FileCatalogRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as FileCatalogRecord;
      if (record.schema !== undefined && record.schema !== FILE_CATALOG_VERSION) {
        throw new Error('unsupported schema');
      }
      records.push(record);
    } catch {
      throw new Error(`Corrupt file catalog line ${i + 1} in ${FILE_CATALOG_NAME}`);
    }
  }
  return records;
}

type UnsignedRecord = Omit<FileCatalogRecord, 'seq' | 'prev' | 'sig'>;

function canonicalRecord(record: Omit<FileCatalogRecord, 'sig'>): string {
  // Key insertion order is the canonical form; do not reorder.
  const out: Record<string, unknown> = {};
  if (record.schema !== undefined) out.schema = record.schema;
  out.seq = record.seq;
  out.type = record.type;
  out.at = record.at;
  out.id = record.id;
  const optional: Array<[keyof FileCatalogRecord, unknown]> = [
    ['snapshotFile', record.snapshotFile],
    ['manifestSha256', record.manifestSha256],
    ['encryptedSha256', record.encryptedSha256],
    ['files', record.files],
    ['bytes', record.bytes],
    ['lockUntil', record.lockUntil],
    ['reason', record.reason],
    ['targetKey', record.targetKey],
    ['run', record.run],
    ['report', record.report],
    ['policy', record.policy],
    ['dryRun', record.dryRun],
    ['added', record.added],
    ['changed', record.changed],
    ['deleted', record.deleted],
    ['quarantined', record.quarantined],
    ['chunksRemoved', record.chunksRemoved],
    ['bytesRemoved', record.bytesRemoved]
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) out[key] = value;
  }
  out.prev = record.prev;
  return JSON.stringify(out);
}

function signRecord(record: Omit<FileCatalogRecord, 'sig'>, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(canonicalRecord(record)).digest('hex');
}

export function verifyFileCatalogChain(records: readonly FileCatalogRecord[]): string | null {
  let prev = '';
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.seq !== i + 1) {
      return `File catalog sequence break at line ${i + 1}: expected seq ${i + 1}, found ${record.seq}`;
    }
    if ((record.prev ?? '') !== prev) {
      return `File catalog chain break at seq ${record.seq}`;
    }
    if (!record.sig || !/^[0-9a-f]{64}$/.test(record.sig)) {
      return `File catalog record seq ${record.seq} has an invalid signature field`;
    }
    const allowed: FileCatalogRecordType[] = ['snapshot', 'prune', 'mirror', 'mirror-state', 'gc'];
    if (!allowed.includes(record.type)) {
      return `File catalog record seq ${record.seq} has an unknown type: ${String(record.type)}`;
    }
    prev = record.sig;
  }
  return null;
}

export function verifyFileCatalogSignatures(records: readonly FileCatalogRecord[], key: Buffer): string | null {
  for (const record of records) {
    const { sig, ...rest } = record;
    if (signRecord(rest, key) !== sig) {
      return `File catalog signature mismatch at seq ${record.seq} (${record.type} ${record.id})`;
    }
  }
  return null;
}

function nextSeq(records: readonly FileCatalogRecord[]): number {
  return records.length === 0 ? 1 : records[records.length - 1].seq + 1;
}

function prevSig(records: readonly FileCatalogRecord[]): string {
  return records.length === 0 ? '' : records[records.length - 1].sig;
}

/** Append one signed record; the file is opened in append mode and fsync'd. */
export function appendFileCatalogRecord(
  repoDir: string,
  record: UnsignedRecord,
  key: Buffer
): FileCatalogRecord {
  const records = loadFileCatalog(repoDir);
  const chainError = verifyFileCatalogChain(records);
  if (chainError) throw new Error(chainError);
  const unsigned: Omit<FileCatalogRecord, 'sig'> = {
    ...record,
    seq: nextSeq(records),
    prev: prevSig(records)
  };
  const signed: FileCatalogRecord = { ...unsigned, sig: signRecord(unsigned, key) };
  const file = fileCatalogPath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(signed) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return signed;
}

/** Active snapshots are creates minus prunes; later records supersede earlier ones. */
export function activeSnapshotRecords(records: readonly FileCatalogRecord[]): FileCatalogRecord[] {
  const pruned = new Set(records.filter((r) => r.type === 'prune').map((r) => r.id));
  const active = new Map<string, FileCatalogRecord>();
  for (const record of records) {
    if (record.type !== 'snapshot' || pruned.has(record.id)) continue;
    active.set(record.id, record);
  }
  return [...active.values()];
}

/** Latest one-way mirror state per hashed target path. */
export function mirrorProtectedIds(records: readonly FileCatalogRecord[]): Set<string> {
  const protectedIds = new Set<string>();
  const latest = new Map<string, FileCatalogRecord>();
  for (const record of records) {
    if (record.type !== 'mirror-state' || !record.targetKey) continue;
    latest.set(record.targetKey, record);
  }
  for (const record of latest.values()) protectedIds.add(record.id);
  return protectedIds;
}
