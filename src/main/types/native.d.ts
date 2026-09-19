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
  export function createSnapshot(volumePath: string): SnapshotInfo;
  export function deleteSnapshot(snapshotId: string): boolean;
  export function readBlocks(devicePath: string, offset: bigint, length: bigint): Buffer;
  export function writeBlocks(devicePath: string, offset: bigint, data: Buffer): number;
  export function readBlocksAsync(devicePath: string, offset: bigint, length: bigint): Promise<Buffer>;
  export function writeBlocksAsync(devicePath: string, offset: bigint, data: Buffer): Promise<number>;
  export function openImageForWrite(path: string): number;
  export function closeAllHandles(): void;
}
