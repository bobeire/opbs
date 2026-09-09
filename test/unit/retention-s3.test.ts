import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { S3Store } from '../../src/main/utils/s3';
import { planRetentionS3 } from '../../src/main/backup/retention-s3';
import { encodeHeader, ImageHeader, IMAGE_VERSION, FLAG_INCREMENTAL, HEADER_SIZE } from '../../src/main/imaging/image-format';

function headerBuffer(overrides: Partial<ImageHeader>): Buffer {
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: Date.now(),
    totalBytes: 0,
    blockSize: 1024,
    compressionId: 0,
    partitionCount: 0,
    flags: 0,
    blockIndexOffset: 0,
    cipherId: 0,
    kdfIterations: 0,
    salt: Buffer.alloc(0),
    baseImagePath: '',
    ...overrides
  };
  return encodeHeader(header);
}

describe('S3 retention', () => {
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
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
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

  const store = (): S3Store =>
    new S3Store({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRET',
      bucket: 'b',
      prefix: 'backups',
      endpoint: baseUrl,
      forcePathStyle: true
    });

  it('plans retention over S3 objects using their headers', async () => {
    objects.clear();
    await store().put('full1.opbs', headerBuffer({ timestamp: 1000 }));
    await store().put('delta1.opbs', headerBuffer({ timestamp: 1500, flags: FLAG_INCREMENTAL, baseImagePath: 'full1.opbs' }));
    await store().put('full2.opbs', headerBuffer({ timestamp: 2000 }));

    const plan = await planRetentionS3(store(), { keepFull: 1, keepDeltasPerFull: 1, retentionDays: 0 });
    const pruned = plan.prune.map((e) => e.name);
    expect(pruned).toContain('full1.opbs');
    expect(pruned).toContain('delta1.opbs');
    expect(pruned).not.toContain('full2.opbs');
  });

  it('keeps the newest chain and its trailing deltas', async () => {
    objects.clear();
    await store().put('full1.opbs', headerBuffer({ timestamp: 1000 }));
    await store().put('delta1.opbs', headerBuffer({ timestamp: 1500, flags: FLAG_INCREMENTAL, baseImagePath: 'full1.opbs' }));
    await store().put('delta2.opbs', headerBuffer({ timestamp: 1600, flags: FLAG_INCREMENTAL, baseImagePath: 'full1.opbs' }));

    const plan = await planRetentionS3(store(), { keepFull: 1, keepDeltasPerFull: 1, retentionDays: 0 });
    const pruned = plan.prune.map((e) => e.name);
    // The only chain (full1 + delta1 + delta2) is retained; one trailing delta
    // (delta2) is kept, so the older delta1 is pruned. full1 stays (root).
    expect(pruned).toContain('delta1.opbs');
    expect(pruned).not.toContain('full1.opbs');
    expect(pruned).not.toContain('delta2.opbs');
  });
});
