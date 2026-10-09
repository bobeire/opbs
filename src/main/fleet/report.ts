/**
 * Builds a FleetCheckin from local machine state: per-destination backup
 * health (chains, analytics, anomalies, drills) plus the SMART inventory of
 * every physical disk. All sources are best-effort — an unreachable or empty
 * destination is reported as data, never thrown, so one dead USB drive can
 * never stop a machine from checking in.
 */
import * as os from 'os';
import { buildChainHealthReport } from '../backup/chain-health';
import { detectAnomalies } from '../backup/anomaly-detect';
import { readAnalytics } from '../utils/backup-analytics';
import { readDrillHistory } from '../utils/drill-history';
import { inventoryMediaHealth, MediaInventoryEntry } from '../utils/media-health';
import {
  FLEET_SCHEMA_VERSION,
  FleetCheckin,
  FleetDestinationReport,
  FleetMediaEntry,
  fleetMachineId
} from './schema';

export interface FleetReportOptions {
  directories: string[];
  appVersion: string;
  machineId?: string;
  hostname?: string;
  /** Skip the SMART inventory (faster check-ins; media section comes back empty). */
  includeMedia?: boolean;
  now?: number;
  inventoryMedia?: () => Promise<MediaInventoryEntry[]>;
}

function buildDestinationReport(dir: string): FleetDestinationReport {
  const report: FleetDestinationReport = {
    directory: dir,
    exists: true,
    imageCount: 0,
    chainCount: 0,
    completeChains: 0,
    brokenChains: 0,
    unparseableImages: 0,
    lastBackupAt: null,
    lastBackupImage: null,
    lastBackupBytes: null,
    lastBackupIncremental: null,
    anomalyOk: true,
    criticalAnomalies: 0,
    warningAnomalies: 0,
    drillTotal: 0,
    drillFailed: 0,
    drillLastAt: null,
    drillLastOk: null
  };

  try {
    const chainReport = buildChainHealthReport(dir);
    report.chainCount = chainReport.chainCount;
    report.completeChains = chainReport.completeChains;
    report.brokenChains = chainReport.brokenChains;
    report.unparseableImages = chainReport.unparseableImages.length;
    report.imageCount =
      chainReport.chains.reduce((sum, chain) => sum + chain.itemCount, 0) + report.unparseableImages;
  } catch (error) {
    if (error instanceof Error && /does not exist/.test(error.message)) {
      report.exists = false;
      return report;
    }
    // Unreadable directory (permissions, going offline mid-scan): surface as unreachable.
    report.exists = false;
    return report;
  }

  const analytics = readAnalytics(dir);
  if (analytics.length > 0) {
    const newest = analytics[0];
    report.lastBackupAt = newest.timestamp;
    report.lastBackupImage = newest.imagePath;
    report.lastBackupBytes = newest.bytesWritten;
    report.lastBackupIncremental = newest.incremental;
  }

  try {
    const anomalies = detectAnomalies(dir);
    report.anomalyOk = anomalies.ok;
    report.criticalAnomalies = anomalies.anomalies.filter((a) => a.severity === 'critical').length;
    report.warningAnomalies = anomalies.anomalies.filter((a) => a.severity === 'warning').length;
  } catch {
    /* anomaly detection is optional context */
  }

  const drills = Object.values(readDrillHistory(dir));
  if (drills.length > 0) {
    report.drillTotal = drills.length;
    report.drillFailed = drills.filter((d) => !d.ok).length;
    const latest = drills.reduce((newest, d) => (d.at > newest.at ? d : newest));
    report.drillLastAt = latest.at;
    report.drillLastOk = latest.ok;
  }

  return report;
}

function toFleetMedia(entry: MediaInventoryEntry): FleetMediaEntry {
  return {
    diskIndex: entry.diskIndex,
    model: entry.model,
    serial: entry.serial,
    size: entry.size,
    driveLetters: entry.driveLetters,
    healthy: !entry.unhealthy,
    measured: entry.health.data != null && Object.keys(entry.health.data).length > 0,
    warnings: entry.health.warnings
  };
}

export async function buildFleetReport(opts: FleetReportOptions): Promise<FleetCheckin> {
  const hostname = opts.hostname ?? os.hostname();
  const destinations: FleetDestinationReport[] = [];
  for (const dir of opts.directories) {
    destinations.push(buildDestinationReport(dir));
  }

  let media: FleetMediaEntry[] = [];
  if (opts.includeMedia !== false) {
    try {
      const inventory = (opts.inventoryMedia ?? inventoryMediaHealth)();
      media = (await inventory).map(toFleetMedia);
    } catch {
      /* SMART unavailable (not elevated, remote session): report empty media. */
    }
  }

  return {
    schema: FLEET_SCHEMA_VERSION,
    machineId: opts.machineId ?? fleetMachineId(hostname, os.arch()),
    hostname,
    os: { platform: process.platform, release: os.release(), arch: os.arch() },
    appVersion: opts.appVersion,
    sentAt: opts.now ?? Date.now(),
    destinations,
    media
  };
}
