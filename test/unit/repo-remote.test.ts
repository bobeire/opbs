import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import {
  initRepository,
  loadHeader,
  loadJournal,
  resolveRepoKey,
  recordImageCreate,
  verifyRepository,
  pruneRepository,
  unlockRepository
} from '../../src/main/imaging/repository';
import {
  uploadRemoteVolumes,
  deleteRemoteVolumes,
  checkRemoteVolumes,
  remoteStore,
  type RepoRemoteConfig
} from '../../src/main/imaging/repo-remote';
import { unprotectFiles } from '../../src/main/utils/file-protect';
import type { S3Config } from '../../src/main/utils/s3';

// init/record/prune spawn PowerShell for ACL updates.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-remote-test-'));
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

describe('repository S3 mirror', () => {
  let server: http.Server;
  let baseUrl: string;
  let objects: Map<string, Buffer>;
  let putHeaders: Map<string, http.IncomingHttpHeaders>;
  let lockedKeys: Set<string>;
  let failPut: boolean;

  const profile: Partial<S3Config> = {
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'secret',
    endpoint: '',
    forcePathStyle: true
  };
  const remote: RepoRemoteConfig = { uri: 's3://mirror-bucket/off-box', lockMode: 'GOVERNANCE' };

  beforeAll(async () => {
    objects = new Map();
    putHeaders = new Map();
    lockedKeys = new Set();
    failPut = false;
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
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>');
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
          objects.set(key, Buffer.concat(chunks));
          putHeaders.set(key, req.headers);
          res.writeHead(200);
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
        res.writeHead(existed ? 204 : 404);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const data = objects.get(key);
        if (data) {
          res.writeHead(200);
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
  });

  function resetMock(): void {
    objects.clear();
    putHeaders.clear();
    lockedKeys.clear();
    failPut = false;
  }

  async function newMirroredRepo(cfg: RepoRemoteConfig = remote) {
    resetMock();
    const dir = tempDir();
    const repoDir = path.join(dir, 'repo');
    const keyfile = path.join(dir, 'repo-key.key');
    const { header } = await initRepository(repoDir, { keyfile, remote: cfg });
    const key = resolveRepoKey(header, { keyfile });
    const imagePath = path.join(repoDir, 'images', 'a.opbs');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, 'image-payload-bytes');
    return { repoDir, header, key, keyfile, imagePath };
  }

  it('stores the mirror config in the header at init', async () => {
    const { repoDir } = await newMirroredRepo();
    const header = loadHeader(repoDir);
    expect(header.remote).toEqual({ uri: 's3://mirror-bucket/off-box', lockMode: 'GOVERNANCE' });
  });

  it('uploads journaled volumes with Object Lock headers matching the journal lock', async () => {
    const { repoDir, header, key, keyfile, imagePath } = await newMirroredRepo();
    const { record, lockUntil } = await recordImageCreate(repoDir, header, key, imagePath, {
      lockDays: 5,
      s3Profile: profile
    });

    expect(loadJournal(repoDir)).toHaveLength(1);
    const objectKey = 'off-box/images/a.opbs';
    expect(objects.has(objectKey)).toBe(true);
    expect(objects.get(objectKey)!.toString()).toBe('image-payload-bytes');

    const headers = putHeaders.get(objectKey)!;
    expect(headers['x-amz-object-lock-mode']).toBe('GOVERNANCE');
    const retain = Date.parse(String(headers['x-amz-object-lock-retain-until-date']));
    expect(retain).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    expect(retain).toBeLessThanOrEqual(Date.parse(lockUntil) + 60_000);
    expect(record.image).toBe('a.opbs');
    expect(record.lock?.until).toBe(lockUntil);

    // Local file stays the hash-verified original.
    expect(fs.readFileSync(imagePath, 'utf-8')).toBe('image-payload-bytes');
    expect(key).toHaveLength(32);
  });

  it('mirrors without retention headers when no lock mode is configured', async () => {
    const { repoDir, header, key, imagePath } = await newMirroredRepo({ uri: 's3://mirror-bucket/off-box' });
    await recordImageCreate(repoDir, header, key, imagePath, { lockDays: 5, s3Profile: profile });
    const headers = putHeaders.get('off-box/images/a.opbs')!;
    expect(headers['x-amz-object-lock-mode']).toBeUndefined();
    expect(headers['x-amz-object-lock-retain-until-date']).toBeUndefined();
    expect(objects.has('off-box/images/a.opbs')).toBe(true);
  });

  it('never journals an image whose mirror upload failed', async () => {
    const { repoDir, header, key, imagePath } = await newMirroredRepo();
    failPut = true;
    await expect(recordImageCreate(repoDir, header, key, imagePath, { lockDays: 5, s3Profile: profile })).rejects.toThrow(
      /failed/i
    );
    expect(loadJournal(repoDir)).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it('verifies the mirror: presence and size problems are reported', async () => {
    const { repoDir, header, key, keyfile, imagePath } = await newMirroredRepo();
    await recordImageCreate(repoDir, header, key, imagePath, { lockDays: 5, s3Profile: profile });

    const clean = await verifyRepository(repoDir, { keyfile, s3Profile: profile });
    expect(clean.ok).toBe(true);
    expect(clean.problems.filter((p) => p.kind.startsWith('remote'))).toEqual([]);

    // Size drift in the mirror.
    objects.set('off-box/images/a.opbs', Buffer.from('shortened'));
    const sized = await verifyRepository(repoDir, { keyfile, s3Profile: profile });
    expect(sized.ok).toBe(false);
    expect(sized.problems.some((p) => p.kind === 'remote-size')).toBe(true);

    // Mirror copy disappears entirely.
    objects.delete('off-box/images/a.opbs');
    const missing = await verifyRepository(repoDir, { keyfile, s3Profile: profile });
    expect(missing.ok).toBe(false);
    expect(missing.problems.some((p) => p.kind === 'remote-missing')).toBe(true);
  });

  it('reports a remote-error problem when the mirror endpoint is unreachable', async () => {
    const { repoDir, keyfile, header, key, imagePath } = await newMirroredRepo();
    await recordImageCreate(repoDir, header, key, imagePath, { lockDays: 5, s3Profile: profile });
    const dead: Partial<S3Config> = { ...profile, endpoint: 'http://127.0.0.1:1' };
    const report = await verifyRepository(repoDir, { keyfile, s3Profile: dead });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === 'remote-error')).toBe(true);
  });

  it('prune refuses (image intact) while Object Lock holds, then succeeds after release', async () => {
    const { repoDir, header, key, keyfile, imagePath } = await newMirroredRepo();
    await recordImageCreate(repoDir, header, key, imagePath, { lockDays: 0, s3Profile: profile });
    await unlockRepository(repoDir, 'a.opbs', { keyfile });
    expect(loadJournal(repoDir).map((r) => r.type)).toEqual(['create', 'unlock']);

    // Mirror object still locked → prune aborts before touching anything local.
    lockedKeys.add('off-box/images/a.opbs');
    await expect(pruneRepository(repoDir, { keyfile, s3Profile: profile })).rejects.toThrow(
      /Object Lock retention/
    );
    expect(fs.existsSync(imagePath)).toBe(true);
    expect(objects.has('off-box/images/a.opbs')).toBe(true);
    expect(loadJournal(repoDir).map((r) => r.type)).toEqual(['create', 'unlock']);

    // Retention released → prune removes remote copy first, then local files.
    lockedKeys.delete('off-box/images/a.opbs');
    const result = await pruneRepository(repoDir, { keyfile, s3Profile: profile });
    expect(result.removed.map((r) => r.name)).toEqual(['a.opbs']);
    expect(objects.has('off-box/images/a.opbs')).toBe(false);
    expect(fs.existsSync(imagePath)).toBe(false);
    expect(loadJournal(repoDir).map((r) => r.type)).toEqual(['create', 'unlock', 'prune']);
  });

  it('uploads/deletes/checks volumes through the shared helpers', async () => {
    resetMock();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'v1.opbs'), 'one');
    fs.writeFileSync(path.join(dir, 'v2.opbs'), 'two');
    const store = remoteStore(remote, profile);

    await uploadRemoteVolumes(store, remote, [
      { name: 'v1.opbs', size: 3 },
      { name: 'v2.opbs', size: 3 }
    ], dir, new Date(Date.now() + 86_400_000).toISOString());
    expect([...objects.keys()].sort()).toEqual(['off-box/images/v1.opbs', 'off-box/images/v2.opbs']);

    const findings = await checkRemoteVolumes(store, [
      { name: 'v1.opbs', size: 3 },
      { name: 'v2.opbs', size: 99 },
      { name: 'v3.opbs', size: 1 }
    ]);
    expect(findings).toEqual([
      { kind: 'size', name: 'v2.opbs', detail: expect.stringContaining('size 3, journal says 99') },
      { kind: 'missing', name: 'v3.opbs', detail: expect.stringContaining('missing: v3.opbs') }
    ]);

    lockedKeys.add('off-box/images/v1.opbs');
    await expect(deleteRemoteVolumes(store, ['v1.opbs'])).rejects.toThrow(/refused to delete images\/v1\.opbs/);
    expect(objects.has('off-box/images/v1.opbs')).toBe(true);
  });
});
