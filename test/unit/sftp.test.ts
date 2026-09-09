import { describe, it, expect } from 'vitest';
import * as stream from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSftpLocation, resolveSftpConfig, SftpStore } from '../../src/main/utils/sftp';

describe('parseSftpLocation', () => {
  it('parses scheme + host + path', () => {
    expect(parseSftpLocation('sftp://host.example.com/backups')).toEqual({
      host: 'host.example.com',
      port: 22,
      username: '',
      password: undefined,
      remotePath: 'backups'
    });
  });

  it('parses user:password@host:port with an absolute path', () => {
    expect(parseSftpLocation('sftp://me:s3cr3t@host:2222/var/backups/')).toEqual({
      host: 'host',
      port: 2222,
      username: 'me',
      password: 's3cr3t',
      remotePath: 'var/backups'
    });
  });

  it('handles percent-encoded credentials', () => {
    expect(parseSftpLocation('sftp://user%40corp:p%40ss@host/dir').username).toBe('user@corp');
    expect(parseSftpLocation('sftp://user%40corp:p%40ss@host/dir').password).toBe('p@ss');
  });

  it('handles IPv6 hosts in brackets', () => {
    expect(parseSftpLocation('sftp://[::1]:2022/backups')).toEqual({
      host: '::1',
      port: 2022,
      username: '',
      password: undefined,
      remotePath: 'backups'
    });
  });

  it('throws on non-sftp URIs', () => {
    expect(() => parseSftpLocation('sftpX://host')).toThrow(/Not an SFTP location/);
  });

  it('throws when the host is missing', () => {
    expect(() => parseSftpLocation('sftp:///path')).toThrow(/missing a host/i);
  });
});

describe('resolveSftpConfig', () => {
  it('pulls credentials from the profile and path from the URI', () => {
    const config = resolveSftpConfig(
      { host: 'profile-host', port: 2222, username: 'profile-user', password: 'pw', remotePath: 'profile' },
      'sftp://uri-host/x/y'
    );
    expect(config.host).toBe('uri-host');
    expect(config.port).toBe(2222); // URI had no port -> profile port wins
    expect(config.username).toBe('profile-user'); // profile supplies the username fallback
    expect(config.remotePath).toBe('x/y');
    expect(config.password).toBe('pw');
  });

  it('uses the profile port when the URI does not specify one', () => {
    const config = resolveSftpConfig({ port: 2222 }, 'sftp://host/path');
    expect(config.port).toBe(2222);
  });

  it('falls back to SFTP_* environment variables', () => {
    const env = {
      SFTP_USER: 'env-user',
      SFTP_PASSWORD: 'env-pass',
      SFTP_PRIVATE_KEY: 'C:/keys/id_ed25519'
    } as NodeJS.ProcessEnv;
    const config = resolveSftpConfig(undefined, 'sftp://host/path', env);
    expect(config.username).toBe('env-user');
    expect(config.password).toBe('env-pass');
    expect(config.privateKey).toBe('C:/keys/id_ed25519');
  });

  it('URI password wins over the profile', () => {
    const config = resolveSftpConfig({ password: 'profile-pass' }, 'sftp://u:uri-pass@host/path');
    expect(config.password).toBe('uri-pass');
  });
});

/** In-memory SSH/SFTP facade providing the ssh2 surface the store uses. */
class FakeSftpServer {
  files = new Map<string, Buffer>();
  dirs = new Set<string>();
  connectError = false;

  mkdir(p: string, cb: (err?: Error) => void): void {
    if (this.dirs.has(p)) {
      cb(new Error('already exists'));
      return;
    }
    if (this.files.has(p)) {
      cb(new Error('not a directory'));
      return;
    }
    this.dirs.add(p);
    cb();
  }

  stat(p: string, cb: (err?: Error | undefined, s?: { isDirectory: () => boolean; size: number }) => void): void {
    if (this.dirs.has(p)) {
      cb(undefined, { isDirectory: () => true, size: 0 });
    } else if (this.files.has(p)) {
      cb(undefined, { isDirectory: () => false, size: this.files.get(p)!.length });
    } else {
      cb(new Error('no such file'));
    }
  }

  readdir(p: string, cb: (err: Error | undefined, list?: Array<{ filename: string; attrs: { isDirectory: () => boolean; size: number } }>) => void): void {
    if (!this.dirs.has(p)) {
      cb(new Error('no such file'));
      return;
    }
    const out: Array<{ filename: string; attrs: { isDirectory: () => boolean; size: number } }> = [];
    const names = new Set<string>();
    for (const f of this.files.keys()) if (f.startsWith(p ? p + '/' : '')) names.add(f.slice(p.length + 1));
    for (const d of this.dirs) if (d !== p && d.startsWith(p ? p + '/' : '')) names.add(d.slice(p.length + 1).split('/')[0]);
    for (const n of names) {
      const full = p ? `${p}/${n}` : n;
      out.push({
        filename: n,
        attrs: { isDirectory: () => this.dirs.has(full), size: this.files.get(full)?.length ?? 0 }
      });
    }
    cb(undefined, out);
  }

  writeFile(p: string, data: Buffer, cb: (err?: Error) => void): void {
    this.files.set(p, data);
    cb();
  }

  readFile(p: string, cb: (err?: Error, data?: Buffer) => void): void {
    const data = this.files.get(p);
    if (data === undefined) cb(new Error('no such file'));
    else cb(undefined, data);
  }

  unlink(p: string, cb: (err?: Error) => void): void {
    if (!this.files.delete(p)) cb(new Error('no such file'));
    else cb();
  }

  createWriteStream(p: string): NodeJS.WritableStream {
    const pending: Buffer[] = [];
    const fake = this;
    const ws = new stream.Writable({
      write(chunk: Buffer, _enc, cb) {
        pending.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        fake.files.set(p, Buffer.concat(pending));
        cb();
      }
    });
    return ws;
  }

  createReadStream(p: string, opts?: { start?: number; end?: number }): NodeJS.ReadableStream {
    const data = this.files.get(p) ?? Buffer.alloc(0);
    const start = opts?.start ?? 0;
    const end = opts?.end === undefined ? data.length : Math.min(opts.end + 1, data.length);
    return stream.Readable.from([data.subarray(start, end)]);
  }

  sftp(cb: (err?: Error, sftp?: unknown) => void): void {
    cb(undefined, this);
  }

  connect(): void {
    /* swallow */
  }

  end(): void {
    /* swallow */
  }
}

class FakeClient {
  private listeners: Record<string, Array<(err?: Error) => void>> = { ready: [], error: [] };
  private server: FakeSftpServer;

  constructor(server: FakeSftpServer) {
    this.server = server;
  }

  on(evt: string, cb: (err?: Error) => void): void {
    this.listeners[evt] = this.listeners[evt] ?? [];
    this.listeners[evt].push(cb);
  }

  connect(opts: Record<string, unknown>): void {
    if (this.server.connectError) {
      setTimeout(() => this.listeners.error.forEach((cb) => cb(new Error('connection refused'))), 0);
    } else {
      setImmediate(() => this.listeners.ready.forEach((cb) => cb()));
    }
  }

  sftp(cb: (err?: Error | undefined, sftp?: unknown) => void): void {
    this.server.sftp(cb);
  }

  end(): void {
    /* swallow */
  }
}

function makeStore(config: { host: string; username: string; password: string; remotePath: string; port?: number }, server: FakeSftpServer) {
  return new SftpStore({
    config: { port: 22, ...config },
    createClient: () => new FakeClient(server)
  });
}

describe('SftpStore', () => {
  it('put + resolveKey writes files under remotePath', async () => {
    const server = new FakeSftpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'backups' }, server);
    await store.put('img.opbs', Buffer.from('hello'));
    expect(server.files.get('backups/img.opbs')?.toString()).toBe('hello');
    expect(store.resolveKey('img.opbs')).toBe('backups/img.opbs');
  });

  it('get returns the stored bytes and getRange honours offsets', async () => {
    const server = new FakeSftpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await store.put('img.opbs', Buffer.from('0123456789'));
    const full = await store.get('img.opbs');
    expect(full.toString()).toBe('0123456789');
    const range = await store.getRange('img.opbs', 2, 3);
    expect(range.toString()).toBe('234');
  });

  it('uploadFile streams a local file to the remote path', async () => {
    const server = new FakeSftpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'r/d' }, server);
    const local = path.join(os.tmpdir(), `opbs-sftp-test-${Date.now()}.bin`);
    fs.writeFileSync(local, Buffer.alloc(1500, 0x5a));
    try {
      await store.uploadFile(local, 'big.opbs');
      expect(server.files.get('r/d/big.opbs')?.length).toBe(1500);
    } finally {
      fs.rmSync(local, { force: true });
    }
  });

  it('list returns filenames and excludes directories', async () => {
    const server = new FakeSftpServer();
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
    const server = new FakeSftpServer();
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await store.put('gone.opbs', Buffer.from('x'));
    await store.delete('gone.opbs');
    expect(server.files.has('b/gone.opbs')).toBe(false);
  });

  it('missing files surface as errors', async () => {
    const server = new FakeSftpServer();
    server.dirs.add('b');
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await expect(store.get('nope.opbs')).rejects.toThrow(/no such file/);
  });

  it('wraps connection failures in a descriptive error', async () => {
    const server = new FakeSftpServer();
    server.connectError = true;
    const store = makeStore({ host: 'h', username: 'u', password: 'p', remotePath: 'b' }, server);
    await expect(store.list()).rejects.toThrow(/connection to h:22 failed.*connection refused/i);
  });
});