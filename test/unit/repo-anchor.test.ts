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
  appendJournalRecord,
  recordImageCreate,
  verifyRepository
} from '../../src/main/imaging/repository';
import {
  writeRepositoryAnchor,
  checkRepositoryAnchor,
  readRepositoryAnchor,
  verifyWithAnchor,
  type RepoAnchor
} from '../../src/main/imaging/repo-anchor';
import { unprotectFiles } from '../../src/main/utils/file-protect';
import type { S3Config } from '../../src/main/utils/s3';

// initRepository/recordImageCreate spawn PowerShell for ACL updates.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-anchor-test-'));
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

async function newRepo(passphrase?: string) {
  const dir = tempDir();
  const repoDir = path.join(dir, 'repo');
  const keyfile = path.join(dir, 'repo-key.key');
  const result = await initRepository(repoDir, { keyfile, passphrase });
  const keyOpts = passphrase ? { passphrase } : { keyfile };
  return { repoDir, target: path.join(dir, 'anchor'), key: resolveRepoKey(result.header, keyOpts), keyOpts };
}

/** Append a create record with a proper chain link. */
function appendCreate(repoDir: string, key: Buffer, image: string) {
  const records = loadJournal(repoDir);
  const prev = records.length === 0 ? '' : records[records.length - 1].sig;
  const seq = records.length === 0 ? 1 : records[records.length - 1].seq + 1;
  return appendJournalRecord(
    repoDir,
    { seq, type: 'create', at: new Date().toISOString(), image, bytes: 0, prev },
    key
  );
}

function journalFile(repoDir: string): string {
  return path.join(repoDir, 'opbs-repo.journal');
}

function anchorFile(target: string, repoId: string): string {
  return path.join(target, repoId, 'opbs-repo.anchor');
}

describe('repository anchor (local target)', () => {
  it('writes and checks an anchor for a fresh repository', async () => {
    const { repoDir, target, keyOpts } = await newRepo();
    const result = await writeRepositoryAnchor(repoDir, target, keyOpts);
    expect(result.seq).toBe(0);
    expect(result.records).toBe(0);
    expect(fs.existsSync(anchorFile(target, result.repoId))).toBe(true);

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.seq).toBe(0);
  });

  it('stays OK while the local journal grows past the anchor (append-only prefix)', async () => {
    const { repoDir, target, key, keyOpts } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    appendCreate(repoDir, key, 'b.opbs');
    const written = await writeRepositoryAnchor(repoDir, target, keyOpts);
    expect(written.seq).toBe(2);

    appendCreate(repoDir, key, 'c.opbs');
    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(true);
    expect(check.seq).toBe(2);
  });

  it('detects a rolled-back (truncated) journal', async () => {
    const { repoDir, target, key, keyOpts } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    appendCreate(repoDir, key, 'b.opbs');
    await writeRepositoryAnchor(repoDir, target, keyOpts);

    const lines = fs.readFileSync(journalFile(repoDir), 'utf-8').trim().split('\n');
    fs.writeFileSync(journalFile(repoDir), `${lines[0]}\n`);

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0].kind).toBe('anchor-mismatch');
    expect(check.problems[0].detail).toMatch(/rolled back/);
  });

  it('detects rewritten (non-prefix) history', async () => {
    const { repoDir, target, key, keyOpts } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    await writeRepositoryAnchor(repoDir, target, keyOpts);

    const tampered = fs.readFileSync(journalFile(repoDir), 'utf-8').replace('a.opbs', 'x.opbs');
    fs.writeFileSync(journalFile(repoDir), tampered);

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(false);
    expect(check.problems[0].kind).toBe('anchor-mismatch');
    expect(check.problems[0].detail).toMatch(/rewritten/);
  });

  it('detects a tampered anchor (edited text, stale checksum)', async () => {
    const { repoDir, target, key, keyOpts } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    const written = await writeRepositoryAnchor(repoDir, target, keyOpts);

    const file = anchorFile(target, written.repoId);
    const anchor = JSON.parse(fs.readFileSync(file, 'utf-8')) as RepoAnchor;
    anchor.journal = anchor.journal.replace('a.opbs', 'evil.opbs');
    fs.writeFileSync(file, JSON.stringify(anchor, null, 2));

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(false);
    expect(check.problems[0].kind).toBe('anchor-mismatch');
    expect(check.problems[0].detail).toMatch(/checksum/);
  });

  it('detects an anchor for a different repository id', async () => {
    const { repoDir, target, keyOpts } = await newRepo();
    const written = await writeRepositoryAnchor(repoDir, target, keyOpts);

    const file = anchorFile(target, written.repoId);
    const anchor = JSON.parse(fs.readFileSync(file, 'utf-8')) as RepoAnchor;
    anchor.repoId = 'someone-elses-repo';
    fs.writeFileSync(file, JSON.stringify(anchor, null, 2));

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(false);
    expect(check.problems[0].detail).toMatch(/different repository/);
  });

  it('detects a header swap (valid checksums, different header)', async () => {
    const { repoDir, target, keyOpts } = await newRepo();
    const written = await writeRepositoryAnchor(repoDir, target, keyOpts);

    const file = anchorFile(target, written.repoId);
    const anchor = JSON.parse(fs.readFileSync(file, 'utf-8')) as RepoAnchor;
    anchor.header = JSON.stringify({ schema: 1, id: anchor.repoId, createdAt: '2000-01-01' });
    anchor.headerSha256 = crypto.createHash('sha256').update(anchor.header, 'utf-8').digest('hex');
    fs.writeFileSync(file, JSON.stringify(anchor, null, 2));

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(false);
    expect(check.problems.some((p) => p.detail.includes('header'))).toBe(true);
  });

  it('reports a missing anchor as anchor-missing', async () => {
    const { repoDir, target, keyOpts } = await newRepo();
    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.ok).toBe(false);
    expect(check.problems[0].kind).toBe('anchor-missing');
  });

  it('verifies signatures of the embedded snapshot when the key is available', async () => {
    const { repoDir, target, key, keyOpts } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    const written = await writeRepositoryAnchor(repoDir, target, keyOpts);

    // Forge the snapshot: edit the embedded record and refresh its checksums.
    const file = anchorFile(target, written.repoId);
    const anchor = JSON.parse(fs.readFileSync(file, 'utf-8')) as RepoAnchor;
    anchor.journal = anchor.journal.replace('a.opbs', 'evil.opbs');
    anchor.journalSha256 = crypto.createHash('sha256').update(anchor.journal, 'utf-8').digest('hex');
    fs.writeFileSync(file, JSON.stringify(anchor, null, 2));

    const check = await checkRepositoryAnchor(repoDir, target, keyOpts);
    expect(check.problems.map((p) => p.kind)).toContain('signature');
  });

  it('rejects unsupported anchor target schemes', async () => {
    const { repoDir, keyOpts } = await newRepo();
    await expect(writeRepositoryAnchor(repoDir, 'ftp://host/path', keyOpts)).rejects.toThrow(
      /Unsupported anchor target scheme/
    );
  });

  it('readRepositoryAnchor round-trips the stored snapshot', async () => {
    const { repoDir, target, key, keyOpts } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    const written = await writeRepositoryAnchor(repoDir, target, keyOpts);
    const anchor = await readRepositoryAnchor(target, written.repoId);
    expect(anchor.repoId).toBe(written.repoId);
    expect(anchor.journal).toBe(fs.readFileSync(journalFile(repoDir), 'utf-8'));
    expect(anchor.header).toBe(fs.readFileSync(path.join(repoDir, 'opbs-repo.json'), 'utf-8'));
  });
});

describe('verifyWithAnchor', () => {
  it('passes with a good anchor and fails only on anchor problems when the anchor is gone', async () => {
    const dir = tempDir();
    const repoDir = path.join(dir, 'repo');
    const keyfile = path.join(dir, 'repo-key.key');
    const target = path.join(dir, 'anchor');
    const { header } = await initRepository(repoDir, { keyfile });
    const key = resolveRepoKey(header, { keyfile });

    const imagePath = path.join(repoDir, 'images', 'a.opbs');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, 'image-bytes');
    await recordImageCreate(repoDir, header, key, imagePath, { lockDays: 5 });

    const baseline = await verifyRepository(repoDir, { keyfile });
    expect(baseline.ok).toBe(true);

    await writeRepositoryAnchor(repoDir, target);
    const good = await verifyWithAnchor(repoDir, { keyfile, anchorTarget: target });
    expect(good.ok).toBe(true);
    expect(good.anchor.ok).toBe(true);
    expect(good.anchor.seq).toBe(1);
    expect(good.problems).toEqual([]);

    fs.rmSync(target, { recursive: true, force: true });
    const missing = await verifyWithAnchor(repoDir, { keyfile, anchorTarget: target });
    expect(missing.ok).toBe(false);
    expect(missing.anchor.ok).toBe(false);
    expect(missing.problems.map((p) => p.kind)).toContain('anchor-missing');
    // The local repository itself is still fine — only the anchor failed.
    expect(missing.problems.filter((p) => !p.kind.startsWith('anchor'))).toEqual([]);
  });
});

describe('anchor over S3', () => {
  let server: http.Server;
  let baseUrl: string;
  let objects: Map<string, Buffer>;

  beforeAll(async () => {
    objects = new Map();
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const key = decodeURIComponent(url.pathname.replace(/^\/[^/]*\//, '').replace(/^\//, ''));
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200);
          res.end();
        });
      } else if (req.method === 'GET') {
        const data = objects.get(key);
        if (data) {
          res.writeHead(200);
          res.end(data);
        } else {
          res.writeHead(404);
          res.end('NoSuchKey');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('round-trips the anchor through an S3-compatible endpoint', async () => {
    const { repoDir, key } = await newRepo();
    appendCreate(repoDir, key, 'a.opbs');
    const s3Profile: Partial<S3Config> = {
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'secret',
      endpoint: baseUrl,
      forcePathStyle: true
    };
    const target = 's3://anchor-bucket/off-box';
    const written = await writeRepositoryAnchor(repoDir, target, { s3Profile });
    expect(objects.has(`off-box/${written.repoId}/opbs-repo.anchor`)).toBe(true);

    const check = await checkRepositoryAnchor(repoDir, target, { s3Profile });
    expect(check.ok).toBe(true);
    expect(check.seq).toBe(1);
  });

  it('reports a missing S3 anchor', async () => {
    const { repoDir } = await newRepo();
    const s3Profile: Partial<S3Config> = {
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'secret',
      endpoint: baseUrl,
      forcePathStyle: true
    };
    const check = await checkRepositoryAnchor(repoDir, 's3://anchor-bucket/never-written', { s3Profile });
    expect(check.ok).toBe(false);
    expect(check.problems[0].kind).toBe('anchor-missing');
  });
});
