import * as path from 'path';
import { S3Store, resolveS3Config, type S3Config } from '../utils/s3';

/**
 * S3 mirror for repository images.
 *
 * A repository can declare `remote: { uri, lockMode? }` in its header (set at
 * `repo init --remote s3://…`). The header + journal stay local (rollback is
 * covered by the off-box anchor); the image volumes are mirrored to
 * `<uri>/images/<name>` while they are journaled, optionally with S3 Object
 * Lock retention for exactly the journal's lock window — so even an admin on
 * the backup machine cannot delete or modify the image data in S3 before the
 * lock expires (true WORM for the valuable bytes).
 *
 * Ordering rules:
 *  - create: upload BEFORE the journal append — a failed upload never leaves
 *    a journaled image without its remote copy;
 *  - prune: delete the remote copy BEFORE the local files — an Object-Lock
 *    refusal (retention not yet expired) keeps the image fully intact.
 *
 * Credentials never live in the header: `resolveS3Config` fills them from the
 * settings profile (GUI) or `AWS_*` environment variables (CLI/scheduler).
 */

export interface RepoRemoteConfig {
  uri: string;
  /** Object Lock mode for mirrored volumes; omit to mirror without locking. */
  lockMode?: 'GOVERNANCE' | 'COMPLIANCE';
}

export interface RemoteVolume {
  name: string;
  size: number;
}

export type RemoteFinding =
  | { kind: 'missing'; name: string; detail: string }
  | { kind: 'size'; name: string; detail: string };

const IMAGES_PREFIX = 'images/';

export function remoteStore(remote: RepoRemoteConfig, profile?: Partial<S3Config>): S3Store {
  if (!/^s3:\/\//i.test(remote.uri)) {
    throw new Error(`Repository mirror must be an s3:// location: ${remote.uri}`);
  }
  return new S3Store(resolveS3Config(profile, remote.uri));
}

/** Upload every volume to `<uri>/images/<name>`, locking when configured. */
export async function uploadRemoteVolumes(
  store: S3Store,
  remote: RepoRemoteConfig,
  volumes: RemoteVolume[],
  localImagesDir: string,
  retainUntil?: string
): Promise<void> {
  // A zero lock window means the journal itself records no lock — mirror the
  // bytes without Object Lock retention rather than writing a past date.
  const objectLock = remote.lockMode && retainUntil ? { mode: remote.lockMode, retainUntil } : undefined;
  for (const volume of volumes) {
    await store.putFile(path.join(localImagesDir, volume.name), `${IMAGES_PREFIX}${volume.name}`, { objectLock });
  }
}

/**
 * Delete mirrored volumes. S3 refuses deletes of Object-Locked objects
 * before their retention expires — surface that with a clear message so
 * `repo prune` can abort while the local image stays intact.
 */
export async function deleteRemoteVolumes(store: S3Store, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await store.delete(`${IMAGES_PREFIX}${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/AccessDenied|ObjectLock|retention|Locked|HTTP 40[39]/i.test(message)) {
        throw new Error(
          `S3 mirror refused to delete images/${name} — Object Lock retention has not expired yet: ${message}`,
          { cause: error }
        );
      }
      throw new Error(`Failed to delete images/${name} from the S3 mirror: ${message}`, { cause: error });
    }
  }
}

/**
 * Object name → size for every volume under a repository's `images/` prefix
 * (one ListObjectsV2, no downloads).
 */
export async function listRemoteVolumes(store: S3Store): Promise<Map<string, number>> {
  const listed = await store.listWithMeta(store.resolveKey(IMAGES_PREFIX));
  const sizes = new Map<string, number>();
  for (const item of listed) {
    const name = item.key.startsWith(IMAGES_PREFIX) ? item.key.slice(IMAGES_PREFIX.length) : item.key;
    if (name) sizes.set(name, item.size);
  }
  return sizes;
}

/**
 * Presence + size check of the mirrored volumes (cheap: one ListObjectsV2,
 * no downloads — the local copies remain the hash-verified originals, and
 * the mirror is protected by Object Lock rather than by re-hashing).
 */
export async function checkRemoteVolumes(
  store: S3Store,
  volumes: RemoteVolume[]
): Promise<RemoteFinding[]> {
  const sizes = await listRemoteVolumes(store);
  const findings: RemoteFinding[] = [];
  for (const volume of volumes) {
    const size = sizes.get(volume.name);
    if (size === undefined) {
      findings.push({ kind: 'missing', name: volume.name, detail: `S3 mirror copy missing: ${volume.name}` });
    } else if (size !== volume.size) {
      findings.push({
        kind: 'size',
        name: volume.name,
        detail: `S3 mirror ${volume.name}: size ${size}, journal says ${volume.size}`
      });
    }
  }
  return findings;
}
