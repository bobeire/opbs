import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import type { Readable } from 'stream';

/**
 * Minimal S3 client using AWS Signature v4. No external SDK: it signs and sends
 * PUT/GET/LIST requests directly. Supports custom endpoints (MinIO, tests) via
 * `endpoint` and path-style addressing.
 *
 * Uploads of local files go through `putFile`, which streams (single PUT for
 * small files, multipart otherwise) instead of buffering the whole image in
 * memory, and can attach S3 Object Lock retention headers (`x-amz-object-lock-*`)
 * for true WORM writes when the bucket has Object Lock enabled.
 */

export interface S3Config {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  /** Custom endpoint (e.g. https://minio.local) or the AWS regional endpoint. */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Object Lock retention mode; requires an Object-Lock-enabled bucket. */
  objectLockMode?: ObjectLockMode;
  /** Days of retention applied to uploaded objects (when mode is set). */
  objectLockRetainDays?: number;
}

export type ObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface ObjectLockRequest {
  mode: ObjectLockMode;
  /** ISO timestamp until which the object is locked. */
  retainUntil: string;
}

/**
 * Derive the Object Lock headers for an upload from the config.
 * Returns undefined when Object Lock is not configured; throws on a
 * retention window that S3 would reject (< 1 day).
 */
export function buildObjectLock(
  config: Pick<S3Config, 'objectLockMode' | 'objectLockRetainDays'>,
  now: Date = new Date()
): ObjectLockRequest | undefined {
  if (!config.objectLockMode) return undefined;
  if (config.objectLockMode !== 'GOVERNANCE' && config.objectLockMode !== 'COMPLIANCE') {
    throw new Error(`Invalid Object Lock mode: ${config.objectLockMode} (use GOVERNANCE or COMPLIANCE)`);
  }
  const days = config.objectLockRetainDays ?? 0;
  if (!Number.isFinite(days) || days < 1) {
    throw new Error('Object Lock retention must be at least 1 day');
  }
  return {
    mode: config.objectLockMode,
    retainUntil: new Date(now.getTime() + days * 86_400_000).toISOString()
  };
}

function objectLockHeaders(lock: ObjectLockRequest): Record<string, string> {
  return {
    'x-amz-object-lock-mode': lock.mode,
    'x-amz-object-lock-retain-until-date': lock.retainUntil
  };
}

export interface ParsedS3Location {
  bucket: string;
  prefix: string;
}

/** Parse an `s3://bucket/prefix` URI into bucket + prefix. */
export function parseS3Location(uri: string): ParsedS3Location {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('s3://')) {
    throw new Error(`Not an S3 location: ${uri}`);
  }
  const rest = trimmed.slice('s3://'.length);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? '' : rest.slice(slash + 1);
  return { bucket, prefix };
}

/**
 * Build an S3Config for a destination URI from the app's cloud profile,
 * falling back to the standard AWS environment variables. The URI always wins
 * for bucket/prefix; the profile supplies credentials/region/endpoint plus a
 * bucket/prefix fallback so an empty `s3://` host can inherit the profile's
 * bucket.
 */
export function resolveS3Config(
  profile: Partial<S3Config> | undefined,
  uri: string,
  env: NodeJS.ProcessEnv = process.env
): S3Config {
  const { bucket, prefix } = parseS3Location(uri);
  const envMode = env.OPBS_S3_OBJECT_LOCK_MODE;
  const objectLockMode =
    profile?.objectLockMode ??
    (envMode === 'GOVERNANCE' || envMode === 'COMPLIANCE' ? envMode : undefined);
  const objectLockRetainDays =
    profile?.objectLockRetainDays ??
    (env.OPBS_S3_OBJECT_LOCK_RETAIN_DAYS ? Number(env.OPBS_S3_OBJECT_LOCK_RETAIN_DAYS) : undefined);
  return {
    region: profile?.region ?? env.AWS_REGION ?? 'us-east-1',
    accessKeyId: profile?.accessKeyId ?? env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: profile?.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY ?? '',
    bucket: bucket || profile?.bucket || '',
    prefix: prefix || profile?.prefix || '',
    endpoint: profile?.endpoint || undefined,
    forcePathStyle: profile?.forcePathStyle,
    objectLockMode,
    objectLockRetainDays
  };
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Streamed single PUT below this size; multipart upload above it. */
const SINGLE_PUT_MAX = 16 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;

function hashFileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function hmac(key: Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sign(key: string, date: string, region: string, service: string): string {
  const kDate = hmac(Buffer.from('AWS4' + key, 'utf8'), date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning.toString('hex');
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export class S3Store {
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly endpoint: string;
  private readonly forcePathStyle: boolean;

  constructor(config: S3Config) {
    this.region = config.region;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.bucket = config.bucket;
    this.prefix = config.prefix.replace(/^\/+/, '').replace(/\/+$/, '');
    this.endpoint = config.endpoint ?? `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    this.forcePathStyle = config.forcePathStyle ?? false;
  }

  private objectKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private host(): string {
    const url = new URL(this.endpoint);
    return url.hostname;
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE' | 'POST',
    key: string,
    body?: Buffer | { stream: Readable; length: number; sha256: string },
    query?: URLSearchParams,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
    const url = new URL(this.endpoint);
    const objectKey = this.objectKey(key);
    const path = this.forcePathStyle
      ? `/${this.bucket}/${objectKey.split('/').map(uriEncode).join('/')}`
      : `/${objectKey.split('/').map(uriEncode).join('/')}`;
    const queryString = query ? query.toString() : '';
    const canonicalUri = queryString ? `${path}?${queryString}` : path;
    const payloadHash = !body
      ? sha256(Buffer.alloc(0))
      : Buffer.isBuffer(body)
        ? sha256(body)
        : body.sha256;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(extraHeaders ?? {})
    };
    const signedHeaders = Object.keys(headers)
      .sort()
      .map((h) => h.toLowerCase())
      .join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      Object.keys(headers)
        .sort()
        .map((h) => `${h.toLowerCase()}:${headers[h]}`)
        .join('\n'),
      '',
      signedHeaders,
      payloadHash
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
    const signingKey = sign(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto.createHmac('sha256', Buffer.from(signingKey, 'hex')).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const contentLength = body ? body.length : undefined;

    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          method,
          hostname: url.hostname,
          port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
          path: canonicalUri,
          headers: {
            ...headers,
            Authorization: authorization,
            ...(contentLength !== undefined ? { 'Content-Length': contentLength } : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
        }
      );
      req.on('error', reject);
      if (!body) {
        req.end();
      } else if (Buffer.isBuffer(body)) {
        req.end(body);
      } else {
        body.stream.on('error', (error) => req.destroy(error));
        body.stream.pipe(req);
      }
    });
  }

  /** Upload `data` to `key` (relative to the configured prefix). */
  async put(key: string, data: Buffer, objectLock?: ObjectLockRequest): Promise<void> {
    const res = await this.request('PUT', key, data, undefined, objectLock ? objectLockHeaders(objectLock) : undefined);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${res.body.toString('utf8')}`);
    }
  }

  /**
   * Upload a local file to `key` without buffering it in memory: a streamed
   * single PUT up to `SINGLE_PUT_MAX`, multipart upload above it. Object Lock
   * headers are applied to the finished object either way.
   */
  async putFile(localPath: string, key: string, opts: { objectLock?: ObjectLockRequest } = {}): Promise<void> {
    const size = fs.statSync(localPath).size;
    if (size <= SINGLE_PUT_MAX) {
      const digest = await hashFileSha256(localPath);
      const res = await this.request(
        'PUT',
        key,
        { stream: fs.createReadStream(localPath), length: size, sha256: digest },
        undefined,
        opts.objectLock ? objectLockHeaders(opts.objectLock) : undefined
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${res.body.toString('utf8')}`);
      }
      return;
    }
    await this.multipartUpload(localPath, key, size, opts.objectLock);
  }

  private async multipartUpload(
    localPath: string,
    key: string,
    size: number,
    objectLock?: ObjectLockRequest
  ): Promise<void> {
    const initiate = await this.request(
      'POST',
      key,
      undefined,
      new URLSearchParams({ uploads: '' }),
      objectLock ? objectLockHeaders(objectLock) : undefined
    );
    if (initiate.status < 200 || initiate.status >= 300) {
      throw new Error(
        `S3 multipart init for ${key} failed: HTTP ${initiate.status} ${initiate.body.toString('utf8')}`
      );
    }
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initiate.body.toString('utf8'))?.[1];
    if (!uploadId) {
      throw new Error(`S3 multipart init for ${key} returned no UploadId`);
    }

    const parts: Array<{ PartNumber: number; ETag: string }> = [];
    try {
      const handle = await fs.promises.open(localPath, 'r');
      try {
        const buffer = Buffer.alloc(PART_SIZE);
        let position = 0;
        let partNumber = 1;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, PART_SIZE, position);
          if (bytesRead === 0) break;
          const data = bytesRead === PART_SIZE ? buffer : buffer.subarray(0, bytesRead);
          const res = await this.request(
            'PUT',
            key,
            data,
            new URLSearchParams({ partNumber: String(partNumber), uploadId }),
            { 'content-md5': crypto.createHash('md5').update(data).digest('base64') }
          );
          if (res.status < 200 || res.status >= 300) {
            throw new Error(
              `S3 multipart part ${partNumber} for ${key} failed: HTTP ${res.status} ${res.body.toString('utf8')}`
            );
          }
          const etag = res.headers.etag;
          if (!etag) throw new Error(`S3 multipart part ${partNumber} for ${key} returned no ETag`);
          parts.push({ PartNumber: partNumber, ETag: etag });
          position += bytesRead;
          partNumber++;
          if (bytesRead < PART_SIZE) break;
        }
      } finally {
        await handle.close();
      }

      const completeXml =
        '<CompleteMultipartUpload>' +
        parts.map((p) => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>';
      const complete = await this.request(
        'POST',
        key,
        Buffer.from(completeXml, 'utf8'),
        new URLSearchParams({ uploadId })
      );
      if (complete.status < 200 || complete.status >= 300) {
        throw new Error(
          `S3 multipart complete for ${key} failed: HTTP ${complete.status} ${complete.body.toString('utf8')}`
        );
      }
      if (size === 0) {
        // S3 requires at least one part; a zero-byte file never reaches here
        // (it takes the single-PUT path), but keep the invariant explicit.
        throw new Error(`S3 multipart upload for ${key} produced no parts`);
      }
    } catch (error) {
      // Best-effort abort so a failed large upload does not leak parts.
      try {
        await this.request('DELETE', key, undefined, new URLSearchParams({ uploadId }));
      } catch {
        /* abort is best-effort */
      }
      throw error;
    }
  }

  /** Download the object at `key`. */
  async get(key: string): Promise<Buffer> {
    const res = await this.request('GET', key);
    if (res.status !== 200) {
      throw new Error(`S3 GET ${key} failed: HTTP ${res.status} ${res.body.toString('utf8')}`);
    }
    return res.body;
  }

  /** Delete the object at `key`. */
  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`S3 DELETE ${key} failed: HTTP ${res.status}`);
    }
  }

  /** List object keys under a prefix (S3 ListObjectsV2, paginated). */
  async list(prefix?: string): Promise<string[]> {
    const items = await this.listWithMeta(prefix);
    return items.map((i) => i.key);
  }

  /** List objects with their sizes under a prefix. */
  async listWithMeta(prefix?: string): Promise<Array<{ key: string; size: number }>> {
    const items: Array<{ key: string; size: number }> = [];
    let token: string | undefined;
    const listPrefix = prefix ?? '';
    do {
      const query = new URLSearchParams({ 'list-type': '2', prefix: listPrefix });
      if (token) query.set('continuation-token', token);
      const res = await this.request('GET', '', undefined, query);
      if (res.status !== 200) {
        throw new Error(`S3 LIST failed: HTTP ${res.status} ${res.body.toString('utf8')}`);
      }
      const xml = res.body.toString('utf8');
      const contentRegex = /<Contents>(.*?)<\/Contents>/gs;
      let match: RegExpExecArray | null;
      while ((match = contentRegex.exec(xml))) {
        const block = match[1];
        const fullKey = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
        const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0);
        if (fullKey !== undefined) {
          // Return keys relative to the configured prefix so getRange/delete
          // (which re-prepend the prefix) work.
          const relKey = this.prefix && fullKey.startsWith(this.prefix + '/') ? fullKey.slice(this.prefix.length + 1) : fullKey;
          items.push({ key: relKey, size });
        }
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const nextToken = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
      token = truncated && nextToken ? nextToken : undefined;
    } while (token);
    return items;
  }

  /** Download a byte range of an object. */
  async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    const res = await this.request('GET', key, undefined, undefined, { Range: `bytes=${offset}-${offset + length - 1}` });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`S3 RANGE GET ${key} failed: HTTP ${res.status} ${res.body.toString('utf8')}`);
    }
    return res.body;
  }

  /** The resolved key for an object (prefix + key). */
  resolveKey(key: string): string {
    return this.objectKey(key);
  }
}
