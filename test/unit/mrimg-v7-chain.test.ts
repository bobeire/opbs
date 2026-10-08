import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  clearMacriumInfoCache,
  macriumRestoreRefusal,
  macriumUnsupportedReason,
  readMacriumImage
} from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';

/**
 * Real-sample tests for v7 (.mrimg) differential/incremental chains. The
 * samples are user-provided and gitignored, so the suite skips itself when
 * they are absent (override the directory with OPBS_V7_CHAIN_DIR).
 */
const CHAIN_DIR =
  process.env.OPBS_V7_CHAIN_DIR ?? path.join(__dirname, '..', '..', 'imagefilesamples');
const FULL = path.join(CHAIN_DIR, 'DACACA7B7E92AAFB-00-00.mrimg');
const DIFF = path.join(CHAIN_DIR, 'DACACA7B7E92AAFB-01-01.mrimg');
const INC = path.join(CHAIN_DIR, 'DACACA7B7E92AAFB-02-02.mrimg');
const present = [FULL, DIFF, INC].every((p) => fs.existsSync(p));

describe.skipIf(!present)('mrimg-v7 chain (real samples)', () => {
  it('parses full / differential / incremental roles and extents', () => {
    clearMacriumInfoCache();
    const full = readMacriumImage(FULL);
    const diff = readMacriumImage(DIFF);
    const inc = readMacriumImage(INC);
    const fp = full.partitions[0];
    const dp = diff.partitions[0];
    const ip = inc.partitions[0];

    expect(full.chain).toBeUndefined();
    expect(fp.chain).toBeUndefined();
    expect(dp.chain?.role).toBe('differential');
    expect(dp.chain?.basePath).toBe(FULL);
    expect(dp.chain?.incrementNo).toBe(1);
    // The differential's own extent is a full-extent index; its changed
    // blocks are the 54 sequential QuickLZ frames in its data region, the
    // rest resolve from the full image.
    expect(dp.blockCount).toBe(fp.blockCount);
    expect(dp.blocks.length).toBe(fp.blockCount);
    expect(dp.blocks.filter((b) => b.carry).length).toBeGreaterThan(0);
    expect(dp.blocks.filter((b) => b.filePosition >= 0).length).toBe(54);
    expect(dp.fsType).toBe('ntfs');

    expect(inc.chain?.role).toBe('incremental');
    expect(inc.chain?.basePath).toBe(DIFF);
    expect(inc.chain?.incrementNo).toBe(2);
    expect(inc.chain?.delta?.length).toBe(55);
    // An incremental inherits its extent and filesystem from the base.
    expect(ip.blockCount).toBe(fp.blockCount);
    expect(ip.blocks.length).toBe(0);
    expect(ip.fsType).toBe('ntfs');

    expect(macriumUnsupportedReason(full)).toBeNull();
    expect(macriumUnsupportedReason(diff)).toBeNull();
    expect(macriumUnsupportedReason(inc)).toBeNull();
    expect(macriumRestoreRefusal(diff)).toBeNull();
    expect(macriumRestoreRefusal(inc)).toBeNull();
  });

  it('browses every chain member to identical resolved content', () => {
    clearMacriumInfoCache();
    const full = readMacriumImage(FULL);
    const diff = readMacriumImage(DIFF);
    const inc = readMacriumImage(INC);
    const fp = full.partitions[0];
    const dp = diff.partitions[0];
    const ip = inc.partitions[0];
    const blockSize = fp.blockSize;

    const fr = openMacriumPartitionReader(full, 0);
    const dr = openMacriumPartitionReader(diff, 0);
    const ir = openMacriumPartitionReader(inc, 0);
    expect(dr.size).toBe(fr.size);
    expect(ir.size).toBe(fr.size);

    // The boot sector resolves identically through every member.
    const boot = fr.read(0, 512);
    expect(boot.subarray(3, 11).toString('latin1')).toBe('NTFS    ');
    expect(dr.read(0, 512).equals(boot)).toBe(true);
    expect(ir.read(0, 512).equals(boot)).toBe(true);

    // Every differential-local (changed) block reads through the reader and
    // matches its record md5 — loadBlock verifies, so a throw also fails.
    const diffLocals = dp.blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.filePosition >= 0);
    expect(diffLocals.length).toBe(54);
    for (const { b, i } of diffLocals) {
      const raw = dr.read(i * blockSize, Math.min(blockSize, dr.size - i * blockSize));
      expect(crypto.createHash('md5').update(raw).digest().equals(b.md5)).toBe(true);
    }

    // Every incremental delta block reads through and matches its delta md5.
    let deltaOk = 0;
    for (const d of ip.chain?.delta ?? []) {
      const raw = ir.read(d.logicalIndex * blockSize, Math.min(blockSize, ir.size - d.logicalIndex * blockSize));
      if (crypto.createHash('md5').update(raw).digest().equals(d.md5)) deltaOk++;
    }
    expect(deltaOk).toBe(55);

    // Blocks unchanged across the chain are byte-identical through all three.
    const deltaIdx = new Set((ip.chain?.delta ?? []).map((d) => d.logicalIndex));
    const changedDiffIdx = new Set(diffLocals.map(({ i }) => i));
    let checked = 0;
    for (let i = 1; i < fp.blockCount && checked < 12; i += 97) {
      if (deltaIdx.has(i) || changedDiffIdx.has(i)) continue;
      const want = Math.min(blockSize, fr.size - i * blockSize);
      const a = fr.read(i * blockSize, want);
      expect(dr.read(i * blockSize, want).equals(a)).toBe(true);
      expect(ir.read(i * blockSize, want).equals(a)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('refuses a chain member whose base image is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-chain-missing-'));
    try {
      const lonely = path.join(tmp, 'DACACA7B7E92AAFB-02-02.mrimg');
      fs.copyFileSync(INC, lonely);
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
