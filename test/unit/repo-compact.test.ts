import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactChain } from '../../src/main/imaging/compact-engine';
import {
  initRepository,
  loadJournal,
  resolveRepoKey,
  recordImageCreate,
  unlockRepository,
  repoImageStates,
  verifyChain,
  verifySignatures
} from '../../src/main/imaging/repository';
import {
  readImageInfo,
  readBlockDataFromImage,
  verifyImage,
  clearImageInfoCache,
  COMPRESSION_ZSTD
} from '../../src/main/imaging/image-format';
import { unprotectFiles } from '../../src/main/utils/file-protect';
import { writeImageFromBytes } from '../helpers/opbs-image';

// recordImageCreate / prune spawn PowerShell for ACL protection round-trips,
// which can exceed the 5s default under parallel test load. The passphrase
// repository below also pays a 600k-iteration PBKDF2.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BLOCK = 16 * 1024;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-repo-compact-'));
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

async function setupRepo(opts: { passphrase?: string } = {}) {
  const dir = tempDir();
  const repoDir = path.join(dir, 'repo');
  const keyfile = path.join(dir, 'repo.key');
  const initOpts = opts.passphrase
    ? { passphrase: opts.passphrase, lockDays: 30 }
    : { keyfile, lockDays: 30 };
  const { header } = await initRepository(repoDir, initOpts);
  const key = resolveRepoKey(header, opts.passphrase ? { passphrase: opts.passphrase } : { keyfile });
  const imagesDir = path.join(repoDir, 'images');
  const fullPath = path.join(imagesDir, 'full.opbs');
  const deltaPath = path.join(imagesDir, 'delta.opbs');
  writeImageFromBytes(fullPath, chainRaw(false), BLOCK, COMPRESSION_ZSTD);
  writeImageFromBytes(deltaPath, chainRaw(true), BLOCK, COMPRESSION_ZSTD, {
    baseImagePath: fullPath
  });
  await recordImageCreate(repoDir, header, key, fullPath, { lockDays: 30 });
  await recordImageCreate(repoDir, header, key, deltaPath, {
    lockDays: 30,
    base: path.basename(fullPath)
  });
  clearImageInfoCache();
  return { dir, repoDir, imagesDir, keyfile, key, header, fullPath, deltaPath };
}

describe('compact inside a repository', () => {
  it('records the compacted image through the journal without touching the locked chain', async () => {
    const { repoDir, imagesDir, keyfile, key, fullPath, deltaPath } = await setupRepo();

    const result = await compactChain({ imagePath: deltaPath, repoKey: { keyfile } });
    expect(result.ok).toBe(true);
    const outPath = result.outputPath!;
    expect(path.dirname(path.resolve(outPath))).toBe(path.resolve(imagesDir));
    expect(result.blocksWritten).toBe(3);
    expect(result.sourcesRemoved).toEqual([]);

    // No remove-source: the locked chain stays on disk untouched.
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.existsSync(deltaPath)).toBe(true);

    const records = loadJournal(repoDir);
    expect(records.filter((r) => r.type === 'prune')).toHaveLength(0);
    const creates = records.filter((r) => r.type === 'create');
    expect(creates.map((r) => r.image)).toEqual([
      'full.opbs',
      'delta.opbs',
      path.basename(outPath)
    ]);

    // New record is an active root; signature chain still verifies.
    const states = repoImageStates(records);
    const compactedState = states.find((s) => s.name === path.basename(outPath))!;
    expect(compactedState.active).toBe(true);
    expect(compactedState.base).toBeUndefined();
    expect(verifyChain(records)).toBeNull();
    expect(verifySignatures(records, key)).toBeNull();

    // The output is a real image and matches newest-wins chain composition.
    expect((await verifyImage(outPath)).ok).toBe(true);
    const outInfo = readImageInfo(outPath);
    const mid = outInfo.blocks.find((b) => b.blockIndex === 1)!;
    expect(
      readBlockDataFromImage(outPath, mid.fileOffset, outInfo.header.compressionId, outInfo.header.cipherId)
    ).toEqual(blockPattern(9, BLOCK));
  });

  it('refuses remove-source while the chain members are locked', async () => {
    const { repoDir, keyfile, fullPath, deltaPath } = await setupRepo();

    const result = await compactChain({ imagePath: deltaPath, repoKey: { keyfile }, removeSource: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/immutable/);
    expect(result.error).toMatch(/full\.opbs/);
    expect(result.error).toMatch(/delta\.opbs/);

    // Nothing happened: sources still on disk, no journal churn.
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.existsSync(deltaPath)).toBe(true);
    expect(loadJournal(repoDir).filter((r) => r.type === 'prune')).toHaveLength(0);
    expect(fs.readdirSync(path.dirname(fullPath)).filter((f) => f.includes('.compacted-'))).toHaveLength(0);
  });

  it('reports the lock refusal on a dry run without writing anything', async () => {
    const { repoDir, imagesDir, keyfile, deltaPath } = await setupRepo();
    const before = loadJournal(repoDir).length;

    const result = await compactChain({
      imagePath: deltaPath,
      repoKey: { keyfile },
      removeSource: true,
      dryRun: true
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/immutable/);
    expect(loadJournal(repoDir)).toHaveLength(before);
    expect(fs.readdirSync(imagesDir).filter((f) => f.includes('.compacted-'))).toHaveLength(0);
  });

  it('remove-source after unlock prunes deltas-first through the journal', async () => {
    const { repoDir, imagesDir, keyfile, key, fullPath, deltaPath } = await setupRepo();
    await unlockRepository(repoDir, '*', { keyfile });

    const result = await compactChain({ imagePath: deltaPath, repoKey: { keyfile }, removeSource: true });
    expect(result.ok).toBe(true);
    expect(result.sourcesRemoved.map((p) => path.basename(p))).toEqual([
      'delta.opbs',
      'full.opbs'
    ]);

    const outPath = result.outputPath!;
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(fullPath)).toBe(false);
    expect(fs.existsSync(deltaPath)).toBe(false);
    const leftovers = fs.readdirSync(imagesDir);
    expect(leftovers).not.toContain('full.opbs');
    expect(leftovers).not.toContain('delta.opbs');
    expect(leftovers).toContain(path.basename(outPath));

    // Journal: two prunes in leaf-first order, signed chain still intact.
    const records = loadJournal(repoDir);
    expect(verifyChain(records)).toBeNull();
    expect(verifySignatures(records, key)).toBeNull();
    expect(records.filter((r) => r.type === 'prune').map((r) => r.image)).toEqual([
      'delta.opbs',
      'full.opbs'
    ]);
    const states = repoImageStates(records);
    expect(states.find((s) => s.name === 'full.opbs')!.active).toBe(false);
    expect(states.find((s) => s.name === 'delta.opbs')!.active).toBe(false);
    const compactedState = states.find((s) => s.name === path.basename(outPath))!;
    expect(compactedState.active).toBe(true);

    expect((await verifyImage(outPath)).ok).toBe(true);
  });

  it('refuses an output path outside the repository images/ directory', async () => {
    const { dir, keyfile, deltaPath } = await setupRepo();
    const outside = path.join(dir, 'outside.opbs');

    const result = await compactChain({ imagePath: deltaPath, repoKey: { keyfile }, outputPath: outside });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/images/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses when the repository key cannot be resolved', async () => {
    // Passphrase-locked repository, compacted without any repo key option.
    const { repoDir, deltaPath } = await setupRepo({ passphrase: 'repo secret phrase' });
    const result = await compactChain({ imagePath: deltaPath });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/key unavailable/);
    expect(result.error).toMatch(/passphrase/);
    expect(loadJournal(repoDir).filter((r) => r.type === 'create')).toHaveLength(2);
  });
});
