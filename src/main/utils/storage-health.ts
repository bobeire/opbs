import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { destinationHealth } from './destination-health';
import { isNonFilesystemLocation } from './location';
import { buildChainHealthReport } from '../backup/chain-health';
import { detectTamper } from './tamper';
import { scanBackupDirectory } from '../backup/retention';
import { readScrubHistory } from '../imaging/scrub';
import { readDrillHistory } from './drill-history';
import { paritySidecarPath } from '../imaging/parity';
import { queryReliability, assessDiskHealth, DiskReliability } from './disk-health';
import { logger } from './logger';

/**
 * Storage health dashboard: a per-destination reliability snapshot that
 * combines capacity, restore-chain integrity, verification/scrub/drill
 * coverage, parity protection, tamper drift, and the SMART health of the
 * physical drive backing the destination (best effort).
 *
 * Everything is best-effort: no signal that cannot be read (elevation,
 * unsupported drive, offline UNC) contributes a penalty. The score is a
 * transparent rubric, kept pure in `computeReliabilityScore` for testing.
 */

export interface ReliabilitySignals {
  reachable: boolean;
  imageCount: number;
  verifiedImages: number;
  parityProtectedImages: number;
  brokenChains: number;
  tamperDrift: boolean;
  newestDate?: number;
  freeBytes?: number;
  totalBytes?: number;
  /** null = not available (no penalty); true = OK; false = health warnings. */
  smartOk: boolean | null;
  /** Scrub ran and reported a non-ok result (only meaningful if a scrub exists). */
  scrubFailed: boolean;
  hasDrill: boolean;
}

export interface StorageHealthSmart {
  diskIndex?: number;
  driveLetter?: string;
  available: boolean;
  data?: DiskReliability;
  warnings: string[];
}

export interface StorageHealthReport extends ReliabilitySignals {
  path: string;
  error?: string;
  oldestDate?: number;
  chainCount: number;
  completeChains: number;
  unparseableImages: number;
  tamperManifestPresent: boolean;
  imagesScrubbed: number;
  lastScrubAt?: number;
  lastScrubOk: boolean | null;
  lastDrillAt?: number;
  smart: StorageHealthSmart;
  score: number;
  status: 'good' | 'degraded' | 'at-risk';
  warnings: string[];
}

export interface StorageHealthDeps {
  /** Map a destination directory to the physical disk it lives on. */
  resolveDisk?: (dir: string) => Promise<{ diskIndex?: number; driveLetter?: string }>;
  /** Read SMART/reliability counters for a physical disk. */
  querySmart?: (diskIndex: number) => DiskReliability | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Transparent scoring rubric (0..100, good >= 90, degraded >= 50). Kept pure
 * so the exact trade-offs are unit-tested and documented:
 *  - broken chain (unrestorable)          -20
 *  - manifest drift (tamper detected)     -15
 *  - drive health warnings                -15
 *  - >=50% images unverified              -10
 *  - never successfully verified anything -5
 *  - newest image older than 7 days       -10
 *  - <50% parity coverage                 -10
 *  - <8% free space                       -10
 *  - last scrub failed                    -10
 *  - no restore drill ever run            -5
 */
export function computeReliabilityScore(signals: ReliabilitySignals): { score: number; status: 'good' | 'degraded' | 'at-risk'; warnings: string[] } {
  const warnings: string[] = [];
  let score = 100;

  if (!signals.reachable) {
    warnings.push('Destination is currently unreachable');
    score -= 40;
  }

  if (signals.brokenChains > 0) {
    warnings.push(`${signals.brokenChains} chain(s) have a missing delta base and cannot be restored`);
    score -= 20;
  }
  if (signals.tamperDrift) {
    warnings.push('Manifest drift detected — backups may have been deleted or modified');
    score -= 15;
  }

  if (signals.smartOk === false) {
    warnings.push('Storage drive reports health problems');
    score -= 15;
  }

  const verifiedRatio = signals.imageCount > 0 ? signals.verifiedImages / signals.imageCount : 1;
  if (verifiedRatio < 0.5) {
    warnings.push(`${signals.imageCount - signals.verifiedImages} of ${signals.imageCount} image(s) never verified`);
    score -= 10;
  }
  if (signals.imageCount > 0 && signals.verifiedImages === 0) {
    score -= 5;
  }

  if (signals.newestDate != null && signals.newestDate < Date.now() - 7 * DAY_MS) {
    warnings.push('Newest backup is more than 7 days old');
    score -= 10;
  }

  const parityRatio = signals.imageCount > 0 ? signals.parityProtectedImages / signals.imageCount : 1;
  if (parityRatio < 0.5) {
    warnings.push(`${signals.imageCount - signals.parityProtectedImages} of ${signals.imageCount} image(s) have no parity protection`);
    score -= 10;
  }

  if (signals.totalBytes != null && signals.freeBytes != null && signals.totalBytes > 0 && signals.freeBytes / signals.totalBytes < 0.08) {
    warnings.push('Less than 8% of destination capacity is free');
    score -= 10;
  }

  if (signals.scrubFailed) {
    warnings.push('Last scrub reported problems that were not repaired');
    score -= 10;
  }

  if (!signals.hasDrill && signals.imageCount > 0) {
    warnings.push('No restore drill has ever passed for this destination');
    score -= 5;
  }

  score = Math.max(0, Math.min(100, score));
  let status: 'good' | 'degraded' | 'at-risk' = score >= 90 ? 'good' : score >= 50 ? 'degraded' : 'at-risk';
  // An unreachable or failing destination can never be "good".
  if (!signals.reachable) {
    status = 'at-risk';
  } else if (signals.smartOk === false && status === 'good') {
    status = 'degraded';
  }
  return { score, status, warnings };
}

async function resolveDiskFor(directory: string): Promise<{ diskIndex?: number; driveLetter?: string }> {
  if (isNonFilesystemLocation(directory)) {
    return {};
  }
  const root = path.parse(path.resolve(directory)).root;
  const match = /^([A-Za-z]):[\\/]/.exec(root);
  const letter = match ? match[1].toUpperCase() : undefined;
  if (!letter) {
    return {};
  }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Partition -DriveLetter '${letter}' -ErrorAction SilentlyContinue | Sort-Object -Property PartitionNumber | Select-Object -First 1 -ExpandProperty DiskNumber)`
        ],
        { timeout: 15_000, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
      );
    });
    const diskIndex = parseInt(out, 10);
    return Number.isInteger(diskIndex) ? { diskIndex, driveLetter: letter } : { driveLetter: letter };
  } catch (error) {
    logger.warn(`Could not resolve the disk backing ${directory}: ${error instanceof Error ? error.message : error}`);
    return { driveLetter: letter };
  }
}

export async function buildStorageHealthReport(
  directory: string,
  options: { keepFull: number; keepDeltasPerFull: number; retentionDays: number; autoCleanup: boolean },
  deps: StorageHealthDeps = {}
): Promise<StorageHealthReport> {
  const resolveDisk = deps.resolveDisk ?? resolveDiskFor;
  const querySmart = deps.querySmart ?? queryReliability;

  const capacity = await destinationHealth(directory, options);

  const report: StorageHealthReport = {
    path: directory,
    reachable: capacity.reachable,
    error: capacity.error,
    freeBytes: capacity.freeBytes,
    totalBytes: capacity.totalBytes,
    imageCount: capacity.imageCount,
    chainCount: capacity.chainCount,
    newestDate: capacity.newestDate,
    oldestDate: capacity.oldestDate,
    brokenChains: 0,
    completeChains: 0,
    unparseableImages: 0,
    verifiedImages: 0,
    parityProtectedImages: 0,
    tamperDrift: false,
    tamperManifestPresent: false,
    imagesScrubbed: 0,
    lastScrubAt: undefined,
    lastScrubOk: null,
    lastDrillAt: undefined,
    hasDrill: false,
    smart: { available: false, warnings: [] },
    smartOk: null,
    scrubFailed: false,
    score: 0,
    status: 'at-risk',
    warnings: []
  };

  if (!capacity.reachable) {
    const scored = computeReliabilityScore(report);
    report.score = scored.score;
    report.status = scored.status;
    report.warnings = scored.warnings;
    return report;
  }

  // Restore-chain integrity + tamper drift.
  try {
    const chain = buildChainHealthReport(directory);
    report.chainCount = chain.chainCount;
    report.completeChains = chain.completeChains;
    report.brokenChains = chain.brokenChains;
    report.unparseableImages = chain.unparseableImages.length;
  } catch (error) {
    logger.warn(`Chain health failed for ${directory}: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const tamper = detectTamper(directory);
    report.tamperManifestPresent = tamper.manifestPresent;
    report.tamperDrift = tamper.manifestPresent && !tamper.ok;
  } catch {
    /* ignore */
  }

  // Coverage signals from the images themselves.
  try {
    const entries = scanBackupDirectory(directory);
    report.verifiedImages = entries.filter((e) => e.verified).length;
    report.parityProtectedImages = entries.filter((e) => fs.existsSync(paritySidecarPath(e.path))).length;
  } catch {
    /* ignore */
  }

  // Scrub + drill history sidecars.
  try {
    const history = readScrubHistory(directory);
    report.imagesScrubbed = new Set(history.map((h) => h.imagePath)).size;
    const latest = history[0];
    if (latest) {
      report.lastScrubAt = latest.at;
      report.lastScrubOk = latest.ok;
      report.scrubFailed = !latest.ok;
    }
  } catch {
    /* ignore */
  }

  try {
    const drills = readDrillHistory(directory);
    const records = Object.values(drills);
    report.hasDrill = records.length > 0;
    if (records.length > 0) {
      report.lastDrillAt = Math.max(...records.map((r) => r.at));
    }
  } catch {
    /* ignore */
  }

  // SMART health of the physical backing drive (best effort).
  const disk = await resolveDisk(directory);
  report.smart.driveLetter = disk.driveLetter;
  report.smart.diskIndex = disk.diskIndex;
  if (disk.diskIndex != null) {
    const data = querySmart(disk.diskIndex);
    if (data) {
      const assessed = assessDiskHealth(disk.diskIndex, data);
      report.smart.available = true;
      report.smart.data = data;
      report.smart.warnings = assessed.warnings;
    } else {
      report.smart.warnings = ['SMART data unavailable for the drive backing this destination'];
    }
  }
  report.smartOk = report.smart.available ? report.smart.warnings.length === 0 : null;

  const scored = computeReliabilityScore(report);
  report.score = scored.score;
  report.status = scored.status;
  report.warnings = scored.warnings;
  if (report.smart.available && report.smart.warnings.length > 0) {
    report.warnings = [...new Set([...report.warnings, ...report.smart.warnings])];
  }
  return report;
}