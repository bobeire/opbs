import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runDiskPerfTest,
  assessWriteSpeed,
  readPerfHistory,
  latestPerf,
  recordPerfResult,
  perfPath,
  DiskPerfResult
} from '../../src/main/utils/disk-perf';
import { computeReliabilityScore, ReliabilitySignals } from '../../src/main/utils/storage-health';

function healthySignals(overrides: Partial<ReliabilitySignals> = {}): ReliabilitySignals {
  return {
    reachable: true,
    imageCount: 2,
    verifiedImages: 2,
    parityProtectedImages: 2,
    brokenChains: 0,
    tamperDrift: false,
    newestDate: Date.now() - 60 * 60 * 1000,
    freeBytes: 500_000_000,
    totalBytes: 1_000_000_000,
    smartOk: true,
    scrubFailed: false,
    hasDrill: true,
    ...overrides
  };
}

describe('assessWriteSpeed', () => {
  it('grades a fast drive as good with no penalty', () => {
    expect(assessWriteSpeed(250)).toEqual({ penalty: 0, label: 'good' });
    expect(assessWriteSpeed(100)).toEqual({ penalty: 0, label: 'good' });
  });

  it('grades slower media transparently', () => {
    expect(assessWriteSpeed(80)).toEqual({ penalty: -5, label: 'fair' });
    expect(assessWriteSpeed(40)).toEqual({ penalty: -5, label: 'fair' });
    expect(assessWriteSpeed(39)).toEqual({ penalty: -10, label: 'slow' });
    expect(assessWriteSpeed(15)).toEqual({ penalty: -10, label: 'slow' });
    expect(assessWriteSpeed(14)).toEqual({ penalty: -15, label: 'critical' });
  });

  it('never penalises missing or invalid measurements', () => {
    expect(assessWriteSpeed(NaN)).toEqual({ penalty: 0, label: 'good' });
    expect(assessWriteSpeed(-1)).toEqual({ penalty: 0, label: 'good' });
  });
});

describe('runDiskPerfTest', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-perf-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('measures write and read throughput and cleans up the scratch file', () => {
    const result = runDiskPerfTest(dir, { sizeBytes: 4 * 1024 * 1024 });
    expect(result.ok).toBe(true);
    expect(result.seqWriteMBs).toBeGreaterThan(0);
    expect(result.seqReadMBs).toBeGreaterThan(0);
    expect(result.bytes).toBe(4 * 1024 * 1024);
    expect(result.writeDurationMs).toBeGreaterThan(0);
    expect(result.readDurationMs).toBeGreaterThan(0);

    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.opbs-perf-'));
    expect(leftovers).toEqual([]);
  });

  it('persists the result to opbs-perf.json and makes it the latest', () => {
    const first = runDiskPerfTest(dir, { sizeBytes: 4 * 1024 * 1024 });
    const second = runDiskPerfTest(dir, { sizeBytes: 4 * 1024 * 1024 });
    expect(fs.existsSync(perfPath(dir))).toBe(true);
    const history = readPerfHistory(dir);
    expect(history.length).toBe(2);
    expect(history.map((r) => r.at)).toEqual([second.at, first.at]);
    expect(latestPerf(dir)?.at).toBe(second.at);
  });

  it('returns an error for a non-filesystem location', () => {
    const result = runDiskPerfTest('s3://bucket/prefix');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('local');
  });

  it('returns an error for an empty directory', () => {
    const result = runDiskPerfTest('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No directory');
  });

  it('returns an error (with no leftover files) when the directory cannot be written', () => {
    const blocker = path.join(os.tmpdir(), 'opbs-perf-blocker');
    fs.writeFileSync(blocker, 'x');
    try {
      const result = runDiskPerfTest(path.join(blocker, 'child'), { sizeBytes: 1024 });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });

  it('deduplicates by timestamp when recording', () => {
    const base: DiskPerfResult = {
      directory: dir,
      at: 1234,
      bytes: 1024,
      seqWriteMBs: 50,
      seqReadMBs: 60,
      writeDurationMs: 10,
      readDurationMs: 10,
      ok: true
    };
    recordPerfResult(dir, base);
    recordPerfResult(dir, base);
    expect(readPerfHistory(dir).length).toBe(1);
  });
});

describe('storage-health integration', () => {
  it('penalises a slow write speed in the reliability score', () => {
    const result = computeReliabilityScore(healthySignals({ perfWriteMBs: 20 }));
    // -10 (slow) from 100 = 90; stays good.
    expect(result.score).toBe(90);
    expect(result.warnings.join(' ')).toContain('write speed');
    expect(result.warnings.join(' ')).toContain('slow');
  });

  it('does not penalise a healthy write speed', () => {
    const result = computeReliabilityScore(healthySignals({ perfWriteMBs: 200 }));
    expect(result.score).toBe(100);
    expect(result.warnings).toEqual([]);
  });

  it('treats a missing measurement as no signal', () => {
    const result = computeReliabilityScore(healthySignals());
    expect(result.score).toBe(100);
  });
});