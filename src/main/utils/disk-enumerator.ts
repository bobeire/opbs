import { execFileSync } from 'child_process';
import * as path from 'path';
import { loadNative } from './native-loader';

const powershellExe = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

interface VolumeInfo {
  driveLetter: string | null;
  fsType: string;
  label: string;
  usedSpace: number;
  isSystem?: boolean;
  isBoot?: boolean;
}

/** Query drive letter / filesystem / label / used space / system-boot flags per partition via PowerShell. */
function queryVolumes(diskIndex: number): Map<number, VolumeInfo> {
  const result = new Map<number, VolumeInfo>();
  try {
    const script =
      `Get-Partition -DiskNumber ${diskIndex} -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `$p=$_; $v = if ($p.DriveLetter) { Get-Volume -DriveLetter $p.DriveLetter -ErrorAction SilentlyContinue } else { $null }; ` +
      `[pscustomobject]@{ PartitionNumber=$p.PartitionNumber; DriveLetter=[string]$p.DriveLetter; ` +
      `FileSystem=if($v){[string]$v.FileSystem}else{''}; Label=if($v){[string]$v.FileSystemLabel}else{''}; ` +
      `Used=if($v -and $v.Size){[int64]($v.Size - $v.SizeRemaining)}else{0}; ` +
      `IsSystem=[bool]$p.IsSystem; IsBoot=[bool]$p.IsBoot } } | ConvertTo-Json -Compress`;
    const out = execFileSync(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true
    }).trim();
    if (!out) return result;
    const parsed = JSON.parse(out);
    const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of arr) {
      const pn = Number(item.PartitionNumber);
      if (!Number.isFinite(pn)) continue;
      result.set(pn, {
        driveLetter: item.DriveLetter || null,
        fsType: item.FileSystem || 'Unknown',
        label: item.Label || '',
        usedSpace: Number(item.Used) || 0,
        isSystem: !!item.IsSystem,
        isBoot: !!item.IsBoot
      });
    }
  } catch {
    // PowerShell unavailable — skip enrichment.
  }
  return result;
}

/** Disk number holding %SystemDrive% (usually C:), or null if unknown. */
export function querySystemDiskIndex(): number | null {
  try {
    const letter = (process.env.SystemDrive || 'C:').replace(':', '');
    const out = execFileSync(
      powershellExe,
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Partition -DriveLetter '${letter}' -ErrorAction Stop).DiskNumber | Out-String`],
      {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true
      }
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface NativePartition {
  diskIndex: number;
  partitionIndex: number;
  offset: number;
  size: number;
  type: number;
}

export interface NativeDiskInfo {
  index: number;
  model: string;
  size: number;
  serial: string;
}

export interface NativeDiskApi {
  getDisks(): NativeDiskInfo[];
  getPartitions(diskIndex: number): NativePartition[];
  getPhysicalDrivePath(diskIndex: number): string;
  getVolumePath(diskIndex: number, partitionOffset: number): string;
}

export interface DiskInfo {
  index: number;
  model: string;
  size: number;
  serial: string;
  partitions: PartitionInfo[];
}

export interface PartitionInfo {
  diskIndex: number;
  partitionIndex: number;
  offset: number;
  size: number;
  type: number;
  driveLetter?: string | null;
  label?: string;
  fsType?: string;
  usedSpace?: number;
  isSystem?: boolean;
  isBoot?: boolean;
}

/**
 * Disk enumeration using the native C++ addon.
 * The native addon uses Windows SetupAPI (no elevation required)
 * for disk detection and volume-based APIs for partition mapping.
 */
export class DiskEnumerator {
  private native: NativeDiskApi;

  constructor(native?: NativeDiskApi) {
    if (native) {
      this.native = native;
      return;
    }

    // Default: load the built native addon
    this.native = loadNative<NativeDiskApi>();
  }

  async getDisks(): Promise<DiskInfo[]> {
    try {
      const disks = this.native.getDisks();

      const result: DiskInfo[] = [];
      for (const disk of disks) {
        const fullDisk: DiskInfo = {
          index: disk.index,
          model: disk.model,
          size: disk.size,
          serial: disk.serial,
          partitions: []
        };

        try {
          fullDisk.partitions = await this.getPartitions(disk.index);
        } catch (error) {
          console.error(`Failed to enumerate partitions for disk ${disk.index}:`, error);
        }

        result.push(fullDisk);
      }

      return result;
    } catch (error) {
      console.error('Failed to enumerate disks:', error);
      return [];
    }
  }

  async getPartitions(diskIndex: number): Promise<PartitionInfo[]> {
    try {
      const partitions = this.native.getPartitions(diskIndex);
      const volumes = queryVolumes(diskIndex);

      return partitions.map((partition) => {
        // PartitionNumber is 1-based; partitionIndex is 0-based.
        const vol = volumes.get(partition.partitionIndex + 1);
        return {
          ...partition,
          driveLetter: vol?.driveLetter ?? null,
          label: vol?.label || `Partition ${partition.partitionIndex}`,
          fsType: vol?.fsType || 'Unknown',
          usedSpace: vol?.usedSpace ?? 0,
          isSystem: vol?.isSystem ?? false,
          isBoot: vol?.isBoot ?? false
        };
      });
    } catch (error) {
      console.error(`Failed to enumerate partitions for disk ${diskIndex}:`, error);
      return [];
    }
  }

  /**
   * Get the physical drive device path, e.g. "\\\\.\\PhysicalDrive0"
   */
  getPhysicalDrivePath(diskIndex: number): string {
    try {
      return this.native.getPhysicalDrivePath(diskIndex) as string;
    } catch (error) {
      console.error(`Failed to get physical drive path for disk ${diskIndex}:`, error);
      return '';
    }
  }

  /**
   * Get the volume device path (e.g. "\\?\Volume{GUID}\") that backs the
   * partition starting at the given offset on the given disk, or null.
   */
  getVolumePath(diskIndex: number, partitionOffset: number): string | null {
    try {
      const path = this.native.getVolumePath(diskIndex, partitionOffset) as string;
      return path ? path : null;
    } catch (error) {
      console.error(`Failed to get volume path for disk ${diskIndex}:`, error);
      return null;
    }
  }
}