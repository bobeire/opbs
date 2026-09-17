import { execFileSync } from 'child_process';
import { logger } from './logger';
import { resolvePowershell } from './elevated';

export interface DiskReliability {
  model?: string;
  healthStatus?: string;
  mediaType?: string;
  powerOnHours?: number;
  temperatureCelsius?: number;
  wear?: number;
  readErrors?: number;
  writeErrors?: number;
  unreliableSectors?: number;
}

export interface DiskHealth {
  diskIndex: number;
  reliable: boolean;
  data: DiskReliability;
  ok: boolean;
  warnings: string[];
}

export interface HealthThresholds {
  maxTempC?: number;
  maxWearPercent?: number;
  maxUnreliableSectors?: number;
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxTempC: 55,
  maxWearPercent: 80,
  maxUnreliableSectors: 0
};

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $disk = Get-PhysicalDisk -DeviceNumber $diskIndex -ErrorAction SilentlyContinue
} catch { Write-Output '{"error":"query"}' ; exit 0 }
if (-not $disk) { Write-Output '{"missing":true}' ; exit 0 }
$rc = $disk | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
[pscustomobject][ordered]@{
  model = $disk.FriendlyName
  healthStatus = if ($disk.HealthStatus) { $disk.HealthStatus.ToString() } else { $null }
  mediaType = if ($disk.MediaType) { $disk.MediaType.ToString() } else { $null }
  powerOnHours = if ($rc -and $null -ne $rc.PowerOnHours) { [int64]$rc.PowerOnHours } else { $null }
  temperatureCelsius = if ($rc -and $null -ne $rc.Temperature) { [double]$rc.Temperature } else { $null }
  wear = if ($rc -and $null -ne $rc.Wear) { [double]$rc.Wear } else { $null }
  readErrors = if ($rc -and $null -ne $rc.ReadErrorsTotal) { [int64]$rc.ReadErrorsTotal } else { $null }
  writeErrors = if ($rc -and $null -ne $rc.WriteErrorsTotal) { [int64]$rc.WriteErrorsTotal } else { $null }
  unreliableSectors = if ($rc) {
    ([int64]$rc.PendingErrorSectors) -as [double] -as [int64]
  } else { $null }
} | ConvertTo-Json -Compress
`;

/**
 * Query Windows reliability counters for a physical disk. Requires elevated
 * privileges for most drives; a partial or empty response is reported
 * gracefully rather than thrown.
 */
export function queryReliability(diskIndex: number): DiskReliability | null {
  try {
    const out = execFileSync(
      resolvePowershell(),
      ['-NoProfile', '-NonInteractive', '-Command', `$diskIndex = ${diskIndex}; ${PS_SCRIPT}`],
      { encoding: 'utf-8', windowsHide: true, timeout: 20_000 }
    );
    const parsed = JSON.parse(out.trim());
    if (parsed?.error || parsed?.missing) {
      return null;
    }
    return parsed as DiskReliability;
  } catch (err) {
    logger.warn(`Disk health query for disk ${diskIndex} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function assessDiskHealth(diskIndex: number, data: DiskReliability | null, thresholds: HealthThresholds = DEFAULT_THRESHOLDS): DiskHealth {
  const warnings: string[] = [];

  if (!data) {
    return {
      diskIndex,
      reliable: false,
      data: {},
      ok: true,
      warnings: ['Unable to read SMART/health data (drive does not support it or requires elevation)']
    };
  }

  if (data.healthStatus && data.healthStatus !== 'Healthy') {
    warnings.push(`Hardware health reported as ${data.healthStatus}`);
  }
  if (data.temperatureCelsius != null && thresholds.maxTempC != null && data.temperatureCelsius > thresholds.maxTempC) {
    warnings.push(`Temperature is high: ${data.temperatureCelsius}°C (limit ${thresholds.maxTempC}°C)`);
  }
  if (data.wear != null && thresholds.maxWearPercent != null && data.wear > thresholds.maxWearPercent) {
    warnings.push(`SSD wear level is ${data.wear.toFixed(0)}% (limit ${thresholds.maxWearPercent}%)`);
  }
  if (data.unreliableSectors != null && thresholds.maxUnreliableSectors != null && data.unreliableSectors > thresholds.maxUnreliableSectors) {
    warnings.push(`${data.unreliableSectors} unreliable sectors detected - imminent failure risk`);
  }
  if (data.readErrors != null && data.readErrors > 1000) {
    warnings.push(`High corrected read error count: ${data.readErrors}`);
  }

  return {
    diskIndex,
    reliable: true,
    data,
    ok: warnings.length === 0,
    warnings
  };
}

/**
 * Full health check for a disk: query reliability counters (works inside the
 * app process) and produce a summary suitable for a pre-backup warning.
 */
export async function checkDiskHealth(diskIndex: number): Promise<DiskHealth> {
  const data = queryReliability(diskIndex);
  return assessDiskHealth(diskIndex, data);
}