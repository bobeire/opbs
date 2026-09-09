import { loadNative } from './native-loader';

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

      return partitions.map((partition) => ({
        ...partition,
        driveLetter: null,
        label: `Partition ${partition.partitionIndex}`,
        fsType: 'Unknown',
        usedSpace: 0,
        isSystem: false,
        isBoot: false
      }));
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