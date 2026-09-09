import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';

/**
 * Minimal S3 client using AWS Signature v4. No external SDK: it signs and sends
 * PUT/GET/LIST requests directly. Supports custom endpoints (MinIO, tests) via
 * `endpoint` and path-style addressing.
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
  return {
    region: profile?.region ?? env.AWS_REGION ?? 'us-east-1',
    accessKeyId: profile?.accessKeyId ?? env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: profile?.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY ?? '',
    bucket: bucket || profile?.bucket || '',
    prefix: prefix || profile?.prefix || '',
    endpoint: profile?.endpoint || undefined,
    forcePathStyle: profile?.forcePathStyle
  };
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
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
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    body?: Buffer,
    query?: URLSearchParams,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; body: Buffer }> {
    const url = new URL(this.endpoint);
    const objectKey = this.objectKey(key);
    const path = this.forcePathStyle
      ? `/${this.bucket}/${objectKey.split('/').map(uriEncode).join('/')}`
      : `/${objectKey.split('/').map(uriEncode).join('/')}`;
    const queryString = query ? query.toString() : '';
    const canonicalUri = queryString ? `${path}?${queryString}` : path;
    const payloadHash = sha256(body ?? Buffer.alloc(0));
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

    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          method,
          hostname: url.hostname,
          port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
          path: canonicalUri,
          headers: { ...headers, Authorization: authorization, ...(body ? { 'Content-Length': body.length } : {}) }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** Upload `data` to `key` (relative to the configured prefix). */
  async put(key: string, data: Buffer): Promise<void> {
    const res = await this.request('PUT', key, data);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${res.body.toString('utf8')}`);
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
