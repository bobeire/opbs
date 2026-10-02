import * as fs from 'fs';
import { loadNative } from '../utils/native-loader';
import {
  attachVirtualDiskFile,
  detachVirtualDiskFile,
  discoverAttachedDiskIndex,
  parsePhysicalDriveIndex,
  readVirtualDiskInfo,
  virtualDiskPhysicalPath
} from '../utils/virtual-disk';

/**
 * Shared attach/discover plumbing for jobs that treat a .vhd/.vhdx file as a
 * disk (restore targets, backup sources). Requires elevation.
 */

const DISCOVERY_TIMEOUT_MS = 15000;
const DISCOVERY_POLL_MS = 250;
const DISK_APPEAR_TIMEOUT_MS = 8000;
const DETACH_RETRIES = 3;
const DETACH_RETRY_DELAY_MS = 500;

export interface DiskLike {
  index: number;
  size: number;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function physicalDiskIndex(vhdPath: string): number | null {
  try {
    return parsePhysicalDriveIndex(virtualDiskPhysicalPath(vhdPath));
  } catch {
    return null;
  }
}

/** Poll until a disk that appeared after an attach can be identified by the
 *  diff plus the virtual disk's capacity. */
export async function pollForAttachedDisk(before: DiskLike[], expectedSize: number): Promise<number | null> {
  const getDisks = loadNative<{ getDisks(): DiskLike[] }>();
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = discoverAttachedDiskIndex(before, getDisks.getDisks(), expectedSize);
    if (found !== null) {
      return found;
    }
    await sleep(DISCOVERY_POLL_MS);
  }
  return null;
}

export async function waitForDiskToAppear(index: number): Promise<boolean> {
  const getDisks = loadNative<{ getDisks(): DiskLike[] }>();
  const deadline = Date.now() + DISK_APPEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (getDisks.getDisks().some((d) => d.index === index)) {
      return true;
    }
    await sleep(DISCOVERY_POLL_MS);
  }
  return getDisks.getDisks().some((d) => d.index === index);
}

export async function detachWithRetries(vhdPath: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DETACH_RETRIES; attempt++) {
    try {
      detachVirtualDiskFile(vhdPath);
      return;
    } catch (error) {
      lastError = error;
      await sleep(DETACH_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** Append a warning to an already-written result (best-effort: the parent
 *  may have consumed and removed the file already). */
export function appendResultWarning(resultPath: string, warning: string): void {
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as { warnings?: string[] };
    result.warnings = [...(result.warnings ?? []), warning];
    fs.writeFileSync(resultPath, JSON.stringify(result));
  } catch {
    /* result already consumed or unreadable — log only */
  }
}

export interface AttachDiscoveryResult {
  diskIndex: number;
  /** True only when *we* attached the file — the caller owns the detach. */
  attachedByUs: boolean;
}

/**
 * Attach `vhdPath` (unless it is already attached) and resolve the physical
 * disk index it maps to. The discovery prefers the exact `\\.\PhysicalDriveN`
 * the virtdisk API reports and falls back to a before/after disk-list diff; a
 * pre-existing physical disk can never be matched because only newly-appearing
 * disks are considered.
 */
export async function attachAndDiscoverDisk(
  vhdPath: string,
  opts: { readOnly?: boolean; report?: (message: string) => void } = {}
): Promise<AttachDiscoveryResult> {
  const report = opts.report ?? (() => undefined);
  const info = readVirtualDiskInfo(vhdPath);

  let diskIndex: number | null;
  let attachedByUs = false;

  if (info.isLoaded) {
    report('Virtual disk is already attached — locating it…');
    diskIndex = physicalDiskIndex(vhdPath);
  } else {
    const getDisks = loadNative<{ getDisks(): DiskLike[] }>();
    const before = getDisks.getDisks().map((d) => ({ index: d.index, size: d.size }));
    report('Attaching virtual disk…');
    try {
      attachVirtualDiskFile(vhdPath, { readOnly: opts.readOnly });
    } catch (attachError) {
      // A racing attach between the isLoaded check and our attempt leaves the
      // disk attached — that is still a state we can use.
      const after = readVirtualDiskInfo(vhdPath);
      if (!after.isLoaded) {
        throw attachError;
      }
    }
    attachedByUs = true;
    diskIndex = physicalDiskIndex(vhdPath);
    if (diskIndex === null) {
      diskIndex = await pollForAttachedDisk(before, info.virtualSize);
    }
  }

  if (diskIndex === null) {
    throw new Error(
      `Attached the virtual disk ${vhdPath} but could not determine which disk it maps to — detach it manually and retry`
    );
  }
  if (!(await waitForDiskToAppear(diskIndex))) {
    throw new Error(`Virtual disk attached as disk ${diskIndex} but the device never appeared`);
  }
  return { diskIndex, attachedByUs };
}
