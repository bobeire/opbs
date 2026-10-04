import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import {
  initRepository,
  loadJournal,
  resolveRepoKey,
  recordImageCreate,
  verifyRepository,
  pruneRepository,
  unlockRepository,
  repoOverview,
  type RepoImageIndex
} from '../../src/main/imaging/repository';
import { openRepoSession, isS3RepoTarget, type RepoSession } from '../../src/main/imaging/repo-s3';
import { listRemoteVolumes, remoteStore } from '../../src/main/imaging/repo-remote';
import { writeRepositoryAnchor, verifyWithAnchor } from '../../src/main/imaging/repo-anchor';
import { unprotectFiles } from '../../src/main/utils/file-protect';
import type { S3Config } from '../../src/main/utils/s3';

// init/record/prune spawn PowerShell for ACL updates.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-s3repo-test-'));
  tempDirs.push(dir);
  return dir;
}

async function removeTree(dir: string): Promise<void> {
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  if (fs.existsSync(dir)) {
    await unprotectFiles(walk(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTree));
});

interface MockS3 {
  objects: Map<string, Buffer>;
  etags: Map<string, string>;
  putHeaders: Map<string, http.IncomingHttpHeaders>;
  lockedKeys: Set<string>;
  failPut: boolean;
  putCount: () => number;
}

describe('repository on S3 (Phase 3)', () => {
  let server: http.Server;
  let baseUrl: string;
  let objects: Map<string, Buffer>;
  let etags: Map<string, string>;
  let putHeaders: Map<string, http.IncomingHttpHeaders>;
  let lockedKeys: Set<string>;
  let failPut: boolean;
  let puts = 0;

  const profile: Partial<S3Config> = {
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'secret',
    endpoint: '',
    forcePathStyle: true
  };
  const uri = 's3://repo-bucket/phase3';

  beforeAll(async () => {
    objects = new Map();
    etags = new Map();
    putHeaders = new Map();
    lockedKeys = new Set();
    failPut = false;
    puts = 0;
    process.env.OPBS_REPO_CACHE_DIR = path.join(os.tmpdir(), `opbs-s3repo-cache-${Date.now()}`);

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const key = decodeURIComponent(url.pathname.replace(/^\/[^/]*\//, '').replace(/^\//, ''));
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
          .join('');
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
        return;
      }
      if (req.method === 'HEAD') {
        const data = objects.get(key);
        if (!data) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Length': String(data.length), ETag: etags.get(key) ?? '' });
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          if (failPut) {
            res.writeHead(500);
            res.end('injected failure');
            return;
          }
          const ifNoneMatch = req.headers['if-none-match'];
          const ifMatch = req.headers['if-match'];
          const exists = objects.has(key);
          // S3 conditional semantics: If-None-Match: * only creates,
          // If-Match: <etag> only overwrites the exact version.
          if (ifNoneMatch === '*' && exists) {
            res.writeHead(412);
            res.end('PreconditionFailed');
            return;
          }
          if (ifMatch && (ifMatch !== '*' ? ifMatch !== etags.get(key) : !exists)) {
            res.writeHead(412);
            res.end('PreconditionFailed');
            return;
          }
          const body = Buffer.concat(chunks);
          objects.set(key, body);
          const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
          etags.set(key, etag);
          putHeaders.set(key, req.headers);
          puts++;
          res.writeHead(200, { ETag: etag });
          res.end();
        });
        return;
      }
      if (req.method === 'DELETE') {
        if (lockedKeys.has(key)) {
          res.writeHead(403, { 'Content-Type': 'application/xml' });
          res.end('<Error><Code>AccessDenied</Code><Message>Access Denied because object under legal hold</Message></Error>');
          return;
        }
        const existed = objects.delete(key);
        etags.delete(key);
        res.writeHead(existed ? 204 : 404);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const data = objects.get(key);
        if (data) {
          res.writeHead(200, { ETag: etags.get(key) ?? '' });
          res.end(data);
        } else {
          res.writeHead(404);
          res.end('NoSuchKey');
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    profile.endpoint = baseUrl;
  });

  afterAll(() => {
    server.close();
    delete process.env.OPBS_REPO_CACHE_DIR;
  });

  function resetMock(): void {
    objects.clear();
    etags.clear();
    putHeaders.clear();
    lockedKeys.clear();
    failPut = false;
    puts = 0;
  }

  async function newS3Repo(opts: { lockMode?: 'GOVERNANCE' | 'COMPLIANCE' } = {}) {
    resetMock();
    const dir = tempDir();
    const keyfile = path.join(dir, 'repo-key.key');
    const { header } = await initRepository(uri, {
      keyfile,
      s3Profile: profile,
      ...(opts.lockMode ? { remote: { uri, lockMode: opts.lockMode } } : {})
    });
    const key = resolveRepoKey(header, { keyfile });
    const session = await openRepoSession(uri, { s3Profile: profile });
    return { keyfile, key, header, session };
  }

  /** Stage an image into the session cache exactly like a backup job would. */
  function stageImage(session: RepoSession, name: string, content: string): string {
    const images = path.join(session.dir, 'images');
    fs.mkdirSync(images, { recursive: true });
    const file = path.join(images, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('detects s3:// targets', () => {
    expect(isS3RepoTarget('s3://b/x')).toBe(true);
    expect(isS3RepoTarget('S3://b/x')).toBe(true);
    expect(isS3RepoTarget('C:/repo')).toBe(false);
    expect(isS3RepoTarget('sftp://h/p')).toBe(false);
  });

  it('init writes header + journal into the bucket with conditional puts', async () => {
    const { header } = await newS3Repo({ lockMode: 'GOVERNANCE' });
    expect(header.remote).toEqual({ uri, lockMode: 'GOVERNANCE' });
    expect(objects.has('phase3/opbs-repo.json')).toBe(true);
    expect(objects.has('phase3/opbs-repo.journal')).toBe(true);
    expect(objects.get('phase3/opbs-repo.journal')!.toString()).toBe('');

    // Object Lock retention on the metadata versions themselves.
    for (const key of ['phase3/opbs-repo.json', 'phase3/opbs-repo.journal']) {
      const headers = putHeaders.get(key)!;
      expect(headers['x-amz-object-lock-mode']).toBe('GOVERNANCE');
      expect(Date.parse(String(headers['x-amz-object-lock-retain-until-date']))).toBeGreaterThan(Date.now());
      // Both metadata puts must be create-only (If-None-Match: *).
      expect(headers['if-none-match']).toBe('*');
    }
  });

  it('refuses a second init over the same location', async () => {
    const { keyfile } = await newS3Repo();
    await expect(initRepository(uri, { keyfile, s3Profile: profile })).rejects.toThrow(/Already an OPBS repository/);
  });

  it('hydrates header + journal into the cache and re-hydrates fresh state', async () => {
    const { session, keyfile } = await newS3Repo();
    expect(session.isS3).toBe(true);
    expect(fs.existsSync(path.join(session.dir, 'opbs-repo.json'))).toBe(true);
    expect(fs.existsSync(path.join(session.dir, 'opbs-repo.journal'))).toBe(true);

    // Another session appends + flushes; this session re-hydrates and sees it.
    const other = await openRepoSession(uri, { s3Profile: profile });
    const header = JSON.parse(fs.readFileSync(path.join(other.dir, 'opbs-repo.json'), 'utf-8'));
    const key = resolveRepoKey(header, { keyfile });
    const staged = stageImage(other, 'a.opbs', 'payload-a');
    await recordImageCreate(other.dir, header, key, staged, { lockDays: 5, s3Profile: profile });
    await other.flush();

    const again = await openRepoSession(uri, { s3Profile: profile });
    expect(loadJournal(again.dir)).toHaveLength(1);
    expect(loadJournal(session.dir)).toHaveLength(0); // stale session never re-read
  });

  it('flush is a no-op without changes and conflicts on concurrent writers', async () => {
    const { session, keyfile } = await newS3Repo();
    const before = puts;
    await session.flush();
    expect(puts).toBe(before); // nothing changed → no PUT

    // Two sessions hydrate the same ETags; both append; first flush wins.
    const a = await openRepoSession(uri, { s3Profile: profile });
    const b = await openRepoSession(uri, { s3Profile: profile });
    const appendTo = (s: RepoSession, image: string) => {
      const header = JSON.parse(fs.readFileSync(path.join(s.dir, 'opbs-repo.json'), 'utf-8'));
      const key = resolveRepoKey(header, { keyfile });
      const staged = stageImage(s, image, `payload-${image}`);
      return recordImageCreate(s.dir, header, key, staged, { lockDays: 0, s3Profile: profile });
    };
    await appendTo(a, 'x.opbs');
    await appendTo(b, 'y.opbs');
    await a.flush();
    await expect(b.flush()).rejects.toThrow(/concurrent writer/);
  });

  it('uploads, journals and fully verifies an image end-to-end', async () => {
    const { session, keyfile, header, key } = await newS3Repo({ lockMode: 'GOVERNANCE' });
    const staged = stageImage(session, 'img.opbs', 'image-bytes-for-verify');
    const { record } = await recordImageCreate(session.dir, header, key, staged, {
      lockDays: 5,
      s3Profile: profile
    });
    await session.flush();

    expect(objects.get('phase3/images/img.opbs')!.toString()).toBe('image-bytes-for-verify');
    const lockHeaders = putHeaders.get('phase3/images/img.opbs')!;
    expect(lockHeaders['x-amz-object-lock-mode']).toBe('GOVERNANCE');
    expect(loadJournal(session.dir)).toHaveLength(1);

    const clean = await verifyRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true });
    expect(clean.ok).toBe(true);
    expect(clean.states[0].filesPresent).toBe(true);
    expect(record.image).toBe('img.opbs');

    // Same-length tamper passes the size gate → streamed hash catches it.
    objects.set('phase3/images/img.opbs', Buffer.from('IMAGE-BYTES-FOR-VERIFY'));
    const tampered = await verifyRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true });
    expect(tampered.ok).toBe(false);
    expect(tampered.problems.some((p) => p.kind === 'hash-mismatch')).toBe(true);
    objects.set('phase3/images/img.opbs', Buffer.from('image-bytes-for-verify'));

    // --fast checks size/presence only — clean again.
    const fast = await verifyRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true, fast: true });
    expect(fast.ok).toBe(true);

    // Missing object + stray object are both reported.
    objects.delete('phase3/images/img.opbs');
    const missing = await verifyRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true });
    expect(missing.problems.some((p) => p.kind === 'remote-missing')).toBe(true);
    objects.set('phase3/images/img.opbs', Buffer.from('image-bytes-for-verify'));
    objects.set('phase3/images/stray.opbs', Buffer.from('not-in-journal'));
    const orphan = await verifyRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true });
    expect(orphan.problems.some((p) => p.kind === 'orphan' && p.detail.includes('stray.opbs'))).toBe(true);
    objects.delete('phase3/images/stray.opbs');
  });

  it('never journals an image whose S3 upload failed', async () => {
    const { session, header, key } = await newS3Repo();
    const staged = stageImage(session, 'bad.opbs', 'payload');
    failPut = true;
    await expect(
      recordImageCreate(session.dir, header, key, staged, { lockDays: 5, s3Profile: profile })
    ).rejects.toThrow();
    expect(loadJournal(session.dir)).toHaveLength(0);
    await session.flush();
    expect(objects.get('phase3/opbs-repo.journal')!.toString()).toBe('');
  });

  it('prunes from the bucket: Object Lock refusal keeps everything, release removes remote first', async () => {
    const { session, keyfile, header, key } = await newS3Repo({ lockMode: 'GOVERNANCE' });
    const staged = stageImage(session, 'p.opbs', 'prunable');
    await recordImageCreate(session.dir, header, key, staged, { lockDays: 0, s3Profile: profile });
    await unlockRepository(session.dir, 'p.opbs', { keyfile, remoteOnly: true });
    await session.flush();
    expect(loadJournal(session.dir).map((r) => r.type)).toEqual(['create', 'unlock']);

    lockedKeys.add('phase3/images/p.opbs');
    await expect(pruneRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true })).rejects.toThrow(
      /Object Lock retention/
    );
    expect(objects.has('phase3/images/p.opbs')).toBe(true);
    expect(loadJournal(session.dir).map((r) => r.type)).toEqual(['create', 'unlock']);

    lockedKeys.delete('phase3/images/p.opbs');
    const result = await pruneRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true });
    expect(result.removed.map((r) => r.name)).toEqual(['p.opbs']);
    expect(objects.has('phase3/images/p.opbs')).toBe(false);
    await session.flush();
    expect(loadJournal(session.dir).map((r) => r.type)).toEqual(['create', 'unlock', 'prune']);

    // Pruned object gone → a stale copy reappearing is flagged as an orphan.
    objects.set('phase3/images/p.opbs', Buffer.from('back-from-the-dead'));
    const resurrected = await verifyRepository(session.dir, { keyfile, s3Profile: profile, remoteOnly: true });
    expect(
      resurrected.problems.some((p) => p.kind === 'orphan' && p.detail.includes('still present in S3'))
    ).toBe(true);
  });

  it('overview uses a precomputed bucket index for presence + orphans', async () => {
    const { session, keyfile, header, key } = await newS3Repo();
    const staged = stageImage(session, 'o.opbs', 'overview-payload');
    await recordImageCreate(session.dir, header, key, staged, { lockDays: 5, s3Profile: profile });
    await session.flush();

    const store = remoteStore({ uri }, profile);
    const sizes = await listRemoteVolumes(store);
    const imageIndex: RepoImageIndex = { names: new Set(sizes.keys()), sizes };
    const overview = repoOverview(session.dir, { keyfile, imageIndex });
    expect(overview.states).toHaveLength(1);
    expect(overview.states[0].filesPresent).toBe(true);
    expect(overview.orphanCount).toBe(0);

    objects.set('phase3/images/untracked.opbs', Buffer.from('x'));
    const sizes2 = await listRemoteVolumes(store);
    const withOrphan = repoOverview(session.dir, {
      keyfile,
      imageIndex: { names: new Set(sizes2.keys()), sizes: sizes2 }
    });
    expect(withOrphan.orphanCount).toBe(1);
  });

  it('anchors the hydrated journal and verify --anchor works with remoteOnly', async () => {
    const { session, keyfile, header, key } = await newS3Repo();
    const staged = stageImage(session, 'anch.opbs', 'anchor-payload');
    await recordImageCreate(session.dir, header, key, staged, { lockDays: 5, s3Profile: profile });
    await session.flush();

    const target = tempDir();
    const result = await writeRepositoryAnchor(session.dir, target, { s3Profile: profile });
    expect(result.seq).toBe(1);

    const report = await verifyWithAnchor(session.dir, {
      keyfile,
      anchorTarget: target,
      s3Profile: profile,
      remoteOnly: true
    });
    expect(report.ok).toBe(true);
    expect(report.anchor?.ok).toBe(true);

    // Truncate the hydrated cache journal (rollback) → anchor mismatch.
    const journal = path.join(session.dir, 'opbs-repo.journal');
    const lines = fs.readFileSync(journal, 'utf-8').trim().split('\n');
    fs.writeFileSync(journal, lines.slice(0, -1).join('\n') + '\n');
    const rolled = await verifyWithAnchor(session.dir, {
      keyfile,
      anchorTarget: target,
      s3Profile: profile,
      remoteOnly: true
    });
    expect(rolled.ok).toBe(false);
    expect(rolled.problems.some((p) => p.kind === 'anchor-mismatch' || p.kind === 'chain')).toBe(true);
  });

  it('openRepoSession refuses a location without a header', async () => {
    resetMock();
    await expect(openRepoSession('s3://repo-bucket/does-not-exist', { s3Profile: profile })).rejects.toThrow(
      /Not an OPBS repository/
    );
  });

  it('cleanup removes the whole staging session dir but keeps the bucket copies', async () => {
    const { session, header, key } = await newS3Repo();
    const staged = stageImage(session, 'temp.opbs', 'staged');
    await recordImageCreate(session.dir, header, key, staged, { lockDays: 5, s3Profile: profile });
    await session.flush();
    expect(fs.existsSync(staged)).toBe(true);

    await session.cleanup();
    expect(fs.existsSync(session.dir)).toBe(false);
    // The uploaded copies in the bucket are untouched.
    expect(objects.has('phase3/images/temp.opbs')).toBe(true);
    expect(objects.has('phase3/opbs-repo.json')).toBe(true);
    expect(objects.has('phase3/opbs-repo.journal')).toBe(true);
  });

  it('local targets pass through without touching S3', async () => {
    resetMock();
    const dir = tempDir();
    const local = await openRepoSession(dir);
    expect(local.isS3).toBe(false);
    expect(local.dir).toBe(dir);
    await local.flush();
    await local.cleanup();
    expect(puts).toBe(0);
  });
});
