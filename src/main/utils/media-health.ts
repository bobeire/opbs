import { execFile } from 'child_process';
import { checkDiskHealth, DiskHealth, DiskReliability } from './disk-health';
import { resolveDestinationDisk } from './storage-health';
import { DiskEnumerator, DiskInfo } from './disk-enumerator';
import { isNonFilesystemLocation } from './location';
import { resolvePowershell } from './elevated';
import { logger } from './logger';

/**
 * Backup-media quality checks (SMART).
 *
 * Two surfaced layers:
 *  1. Pre-backup gate: before a backup writes to a local filesystem destination,
 *     resolve the physical drive it lives on and query its reliability counters.
 *     If the drive actually reports problems (bad health status, high
 *     temperature, SSD wear, unreliable sectors, read errors), the backup is
 *     refused. Crucially the gate only blocks on *reported* problems — a drive
 *     whose SMART data cannot be read (no elevation, remote, stale driver)
 *     passes with a warning, so backups to external media are never held up by
 *     measurement limits.
 *  2. Disk-wide inventory: SMART health for every physical disk, not just the
 *     ones currently hosting a configured destination, so a failing backup
 *     drive is caught before it is ever pointed at.
 *
 * Per-disk query results are cached for 5 minutes so repeated backup runs do
 * not pay a PowerShell round-trip every time.
 */

export interface MediaHealthResult {
  diskIndex?: number;
  driveLetter?: string;
  data?: DiskReliability | null;
  reliable: boolean;
  warnings: string[];
  /** true only when the drive reported a concrete problem worth refusing work. */
  blocked: boolean;
  /** whether a physical disk was resolved and measurable SMART data returned. */
  measured: boolean;
}

export interface MediaHealthDeps {
  resolveDisk?: (dir: string) => Promise<{ diskIndex?: number; driveLetter?: string }>;
  queryDisk?: (diskIndex: number) => DiskHealth;
}

export interface MediaInventoryEntry {
  diskIndex: number;
  model: string;
  serial: string;
  size: number;
  driveLetters: string[];
  health: {
    data?: DiskReliability | null;
    reliable: boolean;
    warnings: string[];
  };
  /** sensor/status problems reported — a healthy (readable) report never flags. */
  unhealthy: boolean;
}

export interface MediaInventoryDeps {
  enumerate?: () => Promise<DiskInfo[]>;
  queryDisk?: (diskIndex: number) => DiskHealth;
  listLetters?: (diskIndex: number) => Promise<string[]>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const diskHealthCache = new Map<number, { at: number; health: DiskHealth }>();

function hasMeasurableData(health?: DiskHealth | null): boolean {
  return !!health?.data && Object.keys(health.data).length > 0;
}

async function queryDiskCached(diskIndex: number): Promise<DiskHealth> {
  const hit = diskHealthCache.get(diskIndex);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.health;
  }
  const health = await checkDiskHealth(diskIndex);
  diskHealthCache.set(diskIndex, { at: Date.now(), health });
  return health;
}

function assessResolvedDisk(
  disk: { diskIndex?: number; driveLetter?: string },
  health: DiskHealth
): MediaHealthResult {
  const measured = hasMeasurableData(health);
  const warnings = health.warnings ?? [];
  return {
    diskIndex: disk.diskIndex,
    driveLetter: disk.driveLetter,
    data: measured ? health.data : null,
    reliable: measured ? warnings.length === 0 : (health.reliable ?? true),
    warnings,
    blocked: measured && warnings.length > 0,
    measured
  };
}

/**
 * Media health of the physical drive backing a backup destination.
 * Never throws: measurement problems are downgraded to warnings.
 */
export async function checkMediaHealth(
  directory: string,
  deps: MediaHealthDeps = {}
): Promise<MediaHealthResult> {
  if (isNonFilesystemLocation(directory)) {
    return { reliable: true, warnings: [], blocked: false, measured: false };
  }
  const resolve = deps.resolveDisk ?? resolveDestinationDisk;
  const disk = await resolve(directory);
  if (disk.diskIndex == null) {
    return {
      driveLetter: disk.driveLetter,
      reliable: true,
      warnings: [],
      blocked: false,
      measured: false
    };
  }
  const health = deps.queryDisk ? await deps.queryDisk(disk.diskIndex) : await queryDiskCached(disk.diskIndex);
  return assessResolvedDisk(disk, health);
}

async function resolveDriveLetters(diskIndex: number): Promise<string[]> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        resolvePowershell(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Partition -DiskNumber ${diskIndex} -ErrorAction SilentlyContinue | Where-Object DriveLetter | ForEach-Object DriveLetter) -join ','`
        ],
        { timeout: 15_000, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
      );
    });
    return out ? out.split(',') : [];
  } catch {
    return [];
  }
}

/**
 * SMART health of every physical disk in the machine, best effort.
 */
export async function inventoryMediaHealth(deps: MediaInventoryDeps = {}): Promise<MediaInventoryEntry[]> {
  const enumerate =
    deps.enumerate ??
    (async () => {
      const enumerator = new DiskEnumerator();
      return enumerator.getDisks();
    });
  const queryDisk = deps.queryDisk ?? queryDiskCached;
  const listLetters = deps.listLetters ?? resolveDriveLetters;

  const disks = await enumerate();
  const entries: MediaInventoryEntry[] = [];

  for (const disk of disks) {
    let health: DiskHealth | null;
    try {
      health = await queryDisk(disk.index);
    } catch (error) {
      logger.warn(`Media health query failed for disk ${disk.index}: ${error instanceof Error ? error.message : error}`);
      health = null;
    }
    const measured = hasMeasurableData(health);
    let driveLetters: string[] = [];
    try {
      driveLetters = await listLetters(disk.index);
    } catch {
      /* ignore */
    }
    entries.push({
      diskIndex: disk.index,
      model: disk.model,
      serial: disk.serial,
      size: disk.size,
      driveLetters,
      health: {
        data: measured ? health?.data : null,
        reliable: health?.reliable ?? true,
        warnings: health?.warnings ?? []
      },
      unhealthy: measured && (health?.warnings.length ?? 0) > 0
    });
  }

  return entries;
}