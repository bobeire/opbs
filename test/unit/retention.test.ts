import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  encodeHeader,
  ImageHeader,
  IMAGE_VERSION,
  HEADER_SIZE,
  DEFAULT_BLOCK_SIZE,
  COMPRESSION_NONE,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_VERIFIED,
  FLAG_INCREMENTAL,
  CIPHER_NONE,
  CIPHER_AES256_GCM,
  KDF_ITERATIONS_DEFAULT,
  SALT_LENGTH
} from '../../src/main/imaging/image-format';
import {
  scanBackupDirectory,
  groupIntoChains,
  planRetention,
  applyRetention,
  writeManifest,
  manifestFilePath,
  selectImagesForVerify,
  resolveScheduledRetention
} from '../../src/main/backup/retention';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function writeTestImage(
  dir: string,
  name: string,
  opts: { ts: number; incremental?: boolean; baseImagePath?: string; encrypted?: boolean }
): string {
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: opts.ts,
    totalBytes: 0,
    blockSize: DEFAULT_BLOCK_SIZE,
    compressionId: COMPRESSION_NONE,
    partitionCount: 0,
    flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED | (opts.incremental ? FLAG_INCREMENTAL : 0),
    blockIndexOffset: 0,
    cipherId: opts.encrypted ? CIPHER_AES256_GCM : CIPHER_NONE,
    kdfIterations: opts.encrypted ? KDF_ITERATIONS_DEFAULT : 0,
    salt: Buffer.alloc(SALT_LENGTH),
    baseImagePath: opts.baseImagePath ?? ''
  };
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, encodeHeader(header));
  return filePath;
}

function names(entries: Array<{ name: string }>): string[] {
  return entries.map((e) => e.name);
}

describe('retention planning', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-ret-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a lone full image', () => {
    writeTestImage(dir, 'full_1.opbs', { ts: NOW - 3 * DAY });
    const plan = planRetention(dir, { keepFull: 1, keepDeltasPerFull: 1 });
    expect(names(plan.prune)).toEqual([]);
    expect(names(plan.keep)).toEqual(['full_1.opbs']);
  });

  it('prunes a delta when keepDeltasPerFull is 0', () => {
    const full = writeTestImage(dir, 'full_1.opbs', { ts: NOW - 3 * DAY });
    writeTestImage(dir, 'delta_1.opbs', { ts: NOW - 2 * DAY, incremental: true, baseImagePath: full });

    const plan = planRetention(dir, { keepFull: 1, keepDeltasPerFull: 0 });
    expect(names(plan.prune)).toEqual(['delta_1.opbs']);
    expect(names(plan.keep)).toEqual(['full_1.opbs']);
  });

  it('keeps trailing deltas per retained full', () => {
    const full = writeTestImage(dir, 'full_1.opbs', { ts: NOW - 10 * DAY });
    writeTestImage(dir, 'delta_1.opbs', { ts: NOW - 9 * DAY, incremental: true, baseImagePath: full });
    writeTestImage(dir, 'delta_2.opbs', { ts: NOW - 8 * DAY, incremental: true, baseImagePath: full });
    writeTestImage(dir, 'delta_3.opbs', { ts: NOW - 7 * DAY, incremental: true, baseImagePath: full });

    const plan = planRetention(dir, { keepFull: 1, keepDeltasPerFull: 2 });
    expect(names(plan.keep).sort()).toEqual(['delta_2.opbs', 'delta_3.opbs', 'full_1.opbs']);
    expect(names(plan.prune)).toEqual(['delta_1.opbs']);
  });

  it('keeps only the newest chains when keepFull is limited', () => {
    for (let i = 5; i >= 1; i--) {
      writeTestImage(dir, `full_${i}.opbs`, { ts: NOW - i * 2 * DAY });
    }
    const plan = planRetention(dir, { keepFull: 2, keepDeltasPerFull: 1 });
    expect(names(plan.keep).sort()).toEqual(['full_1.opbs', 'full_2.opbs']);
    expect(names(plan.prune).sort()).toEqual(['full_3.opbs', 'full_4.opbs', 'full_5.opbs']);
  });

  it('promotes a base image kept alive only by a retained delta', () => {
    const oldFull = writeTestImage(dir, 'full_9.opbs', { ts: NOW - 60 * DAY });
    writeTestImage(dir, 'delta_9.opbs', { ts: NOW - 1 * DAY, incremental: true, baseImagePath: oldFull });

    // keepFull 0 + retentionDays 5: the delta is fresh (kept), but the full
    // would normally be pruned - the fixpoint must promote it.
    const plan = planRetention(dir, { keepFull: 0, keepDeltasPerFull: 1, retentionDays: 5 });
    expect(names(plan.prune)).toEqual([]);
    expect(names(plan.keep).sort()).toEqual(['delta_9.opbs', 'full_9.opbs']);
  });

  it('groups deltas into chains rooted at their full image', () => {
    const full = writeTestImage(dir, 'full_1.opbs', { ts: NOW - 5 * DAY });
    writeTestImage(dir, 'delta_1.opbs', { ts: NOW - 4 * DAY, incremental: true, baseImagePath: full });
    writeTestImage(dir, 'delta_2.opbs', { ts: NOW - 3 * DAY, incremental: true, baseImagePath: full });
    writeTestImage(dir, 'other_full.opbs', { ts: NOW - 1 * DAY });

    const chains = groupIntoChains(scanBackupDirectory(dir));
    expect(chains.length).toBe(2);
    const rootChain = chains.find((c) => c.root.name === 'full_1.opbs')!;
    expect(rootChain.items.map((i) => i.name).sort()).toEqual(['delta_1.opbs', 'delta_2.opbs', 'full_1.opbs']);
    expect(rootChain.complete).toBe(true);
  });

  it('skips invalid image files during scan', () => {
    writeTestImage(dir, 'full_1.opbs', { ts: NOW - DAY });
    fs.writeFileSync(path.join(dir, 'junk.opbs'), Buffer.from('not an image at all'));
    const entries = scanBackupDirectory(dir);
    expect(names(entries)).toEqual(['full_1.opbs']);
  });

  it('applyRetention with dryRun deletes nothing but real run prunes and writes manifest', async () => {
    writeTestImage(dir, 'full_1.opbs', { ts: NOW - 10 * DAY });
    writeTestImage(dir, 'full_2.opbs', { ts: NOW - 1 * DAY });

    const dry = await applyRetention(dir, { keepFull: 1, keepDeltasPerFull: 1, dryRun: true });
    expect(dry.prune.length).toBe(1);
    expect(fs.existsSync(path.join(dir, 'full_1.opbs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'full_2.opbs'))).toBe(true);

    const plan = await applyRetention(dir, { keepFull: 1, keepDeltasPerFull: 1 });
    expect(plan.prune.map((e) => e.name)).toEqual(['full_1.opbs']);
    expect(fs.existsSync(path.join(dir, 'full_1.opbs'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'full_2.opbs'))).toBe(true);

    // Manifest is regenerated after pruning and only lists survivors.
    expect(fs.existsSync(manifestFilePath(dir))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFilePath(dir), 'utf-8'));
    expect(manifest.images.map((i: { name: string }) => i.name)).toEqual(['full_2.opbs']);
  });

  it('reports encrypted and verified flags and chain membership in the manifest', async () => {
    const full = writeTestImage(dir, 'full_1.opbs', { ts: NOW - 3 * DAY, encrypted: true });
    writeTestImage(dir, 'delta_1.opbs', { ts: NOW - 2 * DAY, incremental: true, baseImagePath: full });

    await writeManifest(dir);
    const manifest = JSON.parse(fs.readFileSync(manifestFilePath(dir), 'utf-8'));
    const fullEntry = manifest.images.find((i: { name: string }) => i.name === 'full_1.opbs');
    expect(fullEntry.encrypted).toBe(true);
    expect(fullEntry.verified).toBe(true);
    expect(fullEntry.inChain).toBe(true);
    expect(manifest.images.find((i: { name: string }) => i.name === 'delta_1.opbs').inChain).toBe(false);
  });

  it('selectImagesForVerify newest scope returns only the newest image', () => {
    writeTestImage(dir, 'old.opbs', { ts: NOW - 10 * DAY });
    writeTestImage(dir, 'middle.opbs', { ts: NOW - 5 * DAY });
    writeTestImage(dir, 'new.opbs', { ts: NOW - 1 * DAY });

    const selected = selectImagesForVerify(scanBackupDirectory(dir), 'newest');
    expect(selected.map((e) => e.name)).toEqual(['new.opbs']);
  });

  it('selectImagesForVerify all scope returns every image newest first', () => {
    writeTestImage(dir, 'middle.opbs', { ts: NOW - 5 * DAY });
    writeTestImage(dir, 'new.opbs', { ts: NOW - 1 * DAY });
    writeTestImage(dir, 'old.opbs', { ts: NOW - 10 * DAY });

    const selected = selectImagesForVerify(scanBackupDirectory(dir), 'all');
    expect(selected.map((e) => e.name)).toEqual(['new.opbs', 'middle.opbs', 'old.opbs']);
  });

  it('selectImagesForVerify returns empty for an empty directory', () => {
    expect(selectImagesForVerify(scanBackupDirectory(dir), 'newest')).toEqual([]);
    expect(selectImagesForVerify(scanBackupDirectory(dir), 'all')).toEqual([]);
  });
});

describe('resolveScheduledRetention', () => {
  const globals = { autoCleanup: false, keepFull: 3, keepDeltasPerFull: 3, retentionDays: 30 };

  it('is inactive when global auto-cleanup is off and no per-schedule policy is set', () => {
    const result = resolveScheduledRetention({}, globals);
    expect(result.active).toBe(false);
  });

  it('is active when global auto-cleanup is on', () => {
    const result = resolveScheduledRetention({}, { ...globals, autoCleanup: true });
    expect(result.active).toBe(true);
  });

  it('is active when the schedule requests its own retention policy', () => {
    const result = resolveScheduledRetention({ retentionApplied: true }, globals);
    expect(result.active).toBe(true);
  });

  it('falls back to global numbers when the schedule does not override them', () => {
    const result = resolveScheduledRetention({ retentionApplied: true }, globals);
    expect(result.options).toEqual({ keepFull: 3, keepDeltasPerFull: 3, retentionDays: 30 });
  });

  it('prefers per-schedule numbers when provided', () => {
    const result = resolveScheduledRetention(
      { retentionApplied: true, retentionKeepFull: 5, retentionKeepDeltasPerFull: 7, retentionDays: 90 },
      globals
    );
    expect(result.options).toEqual({ keepFull: 5, keepDeltasPerFull: 7, retentionDays: 90 });
  });

  it('mixes overrides with global fallbacks per field', () => {
    const result = resolveScheduledRetention({ retentionApplied: true, retentionKeepFull: 2 }, globals);
    expect(result.options).toEqual({ keepFull: 2, keepDeltasPerFull: 3, retentionDays: 30 });
  });
});