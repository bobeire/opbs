import * as path from 'path';
import { loadNative } from '../utils/native-loader';
import { openAnyBrowse, BrowseSession } from './fs/file-browse';
import { handleBridgeRequest, BridgeRequest, BridgeReply } from './fs/mount-fs';
import { readImageInfo, deriveImageKey, CIPHER_NONE } from './image-format';
import { detectMacriumFormat } from './mrimg';

/**
 * Mounts a partition from a backup image as a read-only drive letter using the
 * WinFsp filesystem in the native addon. The mounted volume is virtual: WinFsp
 * asks the JS bridge for files, and the bridge reads bytes straight from the
 * image (decompressing only the blocks that are touched). No extra disk space
 * is used.
 *
 * Mounting needs administrator rights (the WinFsp DISK device), so in the GUI
 * and CLI a mount normally lives in the elevated helper process.
 */

export interface MountConfig {
  imagePath: string;
  partitionIndex: number;
  /** Optional drive letter (`X:`). When omitted WinFsp assigns a letter. */
  driveLetter?: string;
  /** Volume label shown in Explorer. */
  label?: string;
  passphrase?: string;
}

export interface MountHandle {
  id: number;
  mountPoint: string;
  unmount(): boolean;
}

interface NativeWinFsp {
  winfspAvailable(): boolean;
  winfspMount(
    config: { label: string; totalSize: number; driveLetter?: string },
    handler: (req: BridgeRequest) => BridgeReply
  ): { id: number; mountPoint: string };
  winfspUnmount(id: number): boolean;
}

interface ActiveMount {
  session: BrowseSession;
  unmount: () => boolean;
}

let nativeCache: NativeWinFsp | null | null = null;

function nativeApi(): NativeWinFsp {
  if (nativeCache === null) {
    nativeCache = loadNative<NativeWinFsp>();
  }
  return nativeCache;
}

/** True when the WinFsp runtime is installed and loadable. */
export function winfspAvailable(): boolean {
  try {
    return nativeApi().winfspAvailable();
  } catch {
    return false;
  }
}

function keyFor(config: MountConfig): Buffer | undefined {
  if (detectMacriumFormat(config.imagePath)) return undefined;
  const info = readImageInfo(config.imagePath);
  const header = info.header;
  return header.cipherId !== CIPHER_NONE
    ? deriveImageKey(config.passphrase ?? '', header.salt, header.kdfIterations)
    : undefined;
}

const mounts = new Map<number, ActiveMount>();

/** Open an image partition as a read-only WinFsp volume. Returns synchronously. */
export function mountImage(config: MountConfig): MountHandle {
  const native = nativeApi();
  if (!native.winfspAvailable()) {
    throw new Error(
      'WinFsp is not installed. Install the WinFsp runtime (https://winfsp.dev) and try again.'
    );
  }
  const session = openAnyBrowse(config.imagePath, config.partitionIndex, keyFor(config));
  const handler = (req: BridgeRequest): BridgeReply => handleBridgeRequest(session, req);
  const label = config.label ?? `OPBS ${path.basename(config.imagePath)}`;
  const res = native.winfspMount(
    { label, totalSize: session.reader.size, driveLetter: config.driveLetter },
    handler
  );
  mounts.set(res.id, { session, unmount: () => native.winfspUnmount(res.id) });
  return { id: res.id, mountPoint: res.mountPoint, unmount: () => unmountImage(res.id) };
}

/** Unmount a mounted volume by id. Returns false when the id is unknown. */
export function unmountImage(id: number): boolean {
  const active = mounts.get(id);
  if (!active) return false;
  mounts.delete(id);
  try {
    return active.unmount();
  } catch {
    return false;
  }
}

/** Number of currently mounted volumes (status reporting / tests). */
export function activeMountCount(): number {
  return mounts.size;
}