/**
 * Fleet check-in contract (Multi-Machine Central Control, Tier 0).
 *
 * Every machine POSTs one FleetCheckin JSON document to the fleet server; the
 * server stores the newest document per machineId and serves an aggregate for
 * the dashboard. The schema is deliberately flat, versioned and forward-
 * tolerant: unknown fields are preserved by the server, missing optional
 * fields default to neutral values, and a schema number bump is the only
 * breaking change signal.
 */
import { createHash } from 'crypto';

export const FLEET_SCHEMA_VERSION = 1;

export interface FleetDestinationReport {
  directory: string;
  exists: boolean;
  imageCount: number;
  chainCount: number;
  completeChains: number;
  brokenChains: number;
  unparseableImages: number;
  /** Newest backup-analytics timestamp in the directory, null when no history. */
  lastBackupAt: number | null;
  lastBackupImage: string | null;
  lastBackupBytes: number | null;
  lastBackupIncremental: boolean | null;
  anomalyOk: boolean;
  criticalAnomalies: number;
  warningAnomalies: number;
  drillTotal: number;
  drillFailed: number;
  drillLastAt: number | null;
  drillLastOk: boolean | null;
}

export interface FleetMediaEntry {
  diskIndex: number;
  model: string;
  serial: string;
  size: number;
  driveLetters: string[];
  /** SMART was readable and reported no problems (or nothing to report). */
  healthy: boolean;
  /** SMART data was actually measurable (false = unknown, not bad). */
  measured: boolean;
  warnings: string[];
}

export interface FleetCheckin {
  schema: number;
  machineId: string;
  hostname: string;
  os: { platform: string; release: string; arch: string };
  appVersion: string;
  sentAt: number;
  destinations: FleetDestinationReport[];
  media: FleetMediaEntry[];
}

export type FleetStatus = 'ok' | 'warning' | 'critical' | 'stale';

export interface FleetStatusResult {
  status: FleetStatus;
  reasons: string[];
}

/** Stable machine identity: hostname + arch, hashed so raw hostnames are not the key. */
export function fleetMachineId(hostname: string, arch: string): string {
  return createHash('sha256').update(`${hostname.toLowerCase()}:${arch.toLowerCase()}`).digest('hex').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validateDestination(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `destinations[${index}] is not an object`;
  const requiredNumbers = [
    'imageCount',
    'chainCount',
    'completeChains',
    'brokenChains',
    'unparseableImages',
    'criticalAnomalies',
    'warningAnomalies',
    'drillTotal',
    'drillFailed'
  ] as const;
  if (!isString(value.directory)) return `destinations[${index}].directory is not a string`;
  if (typeof value.exists !== 'boolean') return `destinations[${index}].exists is not a boolean`;
  for (const key of requiredNumbers) {
    if (!isNumber(value[key])) return `destinations[${index}].${key} is not a number`;
  }
  if (value.lastBackupAt !== null && !isNumber(value.lastBackupAt)) {
    return `destinations[${index}].lastBackupAt is not a number or null`;
  }
  if (value.lastBackupImage !== null && !isString(value.lastBackupImage)) {
    return `destinations[${index}].lastBackupImage is not a string or null`;
  }
  if (value.lastBackupBytes !== null && !isNumber(value.lastBackupBytes)) {
    return `destinations[${index}].lastBackupBytes is not a number or null`;
  }
  if (value.lastBackupIncremental !== null && typeof value.lastBackupIncremental !== 'boolean') {
    return `destinations[${index}].lastBackupIncremental is not a boolean or null`;
  }
  if (typeof value.anomalyOk !== 'boolean') return `destinations[${index}].anomalyOk is not a boolean`;
  if (value.drillLastAt !== null && !isNumber(value.drillLastAt)) {
    return `destinations[${index}].drillLastAt is not a number or null`;
  }
  if (value.drillLastOk !== null && typeof value.drillLastOk !== 'boolean') {
    return `destinations[${index}].drillLastOk is not a boolean or null`;
  }
  return null;
}

function validateMedia(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `media[${index}] is not an object`;
  if (!isNumber(value.diskIndex)) return `media[${index}].diskIndex is not a number`;
  if (!isString(value.model)) return `media[${index}].model is not a string`;
  if (!isString(value.serial)) return `media[${index}].serial is not a string`;
  if (!isNumber(value.size)) return `media[${index}].size is not a number`;
  if (!isStringArray(value.driveLetters)) return `media[${index}].driveLetters is not a string array`;
  if (typeof value.healthy !== 'boolean') return `media[${index}].healthy is not a boolean`;
  if (typeof value.measured !== 'boolean') return `media[${index}].measured is not a boolean`;
  if (!isStringArray(value.warnings)) return `media[${index}].warnings is not a string array`;
  return null;
}

/** Validate an untrusted check-in document, returning a typed object or the first problem. */
export function validateCheckin(value: unknown): { ok: true; checkin: FleetCheckin } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'check-in is not a JSON object' };
  if (!isNumber(value.schema)) return { ok: false, error: 'schema is not a number' };
  if (value.schema !== FLEET_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schema version ${value.schema} (expected ${FLEET_SCHEMA_VERSION})` };
  }
  if (!isString(value.machineId) || value.machineId.length === 0) return { ok: false, error: 'machineId is missing' };
  if (!isString(value.hostname)) return { ok: false, error: 'hostname is not a string' };
  if (!isString(value.appVersion)) return { ok: false, error: 'appVersion is not a string' };
  if (!isNumber(value.sentAt)) return { ok: false, error: 'sentAt is not a number' };
  if (!isRecord(value.os)) return { ok: false, error: 'os is not an object' };
  if (!isString(value.os.platform) || !isString(value.os.release) || !isString(value.os.arch)) {
    return { ok: false, error: 'os.platform/release/arch must be strings' };
  }
  if (!Array.isArray(value.destinations)) return { ok: false, error: 'destinations is not an array' };
  for (let i = 0; i < value.destinations.length; i++) {
    const err = validateDestination(value.destinations[i], i);
    if (err) return { ok: false, error: err };
  }
  if (!Array.isArray(value.media)) return { ok: false, error: 'media is not an array' };
  for (let i = 0; i < value.media.length; i++) {
    const err = validateMedia(value.media[i], i);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, checkin: value as unknown as FleetCheckin };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FleetStatusOptions {
  /** When the server last received this machine's check-in (epoch ms). */
  receivedAt: number;
  now?: number;
  /** Days without a check-in before a machine counts as stale (default 7). */
  staleDays?: number;
  /**
   * Days without a backup before the machine counts as stale (0/undefined
   * disables). Machines with images but no recorded run yet are unaffected —
   * they are already covered by the "never backed up" warning.
   */
  backupStaleDays?: number;
}

/**
 * Derive the fleet status for one machine. Precedence: critical (restore or
 * media risk) > stale (machine stopped checking in) > warning (needs a look)
 * > ok. Returns the human reasons so the dashboard never has to re-derive them.
 */
export function deriveMachineStatus(checkin: FleetCheckin, opts: FleetStatusOptions): FleetStatusResult {
  const now = opts.now ?? Date.now();
  const staleDays = opts.staleDays ?? 7;
  const reasons: string[] = [];

  let critical = false;
  let stale = now - opts.receivedAt > staleDays * DAY_MS;
  if (stale) {
    reasons.push(`no check-in for more than ${staleDays} day(s)`);
  }
  let warning = false;

  for (const dest of checkin.destinations) {
    if (!dest.exists) {
      reasons.push(`${dest.directory}: destination unreachable`);
      warning = true;
      continue;
    }
    if (opts.backupStaleDays && opts.backupStaleDays > 0 && dest.lastBackupAt != null) {
      const backupAgeDays = Math.floor((now - dest.lastBackupAt) / DAY_MS);
      if (backupAgeDays >= opts.backupStaleDays) {
        reasons.push(`${dest.directory}: last backup ${backupAgeDays} day(s) ago (threshold ${opts.backupStaleDays})`);
        stale = true;
      }
    }
    if (dest.brokenChains > 0) {
      reasons.push(`${dest.directory}: ${dest.brokenChains} broken restore chain(s)`);
      critical = true;
    }
    if (dest.criticalAnomalies > 0) {
      reasons.push(`${dest.directory}: ${dest.criticalAnomalies} critical backup anomal(y/ies)`);
      critical = true;
    }
    if (dest.warningAnomalies > 0) {
      reasons.push(`${dest.directory}: ${dest.warningAnomalies} backup anomal(y/ies)`);
      warning = true;
    }
    if (dest.unparseableImages > 0) {
      reasons.push(`${dest.directory}: ${dest.unparseableImages} unparseable image(s)`);
      warning = true;
    }
    if (dest.drillLastOk === false) {
      reasons.push(`${dest.directory}: latest restore drill FAILED`);
      critical = true;
    }
    if (dest.lastBackupAt === null && dest.imageCount > 0) {
      reasons.push(`${dest.directory}: images present but no backup history`);
      warning = true;
    }
    if (dest.lastBackupAt === null && dest.imageCount === 0) {
      reasons.push(`${dest.directory}: no backups yet`);
      warning = true;
    }
  }

  for (const media of checkin.media) {
    if (media.healthy === false && media.measured) {
      reasons.push(`disk ${media.diskIndex} (${media.model || 'unknown'}): SMART reports problems`);
      critical = true;
    }
  }

  const status: FleetStatus = critical ? 'critical' : stale ? 'stale' : warning ? 'warning' : 'ok';
  return { status, reasons };
}

/** Newest backup timestamp across all destinations, null when nothing ever backed up. */
export function lastBackupAt(checkin: FleetCheckin): number | null {
  let newest: number | null = null;
  for (const dest of checkin.destinations) {
    if (dest.lastBackupAt != null && (newest === null || dest.lastBackupAt > newest)) {
      newest = dest.lastBackupAt;
    }
  }
  return newest;
}
