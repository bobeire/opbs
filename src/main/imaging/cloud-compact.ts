import * as fs from 'fs';
import * as path from 'path';
import { compactChain, type CompactOptions, type CompactResult } from './compact-engine';
import {
  materializeImageFromCloud,
  isCloudImageLocation,
  cloudDirUri,
  type StagedCloudImage
} from './cloud-restore';
import { cloudStoreFromLocation } from '../utils/cloud-store';
import { S3Store, resolveS3Config, buildObjectLock, type ObjectLockRequest } from '../utils/s3';
import { sidecarPathFor } from '../utils/bitlocker-capture';
import { logger } from '../utils/logger';

/**
 * Chain compaction against a cloud destination (`s3://`, `sftp://`, `ftp://`).
 *
 * The compaction writer opens local paths only, so a cloud chain is handled
 * like a cloud restore: stage the whole chain into a temp dir, compact
 * locally, then upload the compacted image into the same store prefix. With
 * `removeSource`, the old remote members are deleted only AFTER the upload
 * has been re-listed and size-verified — a failed upload never destroys the
 * live chain. Cloud directories that hold a repository journal are refused:
 * repository images compact through the repository, not this path.
 */

/**
 * Object-store surface this flow needs. `S3Store`, `SftpStore` and `FtpStore`
 * all satisfy it; tests inject an in-memory fake. Upload dispatches on
 * `putFile` (S3) then `uploadFile` (SFTP/FTP).
 */
export interface CompactCloudStore {
  listWithMeta(prefix?: string): Promise<Array<{ key: string; size: number }>>;
  getRange(key: string, offset: number, length: number): Promise<Buffer>;
  downloadFile(key: string, destPath: string, onProgress?: (bytes: number) => void): Promise<void>;
  delete(key: string): Promise<void>;
  putFile?(localPath: string, key: string, opts?: { objectLock?: ObjectLockRequest }): Promise<void>;
  uploadFile?(localPath: string, key: string): Promise<void>;
}

export interface CloudCompactOptions extends CompactOptions {
  /** Injected store for tests; otherwise built from the URI + `cloudStoreOptions`. */
  store?: CompactCloudStore;
}

/** Swap the basename of a store-relative key, keeping its directory. */
function withBasename(key: string, basename: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? basename : `${key.slice(0, slash + 1)}${basename}`;
}

/** Local files that make up the compacted output: base, `.NNN` volumes, BitLocker sidecar. */
function uploadSet(outPath: string): string[] {
  const files = [outPath];
  for (let i = 1; ; i++) {
    const vol = `${outPath}.${String(i).padStart(3, '0')}`;
    if (!fs.existsSync(vol)) break;
    files.push(vol);
  }
  const sidecar = sidecarPathFor(outPath);
  if (fs.existsSync(sidecar)) files.push(sidecar);
  return files;
}

async function uploadOne(
  store: CompactCloudStore,
  localPath: string,
  key: string,
  objectLock?: ObjectLockRequest
): Promise<void> {
  if (store.putFile) {
    await store.putFile(localPath, key, objectLock ? { objectLock } : undefined);
  } else if (store.uploadFile) {
    await store.uploadFile(localPath, key);
  } else {
    throw new Error('cloud store cannot upload');
  }
}

export async function compactCloudChain(options: CloudCompactOptions): Promise<CompactResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const uri = options.imagePath;
  const dirUri = cloudDirUri(uri);

  const fail = (error: string): CompactResult => ({
    ok: false,
    error,
    dryRun: !!options.dryRun,
    plan: { members: [], uniqueBlocks: 0, uniqueRawBytes: 0, estimatedOutputBytes: 0, encrypted: false },
    durationMs: Date.now() - started,
    warnings
  });

  if (!isCloudImageLocation(uri)) {
    return fail(`Not a cloud image location: ${uri}`);
  }
  if (options.outputPath && isCloudImageLocation(options.outputPath)) {
    return fail('the compacted output must be written to a local path before upload');
  }

  let store = options.store;
  let objectLock: ObjectLockRequest | undefined;
  if (!store) {
    store = cloudStoreFromLocation(dirUri, options.cloudStoreOptions ?? {}) as CompactCloudStore;
    if (dirUri.startsWith('s3://')) {
      const profile =
        options.cloudStoreOptions?.s3Profile ??
        (options.cloudStoreOptions?.region !== undefined ? { region: options.cloudStoreOptions.region } : undefined);
      objectLock = buildObjectLock(resolveS3Config(profile, dirUri));
    }
  }

  // Refuse repository-backed directories before spending bandwidth on a
  // staging download: the journal must stay the only writer there.
  let listedKeys: Set<string>;
  try {
    const listing = await store.listWithMeta();
    listedKeys = new Set(listing.map((o) => o.key));
    if (listedKeys.has('opbs-repo.json')) {
      return fail(
        'this cloud directory holds a repository journal; repository images compact through the repository (not supported for cloud mirrors yet)'
      );
    }
  } catch (e) {
    return fail(`could not list the cloud directory: ${e instanceof Error ? e.message : String(e)}`);
  }

  // An SFTP/FTP/S3-hosted repository keeps its journal one level above the
  // `images/` dir — probe there too (injected test stores cover the flat
  // layout above and skip this network probe).
  if (!options.store && /\/images\/?$/i.test(dirUri)) {
    const parentUri = dirUri.replace(/\/images\/?$/i, '');
    try {
      const parentStore = cloudStoreFromLocation(parentUri, options.cloudStoreOptions ?? {}) as CompactCloudStore;
      await parentStore.getRange('opbs-repo.json', 0, 1);
      return fail(
        'this cloud images/ directory belongs to a repository; repository images compact through the repository (not supported for cloud mirrors yet)'
      );
    } catch {
      /* no journal above — a normal backup prefix */
    }
  }

  let staged: StagedCloudImage | undefined;
  try {
    // Stage (download) the whole chain — same pattern as a cloud restore.
    // Cancellation is honoured by the local compact below, not mid-download.
    staged = await materializeImageFromCloud(uri, {
      store,
      onProgress: (p) =>
        options.onProgress?.({
          phase: 'staging',
          percent: p.bytesTotal > 0 ? Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 0,
          blocksDone: 0,
          blocksTotal: 0,
          bytesDone: p.bytesDone,
          totalBytes: p.bytesTotal,
          createdAt: Date.now()
        })
    });

    // Compact locally. Staged files are temp files: remove-source is handled
    // remotely below, and repository options cannot apply inside the temp dir.
    const localResult = await compactChain({
      ...options,
      imagePath: staged.imagePath,
      removeSource: false,
      repoKey: undefined,
      s3Profile: undefined
    });
    const targetKeyOf = (name: string): string => withBasename(staged!.targetKey, name);
    if (!localResult.ok || options.dryRun) {
      // Report where the compacted image WOULD land remotely; the local temp
      // path is gone once staging cleans up.
      const remoteOutput = localResult.outputPath
        ? `${dirUri}/${targetKeyOf(path.basename(localResult.outputPath))}`
        : undefined;
      return {
        ...localResult,
        outputPath: remoteOutput,
        durationMs: Date.now() - started,
        warnings: [...localResult.warnings, ...warnings]
      };
    }

    const outPath = localResult.outputPath!;
    const remoteOutput = `${dirUri}/${targetKeyOf(path.basename(outPath))}`;

    // Upload the compacted image (base + any side volumes + BitLocker sidecar)
    // under the chain's prefix. On failure, drop the partial uploads — the old
    // chain is still intact.
    const uploads: Array<{ key: string; localPath: string; size: number }> = [];
    for (const localFile of uploadSet(outPath)) {
      uploads.push({
        key: targetKeyOf(path.basename(localFile)),
        localPath: localFile,
        size: fs.statSync(localFile).size
      });
    }
    const uploadedKeys: string[] = [];
    try {
      for (const file of uploads) {
        await uploadOne(store, file.localPath, file.key, objectLock);
        uploadedKeys.push(file.key);
      }
    } catch (e) {
      for (const key of uploadedKeys) {
        try {
          await store.delete(key);
        } catch {
          /* best-effort rollback */
        }
      }
      return fail(`could not upload the compacted image: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Verify the upload by re-listing: a size mismatch must stop the prune.
    try {
      const after = await store.listWithMeta();
      const sizeByKey = new Map(after.map((o) => [o.key, o.size] as const));
      const bad = uploads.find((f) => sizeByKey.get(f.key) !== f.size);
      if (bad) {
        throw new Error(`${bad.key} is ${sizeByKey.get(bad.key) ?? 'missing'}, expected ${bad.size} bytes`);
      }
    } catch (e) {
      for (const key of uploadedKeys) {
        try {
          await store.delete(key);
        } catch {
          /* best-effort rollback */
        }
      }
      return fail(`uploaded compacted image failed verification: ${e instanceof Error ? e.message : String(e)}`);
    }

    // remove-source: delete the old remote members newest-first (deltas
    // before their bases), stopping at the first failure like the local flow.
    const sourcesRemoved: string[] = [];
    if (options.removeSource) {
      for (const file of [...staged.plan.files].reverse()) {
        try {
          await store.delete(file.key);
        } catch (e) {
          warnings.push(
            `could not remove cloud source ${file.key}: ${e instanceof Error ? e.message : String(e)} — removal stopped`
          );
          break;
        }
        sourcesRemoved.push(`${dirUri}/${file.key}`);
        // A BitLocker key sidecar uploaded beside the member goes with it,
        // but only when it actually exists in the store.
        const sidecarKey = `${file.key}.bitlocker.json`;
        if (listedKeys.has(sidecarKey)) {
          try {
            await store.delete(sidecarKey);
          } catch {
            /* best-effort — the image itself is already gone */
          }
        }
      }
    }

    logger.info(
      `compact(cloud): ${staged.plan.files.length} member(s) -> ${remoteOutput}` +
        (sourcesRemoved.length ? `, removed ${sourcesRemoved.length} source(s)` : '')
    );
    return {
      ...localResult,
      ok: true,
      outputPath: remoteOutput,
      durationMs: Date.now() - started,
      warnings: [...localResult.warnings, ...warnings],
      ...(sourcesRemoved.length ? { sourcesRemoved } : {})
    };
  } finally {
    staged?.cleanup();
  }
}
