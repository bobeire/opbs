import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';

/**
 * Lazily loads ssh2 so the module graph of the WinPE/CLI payload stays free of
 * `ssh2` (only fzstd/zstdify + the native addon are bundled on media). sftp://
 * destinations load the dependency at connect time, in the main app.
 */
function createSshClient(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ssh2 = require('ssh2') as { Client: new () => unknown };
  return new ssh2.Client();
}

/**
 * SFTP destination support backed by the `ssh2` client. Provides a
 * `S3Store`-compatible object API (put/get/getRange/delete/list/resolveKey)
 * so the same CLI `store`/retention paths work over sftp://. The ssh2 client
 * factory is injectable so the protocol logic is unit-testable offline.
 */

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  /** Password auth. `privateKey` (when present) takes precedence. */
  password?: string;
  /** PEM contents or a path to a PEM private-key file (OpenSSH/DSS/RSA/ECDSA). */
  privateKey?: string;
  /** Directory on the server where images live (mirrors an S3 "prefix"). */
  remotePath: string;
}

export interface SftpProfileSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  remotePath: string;
}

export interface ParsedSftpLocation {
  host: string;
  port: number;
  username: string;
  password?: string;
  remotePath: string;
}

/** Parse an `sftp://[user[:pass]@]host[:port][/path]` URI. */
export function parseSftpLocation(uri: string): ParsedSftpLocation {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('sftp://')) {
    throw new Error(`Not an SFTP location: ${uri}`);
  }
  const rest = trimmed.slice('sftp://'.length);
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
  let port = 22;
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
    throw new Error(`SFTP location is missing a host: ${uri}`);
  }
  return { host, port, username, password, remotePath: remotePath.replace(/\/+$/, '') };
}

/**
 * Build an SftpConfig for a destination URI from the cloud profile, falling
 * back to SFTP_* environment variables. The URI wins for host/port/user/path;
 * the profile supplies credentials and a port/remotePath fallback.
 */
export function resolveSftpConfig(
  profile: Partial<SftpConfig> | undefined,
  uri: string,
  env: NodeJS.ProcessEnv = process.env
): SftpConfig {
  const parsed = parseSftpLocation(uri);
  const privateKey = profile?.privateKey ?? env.SFTP_PRIVATE_KEY;
  return {
    host: parsed.host || profile?.host || '',
    port: parsed.port !== 22 ? parsed.port : profile?.port || 22,
    username: parsed.username || profile?.username || env.SFTP_USER || '',
    password: parsed.password || profile?.password || env.SFTP_PASSWORD || undefined,
    privateKey: privateKey || undefined,
    remotePath:
      parsed.remotePath || profile?.remotePath || (privateKey ? path.dirname(privateKey).replace(/\\/g, '/') : '')
  };
}

function fmkdir(sftp: unknown, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    (sftp as { mkdir: (p: string, cb: (err?: Error) => void) => void }).mkdir(p, (err) => (err ? reject(err) : resolve()));
  });
}

function fstat(sftp: unknown, p: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    (sftp as { stat: (p: string, cb: (err?: Error, s?: unknown) => void) => void }).stat(p, (err, s) =>
      err || s === undefined ? reject(err ?? new Error('stat failed')) : resolve(s)
    );
  });
}

async function ensureRemoteDir(sftp: unknown, remoteDir: string): Promise<void> {
  if (!remoteDir) return;
  const parts = remoteDir.split('/').filter(Boolean);
  let acc = remoteDir.startsWith('/') ? '/' : '';
  for (const part of parts) {
    acc = acc === '/' ? `/${part}` : acc ? `${acc}/${part}` : part;
    try {
      await fmkdir(sftp, acc);
    } catch {
      const existing = await fstat(sftp, acc).catch(() => null);
      if (!existing) throw new Error(`SFTP: could not create remote directory ${acc}`);
    }
  }
}

export interface SftpEntry {
  key: string;
  size: number;
}

export class SftpStore {
  private readonly config: SftpConfig;
  private readonly createClient: () => unknown;
  private readonly connectTimeoutMs: number;

  constructor(options: {
    config: SftpConfig;
    /** Inject a fake ssh2-like client factory for tests. */
    createClient?: () => unknown;
    connectTimeoutMs?: number;
  }) {
    this.config = options.config;
    this.createClient = options.createClient ?? createSshClient;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000;
  }

  private remoteKey(key: string): string {
    const dir = this.config.remotePath.replace(/\/+$/, '');
    return dir ? `${dir}/${key}` : key;
  }

  /** Open a connection, run `fn` with the SFTP subsystem, then close. */
  private async withSftp<T>(fn: (sftp: unknown) => Promise<T>): Promise<T> {
    const client = this.createClient() as {
      on: (e: string, cb: (err?: Error) => void) => void;
      connect: (opts: Record<string, unknown>) => void;
      sftp: (cb: (err?: Error | undefined, sftp?: unknown) => void) => void;
      end: () => void;
    };
    let settled = false;
    const sftp = await new Promise<unknown>((resolve, reject) => {
      client.on('ready', () => {
        client.sftp((err, s) => {
          if (err) {
            settled = true;
            reject(new Error(`SFTP subsystem error: ${err.message}`));
            return;
          }
          settled = true;
          resolve(s);
        });
      });
      client.on('error', (err) => {
        if (!settled) {
          settled = true;
          const detail = (err as { message?: string; code?: string })?.message?.trim() || (err as { code?: string })?.code || 'unknown error';
          reject(new Error(`SFTP connection to ${this.config.host}:${this.config.port} failed: ${detail}`));
        }
      });
      try {
        client.connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          password: this.config.password,
          privateKey: this.config.privateKey,
          readyTimeout: this.connectTimeoutMs
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    try {
      return await fn(sftp);
    } finally {
      try {
        client.end();
      } catch {
        /* best-effort close */
      }
    }
  }

  /** Upload `data` to `key` (relative to the configured remote path). */
  async put(key: string, data: Buffer): Promise<void> {
    await this.withSftp(async (sftp) => {
      await ensureRemoteDir(sftp, this.config.remotePath);
      await new Promise<void>((resolve, reject) => {
        (sftp as { writeFile: (p: string, d: Buffer, cb: (err?: Error) => void) => void }).writeFile(
          this.remoteKey(key),
          data,
          (err) => (err ? reject(new Error(`SFTP write ${key} failed: ${err.message}`)) : resolve())
        );
      });
    });
  }

  /** Stream a local file to `key` (avoids buffering large images in memory). */
  async uploadFile(localPath: string, key: string): Promise<void> {
    await this.withSftp(async (sftp) => {
      await ensureRemoteDir(sftp, this.config.remotePath);
      const ws = (sftp as { createWriteStream: (p: string, o?: Record<string, unknown>) => NodeJS.WritableStream }).createWriteStream(this.remoteKey(key));
      try {
        await pipeline(fs.createReadStream(localPath), ws);
      } catch (err) {
        throw new Error(`SFTP upload ${key} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    });
  }

  /** Download the object at `key` into memory. */
  async get(key: string): Promise<Buffer> {
    return this.withSftp(async (sftp) => {
      return await new Promise<Buffer>((resolve, reject) => {
        (sftp as { readFile: (p: string, cb: (err?: Error, d?: Buffer) => void) => void }).readFile(this.remoteKey(key), (err, d) =>
          err || d === undefined ? reject(new Error(`SFTP read ${key} failed: ${err?.message ?? 'empty'} `)) : resolve(d)
        );
      });
    });
  }

  /** Download a byte range of an object. */
  async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    return this.withSftp(async (sftp) => {
      const rs = (sftp as { createReadStream: (p: string, o?: Record<string, unknown>) => NodeJS.ReadableStream }).createReadStream(
        this.remoteKey(key),
        { start: offset, end: offset + length - 1 }
      );
      const chunks: Buffer[] = [];
      for await (const chunk of rs as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    });
  }

  /** Delete the object at `key`. */
  async delete(key: string): Promise<void> {
    await this.withSftp(async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        (sftp as { unlink: (p: string, cb: (err?: Error) => void) => void }).unlink(this.remoteKey(key), (err) =>
          err ? reject(new Error(`SFTP delete ${key} failed: ${err.message}`)) : resolve()
        );
      });
    });
  }

  /** List object keys under the remote path. */
  async list(prefix?: string): Promise<string[]> {
    const items = await this.listWithMeta(prefix);
    return items.map((i) => i.key);
  }

  /** List objects with their sizes under the remote path. */
  async listWithMeta(prefix?: string): Promise<SftpEntry[]> {
    return this.withSftp(async (sftp) => {
      const dir = this.config.remotePath;
      let entries: Array<unknown>;
      try {
        entries = await new Promise<Array<unknown>>((resolve, reject) => {
          (sftp as { readdir: (p: string, cb: (err: Error | undefined, list?: Array<unknown>) => void) => void }).readdir(
            dir,
            (err, list) => (err ? reject(new Error(`SFTP list ${dir} failed: ${err.message}`)) : resolve(list ?? []))
          );
        });
      } catch (err) {
        const st = await fstat(sftp, dir).catch(() => null);
        if (!st) throw err;
        return [];
      }
      const items: SftpEntry[] = [];
      for (const raw of entries) {
        const entry = raw as { filename?: string; attrs?: { isDirectory?: () => boolean; isFile?: () => boolean; mode?: number; size?: number } };
        const filename = entry.filename ?? '';
        if (!filename || filename === '.' || filename === '..') continue;
        if (entry.attrs) {
          const isDir = typeof entry.attrs.isDirectory === 'function' ? entry.attrs.isDirectory() : (((entry.attrs.mode ?? 0) & 0o170000) === 0o040000);
          if (isDir) continue;
        }
        if (prefix && !filename.startsWith(prefix)) continue;
        items.push({ key: filename, size: entry.attrs?.size ?? 0 });
      }
      return items.sort((a, b) => a.key.localeCompare(b.key));
    });
  }

  /** The resolved remote path for an object key. */
  resolveKey(key: string): string {
    return this.remoteKey(key);
  }
}