import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseHeader, HEADER_SIZE, FLAG_INCREMENTAL } from './image-format';
import { isNonFilesystemLocation } from '../utils/location';
import { cloudStoreFromLocation, type CloudStoreOptions } from '../utils/cloud-store';

/**
 * Restore directly from a cloud destination (`s3://`, `sftp://`, `ftp://`).
 *
 * The whole restore pipeline — the engine's preflight, the per-block reads,
 * and the JSON job handed to the elevated helper — opens local paths only, so
 * a cloud image is staged first: the chain (root full + intermediate deltas +
 * the picked image + any `.NNN` continuation volumes) is downloaded into an
 * `opbs-restore-*` temp dir, the restore runs against those local files, and
 * the caller removes the dir afterwards. Ancestors are recorded in image
 * headers as absolute paths captured at backup time, so — exactly like
 * `prune s3://` — they are matched by basename against the store listing.
 */

/** Object-store surface a cloud restore needs. */
export interface RestoreCloudStore {
  listWithMeta(prefix?: string): Promise<Array<{ key: string; size: number }>>;
  getRange(key: string, offset: number, length: number): Promise<Buffer>;
  downloadFile(key: string, destPath: string, onProgress?: (bytes: number) => void): Promise<void>;
}

export interface CloudDownloadProgress {
  /** Basename of the file currently downloading. */
  file: string;
  /** 1-based index / count across the whole staged set. */
  fileIndex: number;
  fileCount: number;
  fileBytesDone: number;
  fileBytesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface CloudImagePlan {
  /** Files to fetch, chain-root first; `destName` is the basename inside the temp dir. */
  files: Array<{ key: string; destName: string; size: number }>;
  totalBytes: number;
  /** Staged basename of the requested image (the last chain member). */
  targetDestName: string;
}

export interface StagedCloudImage {
  /** Local path of the requested image inside `tempDir`. */
  imagePath: string;
  tempDir: string;
  plan: CloudImagePlan;
  /** Remove the staged temp dir (best-effort, never throws). */
  cleanup(): void;
}

/** True for `s3://`, `sftp://`, `ftp://`, `ftps://` locations. */
export function isCloudImageLocation(uri: string): boolean {
  return isNonFilesystemLocation(uri);
}

/** Bytes kept free on top of the staged size (filesystem metadata, slop). */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Split a cloud image URI into the store location (everything but the last
 * path segment when that segment looks like an image) and the image hint.
 * `s3://bucket/prefix/image.opbs` -> dir `s3://bucket/prefix`, key `image.opbs`.
 */
function splitImageUri(uri: string): { dirUri: string; keyHint: string } {
  const trimmed = uri.trim().replace(/\\/g, '/');
  const lastSlash = trimmed.lastIndexOf('/');
  const last = lastSlash === -1 ? '' : trimmed.slice(lastSlash + 1);
  if (/\.opbs(\.\d{3})?$/i.test(last)) {
    return { dirUri: trimmed.slice(0, lastSlash), keyHint: last };
  }
  return { dirUri: trimmed, keyHint: '' };
}

async function ensureFreeSpace(dir: string, needed: number): Promise<void> {
  let free: number;
  try {
    const disk = await fs.promises.statfs(dir);
    free = Number(disk.bavail) * Number(disk.bsize);
  } catch {
    return; // Unsupported/offline volume — same tolerance as destination-health.
  }
  const required = needed + FREE_SPACE_MARGIN;
  if (free < required) {
    throw new Error(
      `Not enough disk space to stage the cloud image: need ${formatGb(required)} free at ${dir}, have ${formatGb(free)}`
    );
  }
}

/**
 * Resolve everything a restore of `uri` needs from the store: the root-first
 * chain (walking `baseImagePath` basenames through ranged header reads) plus
 * each member's `.NNN` continuation volumes, with sizes for the free-space
 * check and progress totals.
 */
export async function planCloudImageDownload(uri: string, store: RestoreCloudStore): Promise<CloudImagePlan> {
  const { dirUri, keyHint } = splitImageUri(uri);
  const objects = await store.listWithMeta();

  const keyByBasename = new Map<string, string>();
  for (const obj of objects) {
    if (/\.opbs$/i.test(obj.key)) {
      keyByBasename.set(obj.key.split('/').pop() ?? obj.key, obj.key);
    }
  }
  if (keyByBasename.size === 0) {
    throw new Error(`No .opbs images found at ${dirUri}`);
  }

  let targetKey: string | undefined;
  if (keyHint) {
    targetKey = keyByBasename.get(keyHint) ?? objects.find((o) => o.key === keyHint)?.key;
    if (!targetKey) {
      const available = [...keyByBasename.keys()].slice(0, 10).join(', ');
      throw new Error(`Image ${keyHint} not found at ${dirUri} (available: ${available})`);
    }
  } else if (keyByBasename.size === 1) {
    targetKey = [...keyByBasename.values()][0];
  } else {
    throw new Error(`Multiple images at ${dirUri}; specify the image file (…/${[...keyByBasename.keys()][0]})`);
  }

  // Walk the ancestor links back to the root, then reverse: root-first.
  const chainKeys: string[] = [];
  const seen = new Set<string>();
  let current = targetKey;
  while (true) {
    if (seen.has(current)) {
      throw new Error(`Circular incremental chain detected at ${current}`);
    }
    seen.add(current);
    chainKeys.unshift(current);
    const header = parseHeader(await store.getRange(current, 0, HEADER_SIZE));
    if (!(header.flags & FLAG_INCREMENTAL) || !header.baseImagePath) {
      break;
    }
    const baseName = path.basename(header.baseImagePath);
    const baseKey = keyByBasename.get(baseName);
    if (!baseKey) {
      throw new Error(`Base image ${baseName} of ${current} is not present at ${dirUri}`);
    }
    current = baseKey;
  }

  const sizeByKey = new Map(objects.map((o) => [o.key, o.size] as const));
  const files: CloudImagePlan['files'] = [];
  let totalBytes = 0;
  for (const key of chainKeys) {
    const size = sizeByKey.get(key) ?? 0;
    files.push({ key, destName: path.basename(key), size });
    totalBytes += size;
    // Multi-volume continuations live next to their base (`image.opbs.001`).
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const volumePattern = new RegExp(`^${escaped}\\.\\d{3}$`);
    for (const obj of objects) {
      if (volumePattern.test(obj.key)) {
        files.push({ key: obj.key, destName: path.basename(obj.key), size: obj.size });
        totalBytes += obj.size;
      }
    }
  }

  return { files, totalBytes, targetDestName: path.basename(targetKey) };
}

/**
 * Stage a cloud image for restore: plan the chain, verify free space, then
 * download every member into a fresh `opbs-restore-*` temp dir.
 *
 * `store` (already bound to the image's directory) may be injected — tests
 * and callers that built one from Settings profiles; otherwise a store is
 * created from the URI with `storeOptions` (env-var credentials for the CLI).
 * Throws after removing the partial temp dir if any download fails.
 */
export async function materializeImageFromCloud(
  uri: string,
  opts: {
    store?: RestoreCloudStore;
    storeOptions?: CloudStoreOptions;
    onProgress?: (progress: CloudDownloadProgress) => void;
    tempRoot?: string;
  } = {}
): Promise<StagedCloudImage> {
  if (!isCloudImageLocation(uri)) {
    throw new Error(`Not a cloud image location: ${uri}`);
  }
  const store = opts.store ?? (cloudStoreFromLocation(splitImageUri(uri).dirUri, opts.storeOptions ?? {}) as RestoreCloudStore);
  const plan = await planCloudImageDownload(uri, store);

  const tempRoot = opts.tempRoot ?? os.tmpdir();
  await ensureFreeSpace(tempRoot, plan.totalBytes);
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'opbs-restore-'));

  let bytesDone = 0;
  try {
    for (let i = 0; i < plan.files.length; i++) {
      const file = plan.files[i];
      const dest = path.join(tempDir, file.destName);
      await store.downloadFile(file.key, dest, (fileDone) => {
        opts.onProgress?.({
          file: file.destName,
          fileIndex: i + 1,
          fileCount: plan.files.length,
          fileBytesDone: fileDone,
          fileBytesTotal: file.size,
          bytesDone: bytesDone + Math.min(fileDone, file.size),
          bytesTotal: plan.totalBytes
        });
      });
      bytesDone += file.size;
    }
  } catch (error) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw error;
  }

  return {
    imagePath: path.join(tempDir, plan.targetDestName),
    tempDir,
    plan,
    cleanup(): void {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };
}
