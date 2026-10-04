import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3Store, resolveS3Config, type S3Config } from '../utils/s3';
import { unprotectFiles } from '../utils/file-protect';
import { REPO_HEADER_NAME, REPO_JOURNAL_NAME } from './repository';

/**
 * Repository-on-S3 support (Phase 3): the header, journal and image volumes
 * of a repository can live directly in an Object-Lock-enabled bucket instead
 * of a local directory.
 *
 * Model: `repo init s3://bucket/prefix` writes the header + empty journal
 * into the bucket (conditional `If-None-Match: *` so two inits cannot both
 * win). Every later operation *hydrates* — downloads the current header +
 * journal into a per-URI cache under `~/.opbs/cache/repos/<hash>` — runs the
 * existing local repository logic against that cache, and *flushes* on the
 * way out: any changed metadata file is uploaded with `If-Match` against the
 * ETag that was hydrated, so a concurrent writer anywhere gets a clear
 * conflict error instead of silently overwriting history.
 *
 * Image volumes are NOT cached: `backup --repo s3://…` stages them in the
 * cache's `images/` directory while the job runs, `recordImageCreate` uploads
 * them (the header's `remote` field points at the repository's own location)
 * and the staged copies are deleted after a successful flush. Verify checks
 * the bucket directly (list + streamed hashes), never local disk.
 *
 * Credentials never live in the header: `resolveS3Config` fills them from the
 * settings profile (GUI) or the `AWS_*` / `OPBS_S3_*` environment (CLI).
 */

export function isS3RepoTarget(target: string): boolean {
  return /^s3:\/\//i.test(target.trim());
}

function cacheDirFor(uri: string): string {
  const hash = crypto.createHash('sha256').update(uri.trim()).digest('hex').slice(0, 24);
  return path.join(process.env.OPBS_REPO_CACHE_DIR || path.join(os.homedir(), '.opbs', 'cache', 'repos'), hash);
}

/**
 * Each open session stages into its own subdirectory so two concurrent
 * sessions (e.g. a running backup and a `repo list`) never see each other's
 * unflushed metadata or staged images. Old session dirs (crashes leave them
 * behind) are swept on open.
 */
function sessionDirFor(base: string): string {
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('s-')) continue;
      const full = path.join(base, entry.name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600_000) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        // Best-effort sweep.
      }
    }
  } catch {
    // Base may not exist yet.
  }
  const name = `s-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(base, name);
}

interface HydratedMeta {
  bytes: Buffer;
  etag: string | null;
}

export interface RepoSession {
  /** The target as the user gave it (local directory or s3:// URI). */
  readonly target: string;
  /** Working directory holding header + journal (cache for S3 targets). */
  readonly dir: string;
  readonly isS3: boolean;
  readonly store: S3Store | undefined;
  /** Upload header/journal if they changed since hydration (conditional). */
  flush(): Promise<void>;
  /** Delete staged image volumes from the cache (after a successful flush). */
  cleanup(): Promise<void>;
}

export interface OpenRepoSessionOptions {
  /** S3 credentials for the app's cloud profile (GUI); omit for AWS_* env. */
  s3Profile?: Partial<S3Config>;
  /** Do not throw when the target has no header yet (repo init). */
  allowMissing?: boolean;
}

/**
 * Open a repository target for a command: local directories pass through
 * untouched; `s3://` targets are hydrated into the local cache.
 */
export async function openRepoSession(target: string, opts: OpenRepoSessionOptions = {}): Promise<RepoSession> {
  if (!isS3RepoTarget(target)) {
    return {
      target,
      dir: target,
      isS3: false,
      store: undefined,
      flush: async () => undefined,
      cleanup: async () => undefined
    };
  }

  const uri = target.trim();
  const store = new S3Store(resolveS3Config(opts.s3Profile, uri));
  const dir = sessionDirFor(cacheDirFor(uri));
  const hydrated: { header?: HydratedMeta; journal?: HydratedMeta } = {};

  const headerMeta = await store.head(REPO_HEADER_NAME);
  if (!headerMeta) {
    if (!opts.allowMissing) {
      throw new Error(`Not an OPBS repository (missing ${REPO_HEADER_NAME}): ${uri}`);
    }
    // Fresh target: stage header + empty journal for init to upload.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, REPO_HEADER_NAME), Buffer.alloc(0));
    fs.writeFileSync(path.join(dir, REPO_JOURNAL_NAME), Buffer.alloc(0));
  } else {
    const headerBytes = await store.get(REPO_HEADER_NAME);
    const journalMeta = await store.head(REPO_JOURNAL_NAME);
    const journalBytes = journalMeta ? await store.get(REPO_JOURNAL_NAME) : Buffer.alloc(0);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, REPO_HEADER_NAME), headerBytes);
    fs.writeFileSync(path.join(dir, REPO_JOURNAL_NAME), journalBytes);
    hydrated.header = { bytes: headerBytes, etag: headerMeta.etag || null };
    hydrated.journal = { bytes: journalBytes, etag: journalMeta?.etag || null };
  }

  const flush = async (): Promise<void> => {
    const entries: Array<[string, HydratedMeta | undefined, 'header' | 'journal']> = [
      [REPO_HEADER_NAME, hydrated.header, 'header'],
      [REPO_JOURNAL_NAME, hydrated.journal, 'journal']
    ];
    for (const [name, meta, slot] of entries) {
      if (!meta) continue;
      let current: Buffer;
      try {
        current = fs.readFileSync(path.join(dir, name));
      } catch {
        continue;
      }
      if (current.equals(meta.bytes)) continue;
      const result = await store.putIf(name, current, meta.etag ? { ifMatch: meta.etag } : { ifNoneMatch: true });
      if (!result) {
        throw new Error(
          `Repository changed in S3 while it was open (concurrent writer): ${name} — re-run the command`
        );
      }
      hydrated[slot] = { bytes: current, etag: result.etag || null };
    }
  };

  const cleanup = async (): Promise<void> => {
    // The whole session dir is disposable staging: hydrated metadata is
    // re-downloaded on the next open, staged volumes must go after a flush.
    try {
      const walk = (d: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) out.push(...walk(full));
          else out.push(full);
        }
        return out;
      };
      if (fs.existsSync(dir)) await unprotectFiles(walk(dir));
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: leftovers only cost disk and are invisible to verify.
    }
  };

  return { target: uri, dir, isS3: true, store, flush, cleanup };
}
