import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { protectFiles, protectJournal, unprotectFiles } from '../utils/file-protect';
import type { S3Config } from '../utils/s3';
import {
  checkRemoteVolumes,
  deleteRemoteVolumes,
  listRemoteVolumes,
  remoteStore,
  uploadRemoteVolumes,
  type RepoRemoteConfig
} from './repo-remote';
import { isS3RepoTarget } from './repo-s3';

/**
 * Immutable repository format v1 (file-per-image).
 *
 * Layout:
 *   <repo>/opbs-repo.json     header — public metadata + KDF params, never secret
 *   <repo>/opbs-repo.journal  append-only JSONL chain of signed records
 *   <repo>/images/*.opbs      the image chains themselves
 *
 * Every journal record is HMAC-SHA256-signed over a canonical serialization
 * and links to the previous record's signature (`prev`), so any edit,
 * reordering or truncation of history breaks verification. Deleting image
 * files is caught by replaying the journal against the directory (missing
 * volumes); a rewritten journal without the key fails signature checks.
 * Full rollback by an attacker holding the key cannot be detected without an
 * external anchor — `repo anchor` / the Repositories view can push one
 * off-box (local directory, s3://, sftp://) and verification then catches
 * rolled-back or rewritten journals. Documented in the README.
 *
 * The signing key is never stored inside the repository: either a keyfile
 * outside it (default: ~/.opbs/repo-keys/<id>.key) or a passphrase-derived
 * PBKDF2 key (no file at all).
 */

export const REPO_HEADER_NAME = 'opbs-repo.json';
export const REPO_JOURNAL_NAME = 'opbs-repo.journal';
export const REPO_IMAGES_DIR = 'images';

export const DEFAULT_LOCK_DAYS = 30;
// PBKDF2-HMAC-SHA256 iterations for new repositories (OWASP 2023+ guidance).
// Stored in the repo header at init, so existing repositories keep deriving
// with their recorded count.
const KDF_ITERATIONS = 600_000;
const KEY_BYTES = 32;
const MS_PER_DAY = 86_400_000;

export interface RepoHeader {
  schema: 1;
  id: string;
  createdAt: string;
  algo: 'sha256';
  defaultLockDays: number;
  kdf: null | { alg: 'pbkdf2-sha256'; iterations: number; saltHex: string };
  keyId: string;
  /**
   * Optional S3 mirror for image volumes (`repo init --remote`). The journal
   * and header stay local; volumes are copied to `<uri>/images/<name>`,
   * optionally with S3 Object Lock retention equal to the journal lock.
   */
  remote?: RepoRemoteConfig;
}

export interface RepoVolume {
  name: string;
  size: number;
  sha256: string;
}

export type RepoRecordType = 'create' | 'prune' | 'unlock';

/** One journal record. Key order is the canonical order — do not reorder. */
export interface JournalRecord {
  seq: number;
  type: RepoRecordType;
  at: string;
  image: string;
  volumes?: RepoVolume[];
  bytes?: number;
  lock?: { until: string };
  /** Basename of the base image this delta builds on (incremental backups). */
  base?: string;
  prev: string;
  sig: string;
}

export interface RepoKeyOptions {
  passphrase?: string;
  keyfile?: string;
}

export interface RepoOpen {
  dir: string;
  header: RepoHeader;
  records: JournalRecord[];
}

const imagesDir = (repoDir: string): string => path.join(repoDir, REPO_IMAGES_DIR);
const headerPath = (repoDir: string): string => path.join(repoDir, REPO_HEADER_NAME);
const journalPath = (repoDir: string): string => path.join(repoDir, REPO_JOURNAL_NAME);

/** Directory holding externally-stored repository keyfiles. */
export function repoKeyDir(): string {
  return process.env.OPBS_REPO_KEY_DIR || path.join(os.homedir(), '.opbs', 'repo-keys');
}

export function isRepository(dir: string): boolean {
  try {
    return fs.statSync(headerPath(dir)).isFile();
  } catch {
    return false;
  }
}

export function loadHeader(repoDir: string): RepoHeader {
  let raw: string;
  try {
    raw = fs.readFileSync(headerPath(repoDir), 'utf-8');
  } catch {
    throw new Error(`Not an OPBS repository (missing ${REPO_HEADER_NAME}): ${repoDir}`);
  }
  const header = JSON.parse(raw) as RepoHeader;
  if (header.schema !== 1 || !header.id) {
    throw new Error(`Unsupported repository header in ${repoDir}`);
  }
  return header;
}

/** Parse the journal; a missing journal (fresh repo) yields []. */
export function loadJournal(repoDir: string): JournalRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath(repoDir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: JournalRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch {
      throw new Error(`Corrupt journal line ${i + 1} in ${REPO_JOURNAL_NAME}`);
    }
  }
  return records;
}

export function openRepository(repoDir: string): RepoOpen {
  return { dir: repoDir, header: loadHeader(repoDir), records: loadJournal(repoDir) };
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, KEY_BYTES, 'sha256');
}

function keyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function keyfilePathFor(header: RepoHeader, explicit?: string): string {
  if (explicit) return explicit;
  return path.join(repoKeyDir(), `${header.id}.key`);
}

/**
 * Resolve the signing key: explicit keyfile, passphrase, or the automatic
 * external keyfile for this repository's id. Throws a descriptive error.
 */
export function resolveRepoKey(header: RepoHeader, opts: RepoKeyOptions = {}): Buffer {
  if (opts.passphrase) {
    if (!header.kdf) {
      throw new Error('This repository uses a keyfile, not a passphrase.');
    }
    const key = deriveKey(opts.passphrase, Buffer.from(header.kdf.saltHex, 'hex'), header.kdf.iterations);
    if (keyFingerprint(key) !== header.keyId) {
      throw new Error('Wrong passphrase for this repository.');
    }
    return key;
  }
  const file = keyfilePathFor(header, opts.keyfile);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8').trim();
  } catch {
    throw new Error(
      `Repository key not found (looked for ${file}). Provide --keyfile or --passphrase.`
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(`Invalid keyfile format: ${file}`);
  }
  const key = Buffer.from(raw, 'hex');
  if (keyFingerprint(key) !== header.keyId) {
    throw new Error(`Keyfile does not match this repository: ${file}`);
  }
  return key;
}

/** True when the repository's key can be resolved without user input. */
export function hasRepositoryKey(header: RepoHeader, opts: RepoKeyOptions = {}): boolean {
  try {
    resolveRepoKey(header, opts);
    return true;
  } catch {
    return false;
  }
}

function canonicalRecord(record: Omit<JournalRecord, 'sig'>): string {
  // Key insertion order defines the canonical form.
  const out: Record<string, unknown> = {
    seq: record.seq,
    type: record.type,
    at: record.at,
    image: record.image
  };
  if (record.volumes) out.volumes = record.volumes;
  if (record.bytes !== undefined) out.bytes = record.bytes;
  if (record.lock) out.lock = record.lock;
  if (record.base) out.base = record.base;
  out.prev = record.prev;
  return JSON.stringify(out);
}

function signRecord(record: Omit<JournalRecord, 'sig'>, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(canonicalRecord(record)).digest('hex');
}

/** Structural chain check: seq continuity + prev links. No key needed. */
export function verifyChain(records: JournalRecord[]): string | null {
  let prev = '';
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.seq !== i + 1) {
      return `Journal sequence break at line ${i + 1}: expected seq ${i + 1}, found ${record.seq}`;
    }
    if ((record.prev ?? '') !== prev) {
      return `Journal chain break at seq ${record.seq}: prev link does not match previous signature`;
    }
    prev = record.sig || '';
    if (!record.sig || !/^[0-9a-f]{64}$/.test(record.sig)) {
      return `Journal record seq ${record.seq} has an invalid signature field`;
    }
  }
  return null;
}

/** Full signature verification (requires the repository key). */
export function verifySignatures(records: JournalRecord[], key: Buffer): string | null {
  for (const record of records) {
    const { sig, ...rest } = record;
    if (signRecord(rest, key) !== sig) {
      return `Journal signature mismatch at seq ${record.seq} (${record.type} ${record.image}) — tampering or wrong key`;
    }
  }
  return null;
}

/** All volume files of an image chain: main, .001… volumes, sidecars. */
export function imageVolumePaths(imagePath: string): string[] {
  const files = [imagePath];
  for (let i = 1; ; i++) {
    const vol = `${imagePath}.${String(i).padStart(3, '0')}`;
    if (!fs.existsSync(vol)) break;
    files.push(vol);
  }
  const sidecars = [`${imagePath}.bitlocker.json`, `${imagePath}.usn`];
  for (const sidecar of sidecars) {
    if (fs.existsSync(sidecar)) files.push(sidecar);
  }
  return files;
}

function hashFile(file: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve({ size: fs.statSync(file).size, sha256: hash.digest('hex') });
    });
  });
}

/** Hash every volume of an image chain (relative names, repo layout). */
export async function hashImageVolumes(imagePath: string): Promise<{ volumes: RepoVolume[]; bytes: number }> {
  const volumes: RepoVolume[] = [];
  let bytes = 0;
  for (const file of imageVolumePaths(imagePath)) {
    const { size, sha256 } = await hashFile(file);
    volumes.push({ name: path.basename(file), size, sha256 });
    bytes += size;
  }
  return { volumes, bytes };
}

/** Append a signed record (fsync'd) to the journal. */
export function appendJournalRecord(
  repoDir: string,
  record: Omit<JournalRecord, 'sig'>,
  key: Buffer
): JournalRecord {
  const signed: JournalRecord = { ...record, sig: signRecord(record, key) };
  const fd = fs.openSync(journalPath(repoDir), 'a');
  try {
    fs.writeSync(fd, JSON.stringify(signed) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return signed;
}

function nextSeq(records: JournalRecord[]): number {
  return records.length === 0 ? records.length + 1 : records[records.length - 1].seq + 1;
}

function prevSig(records: JournalRecord[]): string {
  return records.length === 0 ? '' : records[records.length - 1].sig;
}

export interface InitOptions extends RepoKeyOptions {
  lockDays?: number;
  /** Mirror image volumes to this s3:// location (checked on every verify). */
  remote?: { uri: string; lockMode?: 'GOVERNANCE' | 'COMPLIANCE' };
  /** S3 credentials for an `s3://` repository target (omit for AWS_* env fallback). */
  s3Profile?: Partial<S3Config>;
}

export interface InitResult {
  header: RepoHeader;
  keyfilePath?: string;
}

/**
 * Validate init options, derive the signing key (keyfile write or KDF salt)
 * and build the header. Shared by the local and S3 init paths so both stay
 * byte-identical apart from where the header lands.
 */
function buildInitState(opts: InitOptions): { header: RepoHeader; keyfilePath?: string } {
  const id = crypto.randomUUID();
  const lockDays = opts.lockDays ?? DEFAULT_LOCK_DAYS;
  if (!Number.isFinite(lockDays) || lockDays < 0) {
    throw new Error('--lock-days must be a non-negative number');
  }
  if (opts.remote) {
    if (!/^s3:\/\//i.test(opts.remote.uri)) {
      throw new Error(`--remote must be an s3:// location: ${opts.remote.uri}`);
    }
    if (opts.remote.lockMode && opts.remote.lockMode !== 'GOVERNANCE' && opts.remote.lockMode !== 'COMPLIANCE') {
      throw new Error(`Invalid --remote-lock mode: ${opts.remote.lockMode} (use GOVERNANCE or COMPLIANCE)`);
    }
  }

  let kdf: RepoHeader['kdf'] = null;
  let key: Buffer;
  let keyfilePath: string | undefined;
  if (opts.passphrase) {
    const salt = crypto.randomBytes(16);
    kdf = { alg: 'pbkdf2-sha256', iterations: KDF_ITERATIONS, saltHex: salt.toString('hex') };
    key = deriveKey(opts.passphrase, salt, KDF_ITERATIONS);
  } else {
    key = crypto.randomBytes(KEY_BYTES);
    keyfilePath = keyfilePathFor({ id } as RepoHeader, opts.keyfile);
    fs.mkdirSync(path.dirname(keyfilePath), { recursive: true });
    if (fs.existsSync(keyfilePath)) {
      throw new Error(`Keyfile already exists: ${keyfilePath}`);
    }
    fs.writeFileSync(keyfilePath, key.toString('hex') + '\n', { mode: 0o600 });
  }

  const header: RepoHeader = {
    schema: 1,
    id,
    createdAt: new Date().toISOString(),
    algo: 'sha256',
    defaultLockDays: lockDays,
    kdf,
    keyId: keyFingerprint(key),
    ...(opts.remote ? { remote: opts.remote } : {})
  };
  return { header, keyfilePath };
}

/** Create a new repository. Refuses to run twice over the same directory. */
export async function initRepository(repoDir: string, opts: InitOptions = {}): Promise<InitResult> {
  if (isS3RepoTarget(repoDir)) {
    return initRepositoryS3(repoDir.trim(), opts);
  }
  if (isRepository(repoDir)) {
    throw new Error(`Already an OPBS repository: ${repoDir}`);
  }
  if (fs.existsSync(headerPath(repoDir)) || fs.existsSync(path.join(repoDir, REPO_JOURNAL_NAME))) {
    throw new Error(`Repository files already exist in ${repoDir}`);
  }
  const { header, keyfilePath } = buildInitState(opts);

  fs.mkdirSync(imagesDir(repoDir), { recursive: true });
  fs.writeFileSync(headerPath(repoDir), JSON.stringify(header, null, 2) + '\n');
  fs.writeFileSync(journalPath(repoDir), '');

  await protectFiles([headerPath(repoDir)]);
  await protectJournal(journalPath(repoDir));

  return { header, keyfilePath };
}

/**
 * `repo init s3://bucket/prefix`: the header + empty journal are written
 * straight into the bucket (both with `If-None-Match: *` so concurrent inits
 * cannot both win) and, when `--remote-lock` is set, with Object Lock
 * retention so past header/journal versions cannot be purged from the
 * bucket's version history either. Image volumes later live under the same
 * location (`header.remote`), uploaded with the same lock mode.
 */
async function initRepositoryS3(uri: string, opts: InitOptions): Promise<InitResult> {
  if (opts.remote?.uri && opts.remote.uri.trim() !== uri) {
    throw new Error(`--remote (${opts.remote.uri}) cannot point away from the repository target (${uri})`);
  }
  const remote: RepoRemoteConfig = {
    uri,
    ...(opts.remote?.lockMode ? { lockMode: opts.remote.lockMode } : {})
  };
  const store = remoteStore(remote, opts.s3Profile);
  const existing = await store.head(REPO_HEADER_NAME);
  if (existing) {
    throw new Error(`Already an OPBS repository: ${uri}`);
  }
  const { header, keyfilePath } = buildInitState({ ...opts, remote });
  const objectLock =
    header.remote?.lockMode && header.defaultLockDays > 0
      ? {
          mode: header.remote.lockMode,
          retainUntil: new Date(Date.now() + header.defaultLockDays * MS_PER_DAY).toISOString()
        }
      : undefined;
  const created = await store.putIf(REPO_HEADER_NAME, Buffer.from(JSON.stringify(header, null, 2) + '\n'), {
    ifNoneMatch: true,
    ...(objectLock ? { objectLock } : {})
  });
  if (!created) {
    throw new Error(`Already an OPBS repository: ${uri}`);
  }
  let journal: { etag: string } | null;
  try {
    journal = await store.putIf(REPO_JOURNAL_NAME, Buffer.alloc(0), {
      ifNoneMatch: true,
      ...(objectLock ? { objectLock } : {})
    });
  } catch (error) {
    // Never leave a header without its journal.
    await store.delete(REPO_HEADER_NAME).catch(() => undefined);
    throw error;
  }
  if (!journal) {
    await store.delete(REPO_HEADER_NAME).catch(() => undefined);
    throw new Error(`A journal already exists at ${uri} without a header — remove it or choose another location`);
  }
  return { header, keyfilePath };
}

export interface RepoImageState {
  name: string;
  active: boolean;
  created: string;
  lockUntil: string | null;
  expired: boolean;
  unlocked: boolean;
  bytes: number;
  base?: string;
  filesPresent: boolean;
}

/** Recompute per-image state by replaying the journal. */
export function repoImageStates(records: JournalRecord[]): RepoImageState[] {
  const states = new Map<string, RepoImageState>();
  const now = Date.now();
  for (const record of records) {
    if (record.type === 'create') {
      states.set(record.image, {
        name: record.image,
        active: true,
        created: record.at,
        lockUntil: record.lock?.until ?? null,
        expired: record.lock ? Date.parse(record.lock.until) <= now : true,
        unlocked: false,
        bytes: record.bytes ?? 0,
        base: record.base,
        filesPresent: false
      });
    } else if (record.type === 'prune') {
      const state = states.get(record.image);
      if (state) state.active = false;
    } else if (record.type === 'unlock') {
      if (record.image === '*') {
        for (const state of states.values()) {
          if (state.active) state.unlocked = true;
        }
      } else {
        const state = states.get(record.image);
        if (state) state.unlocked = true;
      }
    }
  }
  return [...states.values()];
}

/** Chain membership via base links: root name -> all its deltas. */
export function chainDescendants(states: RepoImageState[]): Map<string, string[]> {
  const byName = new Map(states.map((s) => [s.name, s]));
  const children = new Map<string, string[]>();
  for (const state of states) {
    if (!state.base) continue;
    if (!byName.has(state.base)) continue;
    const list = children.get(state.base) ?? [];
    list.push(state.name);
    children.set(state.base, list);
  }
  // Resolve transitive chains (delta of delta).
  const roots = states.filter((s) => !s.base).map((s) => s.name);
  const chains = new Map<string, string[]>();
  const walk = (name: string): string[] => {
    const out: string[] = [];
    for (const child of children.get(name) ?? []) {
      out.push(child, ...walk(child));
    }
    return out;
  };
  for (const root of roots) {
    chains.set(root, walk(root));
  }
  return chains;
}

export interface RepoOverview {
  header: RepoHeader;
  /** Total journal records (create + prune + unlock). */
  recordCount: number;
  chainOk: boolean;
  /** The signing key resolves right now (keyfile present / passphrase given). */
  keyAvailable: boolean;
  /** Active images (pruned ones filtered out), with file-presence checked. */
  states: RepoImageState[];
  /** *.opbs files on disk with no active journal record. */
  orphanCount: number;
}

/** Names/sizes of the repository's image objects — a bucket listing for S3 repositories, precomputed by the caller (repoOverview stays synchronous). */
export interface RepoImageIndex {
  names: Set<string>;
  sizes: Map<string, number>;
}

/**
 * Cheap repository snapshot for the GUI: journal replay + file existence only,
 * no hashing or signature verification (`verifyRepository` does that).
 *
 * For repositories living in S3 the caller passes `imageIndex` (one
 * ListObjectsV2 of the `images/` prefix) — presence and orphan counting then
 * run against the bucket instead of local disk.
 */
export function repoOverview(
  repoDir: string,
  opts: RepoKeyOptions & { imageIndex?: RepoImageIndex } = {}
): RepoOverview {
  const header = loadHeader(repoDir);
  const records = loadJournal(repoDir);
  const chainError = verifyChain(records);
  const states = repoImageStates(records).filter((s) => s.active);

  const lastCreate = new Map<string, JournalRecord>();
  for (const record of records) {
    if (record.type === 'create') lastCreate.set(record.image, record);
  }
  for (const state of states) {
    const volumes = lastCreate.get(state.name)?.volumes ?? [];
    state.filesPresent =
      volumes.length > 0 &&
      volumes.every((volume) =>
        opts.imageIndex ? opts.imageIndex.sizes.has(volume.name) : fs.existsSync(path.join(imagesDir(repoDir), volume.name))
      );
  }

  let orphanCount = 0;
  const referenced = new Set(states.map((s) => s.name));
  const imageNames = opts.imageIndex
    ? [...opts.imageIndex.names]
    : (() => {
        try {
          return fs.readdirSync(imagesDir(repoDir));
        } catch {
          // Missing images directory — verify reports it properly.
          return [] as string[];
        }
      })();
  for (const name of imageNames) {
    if (!/\.(opbs|opbs\.\d{3}|opbs\.bitlocker\.json|opbs\.usn)$/i.test(name)) continue;
    const base = name.replace(/\.(bitlocker\.json|usn)$/, '').replace(/\.(\d{3})$/, '');
    if (!referenced.has(base)) orphanCount++;
  }

  return {
    header,
    recordCount: records.length,
    chainOk: !chainError,
    keyAvailable: hasRepositoryKey(header, opts),
    states,
    orphanCount
  };
}

export interface CreateResult {
  record: JournalRecord;
  lockUntil: string;
}

export interface RecordCreateOptions {
  lockDays?: number;
  /** Basename of the base image for incremental backups (chain bookkeeping). */
  base?: string;
  /** S3 credentials for the header's mirror (omit for AWS_* env fallback). */
  s3Profile?: Partial<S3Config>;
}

/** Record a freshly-written image as immutable until `lockDays` from now. */
export async function recordImageCreate(
  repoDir: string,
  header: RepoHeader,
  key: Buffer,
  imagePath: string,
  opts: RecordCreateOptions = {}
): Promise<CreateResult> {
  const name = path.basename(imagePath);
  const { volumes, bytes } = await hashImageVolumes(imagePath);
  const days = opts.lockDays ?? header.defaultLockDays;
  if (!Number.isFinite(days) || days < 0) {
    throw new Error('--lock-days must be a non-negative number');
  }
  const until = new Date(Date.now() + days * MS_PER_DAY).toISOString();
  const base = opts.base ? path.basename(opts.base) : undefined;

  // Mirror FIRST: a failed upload must never leave a journaled image without
  // its remote copy (ordering rule — see repo-remote.ts).
  if (header.remote) {
    const store = remoteStore(header.remote, opts.s3Profile);
    await uploadRemoteVolumes(store, header.remote, volumes, imagesDir(repoDir), days > 0 ? until : undefined);
  }

  const records = loadJournal(repoDir);
  const record = appendJournalRecord(
    repoDir,
    {
      seq: nextSeq(records),
      type: 'create',
      at: new Date().toISOString(),
      image: name,
      volumes,
      bytes,
      lock: { until },
      ...(base && base !== name ? { base } : {}),
      prev: prevSig(records)
    },
    key
  );

  await protectFiles(volumes.map((v) => path.join(imagesDir(repoDir), v.name)));
  return { record, lockUntil: until };
}

export interface VerifyOptions extends RepoKeyOptions {
  fast?: boolean;
  /** Optional per-stage progress sink (GUI progress line). */
  onProgress?: (message: string) => void;
  /** S3 credentials for the header's mirror (omit for AWS_* env fallback). */
  s3Profile?: Partial<S3Config>;
  /**
   * The repository itself lives in S3 (session-hydrated): images are listed
   * and hashed in the bucket, and local-disk checks are skipped entirely.
   */
  remoteOnly?: boolean;
}

export interface VerifyProblem {
  kind:
    | 'chain'
    | 'signature'
    | 'missing-key'
    | 'missing-file'
    | 'size-mismatch'
    | 'hash-mismatch'
    | 'orphan'
    | 'anchor-missing'
    | 'anchor-mismatch'
    | 'remote-missing'
    | 'remote-size'
    | 'remote-error';
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: VerifyProblem[];
  states: RepoImageState[];
  signaturesVerified: boolean;
}

/**
 * Full repository verification:
 *  1. journal chain structure (always)
 *  2. signatures (requires key)
 *  3. every active image's volumes exist with the recorded size,
 *     and (unless fast) the recorded sha256 — catches silent encryption
 *  4. images on disk not in the journal (catches journal truncation)
 *  5. pruned images whose files reappeared
 */
export async function verifyRepository(repoDir: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const header = loadHeader(repoDir);
  const records = loadJournal(repoDir);
  const problems: VerifyProblem[] = [];

  opts.onProgress?.('Checking journal chain…');
  const chainError = verifyChain(records);
  if (chainError) problems.push({ kind: 'chain', detail: chainError });

  let signaturesVerified = false;
  if (!chainError) {
    opts.onProgress?.('Verifying journal signatures…');
    let key: Buffer | null = null;
    try {
      key = resolveRepoKey(header, opts);
    } catch {
      problems.push({
        kind: 'missing-key',
        detail: 'Repository key unavailable — signatures and hashes not verified (pass --keyfile/--passphrase)'
      });
    }
    if (key) {
      const sigError = verifySignatures(records, key);
      if (sigError) problems.push({ kind: 'signature', detail: sigError });
      else signaturesVerified = true;
    }
  }

  const states = repoImageStates(records);
  const active = states.filter((s) => s.active);
  const pruned = states.filter((s) => !s.active);
  const referencedActive = new Set<string>();
  const referencedPruned = new Set<string>();

  const byName = new Map<string, JournalRecord[]>();
  for (const record of records) {
    if (record.type !== 'create') continue;
    const list = byName.get(record.image) ?? [];
    list.push(record);
    byName.set(record.image, list);
  }

  if (!opts.remoteOnly) {
    opts.onProgress?.('Checking image files…');
    for (const state of active) {
      const creates = byName.get(state.name) ?? [];
      const volumes = creates[creates.length - 1]?.volumes ?? [];
      referencedActive.add(state.name);
      for (const volume of volumes) {
        state.filesPresent = true;
        const file = path.join(imagesDir(repoDir), volume.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          problems.push({ kind: 'missing-file', detail: `Missing image file: ${volume.name}` });
          continue;
        }
        if (stat.size !== volume.size) {
          problems.push({
            kind: 'size-mismatch',
            detail: `${volume.name}: size ${stat.size}, journal says ${volume.size}`
          });
          continue;
        }
        if (!opts.fast && signaturesVerified) {
          opts.onProgress?.(`Hashing ${volume.name}…`);
          const { sha256 } = await hashFile(file);
          if (sha256 !== volume.sha256) {
            problems.push({
              kind: 'hash-mismatch',
              detail: `${volume.name}: content hash differs from journal — file was modified`
            });
          }
        }
      }
    }

    for (const state of pruned) {
      referencedPruned.add(state.name);
      const creates = byName.get(state.name) ?? [];
      const volumes = creates[creates.length - 1]?.volumes ?? [];
      for (const volume of volumes) {
        const file = path.join(imagesDir(repoDir), volume.name);
        if (fs.existsSync(file)) {
          problems.push({
            kind: 'orphan',
            detail: `${volume.name}: pruned in journal but still present on disk`
          });
        }
      }
    }

    // Journal truncation / foreign files: *.opbs on disk with no active record.
    opts.onProgress?.('Scanning for orphaned files…');
    try {
      for (const name of fs.readdirSync(imagesDir(repoDir))) {
        if (!/\.(opbs|opbs\.\d{3}|opbs\.bitlocker\.json|opbs\.usn)$/i.test(name)) continue;
        const base = name.replace(/\.(bitlocker\.json|usn)$/, '').replace(/\.(\d{3})$/, '');
        if (referencedActive.has(base)) continue;
        problems.push({ kind: 'orphan', detail: `File not in journal: ${name}` });
      }
    } catch {
      problems.push({ kind: 'missing-file', detail: `Missing images directory: ${imagesDir(repoDir)}` });
    }
  } else {
    for (const state of active) {
      referencedActive.add(state.name);
    }
    for (const state of pruned) {
      referencedPruned.add(state.name);
    }
  }

  // S3 mirror presence/size (cheap ListObjectsV2 — the local copies stay the
  // hash-verified originals; Object Lock protects the mirror bytes).
  if (header.remote && !opts.remoteOnly) {
    opts.onProgress?.('Checking S3 mirror…');
    try {
      const store = remoteStore(header.remote, opts.s3Profile);
      const mirrored: Array<{ name: string; size: number }> = [];
      for (const state of active) {
        const creates = byName.get(state.name) ?? [];
        for (const volume of creates[creates.length - 1]?.volumes ?? []) {
          mirrored.push({ name: volume.name, size: volume.size });
        }
      }
      const findings = await checkRemoteVolumes(store, mirrored);
      for (const finding of findings) {
        problems.push({
          kind: finding.kind === 'missing' ? 'remote-missing' : 'remote-size',
          detail: finding.detail
        });
      }
    } catch (error) {
      problems.push({
        kind: 'remote-error',
        detail: `S3 mirror check failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  // Repository hosted in S3: the bucket IS the image store. One listing
  // covers presence, sizes, pruned-but-present and never-referenced objects;
  // full verification additionally streams each active volume's hash.
  if (opts.remoteOnly) {
    if (!header.remote) {
      problems.push({
        kind: 'remote-error',
        detail: 'S3 repository header has no storage location (remote) — cannot check images'
      });
    } else {
      opts.onProgress?.('Listing images in S3…');
      try {
        const store = remoteStore(header.remote, opts.s3Profile);
        const listed = await listRemoteVolumes(store);
        for (const state of active) {
          const creates = byName.get(state.name) ?? [];
          const volumes = creates[creates.length - 1]?.volumes ?? [];
          let present = volumes.length > 0;
          for (const volume of volumes) {
            const size = listed.get(volume.name);
            if (size === undefined) {
              present = false;
              problems.push({ kind: 'remote-missing', detail: `S3 repository object missing: ${volume.name}` });
              continue;
            }
            if (size !== volume.size) {
              problems.push({
                kind: 'remote-size',
                detail: `${volume.name}: size ${size}, journal says ${volume.size}`
              });
              continue;
            }
            if (!opts.fast && signaturesVerified) {
              opts.onProgress?.(`Hashing ${volume.name} (S3)…`);
              const { sha256 } = await store.hashObject(`images/${volume.name}`);
              if (sha256 !== volume.sha256) {
                problems.push({
                  kind: 'hash-mismatch',
                  detail: `${volume.name}: content hash differs from journal — object was modified`
                });
              }
            }
          }
          if (present) state.filesPresent = true;
        }
        for (const state of pruned) {
          const creates = byName.get(state.name) ?? [];
          for (const volume of creates[creates.length - 1]?.volumes ?? []) {
            if (listed.has(volume.name)) {
              problems.push({
                kind: 'orphan',
                detail: `${volume.name}: pruned in journal but still present in S3`
              });
            }
          }
        }
        for (const name of listed.keys()) {
          if (!/\.(opbs|opbs\.\d{3}|opbs\.bitlocker\.json|opbs\.usn)$/i.test(name)) continue;
          const base = name.replace(/\.(bitlocker\.json|usn)$/, '').replace(/\.(\d{3})$/, '');
          if (referencedActive.has(base) || referencedPruned.has(base)) continue;
          problems.push({ kind: 'orphan', detail: `File not in journal: ${name}` });
        }
      } catch (error) {
        problems.push({
          kind: 'remote-error',
          detail: `S3 repository image check failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, states, signaturesVerified };
}

export interface PrunePlanEntry {
  name: string;
  reason: string;
  bytes: number;
}

export interface PruneResult {
  dryRun: boolean;
  eligible: PrunePlanEntry[];
  skipped: PrunePlanEntry[];
  removed: PrunePlanEntry[];
  dryRunOnly?: boolean;
}

/**
 * Prune images whose immutability window has passed (or that were explicitly
 * unlocked). A chain root only goes once every one of its deltas is eligible
 * too, so a locked delta never loses its base.
 */
export async function pruneRepository(
  repoDir: string,
  opts: RepoKeyOptions & { dryRun?: boolean; s3Profile?: Partial<S3Config>; remoteOnly?: boolean } = {}
): Promise<PruneResult> {
  const header = loadHeader(repoDir);
  const records = loadJournal(repoDir);
  const chainError = verifyChain(records);
  if (chainError) throw new Error(`Refusing to prune: ${chainError}`);

  let key: Buffer | null = null;
  if (!opts.dryRun) {
    key = resolveRepoKey(header, opts);
    const sigError = verifySignatures(records, key);
    if (sigError) throw new Error(`Refusing to prune: ${sigError}`);
  }

  const states = repoImageStates(records).filter((s) => s.active);
  const chains = chainDescendants(states);
  const byName = new Map(states.map((s) => [s.name, s]));

  const eligibleSet = new Set<string>();
  for (const state of states) {
    if (state.expired || state.unlocked) eligibleSet.add(state.name);
  }

  const eligible: PrunePlanEntry[] = [];
  const skipped: PrunePlanEntry[] = [];
  for (const state of states) {
    const reason = state.unlocked
      ? 'unlocked'
      : state.expired
        ? `lock expired ${state.lockUntil ?? ''}`.trim()
        : null;
    if (!reason) {
      skipped.push({ name: state.name, reason: `locked until ${state.lockUntil}`, bytes: state.bytes });
      continue;
    }
    if (!state.base) {
      // Root: every delta in its chain must be eligible as well.
      const deltas = chains.get(state.name) ?? [];
      const blocked = deltas.filter((name) => !eligibleSet.has(name));
      if (blocked.length > 0) {
        skipped.push({
          name: state.name,
          reason: `waiting for ${blocked.length} locked delta(s): ${blocked.join(', ')}`,
          bytes: state.bytes
        });
        continue;
      }
    }
    eligible.push({ name: state.name, reason, bytes: state.bytes });
  }

  if (opts.dryRun) {
    return { dryRun: true, eligible, skipped, removed: [] };
  }

  const keyBuf = key as Buffer;
  const removed: PrunePlanEntry[] = [];
  // Delete deltas before roots so partial failure never orphans a live delta.
  const ordered = [...eligible].sort((a, b) => (byName.get(a.name)?.base ? 0 : 1) - (byName.get(b.name)?.base ? 0 : 1));
  for (const entry of ordered) {
    const creates = records.filter((r) => r.type === 'create' && r.image === entry.name);
    const volumes = creates[creates.length - 1]?.volumes ?? [];
    // Remote copy first: if Object Lock still refuses the delete, the image
    // stays fully intact (local files untouched, journal record untouched).
    if (header.remote && volumes.length > 0) {
      const store = remoteStore(header.remote, opts.s3Profile);
      await deleteRemoteVolumes(
        store,
        volumes.map((v) => v.name)
      );
    }
    // S3-hosted repositories have no local copies to remove — the remote
    // delete above already was the real one.
    if (!opts.remoteOnly) {
      const files = volumes.map((v) => path.join(imagesDir(repoDir), v.name));
      await unprotectFiles(files);
      for (const file of files) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          throw new Error(`Failed to delete ${file}`, { cause: error });
        }
      }
    }
    const current = loadJournal(repoDir);
    appendJournalRecord(
      repoDir,
      {
        seq: nextSeq(current),
        type: 'prune',
        at: new Date().toISOString(),
        image: entry.name,
        prev: prevSig(current)
      },
      keyBuf
    );
    removed.push(entry);
  }
  return { dryRun: false, eligible, skipped, removed };
}

/** Explicitly unlock image(s): audited journal record + remove OS protection. */
export async function unlockRepository(
  repoDir: string,
  target: string,
  opts: RepoKeyOptions & { remoteOnly?: boolean } = {}
): Promise<string[]> {
  const header = loadHeader(repoDir);
  const records = loadJournal(repoDir);
  const chainError = verifyChain(records);
  if (chainError) throw new Error(`Refusing to unlock: ${chainError}`);
  const key = resolveRepoKey(header, opts);
  const sigError = verifySignatures(records, key);
  if (sigError) throw new Error(`Refusing to unlock: ${sigError}`);

  const states = repoImageStates(records).filter((s) => s.active);
  const wanted =
    target === '*'
      ? states.filter((s) => !s.unlocked).map((s) => s.name)
      : states.filter((s) => s.name === target || s.name === path.basename(target)).map((s) => s.name);

  if (target !== '*' && wanted.length === 0) {
    const known = states.find((s) => s.name.includes(path.basename(target)));
    throw new Error(
      known
        ? `Image is already unlocked or pruned: ${path.basename(target)}`
        : `No active image named ${path.basename(target)} in this repository`
    );
  }

  const unlocked: string[] = [];
  for (const name of wanted) {
    const creates = records.filter((r) => r.type === 'create' && r.image === name);
    const volumes = creates[creates.length - 1]?.volumes ?? [];
    if (!opts.remoteOnly) {
      await unprotectFiles(volumes.map((v) => path.join(imagesDir(repoDir), v.name)));
    }
    const current = loadJournal(repoDir);
    appendJournalRecord(
      repoDir,
      {
        seq: nextSeq(current),
        type: 'unlock',
        at: new Date().toISOString(),
        image: name,
        prev: prevSig(current)
      },
      key
    );
    unlocked.push(name);
  }
  if (target === '*' && unlocked.length === 0) {
    // All already unlocked — record a repo-wide marker for audit continuity.
    const current = loadJournal(repoDir);
    appendJournalRecord(
      repoDir,
      {
        seq: nextSeq(current),
        type: 'unlock',
        at: new Date().toISOString(),
        image: '*',
        prev: prevSig(current)
      },
      key
    );
  }
  return unlocked;
}
