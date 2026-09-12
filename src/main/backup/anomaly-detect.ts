import { readAnalytics } from '../utils/backup-analytics';

/**
 * Anomaly detection for backup runs.
 *
 * Every successful backup records a row in `opbs-analytics.json` (see
 * backup-analytics.ts). This module compares the most recent run against a
 * robust baseline (median + median absolute deviation) built from the last
 * dozen records and flags *deviations* — the kinds of things that mean "the
 * data being backed up changed shape" rather than "a file is corrupt":
 *
 *  - size: the run's footprint deviates strongly from its type's (full/delta)
 *    baseline — the source disk was resized/replaced, a drive got merged into
 *    the image, or the retention policy silently changed.
 *  - ratio: the compression ratio collapses while the baseline compressed well
 *    — often a symptom of the source becoming incompressible (e.g. encrypted
 *    files/ransomware) or the capture changing.
 *  - speed: throughput collapses well below the historical pace — a degraded
 *    or contended drive, complementary to the SMART gate in #6.
 *  - gap: backups stopped arriving — the newest recorded run is much older
 *    than the historical cadence implies.
 *
 * Detection is pure over the analytics sidecar (no image reads, no DRM on the
 * destination), so it is cheap, deterministic and unit-testable. Missing or
 * thin history is reported as an informational note, never a false positive.
 */

export type AnomalySeverity = 'critical' | 'warning' | 'info';

export type AnomalyKind = 'size' | 'ratio' | 'speed' | 'gap' | 'info';

export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  message: string;
  metric?: number;
  baseline?: number;
}

export interface AnomalyBaseline {
  medianIntervalMs?: number;
  medianRatio?: number;
  medianSpeedMBs?: number;
  medianBytesFull?: number;
  medianBytesDelta?: number;
}

export interface AnomalyReport {
  directory: string;
  historyCount: number;
  baseline: AnomalyBaseline;
  anomalies: Anomaly[];
  /** no critical/warning anomalies (informational notes do not fail the check). */
  ok: boolean;
}

const HISTORY_WINDOW = 12;
// Deviation is more than the larger of: a 3x blow-up (median * 2 is the shrink
// bound) or 4 * 1.4826 * MAD — robust to the natural noise of backup runs.
const MEDIAN_FACTOR = 3;
const MAD_FACTOR = 4 * 1.4826;
const RATIO_COLLAPSE_FACTOR = 2;
const SPEED_COLLAPSE_FACTOR = 4;
const GAP_FACTOR = 1.5;
const MIN_RATIO_BASELINE = 1.5;
const MIN_HISTORY = 3;

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mad(values: number[], med: number): number {
  return median(values.map((v) => Math.abs(v - med))) ?? 0;
}

function deviates(value: number, med: number | undefined, window: number[]): boolean {
  if (med == null || med <= 0 || window.length === 0) return false;
  if (value <= 0) return true; // a run recorded zero written bytes is always suspicious
  const scale = MAD_FACTOR * mad(window, med);
  const threshold = Math.max(med * MEDIAN_FACTOR, scale > 0 ? scale : 0);
  return Math.abs(value - med) > threshold;
}

export function detectAnomalies(directory: string): AnomalyReport {
  const history = readAnalytics(directory);
  const report: AnomalyReport = {
    directory,
    historyCount: history.length,
    baseline: {},
    anomalies: [],
    ok: true
  };

  if (history.length === 0) {
    report.anomalies.push({
      kind: 'info',
      severity: 'info',
      message: 'No backup history yet — anomalies can be detected after the first few runs.'
    });
    return report;
  }

  const window = history.slice(0, HISTORY_WINDOW);
  const newest = history[0];

  // Baselines.
  const fulls = window.filter((e) => !e.incremental);
  const deltas = window.filter((e) => e.incremental);
  const ratioValues = window.map((e) => e.compressionRatio).filter((r) => Number.isFinite(r) && r > 0);
  const speedValues = window.map((e) => e.speedMBs).filter((s) => Number.isFinite(s) && s >= 0);
  const ratioMed = median(ratioValues);
  const speedMed = median(speedValues);
  const fullMed = median(fulls.map((e) => e.totalBytes));
  const deltaMed = median(deltas.map((e) => e.totalBytes));

  // Cadence: median gap between consecutive recorded runs.
  const sorted = [...window].sort((a, b) => a.timestamp - b.timestamp);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].timestamp - sorted[i - 1].timestamp);
  const cadence = median(gaps.filter((g) => g > 0));

  report.baseline = {
    medianIntervalMs: cadence,
    medianRatio: ratioMed,
    medianSpeedMBs: speedMed,
    medianBytesFull: fullMed,
    medianBytesDelta: deltaMed
  };

  if (history.length < MIN_HISTORY) {
    report.anomalies.push({
      kind: 'info',
      severity: 'info',
      message: `Only ${history.length} recorded run(s) — anomaly baselines need at least ${MIN_HISTORY}.`
    });
    // Never flag real anomalies off a base of one or two runs.
    return report;
  }

  const latest = newest.totalBytes;
  const newestIsFull = !newest.incremental;
  const sizeBaseline = newestIsFull ? fullMed : deltaMed;
  const sizeWindow = newestIsFull ? fulls.map((e) => e.totalBytes) : deltas.map((e) => e.totalBytes);

  if (sizeBaseline != null && sizeWindow.length >= 3 && deviates(latest, sizeBaseline, sizeWindow)) {
    const pct = sizeBaseline > 0 ? Math.round(((latest - sizeBaseline) / sizeBaseline) * 100) : 0;
    report.anomalies.push({
      kind: 'size',
      severity: Math.abs(pct) > 400 ? 'critical' : 'warning',
      message: `Latest ${newestIsFull ? 'full' : 'delta'} run is ${pct > 0 ? '+' + pct : pct}% of the baseline size — source disk changed or the capture is misconfigured.`,
      metric: latest,
      baseline: sizeBaseline
    });
  }

  if (ratioMed != null && ratioMed > MIN_RATIO_BASELINE && newest.compressionRatio < ratioMed / RATIO_COLLAPSE_FACTOR) {
    report.anomalies.push({
      kind: 'ratio',
      severity: 'warning',
      message: `Compression ratio collapsed from ${ratioMed.toFixed(2)}× to ${newest.compressionRatio.toFixed(2)}× — the source may have become incompressible (encryption/ransomware) or the capture changed.`,
      metric: newest.compressionRatio,
      baseline: ratioMed
    });
  }

  if (speedMed != null && speedMed > 0 && newest.speedMBs < speedMed / SPEED_COLLAPSE_FACTOR) {
    report.anomalies.push({
      kind: 'speed',
      severity: 'warning',
      message: `Throughput collapsed to ${newest.speedMBs.toFixed(1)} MB/s vs a baseline of ${speedMed.toFixed(1)} MB/s — the destination drive may be degrading or contended.`,
      metric: newest.speedMBs,
      baseline: speedMed
    });
  }

  if (cadence != null && cadence > 0 && history.length >= MIN_HISTORY) {
    const idle = Date.now() - newest.timestamp;
    if (idle > cadence * GAP_FACTOR) {
      const days = Math.round(idle / (24 * 3600 * 1000));
      report.anomalies.push({
        kind: 'gap',
        severity: days >= 30 ? 'critical' : 'warning',
        message: `No backup for ${days} day(s) — the historical cadence implies one every ${Math.max(1, Math.round(cadence / (24 * 3600 * 1000)))} day(s).`,
        metric: idle,
        baseline: cadence
      });
    }
  }

  report.anomalies.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  report.ok = !report.anomalies.some((a) => a.severity !== 'info');
  return report;
}