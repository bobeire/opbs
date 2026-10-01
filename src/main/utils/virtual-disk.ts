import * as fs from 'fs';
import { loadNative } from './native-loader';

/**
 * VHD/VHDX restore-target helpers.
 *
 * The pure functions below are unit-tested; the native wrappers call into the
 * virtdisk API (createVirtualDisk / attachVirtualDisk / detachVirtualDisk /
 * getVirtualDiskInfo / getVirtualDiskPhysicalPath) and only ever run inside
 * the elevated helper — attaching a virtual disk requires administrator
 * rights. The one exception is getVirtualDiskInfo, which works unelevated and
 * is used by preflight in the main process.
 */

export type VirtualDiskFormat = 'vhd' | 'vhdx';
export type VirtualDiskType = 'dynamic' | 'fixed';

/** Restore target pointing at a .vhd/.vhdx file instead of a physical disk. */
export interface VirtualDiskTarget {
  /** Absolute path of the virtual disk file (created when missing). */
  path: string;
  /** Virtual capacity in bytes. Required when the file does not exist yet. */
  virtualSize?: number;
  /** Advisory: derived from the path extension when omitted; must match it. */
  format?: VirtualDiskFormat;
  /** Allocation style for a file we create. Defaults to dynamic. */
  type?: VirtualDiskType;
}

export interface DiskSnapshotLike {
  index: number;
  size: number;
}

export interface VirtualDiskInfo {
  virtualSize: number;
  physicalSize: number;
  blockSize: number;
  sectorSize: number;
  isLoaded: boolean;
}

interface VirtualDiskNativeApi {
  createVirtualDisk(path: string, sizeBytes: number, format: string, fixed: boolean): void;
  attachVirtualDisk(path: string): boolean;
  detachVirtualDisk(path: string): boolean;
  getVirtualDiskInfo(path: string): VirtualDiskInfo;
  getVirtualDiskPhysicalPath(path: string): string;
}

/** Classic VHD caps out at 2040 GB; VHDX supports up to 64 TB. */
export const VHD_MAX_BYTES = 2040 * 1024 ** 3;
export const VHDX_MAX_BYTES = 64 * 1024 ** 4;
/** Windows rejects VHD/VHDX files below roughly 3 MB. */
export const VIRTUAL_DISK_MIN_BYTES = 3 * 1024 * 1024;

export const DEFAULT_DISCOVERY_TOLERANCE_BYTES = 4 * 1024 * 1024;

export function virtualDiskFormatFromPath(p: string): VirtualDiskFormat {
  return /\.vhdx$/i.test(p ?? '') ? 'vhdx' : 'vhd';
}

export function isVirtualDiskPath(p: string): boolean {
  return /\.vhdx?$/i.test(p ?? '');
}

export function roundToSector(bytes: number, sector = 512): number {
  const remainder = bytes % sector;
  return remainder === 0 ? bytes : bytes + (sector - remainder);
}

export function alignUp(bytes: number, alignment: number): number {
  const remainder = bytes % alignment;
  return remainder === 0 ? bytes : bytes + (alignment - remainder);
}

/** Returns a human-readable problem, or null when the size is acceptable. */
export function validateVirtualSize(format: VirtualDiskFormat, bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'Virtual disk size must be a positive number of bytes';
  }
  if (bytes < VIRTUAL_DISK_MIN_BYTES) {
    return `Virtual disks must be at least ${Math.ceil(VIRTUAL_DISK_MIN_BYTES / 1048576)} MB`;
  }
  if (format === 'vhd' && bytes > VHD_MAX_BYTES) {
    return `Classic .vhd supports at most 2040 GB — use a .vhdx file for larger disks`;
  }
  if (format === 'vhdx' && bytes > VHDX_MAX_BYTES) {
    return '.vhdx supports at most 64 TB';
  }
  return null;
}

/**
 * Default capacity for a new virtual disk: large enough to hold every
 * captured partition at its original offset, plus 1 MiB of headroom for the
 * GPT backup header / alignment, rounded up to whole MiB.
 */
export function defaultVirtualSizeBytes(
  imagePartitions: Array<{ offsetOnDisk: number; size: number }>
): number {
  let end = 0;
  for (const p of imagePartitions) {
    end = Math.max(end, p.offsetOnDisk + p.size);
  }
  if (end <= 0) {
    return 0;
  }
  return alignUp(end + 1048576, 1048576);
}

export function defaultVirtualSizeGb(imagePartitions: Array<{ offsetOnDisk: number; size: number }>): number {
  const bytes = defaultVirtualSizeBytes(imagePartitions);
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / 1024 ** 3)) : 1;
}

/**
 * Find the disk that a just-attached virtual disk maps to by diffing the disk
 * list taken before the attach against the list after it. A disk's identity is
 * its index *and* size, so an index reused by a different device still shows
 * up as new. Only disks that appeared in the diff are considered — a physical
 * disk that was already present can never be matched, even when its size
 * happens to equal the virtual disk's capacity.
 *
 * Returns the disk index, or null when nothing unambiguous was found.
 */
export function discoverAttachedDiskIndex(
  before: DiskSnapshotLike[],
  after: DiskSnapshotLike[],
  expectedSizeBytes: number,
  toleranceBytes: number = DEFAULT_DISCOVERY_TOLERANCE_BYTES
): number | null {
  const seen = new Set(before.map((d) => `${d.index}:${d.size}`));
  const fresh = after.filter((d) => !seen.has(`${d.index}:${d.size}`));
  if (fresh.length === 0) {
    return null;
  }
  const exact = fresh.filter((d) => d.size === expectedSizeBytes);
  if (exact.length === 1) {
    return exact[0].index;
  }
  if (exact.length > 1) {
    return null;
  }
  const near = fresh.filter((d) => Math.abs(d.size - expectedSizeBytes) <= toleranceBytes);
  return near.length === 1 ? near[0].index : null;
}

/** Parse `\\.\PhysicalDrive5` (or a bare `PhysicalDrive5`) into 5. */
export function parsePhysicalDriveIndex(physicalPath: string): number | null {
  const match = /PhysicalDrive(\d+)/i.exec(physicalPath ?? '');
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** Resolve the effective capacity: an existing file's real virtual size
 *  wins; otherwise the configured creation size is used. */
export function resolveVirtualDiskSize(target: VirtualDiskTarget): number {
  if (fs.existsSync(target.path)) {
    return readVirtualDiskInfo(target.path).virtualSize;
  }
  if (typeof target.virtualSize === 'number' && Number.isFinite(target.virtualSize)) {
    return roundToSector(Math.floor(target.virtualSize));
  }
  throw new Error(
    `Virtual disk ${target.path} does not exist and no size was given — set the virtual disk size to create it`
  );
}

// --- native wrappers ------------------------------------------------------

function vdNative(): VirtualDiskNativeApi {
  return loadNative<VirtualDiskNativeApi>();
}

/** Read size/attachment state. Works unelevated; throws when the file is missing. */
export function readVirtualDiskInfo(path: string): VirtualDiskInfo {
  return vdNative().getVirtualDiskInfo(path);
}

export function createVirtualDiskFile(target: VirtualDiskTarget): void {
  const format = virtualDiskFormatFromPath(target.path);
  if (target.format && target.format !== format) {
    throw new Error(`Virtual disk format "${target.format}" does not match the file extension of ${target.path}`);
  }
  if (typeof target.virtualSize !== 'number' || !Number.isFinite(target.virtualSize)) {
    throw new Error('Virtual disk size is required to create a new virtual disk');
  }
  const size = roundToSector(Math.floor(target.virtualSize));
  const problem = validateVirtualSize(format, size);
  if (problem) {
    throw new Error(problem);
  }
  vdNative().createVirtualDisk(target.path, size, format, target.type === 'fixed');
}

/** Attach without a drive letter. Requires elevation. */
export function attachVirtualDiskFile(path: string): void {
  vdNative().attachVirtualDisk(path);
}

/** Detach. Requires elevation. Throws when the disk is not attached. */
export function detachVirtualDiskFile(path: string): void {
  vdNative().detachVirtualDisk(path);
}

/** `\\.\PhysicalDriveN` for an attached virtual disk. Requires elevation. */
export function virtualDiskPhysicalPath(path: string): string {
  return vdNative().getVirtualDiskPhysicalPath(path);
}
