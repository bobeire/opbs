declare module 'opbs-native' {
  export interface DiskInfo {
    index: number;
    model: string;
    size: number;
    serial: string;
  }

  export interface PartitionInfo {
    diskIndex: number;
    partitionIndex: number;
    offset: number;
    size: number;
    type: number;
  }

  export interface SnapshotInfo {
    id: string;
    devicePath: string;
  }

  export function getDisks(): DiskInfo[];
  export function getPartitions(diskIndex: number): PartitionInfo[];
  export function getPhysicalDrivePath(diskIndex: number): string;
  export function getVolumePath(diskIndex: number, partitionOffset: number): string;
  export function lockAndDismountVolume(volumePath: string): boolean;
  export function releaseLockedVolumes(): void;
  export function updateDiskProperties(devicePath: string): boolean;
  export function createSnapshot(volumePath: string): SnapshotInfo;
  export function deleteSnapshot(snapshotId: string): boolean;
  export function readBlocks(devicePath: string, offset: bigint, length: bigint): Buffer;
  export function writeBlocks(devicePath: string, offset: bigint, data: Buffer): number;
  export function readBlocksAsync(devicePath: string, offset: bigint, length: bigint): Promise<Buffer>;
  export function writeBlocksAsync(devicePath: string, offset: bigint, data: Buffer): Promise<number>;
  export function openImageForWrite(path: string): number;
  export function closeAllHandles(): void;

  export interface VirtualDiskInfo {
    virtualSize: number;
    physicalSize: number;
    blockSize: number;
    sectorSize: number;
    isLoaded: boolean;
  }
  /** Create a new .vhd/.vhdx file. `format` is 'vhd' | 'vhdx'. */
  export function createVirtualDisk(path: string, sizeBytes: number, format: string, fixed: boolean): void;
  /** Attach without a drive letter (admin only). */
  export function attachVirtualDisk(path: string): boolean;
  /** Detach (admin only). */
  export function detachVirtualDisk(path: string): boolean;
  /** Size/attachment info; works unelevated. */
  export function getVirtualDiskInfo(path: string): VirtualDiskInfo;
  /** `\\.\PhysicalDriveN` for an attached virtual disk (admin only). */
  export function getVirtualDiskPhysicalPath(path: string): string;
}
