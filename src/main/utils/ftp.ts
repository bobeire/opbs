import * as fs from 'fs';
import { Readable, Writable } from 'stream';

/**
 * FTP / FTPS destination support backed by `basic-ftp`. Provides an
 * `SftpStore`/`S3Store`-compatible object API (put/get/getRange/delete/
 * list/listWithMeta/resolveKey/uploadFile) so the same CLI `store`/retention
 * paths work over ftp:// and ftps:// URIs. The client factory is injectable so
 * the protocol logic is unit-testable offline, and the dependency is lazily
 * required so it stays out of the WinPE/CLI payload module graph.
 */

export type FtpSecurity = 'plain' | 'explicit' | 'implicit';

export interface FtpConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  /** Directory on the server where images live (mirrors an S3 "prefix"). */
  remotePath: string;
  /**
   * 'plain' = cleartext FTP (NOT recommended); 'explicit' = FTPS on port 21
   * via AUTH TLS; 'implicit' = FTPS on port 990. Defaults to 'explicit' when a
   * TLS mode is required and to 'plain' for plain ftp:// URIs.
   */
  secure: FtpSecurity;
}

export interface FtpProfileSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  secure: FtpSecurity;
}

export interface ParsedFtpLocation {
  scheme: 'ftp' | 'ftps';
  host: string;
  port: number;
  username: string;
  password?: string;
  remotePath: string;
}

function defaultPort(scheme: 'ftp' | 'ftps'): number {
  return scheme === 'ftps' ? 990 : 21;
}

/** Parse an `ftp://` or `ftps://[user[:pass]@]host[:port][/path]` URI. */
export function parseFtpLocation(uri: string): ParsedFtpLocation {
  const trimmed = uri.trim();
  const match = trimmed.match(/^(ftp|ftps):\/\/(.*)$/i);
  if (!match) {
    throw new Error(`Not an FTP location: ${uri}`);
  }
  const scheme = (match[1].toLowerCase() === 'ftps' ? 'ftps' : 'ftp') as 'ftp' | 'ftps';
  const rest = match[2];
  let auth = '';
  let hostPortPath = rest;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    auth = rest.slice(0, at);
    hostPortPath = rest.slice(at + 1);
  }
  let username = '';
  let password: string | undefined;
  if (auth) {
    const colon = auth.indexOf(':');
    username = decodeURIComponent(colon === -1 ? auth : auth.slice(0, colon));
    if (colon !== -1) password = decodeURIComponent(auth.slice(colon + 1));
  }
  const slash = hostPortPath.indexOf('/');
  const hostPort = slash === -1 ? hostPortPath : hostPortPath.slice(0, slash);
  const remotePath = slash === -1 ? '' : decodeURIComponent(hostPortPath.slice(slash + 1));
  let host = hostPort;
  let port = defaultPort(scheme);
  const bracket = hostPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = Number(hostPort.slice(colon + 1));
    }
  }
  if (!host) {
    throw new Error(`FTP location is missing a host: ${uri}`);
  }
  return { scheme, host, port, username, password, remotePath: remotePath.replace(/\/+$/, '') };
}

/**
 * Build an FtpConfig for a destination URI from the cloud profile, falling
 * back to FTP_* environment variables. The URI wins for host/port/user/path;
 * the profile supplies credentials, a port and the TLS mode fallback.
 */
export function resolveFtpConfig(
  profile: Partial<FtpConfig> | undefined,
  uri: string,
  env: NodeJS.ProcessEnv = process.env
): FtpConfig {
  const parsed = parseFtpLocation(uri);
  let secure: FtpSecurity = profile?.secure ?? (parsed.scheme === 'ftps' ? 'implicit' : 'plain');
  const envSecure = (env.FTP_SECURE ?? '').toLowerCase();
  if (envSecure === 'plain' || envSecure === 'explicit' || envSecure === 'implicit') {
    secure = envSecure;
  }
  return {
    host: parsed.host || profile?.host || '',
    port: parsed.port !== defaultPort(parsed.scheme) ? parsed.port : profile?.port || defaultPort(parsed.scheme),
    username: parsed.username || profile?.username || env.FTP_USER || '',
    password: parsed.password || profile?.password || env.FTP_PASSWORD || undefined,
    remotePath: parsed.remotePath || profile?.remotePath || '',
    secure
  };
}

/**
 * The subset of the basic-ftp `Client` surface the store uses; injectable for
 * offline tests.
 */
export interface FtpClientLike {
  access(options: {
    host: string;
    port: number;
    user: string;
    password?: string;
    secure?: boolean | string;
  }): Promise<void>;
  ensureDir(path: string): Promise<void>;
  list(path?: string): Promise<Array<{ name: string; size?: number; isDirectory: boolean }>>;
  downloadTo(dest: NodeJS.WritableStream | string, toPath: string, startAt?: number): Promise<void>;
  uploadFrom(source: NodeJS.ReadableStream | string, toPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  close(): void;
}

type FtpClientCtor = new () => FtpClientLike;

function createFtpClient(): FtpClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const basicFtp = require('basic-ftp') as { Client: FtpClientCtor };
  return new basicFtp.Client();
}

export interface FtpEntry {
  key: string;
  size: number;
}

export class FtpStore {
  private readonly config: FtpConfig;
  private readonly createClient: () => FtpClientLike;
  private readonly connectTimeoutMs: number;

  constructor(options: {
    config: FtpConfig;
    /** Inject a fake basic-ftp-like client factory for tests. */
    createClient?: () => FtpClientLike;
    connectTimeoutMs?: number;
  }) {
    this.config = options.config;
    this.createClient = options.createClient ?? createFtpClient;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000;
  }

  private remoteKey(key: string): string {
    const dir = this.config.remotePath.replace(/\/+$/, '');
    return dir ? `${dir}/${key}` : key;
  }

  private modeToBasicFtpSecure(secure: FtpSecurity): boolean | string {
    if (secure === 'implicit') return 'implicit';
    if (secure === 'explicit') return 'explicit';
    return false;
  }

  /** Open a connection, authenticate, run `fn`, then close. */
  private async withFtp<T>(fn: (client: FtpClientLike) => Promise<T>): Promise<T> {
    const client = this.createClient();
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`FTP connection to ${this.config.host}:${this.config.port} timed out`)), this.connectTimeoutMs);
      t.unref();
    });
    try {
      await Promise.race([
        (async () => {
          await client.access({
            host: this.config.host,
            port: this.config.port,
            user: this.config.username,
            password: this.config.password,
            secure: this.modeToBasicFtpSecure(this.config.secure)
          });
        })(),
        timeout
      ]);
      return await fn(client);
    } finally {
      try {
        client.close();
      } catch {
        /* best-effort close */
      }
    }
  }

  /** Upload `data` to `key` (relative to the configured remote path). */
  async put(key: string, data: Buffer): Promise<void> {
    await this.withFtp(async (client) => {
      await client.ensureDir(this.config.remotePath);
      await client.uploadFrom(Readable.from([data]), this.remoteKey(key));
    });
  }

  /** Stream a local file to `key` (avoids buffering large images in memory). */
  async uploadFile(localPath: string, key: string): Promise<void> {
    await this.withFtp(async (client) => {
      await client.ensureDir(this.config.remotePath);
      await client.uploadFrom(fs.createReadStream(localPath), this.remoteKey(key));
    });
  }

  /** Download the object at `key` into memory. */
  async get(key: string): Promise<Buffer> {
    let out: Buffer = Buffer.alloc(0);
    await this.withFtp(async (client) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer | string, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        }
      });
      await client.downloadTo(sink, this.remoteKey(key));
      out = Buffer.concat(chunks);
    });
    return out;
  }

  /** Download a byte range of an object (restarts at `offset`). */
  async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    let out: Buffer = Buffer.alloc(0);
    await this.withFtp(async (client) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer | string, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        }
      });
      await client.downloadTo(sink, this.remoteKey(key), offset);
      out = Buffer.concat(chunks).subarray(0, Math.max(0, length));
    });
    return out;
  }

  /** Delete the object at `key`. */
  async delete(key: string): Promise<void> {
    await this.withFtp(async (client) => {
      await client.remove(this.remoteKey(key));
    });
  }

  /** List object keys under the remote path. */
  async list(prefix?: string): Promise<string[]> {
    const items = await this.listWithMeta(prefix);
    return items.map((i) => i.key);
  }

  /** List objects with their sizes under the remote path. */
  async listWithMeta(prefix?: string): Promise<FtpEntry[]> {
    return this.withFtp(async (client) => {
      const dir = this.config.remotePath;
      await client.ensureDir(dir);
      const entries = await client.list(dir);
      const items: FtpEntry[] = [];
      for (const entry of entries) {
        const name = entry.name;
        if (!name || name === '.' || name === '..') continue;
        if (entry.isDirectory) continue;
        if (prefix && !name.startsWith(prefix)) continue;
        items.push({ key: name, size: entry.size ?? 0 });
      }
      return items.sort((a, b) => a.key.localeCompare(b.key));
    });
  }

  /** The resolved remote path for an object key. */
  resolveKey(key: string): string {
    return this.remoteKey(key);
  }
}