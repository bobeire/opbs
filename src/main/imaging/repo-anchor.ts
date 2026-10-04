import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  REPO_HEADER_NAME,
  REPO_JOURNAL_NAME,
  loadHeader,
  resolveRepoKey,
  verifyChain,
  verifySignatures,
  verifyRepository,
  type JournalRecord,
  type RepoKeyOptions,
  type VerifyOptions,
  type VerifyProblem,
  type VerifyResult
} from './repository';
import { resolveS3Config, S3Store, type S3Config } from '../utils/s3';
import { resolveSftpConfig, SftpStore, type SftpConfig } from '../utils/sftp';

/**
 * Off-box journal anchor.
 *
 * A repository journal is tamper-evident but not rollback-proof: an attacker
 * who can rewrite <repo>/opbs-repo.journal (and holds the key) can replay an
 * older, internally-consistent history. The fix is a snapshot of the header +
 * journal stored somewhere the attacker is assumed not to control.
 *
 * The anchor file (opbs-repo.anchor under <target>/<repoId>/) embeds the
 * exact header and journal text plus their SHA-256 checksums. Verification
 * compares the local files against that snapshot byte-for-byte:
 *   - local journal shorter than the anchor          → rollback
 *   - local journal diverges from the anchored text  → records rewritten
 *   - local header differs from the anchored header  → header swap
 *   - anchor's own checksums do not match its text   → anchor corrupted
 *   - embedded journal fails chain/signature checks  → forged anchor text
 *
 * Append-only history is fine: the anchored journal is always a byte-prefix
 * of the local one until the next anchor is written.
 *
 * Targets: a local directory (a second disk, a network share), s3://bucket/prefix
 * (ideally an Object-Lock bucket — Phase 3) or sftp://host/path. The target
 * must be writable by OPBS but not rewriteable by whoever can edit the
 * repository — that is the whole point; keep the credentials separate.
 */

export interface RepoAnchor {
  schema: 1;
  repoId: string;
  anchoredAt: string;
  headerSha256: string;
  journalSha256: string;
  /** Exact bytes of opbs-repo.json at anchor time. */
  header: string;
  /** Exact bytes of opbs-repo.journal at anchor time. */
  journal: string;
}

export interface AnchorTransportOptions {
  s3Profile?: Partial<S3Config>;
  sftpProfile?: Partial<SftpConfig>;
}

export interface AnchorWriteResult {
  target: string;
  repoId: string;
  seq: number;
  records: number;
  journalBytes: number;
  anchoredAt: string;
}

export interface AnchorCheckResult {
  ok: boolean;
  problems: VerifyProblem[];
  seq: number;
  records: number;
  anchoredAt: string;
}

export type VerifyWithAnchorResult = VerifyResult & {
  anchor: { ok: boolean; seq: number; records: number; anchoredAt: string };
};

const ANCHOR_NAME = 'opbs-repo.anchor';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function targetKind(target: string): 'local' | 's3' | 'sftp' {
  if (/^s3:\/\//i.test(target)) return 's3';
  if (/^sftp:\/\//i.test(target)) return 'sftp';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    throw new Error(`Unsupported anchor target scheme: ${target} (use a local directory, s3:// or sftp://)`);
  }
  return 'local';
}

function anchorKey(repoId: string): string {
  return `${repoId}/${ANCHOR_NAME}`;
}

function readRepoText(repoDir: string, name: string): string {
  try {
    return fs.readFileSync(path.join(repoDir, name), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name === REPO_JOURNAL_NAME) return '';
    throw new Error(`Not an OPBS repository (missing ${name}): ${repoDir}`, { cause: error });
  }
}

function parseJournalText(text: string): JournalRecord[] {
  const records: JournalRecord[] = [];
  const lines = text.split(/\r?\n/);
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

async function putAnchorText(target: string, repoId: string, text: string, opts: AnchorTransportOptions): Promise<void> {
  const kind = targetKind(target);
  if (kind === 'local') {
    const file = path.join(target, repoId, ANCHOR_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return;
  }
  const body = Buffer.from(text, 'utf-8');
  if (kind === 's3') {
    await new S3Store(resolveS3Config(opts.s3Profile, target)).put(anchorKey(repoId), body);
    return;
  }
  await new SftpStore({ config: resolveSftpConfig(opts.sftpProfile, target) }).put(anchorKey(repoId), body);
}

async function getAnchorText(target: string, repoId: string, opts: AnchorTransportOptions): Promise<string> {
  const kind = targetKind(target);
  if (kind === 'local') {
    return fs.readFileSync(path.join(target, repoId, ANCHOR_NAME), 'utf-8');
  }
  const key = anchorKey(repoId);
  if (kind === 's3') {
    return (await new S3Store(resolveS3Config(opts.s3Profile, target)).get(key)).toString('utf-8');
  }
  return (await new SftpStore({ config: resolveSftpConfig(opts.sftpProfile, target) }).get(key)).toString('utf-8');
}

/** Snapshot header + journal to the anchor target. Returns tail info. */
export async function writeRepositoryAnchor(
  repoDir: string,
  target: string,
  opts: RepoKeyOptions & AnchorTransportOptions = {}
): Promise<AnchorWriteResult> {
  const header = loadHeader(repoDir);
  const headerText = readRepoText(repoDir, REPO_HEADER_NAME);
  const journalText = readRepoText(repoDir, REPO_JOURNAL_NAME);
  const records = parseJournalText(journalText);
  const anchor: RepoAnchor = {
    schema: 1,
    repoId: header.id,
    anchoredAt: new Date().toISOString(),
    headerSha256: sha256(headerText),
    journalSha256: sha256(journalText),
    header: headerText,
    journal: journalText
  };
  await putAnchorText(target, header.id, JSON.stringify(anchor, null, 2), opts);
  return {
    target,
    repoId: header.id,
    seq: records.length === 0 ? 0 : records[records.length - 1].seq,
    records: records.length,
    journalBytes: Buffer.byteLength(journalText, 'utf-8'),
    anchoredAt: anchor.anchoredAt
  };
}

/** Fetch and structurally validate the anchor for this repository. */
export async function readRepositoryAnchor(
  target: string,
  repoId: string,
  opts: AnchorTransportOptions = {}
): Promise<RepoAnchor> {
  const anchor = JSON.parse(await getAnchorText(target, repoId, opts)) as RepoAnchor;
  if (anchor.schema !== 1 || !anchor.repoId || typeof anchor.header !== 'string' || typeof anchor.journal !== 'string') {
    throw new Error('Not an OPBS repository anchor (bad schema)');
  }
  return anchor;
}

/**
 * Compare the local header/journal against the anchored snapshot.
 * Read failures become an `anchor-missing` problem; content differences
 * become `anchor-mismatch`; chain/signature failures of the embedded
 * journal are reported as `chain`/`signature` with an "Anchored journal"
 * prefix.
 */
export async function checkRepositoryAnchor(
  repoDir: string,
  target: string,
  opts: RepoKeyOptions & AnchorTransportOptions = {}
): Promise<AnchorCheckResult> {
  const problems: VerifyProblem[] = [];
  const header = loadHeader(repoDir);

  let anchor: RepoAnchor;
  try {
    anchor = JSON.parse(await getAnchorText(target, header.id, opts)) as RepoAnchor;
    if (
      anchor.schema !== 1 ||
      !anchor.repoId ||
      typeof anchor.header !== 'string' ||
      typeof anchor.journal !== 'string'
    ) {
      throw new Error('bad schema');
    }
  } catch (error) {
    problems.push({
      kind: 'anchor-missing',
      detail: `No anchor at ${target}: ${error instanceof Error ? error.message : String(error)}`
    });
    return { ok: false, problems, seq: 0, records: 0, anchoredAt: '' };
  }

  let records: JournalRecord[] = [];
  try {
    records = parseJournalText(anchor.journal);
  } catch (error) {
    problems.push({
      kind: 'anchor-mismatch',
      detail: `Anchored journal is unreadable: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const seq = records.length === 0 ? 0 : records[records.length - 1].seq;
  const embeddedOk =
    sha256(anchor.header) === anchor.headerSha256 && sha256(anchor.journal) === anchor.journalSha256;

  if (!embeddedOk) {
    problems.push({
      kind: 'anchor-mismatch',
      detail: 'Anchor file checksum mismatch — the anchor itself was corrupted or edited'
    });
    return { ok: false, problems, seq, records: records.length, anchoredAt: anchor.anchoredAt };
  }

  if (anchor.repoId !== header.id) {
    problems.push({
      kind: 'anchor-mismatch',
      detail: `Anchor belongs to a different repository (${anchor.repoId} ≠ ${header.id})`
    });
    return { ok: false, problems, seq, records: records.length, anchoredAt: anchor.anchoredAt };
  }

  const headerText = readRepoText(repoDir, REPO_HEADER_NAME);
  if (anchor.header !== headerText) {
    problems.push({ kind: 'anchor-mismatch', detail: 'Repository header differs from the anchored header' });
  }

  const journalText = readRepoText(repoDir, REPO_JOURNAL_NAME);
  if (!journalText.startsWith(anchor.journal)) {
    if (anchor.journal.startsWith(journalText)) {
      problems.push({
        kind: 'anchor-mismatch',
        detail:
          `Local journal is shorter than the anchor (local ${Buffer.byteLength(journalText)} bytes, ` +
          `anchored ${Buffer.byteLength(anchor.journal)} bytes through seq ${seq}) — journal rolled back`
      });
    } else {
      problems.push({
        kind: 'anchor-mismatch',
        detail: 'Local journal diverges from the anchored journal — history was rewritten'
      });
    }
  }

  // Best-effort signature verification of the embedded snapshot (skipped
  // when the key is unavailable — the byte-prefix check already ran).
  if (records.length > 0) {
    try {
      const key = resolveRepoKey(header, opts);
      const chainError = verifyChain(records);
      if (chainError) problems.push({ kind: 'chain', detail: `Anchored journal: ${chainError}` });
      else {
        const sigError = verifySignatures(records, key);
        if (sigError) problems.push({ kind: 'signature', detail: `Anchored journal: ${sigError}` });
      }
    } catch {
      // Key unavailable — verifyRepository reports missing-key separately.
    }
  }

  return { ok: problems.length === 0, problems, seq, records: records.length, anchoredAt: anchor.anchoredAt };
}

/** Full local verification plus the anchor comparison, merged into one report. */
export async function verifyWithAnchor(
  repoDir: string,
  opts: VerifyOptions & { anchorTarget: string } & AnchorTransportOptions
): Promise<VerifyWithAnchorResult> {
  // s3Profile must reach BOTH the verify (S3-hosted repo image check) and the
  // anchor fetch — dropping it would silently fall back to AWS_* env.
  const { anchorTarget, sftpProfile, ...verifyOpts } = opts;
  const base = await verifyRepository(repoDir, verifyOpts);
  const check = await checkRepositoryAnchor(repoDir, anchorTarget, { ...verifyOpts, sftpProfile });
  const problems = [...base.problems, ...check.problems];
  return {
    ...base,
    ok: base.ok && check.ok,
    problems,
    anchor: { ok: check.ok, seq: check.seq, records: check.records, anchoredAt: check.anchoredAt }
  };
}
