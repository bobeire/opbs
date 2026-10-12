import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  materializeImageFromCloud,
  planCloudImageDownload,
  isCloudImageLocation,
  type RestoreCloudStore
} from '../../src/main/imaging/cloud-restore';
import {
  encodeHeader,
  IMAGE_VERSION,
  DEFAULT_BLOCK_SIZE,
  COMPRESSION_NONE,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_VERIFIED,
  FLAG_INCREMENTAL,
  CIPHER_NONE,
  SALT_LENGTH,
  type ImageHeader
} from '../../src/main/imaging/image-format';
import { cloudImageEntries } from '../../src/main/backup/retention-s3';
import { pickDrillImage } from '../../src/main/backup/retention';

function imageHeader(opts: { ts: number; base?: string; encrypted?: boolean }): Buffer {
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: opts.ts,
    totalBytes: 0,
    blockSize: DEFAULT_BLOCK_SIZE,
    compressionId: COMPRESSION_NONE,
    partitionCount: 0,
    flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED | (opts.base ? FLAG_INCREMENTAL : 0),
    blockIndexOffset: 0,
    cipherId: opts.encrypted ? 1 : CIPHER_NONE,
    kdfIterations: 0,
    salt: Buffer.alloc(SALT_LENGTH),
    baseImagePath: opts.base ?? '',
    sourceDiskModel: '',
    sourceDiskSerial: ''
  };
  return encodeHeader(header);
}

/** In-memory store implementing the cloud-restore surface (plus delete for cloudImageEntries). */
class FakeStore implements RestoreCloudStore {
  objects = new Map<string, Buffer>();
  downloaded: string[] = [];
  failOn: string | undefined;

  listWithMeta = vi.fn(async () => [...this.objects.entries()].map(([key, buf]) => ({ key, size: buf.length })));

  getRange = vi.fn(async (key: string, offset: number, length: number) => {
    const buf = this.objects.get(key);
    if (!buf) throw new Error(`no such key: ${key}`);
    return buf.subarray(offset, offset + length);
  });

  downloadFile = vi.fn(async (key: string, dest: string, onProgress?: (bytes: number) => void) => {
    if (this.failOn === key) throw new Error(`transfer failed: ${key}`);
    const buf = this.objects.get(key);
    if (!buf) throw new Error(`no such key: ${key}`);
    fs.writeFileSync(dest, buf);
    this.downloaded.push(key);
    onProgress?.(buf.length);
  });

  delete = vi.fn(async () => {});
}

describe('isCloudImageLocation', () => {
  it('accepts the cloud schemes and rejects filesystem locations', () => {
    expect(isCloudImageLocation('s3://bucket/prefix/img.opbs')).toBe(true);
    expect(isCloudImageLocation('sftp://user@host/path/img.opbs')).toBe(true);
    expect(isCloudImageLocation('ftp://user@host/img.opbs')).toBe(true);
    expect(isCloudImageLocation('ftps://user@host/img.opbs')).toBe(true);
    expect(isCloudImageLocation('C:\\backups\\img.opbs')).toBe(false);
    expect(isCloudImageLocation('\\\\server\\share\\img.opbs')).toBe(false);
    expect(isCloudImageLocation('file:///C:/backups')).toBe(false);
    expect(isCloudImageLocation('')).toBe(false);
  });
});

describe('planCloudImageDownload', () => {
  it('plans a root-first chain plus .NNN volumes for a picked delta', async () => {
    const store = new FakeStore();
    store.objects.set('full.opbs', imageHeader({ ts: 1000 }));
    store.objects.set('mid.opbs', imageHeader({ ts: 2000, base: 'C:\\old\\full.opbs' }));
    store.objects.set('delta.opbs', imageHeader({ ts: 3000, base: 'C:\\old\\mid.opbs' }));
    store.objects.set('delta.opbs.001', Buffer.alloc(10, 1));
    store.objects.set('delta.opbs.002', Buffer.alloc(20, 2));
    store.objects.set('unrelated.opbs', imageHeader({ ts: 500 }));

    const plan = await planCloudImageDownload('s3://bucket/prefix/delta.opbs', store);

    expect(plan.files.map((f) => f.key)).toEqual([
      'full.opbs',
      'mid.opbs',
      'delta.opbs',
      'delta.opbs.001',
      'delta.opbs.002'
    ]);
    expect(plan.targetDestName).toBe('delta.opbs');
    expect(plan.totalBytes).toBe(
      plan.files.reduce((sum, f) => sum + f.size, 0)
    );
  });

  it('resolves a directory URI with a single image without a key hint', async () => {
    const store = new FakeStore();
    store.objects.set('only.opbs', imageHeader({ ts: 1 }));
    const plan = await planCloudImageDownload('s3://bucket/prefix', store);
    expect(plan.targetDestName).toBe('only.opbs');
  });

  it('errors when a directory holds several images and no hint is given', async () => {
    const store = new FakeStore();
    store.objects.set('a.opbs', imageHeader({ ts: 1 }));
    store.objects.set('b.opbs', imageHeader({ ts: 2 }));
    await expect(planCloudImageDownload('s3://bucket/prefix', store)).rejects.toThrow(/specify the image/i);
  });

  it('errors when the requested image is not in the listing', async () => {
    const store = new FakeStore();
    store.objects.set('a.opbs', imageHeader({ ts: 1 }));
    await expect(planCloudImageDownload('s3://bucket/prefix/missing.opbs', store)).rejects.toThrow(
      /missing\.opbs not found.*available: a\.opbs/i
    );
  });

  it('errors when the store holds no images at all', async () => {
    const store = new FakeStore();
    store.objects.set('notes.txt', Buffer.from('hi'));
    await expect(planCloudImageDownload('s3://bucket/prefix/img.opbs', store)).rejects.toThrow(/No \.opbs images/);
  });

  it('errors when a base image referenced by a delta is absent', async () => {
    const store = new FakeStore();
    store.objects.set('delta.opbs', imageHeader({ ts: 2, base: 'C:\\old\\full.opbs' }));
    await expect(planCloudImageDownload('s3://bucket/prefix/delta.opbs', store)).rejects.toThrow(
      /Base image full\.opbs of delta\.opbs is not present/
    );
  });

  it('rejects a circular base chain', async () => {
    const store = new FakeStore();
    store.objects.set('a.opbs', imageHeader({ ts: 1, base: 'C:\\old\\b.opbs' }));
    store.objects.set('b.opbs', imageHeader({ ts: 2, base: 'C:\\old\\a.opbs' }));
    await expect(planCloudImageDownload('s3://bucket/prefix/a.opbs', store)).rejects.toThrow(/Circular incremental chain/);
  });
});

describe('materializeImageFromCloud', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-restore-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('downloads the chain into an opbs-restore-* dir, reports progress, and cleans up', async () => {
    const store = new FakeStore();
    store.objects.set('full.opbs', imageHeader({ ts: 1000 }));
    store.objects.set('delta.opbs', imageHeader({ ts: 2000, base: 'C:\\old\\full.opbs' }));
    const progress: Array<{ bytesDone: number; bytesTotal: number; fileIndex: number; fileCount: number }> = [];

    const staged = await materializeImageFromCloud('s3://bucket/prefix/delta.opbs', {
      store,
      tempRoot,
      onProgress: (p) => progress.push(p)
    });

    expect(path.basename(staged.tempDir)).toMatch(/^opbs-restore-/);
    expect(path.dirname(staged.tempDir)).toBe(tempRoot);
    expect(staged.imagePath).toBe(path.join(staged.tempDir, 'delta.opbs'));
    expect(fs.existsSync(staged.imagePath)).toBe(true);
    expect(fs.existsSync(path.join(staged.tempDir, 'full.opbs'))).toBe(true);
    expect(store.downloaded).toEqual(['full.opbs', 'delta.opbs']);
    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last.fileCount).toBe(2);
    expect(last.fileIndex).toBe(2);
    expect(last.bytesDone).toBe(last.bytesTotal);

    staged.cleanup();
    expect(fs.existsSync(staged.tempDir)).toBe(false);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  it('refuses to stage when the temp volume lacks free space', async () => {
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 512 } as never);
    const store = new FakeStore();
    store.objects.set('img.opbs', imageHeader({ ts: 1 }));

    await expect(
      materializeImageFromCloud('s3://bucket/prefix/img.opbs', { store, tempRoot })
    ).rejects.toThrow(/Not enough disk space/);
    expect(store.downloaded).toHaveLength(0);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  it('removes the partial temp dir when a download fails', async () => {
    const store = new FakeStore();
    store.objects.set('full.opbs', imageHeader({ ts: 1000 }));
    store.objects.set('delta.opbs', imageHeader({ ts: 2000, base: 'C:\\old\\full.opbs' }));
    store.failOn = 'delta.opbs';

    await expect(
      materializeImageFromCloud('s3://bucket/prefix/delta.opbs', { store, tempRoot })
    ).rejects.toThrow(/transfer failed/);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  it('refuses non-cloud URIs', async () => {
    const store = new FakeStore();
    await expect(
      materializeImageFromCloud('C:\\backups\\img.opbs', { store, tempRoot })
    ).rejects.toThrow(/Not a cloud image location/);
  });
});

describe('cloud listing feeds the drill picker', () => {
  it('reads headers from the store and picks the newest drillable image', async () => {
    const store = new FakeStore();
    store.objects.set('old-full.opbs', imageHeader({ ts: 1000 }));
    store.objects.set('new-encrypted.opbs', imageHeader({ ts: 5000, encrypted: true }));

    const entries = await cloudImageEntries(store);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === 'new-encrypted.opbs')?.encrypted).toBe(true);
    expect(entries.find((e) => e.name === 'old-full.opbs')?.encrypted).toBe(false);

    // Without a passphrase the encrypted newest is skipped; with one it wins.
    expect(pickDrillImage(entries)?.name).toBe('old-full.opbs');
    expect(pickDrillImage(entries, 'pw')?.name).toBe('new-encrypted.opbs');
  });
});
