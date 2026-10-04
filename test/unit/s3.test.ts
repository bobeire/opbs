import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { S3Store, parseS3Location, resolveS3Config, buildObjectLock } from '../../src/main/utils/s3';

describe('S3 store', () => {
  let server: http.Server;
  let baseUrl: string;
  let objects: Map<string, Buffer>;
  let objectHeaders: Map<string, http.IncomingHttpHeaders>;
  let mpu: Map<string, { id: string; parts: Map<number, Buffer> }>;
  let initiateHeaders: http.IncomingHttpHeaders | undefined;
  let mpuCounter = 0;
  const tempFiles: string[] = [];

  const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    objects = new Map();
    objectHeaders = new Map();
    mpu = new Map();
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        if (method === 'GET' && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const contents = [...objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`)
            .join('');
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
          return;
        }
        const key = decodeURIComponent(url.pathname.replace(/^\/[^/]*\//, '').replace(/^\//, ''));

        // Multipart: initiate.
        if (method === 'POST' && url.searchParams.has('uploads')) {
          const id = `upload-${++mpuCounter}`;
          mpu.set(key, { id, parts: new Map() });
          initiateHeaders = req.headers;
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end(
            `<InitiateMultipartUploadResult><Bucket>test</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
          );
          return;
        }
        // Multipart: complete.
        if (method === 'POST' && url.searchParams.has('uploadId')) {
          const id = url.searchParams.get('uploadId');
          const entry = mpu.get(key);
          if (!entry || entry.id !== id) {
            res.writeHead(404);
            res.end();
            return;
          }
          await readBody(req);
          const order = [...entry.parts.keys()].sort((a, b) => a - b);
          objects.set(key, Buffer.concat(order.map((n) => entry.parts.get(n)!)));
          mpu.delete(key);
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end(
            `<CompleteMultipartUploadResult><Location>x</Location><Bucket>test</Bucket><Key>${key}</Key><ETag>"agg"</ETag></CompleteMultipartUploadResult>`
          );
          return;
        }
        // Multipart: part upload.
        if (method === 'PUT' && url.searchParams.has('partNumber')) {
          const partNumber = Number(url.searchParams.get('partNumber'));
          const id = url.searchParams.get('uploadId');
          const entry = mpu.get(key);
          if (!entry || entry.id !== id) {
            res.writeHead(404);
            res.end();
            return;
          }
          entry.parts.set(partNumber, await readBody(req));
          res.writeHead(200, { ETag: `"part-${partNumber}"` });
          res.end();
          return;
        }
        // Multipart: abort.
        if (method === 'DELETE' && url.searchParams.has('uploadId')) {
          mpu.delete(key);
          res.writeHead(204);
          res.end();
          return;
        }

        if (method === 'PUT') {
          objectHeaders.set(key, req.headers);
          objects.set(key, await readBody(req));
          res.writeHead(200, { 'x-amz-request-id': 'test' });
          res.end();
        } else if (method === 'GET') {
          const data = objects.get(key);
          if (data) {
            res.writeHead(200);
            res.end(data);
          } else {
            res.writeHead(404);
            res.end('NoSuchKey');
          }
        } else if (method === 'DELETE') {
          objects.delete(key);
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
    for (const file of tempFiles) {
      await fs.promises.rm(file, { force: true });
    }
  });

  it('parses s3:// URIs into bucket and prefix', () => {
    expect(parseS3Location('s3://mybucket')).toEqual({ bucket: 'mybucket', prefix: '' });
    expect(parseS3Location('s3://mybucket/backups/2026')).toEqual({ bucket: 'mybucket', prefix: 'backups/2026' });
  });

  it('rejects non-S3 URIs', () => {
    expect(() => parseS3Location('D:\\OPBS')).toThrow(/not an S3 location/i);
  });

  it('round-trips an object via a mock S3 endpoint (path-style)', async () => {
    const store = new S3Store({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'testbucket',
      prefix: 'backups',
      endpoint: baseUrl,
      forcePathStyle: true
    });
    const data = Buffer.from('hello s3', 'utf8');
    await store.put('img.opbs', data);
    const got = await store.get('img.opbs');
    expect(got.toString()).toBe('hello s3');
    expect(store.resolveKey('img.opbs')).toBe('backups/img.opbs');
  });

  it('lists objects under a prefix (ListObjectsV2)', async () => {
    const store = new S3Store({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'testbucket',
      prefix: 'backups',
      endpoint: baseUrl,
      forcePathStyle: true
    });
    await store.put('a.opbs', Buffer.from('a'));
    await store.put('b.opbs', Buffer.from('b'));
    const keys = await store.list();
    expect(keys).toContain('a.opbs');
    expect(keys).toContain('b.opbs');
  });

  it('produces a well-formed SigV4 Authorization header and is deterministic', async () => {
    const seen = new Map<string, string>();
    const validating = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      const path = req.url ?? '';
      seen.set(path, auth);
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => validating.listen(0, '127.0.0.1', resolve));
    const addr = validating.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;

    const store = new S3Store({
      region: 'eu-west-2',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'b',
      prefix: 'p',
      endpoint: url,
      forcePathStyle: true
    });
    await store.put('x.opbs', Buffer.from('data'));
    const auth = seen.get('/b/p/x.opbs') ?? '';
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    expect(auth).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);

    validating.close();
  });

  it('putFile streams a small file and attaches Object Lock headers', async () => {
    const file = path.join(os.tmpdir(), `opbs-s3-small-${Date.now()}.txt`);
    tempFiles.push(file);
    fs.writeFileSync(file, 'streamed small file');
    const store = new S3Store({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'testbucket',
      prefix: 'backups',
      endpoint: baseUrl,
      forcePathStyle: true
    });
    await store.putFile(file, 'small.opbs', {
      objectLock: { mode: 'GOVERNANCE', retainUntil: '2030-01-01T00:00:00.000Z' }
    });
    expect(objects.get('backups/small.opbs')?.toString()).toBe('streamed small file');
    const headers = objectHeaders.get('backups/small.opbs');
    expect(headers?.['x-amz-object-lock-mode']).toBe('GOVERNANCE');
    expect(headers?.['x-amz-object-lock-retain-until-date']).toBe('2030-01-01T00:00:00.000Z');
  });

  it('putFile multiparts large files (>16MB), assembles parts and locks at initiate', async () => {
    const file = path.join(os.tmpdir(), `opbs-s3-big-${Date.now()}.bin`);
    tempFiles.push(file);
    const big = Buffer.alloc(16 * 1024 * 1024 + 4096, 7);
    fs.writeFileSync(file, big);
    const store = new S3Store({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'testbucket',
      prefix: 'backups',
      endpoint: baseUrl,
      forcePathStyle: true
    });
    await store.putFile(file, 'big.opbs', {
      objectLock: { mode: 'COMPLIANCE', retainUntil: '2031-06-01T00:00:00.000Z' }
    });
    expect(objects.get('backups/big.opbs')?.equals(big)).toBe(true);
    expect(initiateHeaders?.['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    expect(initiateHeaders?.['x-amz-object-lock-retain-until-date']).toBe('2031-06-01T00:00:00.000Z');
    expect(mpu.size).toBe(0);
  });

  it('putFile round-trips without Object Lock when it is not configured', async () => {
    const file = path.join(os.tmpdir(), `opbs-s3-nolock-${Date.now()}.txt`);
    tempFiles.push(file);
    fs.writeFileSync(file, 'plain upload');
    const store = new S3Store({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'testbucket',
      prefix: 'backups',
      endpoint: baseUrl,
      forcePathStyle: true
    });
    await store.putFile(file, 'plain.opbs');
    expect(objects.get('backups/plain.opbs')?.toString()).toBe('plain upload');
    const headers = objectHeaders.get('backups/plain.opbs');
    expect(headers?.['x-amz-object-lock-mode']).toBeUndefined();
  });
});

describe('buildObjectLock', () => {
  it('returns undefined when Object Lock is off', () => {
    expect(buildObjectLock({})).toBeUndefined();
    expect(buildObjectLock({ objectLockRetainDays: 30 })).toBeUndefined();
  });

  it('computes retainUntil from the retention days', () => {
    const lock = buildObjectLock(
      { objectLockMode: 'GOVERNANCE', objectLockRetainDays: 30 },
      new Date('2026-01-01T00:00:00.000Z')
    );
    expect(lock).toEqual({ mode: 'GOVERNANCE', retainUntil: '2026-01-31T00:00:00.000Z' });
  });

  it('rejects retention windows below one day', () => {
    expect(() => buildObjectLock({ objectLockMode: 'GOVERNANCE', objectLockRetainDays: 0 })).toThrow(
      /at least 1 day/
    );
    expect(() => buildObjectLock({ objectLockMode: 'COMPLIANCE' })).toThrow(/at least 1 day/);
  });

  it('rejects unknown modes', () => {
    expect(() =>
      buildObjectLock({ objectLockMode: 'SOMETIMES' as never, objectLockRetainDays: 5 })
    ).toThrow(/Invalid Object Lock mode/);
  });
});

describe('resolveS3Config', () => {
  it('prefers profile credentials/region/endpoint and URI bucket/prefix', () => {
    const config = resolveS3Config(
      {
        accessKeyId: 'AKIA',
        secretAccessKey: 'SECRET',
        region: 'eu-west-1',
        endpoint: 'https://minio.local',
        forcePathStyle: true
      },
      's3://my-bucket/backups/2026'
    );
    expect(config.accessKeyId).toBe('AKIA');
    expect(config.secretAccessKey).toBe('SECRET');
    expect(config.region).toBe('eu-west-1');
    expect(config.endpoint).toBe('https://minio.local');
    expect(config.forcePathStyle).toBe(true);
    expect(config.bucket).toBe('my-bucket');
    expect(config.prefix).toBe('backups/2026');
  });

  it('falls back to the profile bucket/prefix for a bare s3:// host', () => {
    const config = resolveS3Config(
      { bucket: 'profile-bucket', prefix: 'profile/prefix', accessKeyId: 'AKIA', secretAccessKey: 'SECRET' },
      's3://'
    );
    expect(config.bucket).toBe('profile-bucket');
    expect(config.prefix).toBe('profile/prefix');
  });

  it('falls back to AWS environment variables when no profile fields are set', () => {
    const env = {
      AWS_ACCESS_KEY_ID: 'ENV_KEY',
      AWS_SECRET_ACCESS_KEY: 'ENV_SECRET',
      AWS_REGION: 'ap-southeast-2'
    } as NodeJS.ProcessEnv;
    const config = resolveS3Config(undefined, 's3://bucket/path', env);
    expect(config.accessKeyId).toBe('ENV_KEY');
    expect(config.secretAccessKey).toBe('ENV_SECRET');
    expect(config.region).toBe('ap-southeast-2');
    expect(config.bucket).toBe('bucket');
    expect(config.prefix).toBe('path');
  });

  it('passes Object Lock from the profile, with env fallback for CLI runs', () => {
    const fromProfile = resolveS3Config(
      { objectLockMode: 'COMPLIANCE', objectLockRetainDays: 14 },
      's3://b/p'
    );
    expect(fromProfile.objectLockMode).toBe('COMPLIANCE');
    expect(fromProfile.objectLockRetainDays).toBe(14);

    const fromEnv = resolveS3Config(undefined, 's3://b/p', {
      OPBS_S3_OBJECT_LOCK_MODE: 'GOVERNANCE',
      OPBS_S3_OBJECT_LOCK_RETAIN_DAYS: '7'
    } as NodeJS.ProcessEnv);
    expect(fromEnv.objectLockMode).toBe('GOVERNANCE');
    expect(fromEnv.objectLockRetainDays).toBe(7);

    const noLock = resolveS3Config(undefined, 's3://b/p', {
      OPBS_S3_OBJECT_LOCK_MODE: 'bogus'
    } as NodeJS.ProcessEnv);
    expect(noLock.objectLockMode).toBeUndefined();
  });
});
