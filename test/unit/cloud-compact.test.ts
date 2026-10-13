import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactCloudChain, type CompactCloudStore } from '../../src/main/imaging/cloud-compact';
import { unprotectFiles } from '../../src/main/utils/file-protect';
import { writeImageFromBytes } from '../helpers/opbs-image';
import {
  readImageInfo,
  readBlockDataFromImage,
  verifyImage,
  clearImageInfoCache,
  COMPRESSION_ZSTD
} from '../../src/main/imaging/image-format';

vi.setConfig({ testTimeout: 15_000 });

const BLOCK = 16 * 1024;
const URI = 's3://bucket/prefix/delta.opbs';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-cloud-compact-'));
  tempDirs.push(dir);
  return dir;
}

async function removeTree(dir: string): Promise<void> {
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  if (fs.existsSync(dir)) {
    await unprotectFiles(walk(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTree));
});

/** In-memory object store; keys are store-relative like the real stores. */
class FakeCloudStore implements CompactCloudStore {
  files = new Map<string, Buffer>();
  failUpload = false;
  truncateUploads = false;

  async listWithMeta(): Promise<Array<{ key: string; size: number }>> {
    return [...this.files.entries()].map(([key, buf]) => ({ key, size: buf.length }));
  }
  async getRange(key: string, offset: number, length: number): Promise<Buffer> {
    const buf = this.files.get(key);
    if (!buf) throw new Error(`missing ${key}`);
    return buf.subarray(offset, offset + length);
  }
  async downloadFile(key: string, destPath: string, onProgress?: (bytes: number) => void): Promise<void> {
    const buf = this.files.get(key);
    if (!buf) throw new Error(`missing ${key}`);
    fs.writeFileSync(destPath, buf);
    onProgress?.(buf.length);
  }
  async uploadFile(localPath: string, key: string): Promise<void> {
    if (this.failUpload) throw new Error('upload exploded');
    const data = fs.readFileSync(localPath);
    this.files.set(key, this.truncateUploads ? data.subarray(0, Math.max(0, data.length - 16)) : Buffer.from(data));
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

function blockPattern(seed: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (seed * 31 + i * 7) & 0xff;
  return buf;
}

/** full = [seed3, seed3, seed3]; delta rewrites only block 1 with seed9. */
function chainRaw(delta: boolean): Buffer {
  return Buffer.concat([
    blockPattern(3, BLOCK),
    delta ? blockPattern(9, BLOCK) : blockPattern(3, BLOCK),
    blockPattern(3, BLOCK)
  ]);
}

/** Ingest a two-member chain into the fake store. */
function seedChain(store: FakeCloudStore): void {
  const dir = tempDir();
  clearImageInfoCache();
  const fullLocal = path.join(dir, 'full.opbs');
  const deltaLocal = path.join(dir, 'delta.opbs');
  writeImageFromBytes(fullLocal, chainRaw(false), BLOCK, COMPRESSION_ZSTD);
  writeImageFromBytes(deltaLocal, chainRaw(true), BLOCK, COMPRESSION_ZSTD, {
    baseImagePath: fullLocal
  });
  store.files.set('full.opbs', fs.readFileSync(fullLocal));
  store.files.set('delta.opbs', fs.readFileSync(deltaLocal));
}

describe('compactCloudChain', () => {
  it('stages, compacts, uploads and prunes the remote chain (remove-source)', async () => {
    const store = new FakeCloudStore();
    seedChain(store);
    const phases: string[] = [];

    const result = await compactCloudChain({
      imagePath: URI,
      removeSource: true,
      store,
      onProgress: (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      }
    });

    expect(result.ok).toBe(true);
    expect(phases).toContain('staging');
    expect(phases).toContain('copying');

    // Output landed in the same prefix and is the only image left.
    const outKey = result.outputPath!;
    expect(outKey.startsWith('s3://bucket/prefix/')).toBe(true);
    const outName = outKey.split('/').pop()!;
    expect(store.files.has(outName)).toBe(true);
    expect(store.files.has('full.opbs')).toBe(false);
    expect(store.files.has('delta.opbs')).toBe(false);
    expect(result.sourcesRemoved).toEqual([
      's3://bucket/prefix/delta.opbs',
      's3://bucket/prefix/full.opbs'
    ]);

    // The uploaded bytes are a verified image with newest-wins composition.
    const downloaded = path.join(tempDir(), 'downloaded.opbs');
    fs.writeFileSync(downloaded, store.files.get(outName)!);
    expect((await verifyImage(downloaded)).ok).toBe(true);
    const info = readImageInfo(downloaded);
    const mid = info.blocks.find((b) => b.blockIndex === 1)!;
    expect(
      readBlockDataFromImage(downloaded, mid.fileOffset, info.header.compressionId, info.header.cipherId)
    ).toEqual(blockPattern(9, BLOCK));
  });

  it('keeps the remote chain when remove-source is off', async () => {
    const store = new FakeCloudStore();
    seedChain(store);

    const result = await compactCloudChain({ imagePath: URI, store });
    expect(result.ok).toBe(true);
    expect(store.files.has('full.opbs')).toBe(true);
    expect(store.files.has('delta.opbs')).toBe(true);
    expect(result.sourcesRemoved ?? []).toHaveLength(0);
    expect(store.files.has(result.outputPath!.split('/').pop()!)).toBe(true);
  });

  it('a failed upload leaves the remote chain intact', async () => {
    const store = new FakeCloudStore();
    seedChain(store);
    store.failUpload = true;

    const result = await compactCloudChain({ imagePath: URI, removeSource: true, store });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/upload/);
    expect(store.files.has('full.opbs')).toBe(true);
    expect(store.files.has('delta.opbs')).toBe(true);
    // No compacted image was kept.
    expect([...store.files.keys()].some((k) => k.includes('.compacted-'))).toBe(false);
  });

  it('a size-mismatched upload is rolled back and never prunes the chain', async () => {
    const store = new FakeCloudStore();
    seedChain(store);
    store.truncateUploads = true;

    const result = await compactCloudChain({ imagePath: URI, removeSource: true, store });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verification/);
    expect(store.files.has('full.opbs')).toBe(true);
    expect(store.files.has('delta.opbs')).toBe(true);
    expect([...store.files.keys()].some((k) => k.includes('.compacted-'))).toBe(false);
  });

  it('refuses a cloud directory that holds a repository journal', async () => {
    const store = new FakeCloudStore();
    seedChain(store);
    store.files.set('opbs-repo.json', Buffer.from('{}'));

    const result = await compactCloudChain({ imagePath: URI, store });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/repository/);
  });

  it('refuses a cloud output path and passes dry-runs through without writes', async () => {
    const store = new FakeCloudStore();
    seedChain(store);

    const cloudOut = await compactCloudChain({ imagePath: URI, outputPath: 's3://bucket/other.opbs', store });
    expect(cloudOut.ok).toBe(false);
    expect(cloudOut.error).toMatch(/local path/);

    const before = new Map(store.files);
    const dry = await compactCloudChain({ imagePath: URI, removeSource: true, dryRun: true, store });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.outputPath).toMatch(/^s3:\/\/bucket\/prefix\/.+\.compacted-/);
    // Nothing uploaded or deleted.
    expect([...store.files.keys()].sort()).toEqual([...before.keys()].sort());
  });
});
