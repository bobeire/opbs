import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { S3Store, parseS3Location, resolveS3Config } from '../../src/main/utils/s3';

describe('S3 store', () => {
  let server: http.Server;
  let baseUrl: string;
  let objects: Map<string, Buffer>;

  beforeAll(async () => {
    objects = new Map();
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const contents = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`)
          .join('');
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
        return;
      }
      const key = url.pathname.replace(/^\/[^/]*\//, '').replace(/^\//, '');
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200, { 'x-amz-request-id': 'test' });
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
});
