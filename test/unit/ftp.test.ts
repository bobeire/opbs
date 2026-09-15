import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseFtpLocation,
  resolveFtpConfig,
  FtpStore,
  type FtpClientLike,
  type FtpSecurity
} from '../../src/main/utils/ftp';

describe('parseFtpLocation', () => {
  it('parses scheme + host + path', () => {
    expect(parseFtpLocation('ftp://host.example.com/backups')).toEqual({
      scheme: 'ftp',
      host: 'host.example.com',
      port: 21,
      username: '',
      password: undefined,
      remotePath: 'backups'
    });
  });

  it('parses user:password@host:port with an absolute path', () => {
    expect(parseFtpLocation('ftp://me:s3cr3t@host:2121/var/backups/')).toEqual({
      scheme: 'ftp',
      host: 'host',
      port: 2121,
      username: 'me',
      password: 's3cr3t',
      remotePath: 'var/backups'
    });
  });

  it('handles percent-encoded credentials', () => {
    expect(parseFtpLocation('ftp://user%40corp:p%40ss@host/dir').username).toBe('user@corp');
    expect(parseFtpLocation('ftp://user%40corp:p%40ss@host/dir').password).toBe('p@ss');
  });

  it('handles IPv6 hosts in brackets', () => {
    expect(parseFtpLocation('ftp://[::1]:2121/backups')).toEqual({
      scheme: 'ftp',
      host: '::1',
      port: 2121,
      username: '',
      password: undefined,
      remotePath: 'backups'
    });
  });

  it('defaults ftps:// scheme to port 990 (implicit TLS)', () => {
    expect(parseFtpLocation('ftps://host/backups')).toEqual({
      scheme: 'ftps',
      host: 'host',
      port: 990,
      username: '',
      password: undefined,
      remotePath: 'backups'
    });
  });

  it('throws on non-ftp URIs', () => {
    expect(() => parseFtpLocation('ftpX://host')).toThrow(/Not an FTP location/);
  });

  it('throws when the host is missing', () => {
    expect(() => parseFtpLocation('ftp:///path')).toThrow(/missing a host/i);
  });
});

describe('resolveFtpConfig', () => {
  it('pulls credentials from the profile and path from the URI', () => {
    const config = resolveFtpConfig(
      { host: 'profile-host', port: 2121, username: 'profile-user', password: 'pw', remotePath: 'profile', secure: 'explicit' },
      'ftp://uri-host/x/y'
    );
    expect(config.host).toBe('uri-host');
    expect(config.port).toBe(2121); // URI had no port -> profile port wins
    expect(config.username).toBe('profile-user'); // profile supplies the username fallback
    expect(config.remotePath).toBe('x/y');
    expect(config.password).toBe('pw');
    expect(config.secure).toBe('explicit');
  });

  it('uses the profile port when the URI does not specify one', () => {
    const config = resolveFtpConfig({ port: 2121 }, 'ftp://host/path');
    expect(config.port).toBe(2121);
  });

  it('falls back to FTP_* environment variables for credentials', () => {
    const env = {
      FTP_USER: 'env-user',
      FTP_PASSWORD: 'env-pass'
    } as NodeJS.ProcessEnv;
    const config = resolveFtpConfig(undefined, 'ftp://host/path', env);
    expect(config.username).toBe('env-user');
    expect(config.password).toBe('env-pass');
  });

  it('URI password wins over the profile', () => {
    const config = resolveFtpConfig({ password: 'profile-pass' }, 'ftp://u:uri-pass@host/path');
    expect(config.password).toBe('uri-pass');
  });

  it('maps TLS mode: ftp:// plain, ftps:// implicit, FTP_SECURE overrides', () => {
    expect(resolveFtpConfig(undefined, 'ftp://host/path').secure).toBe('plain');
    expect(resolveFtpConfig(undefined, 'ftps://host/path').secure).toBe('implicit');
    const env = { FTP_SECURE: 'explicit' } as NodeJS.ProcessEnv;
    expect(resolveFtpConfig(undefined, 'ftps://host/path', env).secure).toBe('explicit');
  });
});

/** In-memory basic-ftp facade exposing only what FtpStore uses. */
class FakeFtpServer {
  files = new Map<string, Buffer>();
  dirs = new Set<string>();
  failAccess = false;
}

class FakeFtpClient implements FtpClientLike {
  server: FakeFtpServer;
  accessHost = '';
  accessPort = 0;
  accessUser = '';
  accessSecure: boolean | string | undefined;
  closed = false;

  constructor(server: FakeFtpServer) {
    this.server = server;
  }

  async access(opts: { host: string; port: number; user: string; password?: string; secure?: boolean | string }): Promise<void> {
    if (this.server.failAccess) throw new Error('connection refused');
    this.accessHost = opts.host;
    this.accessPort = opts.port;
    this.accessUser = opts.user;
    this.accessSecure = opts.secure;
  }

  async ensureDir(dir: string): Promise<void> {
    if (dir) this.server.dirs.add(dir);
  }

  async list(dir: string): Promise<Array<{ name: string; size?: number; isDirectory: boolean }>> {
    const prefix = dir ? dir + '/' : '';
    const names = new Set<string>();
    for (const f of this.server.files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]);
    for (const d of this.server.dirs) if (d !== dir && d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0]);
    return [...names].map((n) => {
      const full = prefix + n;
      return { name: n, size: this.server.files.get(full)?.length, isDirectory: this.server.dirs.has(full) };
    });
  }

  async downloadTo(dest: NodeJS.WritableStream | string, toPath: string, startAt = 0): Promise<void> {
    const data = this.server.files.get(toPath);
    if (data === undefined) throw new Error('no such file');
    const slice = data.subarray(startAt);
    if (typeof dest === 'string') {
      fs.writeFileSync(dest, slice);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      dest.write(slice, (err?: Error) => (err ? reject(err) : resolve()));
    });
  }

  async uploadFrom(source: NodeJS.ReadableStream | string, toPath: string): Promise<void> {
    if (typeof source === 'string') {
      this.server.files.set(toPath, fs.readFileSync(source));
      return;
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      source.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      source.on('end', () => resolve());
      source.on('error', reject);
    });
    this.server.files.set(toPath, Buffer.concat(chunks));
  }

  async remove(toPath: string): Promise<void> {
    if (!this.server.files.delete(toPath)) throw new Error('no such file');
  }

  close(): void {
    this.closed = true;
  }
}

function makeStore(config: { host: string; username: string; password: string; remotePath: string; port?: number; secure?: FtpSecurity }, server: FakeFtpServer) {
  return new FtpStore({
    config: { port: 21, secure: 'explicit', ...config },
    createClient: () => new FakeFtpClient(server)
  });
}

describe('FtpStore', () => {
  it('put + resolveKey writes files under remotePath', async () => {
    const server = new FakeFtpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'backups' }, server);
    await store.put('img.opbs', Buffer.from('hello'));
    expect(server.files.get('backups/img.opbs')?.toString()).toBe('hello');
    expect(store.resolveKey('img.opbs')).toBe('backups/img.opbs');
  });

  it('get returns the stored bytes and getRange honours offsets', async () => {
    const server = new FakeFtpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await store.put('img.opbs', Buffer.from('0123456789'));
    const full = await store.get('img.opbs');
    expect(full.toString()).toBe('0123456789');
    const range = await store.getRange('img.opbs', 2, 3);
    expect(range.toString()).toBe('234');
  });

  it('uploadFile streams a local file to the remote path', async () => {
    const server = new FakeFtpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'r/d' }, server);
    const local = path.join(os.tmpdir(), `opbs-ftp-test-${Date.now()}.bin`);
    fs.writeFileSync(local, Buffer.alloc(1500, 0x5a));
    try {
      await store.uploadFile(local, 'big.opbs');
      expect(server.files.get('r/d/big.opbs')?.length).toBe(1500);
    } finally {
      fs.rmSync(local, { force: true });
    }
  });

  it('list returns filenames and excludes directories', async () => {
    const server = new FakeFtpServer();
    server.dirs.add('b');
    server.files.set('b/one.opbs', Buffer.alloc(1));
    server.files.set('b/two.opbs', Buffer.alloc(2));
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    const keys = await store.list();
    expect(keys.sort()).toEqual(['one.opbs', 'two.opbs']);
    const meta = await store.listWithMeta();
    expect(meta.find((m) => m.key === 'two.opbs')?.size).toBe(2);
  });

  it('delete removes the file', async () => {
    const server = new FakeFtpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await store.put('gone.opbs', Buffer.from('x'));
    await store.delete('gone.opbs');
    expect(server.files.has('b/gone.opbs')).toBe(false);
  });

  it('passes the TLS mode to the client access() call', async () => {
    const server = new FakeFtpServer();
    const cases: Array<[FtpSecurity, boolean | string]> = [
      ['implicit', 'implicit'],
      ['explicit', 'explicit'],
      ['plain', false]
    ];
    for (const [secure, expected] of cases) {
      let lastClient: FakeFtpClient | undefined;
      const store = new FtpStore({
        config: { host: 'h', port: 21, username: 'u', password: 'p', remotePath: 'b', secure },
        createClient: () => {
          lastClient = new FakeFtpClient(server);
          return lastClient;
        }
      });
      await store.list();
      expect(lastClient!.accessSecure).toBe(expected);
    }
  });

  it('missing files surface as errors', async () => {
    const server = new FakeFtpServer();
    server.dirs.add('b');
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await expect(store.get('nope.opbs')).rejects.toThrow(/no such file/);
  });

  it('wraps connection failures in a descriptive error', async () => {
    const server = new FakeFtpServer();
    server.failAccess = true;
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await expect(store.list()).rejects.toThrow(/connection refused/);
  });
});