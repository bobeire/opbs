import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectAnomalies, AnomalyReport } from '../../src/main/backup/anomaly-detect';

const DAY = 24 * 3600 * 1000;

function writeHistory(dir: string, entries: any[]): void {
  fs.writeFileSync(path.join(dir, 'opbs-analytics.json'), JSON.stringify(entries));
}

function deltaRun(offsetHours: number, overrides: any = {}): any {
  return {
    imagePath: path.join(dir(), 'C0000001.opbs'),
    timestamp: Date.now() - offsetHours * 3600 * 1000,
    totalBytes: 100_000_000,
    bytesWritten: 50_000_000,
    blocksWritten: 100,
    totalBlocks: 100,
    skippedBlocks: 0,
    incremental: true,
    compressionRatio: 2,
    durationMs: 10_000,
    speedMBs: 100,
    ...overrides
  };
}

let dirVar = '';
function dir(): string {
  return dirVar;
}

describe('detectAnomalies over the analytics history', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-anomaly-'));
    dirVar = tmp;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports no history as an informational note, ok', () => {
    const report = detectAnomalies(tmp);
    expect(report.historyCount).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.anomalies.map((a) => a.severity)).toEqual(['info']);
  });

  it('reports thin history without inventing anomalies', () => {
    writeHistory(tmp, [deltaRun(1), deltaRun(2)]);
    const report = detectAnomalies(tmp);
    expect(report.ok).toBe(true);
    expect(report.anomalies.every((a) => a.severity === 'info')).toBe(true);
    expect(report.anomalies.length).toBe(1);
  });

  it('passes a healthy run with consistent history', () => {
    writeHistory(
      tmp,
      Array.from({ length: 10 }, (_, i) =>
        deltaRun(i * 24 + 1, {
          imagePath: path.join(tmp, `C000000${i}.opbs`),
          totalBytes: 100_000_000 + (i % 3) * 2_000_000
        })
      )
    );
    const report = detectAnomalies(tmp);
    expect(report.ok).toBe(true);
    expect(report.anomalies).toEqual([]);
  });

  it('flags a size blow-up for the latest run', () => {
    writeHistory(
      tmp,
      Array.from({ length: 10 }, (_, i) =>
        deltaRun(i * 24 + 1, {
          imagePath: path.join(tmp, `C000000${i}.opbs`),
          totalBytes: i === 0 ? 900_000_000 : 100_000_000 + i * 2_000_000
        })
      )
    );
    const report = (detectAnomalies(tmp) as unknown) as AnomalyReport;
    const size = report.anomalies.find((a) => a.kind === 'size');
    expect(size).toBeTruthy();
    expect(size?.severity).toBe('critical');
    expect(report.ok).toBe(false);
  });

  it('is type-aware: a full is compared against the full baseline, not deltas', () => {
    writeHistory(tmp, [
      // Latest run is a FULL with a normal full-sized footprint.
      { imagePath: path.join(tmp, 'C0000010.opbs'), timestamp: Date.now() - 1 * 3600 * 1000, totalBytes: 5_000_000_000, bytesWritten: 2_000_000_000, blocksWritten: 1000, totalBlocks: 1000, skippedBlocks: 0, incremental: false, compressionRatio: 2.5, durationMs: 60_000, speedMBs: 120 },
      // Five previous fulls of the same magnitude.
      ...[1, 2, 3, 4, 5].map((n) => ({
        imagePath: path.join(tmp, `C000000${n}.opbs`),
        timestamp: Date.now() - (n * 24 + 1) * 3600 * 1000,
        totalBytes: 5_000_000_000 + n * 20_000_000,
        bytesWritten: 2_000_000_000,
        blocksWritten: 1000,
        totalBlocks: 1000,
        skippedBlocks: 0,
        incremental: false,
        compressionRatio: 2.5,
        durationMs: 60_000,
        speedMBs: 120
      })),
      // A handful of small deltas that must NOT distort the full baseline.
      ...[0, 1, 2].map((n) => ({
        imagePath: path.join(tmp, `D000000${n}.opbs`),
        timestamp: Date.now() - (n + 2) * 12 * 3600 * 1000,
        totalBytes: 100_000_000,
        bytesWritten: 50_000_000,
        blocksWritten: 100,
        totalBlocks: 100,
        skippedBlocks: 0,
        incremental: true,
        compressionRatio: 2,
        durationMs: 10_000,
        speedMBs: 100
      }))
    ]);
    const report = detectAnomalies(tmp);
    expect(report.ok).toBe(true);
    expect(report.anomalies).toEqual([]);
    expect(report.baseline.medianBytesFull).toBe(5_050_000_000);
    expect(report.baseline.medianBytesDelta).toBe(100_000_000);
  });

  it('flags a compression-ratio collapse', () => {
    writeHistory(
      tmp,
      Array.from({ length: 10 }, (_, i) =>
        deltaRun(i * 24 + 1, {
          imagePath: path.join(tmp, `C000000${i}.opbs`),
          compressionRatio: i === 0 ? 1.1 : 3.0 + (i % 3) * 0.2
        })
      )
    );
    const report = (detectAnomalies(tmp) as unknown) as AnomalyReport;
    const ratio = report.anomalies.find((a) => a.kind === 'ratio');
    expect(ratio).toBeTruthy();
    expect(ratio?.message).toContain('incompressible');
    expect(report.ok).toBe(false);
  });

  it('flags a throughput collapse', () => {
    writeHistory(
      tmp,
      Array.from({ length: 10 }, (_, i) =>
        deltaRun(i * 24 + 1, {
          imagePath: path.join(tmp, `C000000${i}.opbs`),
          speedMBs: i === 0 ? 5 : 80 + (i % 4) * 10
        })
      )
    );
    const report = (detectAnomalies(tmp) as unknown) as AnomalyReport;
    const speed = report.anomalies.find((a) => a.kind === 'speed');
    expect(speed).toBeTruthy();
    expect(speed?.message).toContain('MB/s');
    expect(report.ok).toBe(false);
  });

  it('flags a backup gap when the cadence is long exceeded', () => {
    writeHistory(
      tmp,
      Array.from({ length: 8 }, (_, i) =>
        deltaRun(i * 24 + 1, {
          imagePath: path.join(tmp, `C000000${i}.opbs`)
        })
      )
    );
    // Rewrite the newest record to be 6 days old.
    const entries = JSON.parse(fs.readFileSync(path.join(tmp, 'opbs-analytics.json'), 'utf-8'));
    entries[0].timestamp = Date.now() - 6 * DAY;
    writeHistory(tmp, entries);
    const report = (detectAnomalies(tmp) as unknown) as AnomalyReport;
    const gap = report.anomalies.find((a) => a.kind === 'gap');
    expect(gap).toBeTruthy();
    expect(gap?.severity).toBe('warning');
    expect(gap?.message).toContain('day');
    expect(report.ok).toBe(false);
  });
});