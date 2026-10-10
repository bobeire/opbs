import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  clearMacriumInfoCache,
  macriumRestoreRefusal,
  macriumUnsupportedReason,
  readMacriumImage,
  MacriumIndexElement
} from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { findV7ChainSample } from './helpers/v7-sample';

/**
 * Real-sample tests for `.mrimg` (Reflect 7/8) chains: full + two members.
 * The samples are user-provided and gitignored, so the suite skips itself
 * when they are absent (override the directory with OPBS_V7_CHAIN_DIR).
 * Roles are read from each file's footer — Reflect defaults to differential
 * first members but incremental chains name their members identically.
 */
const sample = findV7ChainSample();
const { full: FULL, diff: MEMBER1, inc: MEMBER2 } = sample;

function localBlocks(blocks: MacriumIndexElement[]): Array<{ b: MacriumIndexElement; i: number }> {
  return blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.filePosition >= 0);
}

describe.skipIf(!sample.present)('mrimg chain (real samples)', () => {
  it('parses full / member roles and extents, one partition per file', () => {
    clearMacriumInfoCache();
    const full = readMacriumImage(FULL);
    const m1 = readMacriumImage(MEMBER1);
    const m2 = readMacriumImage(MEMBER2);
    const fp = full.partitions[0];

    expect(full.chain).toBeUndefined();
    expect(fp.chain).toBeUndefined();
    expect(fp.blockCount).toBeGreaterThan(0);
    expect(fp.blocks.length).toBe(fp.blockCount);

    // Member 1: a chain member rooted at the full image. Either a
    // differential (full-extent index with carry markers) or an incremental
    // (delta index only) — both are valid Reflect chain shapes.
    expect(m1.chain?.incrementNo).toBe(1);
    expect(m1.chain?.basePath).toBe(FULL);
    if (m1.chain?.role === 'differential') {
      expect(m1.partitions[0].blocks.length).toBe(fp.blockCount);
      expect(m1.partitions[0].blocks.filter((b) => b.carry).length).toBeGreaterThan(0);
      expect(localBlocks(m1.partitions[0].blocks).length).toBeGreaterThan(0);
      expect(m1.chain.delta ?? []).toEqual([]);
    } else {
      expect(m1.chain?.role).toBe('incremental');
      expect(m1.partitions[0].blocks.length).toBe(0);
      expect((m1.chain?.delta ?? []).length).toBeGreaterThan(0);
    }

    // Member 2 sits on top of member 1 and stores its own changed blocks.
    expect(m2.chain?.incrementNo).toBe(2);
    expect(m2.chain?.basePath).toBe(MEMBER1);
    expect(m2.chain?.role === 'differential' || m2.chain?.role === 'incremental').toBe(true);
    const m2local = m2.partitions.reduce((n, p) => n + localBlocks(p.blocks).length, 0);
    expect(m2local + (m2.chain?.delta?.length ?? 0)).toBeGreaterThan(0);

    // Regression: marker scans on Reflect 8 incrementals can invent a phantom
    // second partition with garbage offsets — every file must parse to exactly
    // the one partition its single partition index describes.
    expect(full.partitions.length).toBe(1);
    expect(m1.partitions.length).toBe(1);
    expect(m2.partitions.length).toBe(1);

    expect(fp.fsType).toBe('ntfs');
    expect(macriumUnsupportedReason(full)).toBeNull();
    expect(macriumUnsupportedReason(m1)).toBeNull();
    expect(macriumUnsupportedReason(m2)).toBeNull();
    expect(macriumRestoreRefusal(m1)).toBeNull();
    expect(macriumRestoreRefusal(m2)).toBeNull();
  });

  it('browses every chain member to identical resolved content', () => {
    clearMacriumInfoCache();
    const full = readMacriumImage(FULL);
    const m1 = readMacriumImage(MEMBER1);
    const m2 = readMacriumImage(MEMBER2);
    const fp = full.partitions[0];
    const blockSize = fp.blockSize;

    const fr = openMacriumPartitionReader(full, 0);
    const r1 = openMacriumPartitionReader(m1, 0);
    const r2 = openMacriumPartitionReader(m2, 0);
    expect(r1.size).toBe(fr.size);
    expect(r2.size).toBe(fr.size);

    // The boot sector resolves identically through every member.
    const boot = fr.read(0, 512);
    expect(boot.subarray(3, 11).toString('latin1')).toBe('NTFS    ');
    expect(r1.read(0, 512).equals(boot)).toBe(true);
    expect(r2.read(0, 512).equals(boot)).toBe(true);

    // Every locally stored block reads through the reader and matches its
    // record md5 — loadBlock verifies, so a throw also fails the test.
    for (const [info, reader] of [
      [m1, r1],
      [m2, r2]
    ] as const) {
      for (const part of info.partitions) {
        for (const { b, i } of localBlocks(part.blocks)) {
          const raw = reader.read(i * blockSize, Math.min(blockSize, reader.size - i * blockSize));
          expect(crypto.createHash('md5').update(raw).digest().equals(b.md5)).toBe(true);
        }
      }
      // Every incremental delta block reads through and matches its md5.
      const part0 = info.partitions[0];
      for (const d of info.chain?.delta ?? []) {
        const raw = reader.read(d.logicalIndex * blockSize, Math.min(blockSize, reader.size - d.logicalIndex * blockSize));
        expect(crypto.createHash('md5').update(raw).digest().equals(d.md5)).toBe(true);
      }
      expect(part0.blockCount).toBe(fp.blockCount);
    }

    // Blocks unchanged across the chain are byte-identical to the full image.
    const deltaIdx = new Set([
      ...(m1.chain?.delta ?? []).map((d) => d.logicalIndex),
      ...(m2.chain?.delta ?? []).map((d) => d.logicalIndex)
    ]);
    const localIdx = new Set([
      ...localBlocks(m1.partitions[0].blocks).map(({ i }) => i),
      ...localBlocks(m2.partitions[0].blocks).map(({ i }) => i)
    ]);
    let checked = 0;
    for (let i = 1; i < fp.blockCount && checked < 12; i += 9973) {
      if (deltaIdx.has(i) || localIdx.has(i)) continue;
      const want = Math.min(blockSize, fr.size - i * blockSize);
      const a = fr.read(i * blockSize, want);
      expect(r1.read(i * blockSize, want).equals(a)).toBe(true);
      expect(r2.read(i * blockSize, want).equals(a)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('refuses a chain member whose base image is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-chain-missing-'));
    try {
      const lonely = path.join(tmp, path.basename(MEMBER2));
      fs.copyFileSync(MEMBER2, lonely);
      clearMacriumInfoCache();
      const info = readMacriumImage(lonely);
      expect(macriumUnsupportedReason(info)).toMatch(/base image .* not found/);
      expect(macriumRestoreRefusal(info)).toMatch(/base image .* not found/);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow(/base image .* not found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
