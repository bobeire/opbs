import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSource } from '../../src/main/imaging/migrate/source';
import { buildPlan, computePlanHash } from '../../src/main/imaging/migrate/plan';
import { executePlan } from '../../src/main/imaging/migrate/execute';
import { SEED_APPS_DB } from '../../src/main/imaging/migrate/apps-db';
import { cmdMigrate } from '../../src/main/cli/migrate';
import type { CommandContext } from '../../src/main/cli/index';
import type { MigratePlan, MigrateSource } from '../../src/main/imaging/migrate/types';

let srcRoot: string;
const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeFixture(rel: string, bytes: number | string): void {
  const full = path.join(srcRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 0x61));
}

function mkTarget(): string {
  return tempDir('opbs-exec-target-');
}

function mkPlan(target: string, onlyFolders?: string[]): MigratePlan {
  const source = new LiveSource(srcRoot);
  try {
    return buildPlan(source, 'Alice', SEED_APPS_DB, { targetProfileDir: target, onlyFolders });
  } finally {
    source.close();
  }
}

function run(target: string, options: { merge?: boolean; resume?: boolean; dryRun?: boolean } = {}): ReturnType<typeof executePlan> {
  const source = new LiveSource(srcRoot);
  const plan = mkPlan(target);
  try {
    return executePlan(source, plan, {
      targetProfileDir: target,
      planHash: computePlanHash(plan),
      ...options
    });
  } finally {
    source.close();
  }
}

beforeAll(() => {
  srcRoot = tempDir('opbs-exec-src-');
  writeFixture('Users/Alice/Documents/readme.txt', 'hello');
  writeFixture('Users/Alice/Downloads/big.bin', 2048);
  writeFixture('Users/Alice/AppData/Local/Google/Chrome/User Data/Default/History', 100);
  writeFixture('Users/Alice/AppData/Local/Temp/junk.tmp', 9999);
  writeFixture('Users/Alice/AppData/Local/Application Data/loop.txt', 'loop');
});

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrate execute (tier 1)', () => {
  it('dry run writes nothing', () => {
    const target = mkTarget();
    const report = run(target, { dryRun: true });
    expect(report.executed).toBe(false);
    expect(report.notes.some((n) => n.includes('Dry run'))).toBe(true);
    expect(report.summary.plannedFiles).toBe(4);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('copies files, verifies content, skips excluded and legacy-junction subtrees, writes artifacts', () => {
    const target = mkTarget();
    const report = run(target);
    expect(report.executed).toBe(true);
    expect(report.summary.copied).toBe(3);
    expect(report.summary.skippedReparse).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.verifyChecked).toBe(3);
    expect(report.summary.verifyMismatches).toBe(0);
    expect(fs.readFileSync(path.join(target, 'Documents', 'readme.txt'), 'utf8')).toBe('hello');
    expect(fs.statSync(path.join(target, 'Downloads', 'big.bin')).size).toBe(2048);
    expect(fs.existsSync(path.join(target, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'AppData', 'Local', 'Temp'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'AppData', 'Local', 'Application Data'))).toBe(false);
    expect(report.outcomes.some((o) => o.action === 'skipped-reparse' && o.sourceRelPath.includes('Application Data'))).toBe(true);
    expect(report.artifacts.reportPath).toBeDefined();
    expect(report.artifacts.wingetPath).toBeDefined();
    expect(report.artifacts.journalPath).toBeDefined();
    const onDisk = JSON.parse(fs.readFileSync(report.artifacts.reportPath as string, 'utf8'));
    expect(onDisk.executed).toBe(true);
    expect(onDisk.summary.copied).toBe(3);
    const winget = JSON.parse(fs.readFileSync(report.artifacts.wingetPath as string, 'utf8'));
    const ids = winget.Sources[0].Packages.map((p: { PackageIdentifier: string }) => p.PackageIdentifier);
    expect(ids).toContain('Google.Chrome');
    const journalLines = fs.readFileSync(report.artifacts.journalPath as string, 'utf8').trim().split('\n');
    expect(journalLines).toHaveLength(3);
  });

  it('produces a stable plan hash across rebuilds and changes with options', () => {
    const target = mkTarget();
    const planA = mkPlan(target);
    const planB = mkPlan(target);
    expect(planA.generatedAt).not.toBe(undefined);
    expect(computePlanHash(planA)).toBe(computePlanHash(planB));
    const planRestricted = mkPlan(target, ['Documents']);
    expect(computePlanHash(planRestricted)).not.toBe(computePlanHash(planA));
  });

  it('keeps the plan hash stable under live size churn (2026-10-21 drill finding)', () => {
    const target = mkTarget();
    const plan = mkPlan(target);
    const baseline = computePlanHash(plan);
    const churned: MigratePlan = {
      ...plan,
      totalBytes: plan.totalBytes + 123_456,
      totalItems: plan.totalItems + 7,
      entries: plan.entries.map((e) => ({ ...e, bytes: e.bytes + 999, itemCount: e.itemCount + 1 })),
      stores: plan.stores.map((s) => ({ ...s, bytes: s.bytes + 111, itemCount: s.itemCount + 1 })),
      generatedAt: new Date().toISOString()
    };
    expect(computePlanHash(churned)).toBe(baseline);
    const moved: MigratePlan = {
      ...churned,
      entries: plan.entries.map((e, i) => (i === 0 ? { ...e, sourceRelPath: `${e.sourceRelPath}/other` } : e))
    };
    expect(computePlanHash(moved)).not.toBe(baseline);
  });

  it('refuses plans that carry refusals and writes nothing', () => {
    const target = mkTarget();
    const source = new LiveSource(srcRoot);
    try {
      const plan = buildPlan(source, 'Ghost', SEED_APPS_DB, { targetProfileDir: target });
      expect(plan.refusals.length).toBeGreaterThan(0);
      const report = executePlan(source, plan, { targetProfileDir: target, planHash: 'unused' });
      expect(report.executed).toBe(false);
      expect(report.notes.some((n) => n.includes('refusals'))).toBe(true);
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      source.close();
    }
  });

  it('fails on collisions without --merge and overwrites with --merge', () => {
    const target = mkTarget();
    fs.mkdirSync(path.join(target, 'Documents'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Documents', 'readme.txt'), 'OLD');
    const first = run(target);
    expect(first.executed).toBe(true);
    const collision = first.outcomes.find((o) => o.action === 'failed' && o.error?.includes('--merge'));
    expect(collision).toBeDefined();
    expect(fs.readFileSync(path.join(target, 'Documents', 'readme.txt'), 'utf8')).toBe('OLD');
    const second = run(target, { merge: true });
    expect(second.summary.failed).toBe(0);
    expect(fs.readFileSync(path.join(target, 'Documents', 'readme.txt'), 'utf8')).toBe('hello');
  });

  it('resume skips journaled files from a previous run', () => {
    const target = mkTarget();
    const first = run(target);
    expect(first.summary.copied).toBe(3);
    const second = run(target, { resume: true });
    expect(second.summary.copied).toBe(0);
    expect(second.summary.skippedResume).toBe(3);
    expect(second.notes.some((n) => n.includes('Resume'))).toBe(true);
  });

  it('records verify mismatches when hashes disagree', () => {
    const target = mkTarget();
    const real = new LiveSource(srcRoot);
    const plan = mkPlan(target);
    const lying: MigrateSource = {
      kind: 'live',
      label: real.label,
      list: (rel) => real.list(rel),
      copyFileTo: (rel, dest) => fs.copyFileSync(path.join(srcRoot, rel), dest),
      hashFile: () => 'deadbeef',
      close: () => real.close()
    };
    try {
      const report = executePlan(lying, plan, { targetProfileDir: target, planHash: computePlanHash(plan) });
      expect(report.summary.copied).toBe(3);
      expect(report.summary.verifyMismatches).toBe(3);
      expect(report.outcomes.filter((o) => o.verify === 'mismatch')).toHaveLength(3);
      expect(report.notes.some((n) => n.includes('mismatch'))).toBe(true);
    } finally {
      real.close();
    }
  });

  it('falls back to size-only verification when the source cannot hash', () => {
    const target = mkTarget();
    const real = new LiveSource(srcRoot);
    const plan = mkPlan(target);
    const sizeOnly: MigrateSource = {
      kind: 'image',
      label: 'image:test',
      list: (rel) => real.list(rel),
      copyFileTo: (rel, dest) => fs.copyFileSync(path.join(srcRoot, rel), dest),
      hashFile: () => null,
      close: () => undefined
    };
    try {
      const report = executePlan(sizeOnly, plan, { targetProfileDir: target, planHash: computePlanHash(plan) });
      expect(report.summary.verifyChecked).toBe(3);
      expect(report.summary.verifyMismatches).toBe(0);
      expect(report.notes.some((n) => n.includes('size only'))).toBe(true);
    } finally {
      real.close();
    }
  });

  it('honours --folder restrictions during execute', () => {
    const target = mkTarget();
    const source = new LiveSource(srcRoot);
    const plan = mkPlan(target, ['Documents']);
    try {
      const report = executePlan(source, plan, { targetProfileDir: target, planHash: computePlanHash(plan) });
      expect(report.summary.copied).toBe(1);
      expect(fs.existsSync(path.join(target, 'Documents', 'readme.txt'))).toBe(true);
      expect(fs.existsSync(path.join(target, 'Downloads'))).toBe(false);
    } finally {
      source.close();
    }
  });

  it('skips directory junctions as reparse points when the source reports them', () => {
    const jSrc = tempDir('opbs-exec-jsrc-');
    const jTarget = mkTarget();
    const content = path.join(jSrc, 'JContent');
    fs.mkdirSync(content, { recursive: true });
    fs.writeFileSync(path.join(content, 'inner.txt'), 'inner');
    fs.mkdirSync(path.join(jSrc, 'Users', 'Bob', 'Documents'), { recursive: true });
    fs.writeFileSync(path.join(jSrc, 'Users', 'Bob', 'Documents', 'doc.txt'), 'doc');
    const junction = path.join(jSrc, 'Users', 'Bob', 'Documents', 'Link');
    try {
      fs.symlinkSync(content, junction, 'junction');
    } catch {
      return; // junction creation not permitted on this machine — guard covered by unit logic elsewhere
    }
    const source = new LiveSource(jSrc);
    try {
      const plan = buildPlan(source, 'Bob', SEED_APPS_DB, { targetProfileDir: jTarget });
      const report = executePlan(source, plan, { targetProfileDir: jTarget, planHash: computePlanHash(plan) });
      expect(report.summary.skippedReparse).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(jTarget, 'Documents', 'Link'))).toBe(false);
      expect(fs.readFileSync(path.join(jTarget, 'Documents', 'doc.txt'), 'utf8')).toBe('doc');
    } finally {
      source.close();
    }
  });
});

describe('migrate CLI run', () => {
  it('dry-run prints a plan hash, --execute with that hash applies the plan', async () => {
    const target = mkTarget();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      const base = ['run', '--live', '--live-root', srcRoot, '--profile', 'Alice', '--target', target];
      const dryCtx: CommandContext = { argv: [...base], opts: { json: true } };
      const dryCode = await cmdMigrate(dryCtx);
      expect(dryCode).toBe(0);
      const dryPlan = JSON.parse(logs.join('\n')) as { planHash: string; refusals: unknown[] };
      expect(dryPlan.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dryPlan.refusals).toEqual([]);
      expect(fs.readdirSync(target)).toEqual([]);

      logs.length = 0;
      const execCtx: CommandContext = { argv: [...base, '--execute', '--plan-hash', dryPlan.planHash], opts: { json: true } };
      const execCode = await cmdMigrate(execCtx);
      expect(execCode).toBe(0);
      const report = JSON.parse(logs.join('\n')) as { executed: boolean; summary: { copied: number; verifyMismatches: number } };
      expect(report.executed).toBe(true);
      expect(report.summary.copied).toBe(3);
      expect(report.summary.verifyMismatches).toBe(0);
      expect(fs.readFileSync(path.join(target, 'Documents', 'readme.txt'), 'utf8')).toBe('hello');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('rejects --execute without --plan-hash and on hash mismatch', async () => {
    const target = mkTarget();
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      const base = ['run', '--live', '--live-root', srcRoot, '--profile', 'Alice', '--target', target, '--execute'];
      expect(await cmdMigrate({ argv: [...base], opts: { json: false } })).toBe(1);
      expect(errors.join('\n')).toContain('--plan-hash');
      errors.length = 0;
      expect(await cmdMigrate({ argv: [...base, '--plan-hash', 'ab'.repeat(32)], opts: { json: false } })).toBe(1);
      expect(errors.join('\n')).toContain('hash mismatch');
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
