import * as path from 'path';
import { parseHeader, HEADER_SIZE, FLAG_INCREMENTAL, FLAG_VERIFIED } from '../imaging/image-format';
import { planRetention, BackupImageEntry, RetentionOptions, RetentionPlan } from './retention';

/** Object-store surface shared by the S3 and SFTP backends. */
export interface CloudStore {
  listWithMeta(prefix?: string): Promise<Array<{ key: string; size: number }>>;
  getRange(key: string, offset: number, length: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/**
 * Retention/GFS planning over an object store prefix. Reads each `.opbs`
 * object's header (via a ranged GET) to build the image metadata, then reuses
 * the same chain + GFS policy as the local path. Incremental bases are matched
 * by basename so chains link across the stored object keys.
 */
export async function planRetentionS3(store: CloudStore, options: RetentionOptions): Promise<RetentionPlan> {
  const objects = await store.listWithMeta();
  const keyByBasename = new Map<string, string>();
  for (const obj of objects) {
    if (obj.key.endsWith('.opbs')) keyByBasename.set(obj.key.split('/').pop() ?? '', obj.key);
  }

  const entries: BackupImageEntry[] = [];
  for (const obj of objects) {
    if (!obj.key.endsWith('.opbs')) continue;
    const header = parseHeader(await store.getRange(obj.key, 0, HEADER_SIZE));
    const baseName = header.baseImagePath ? path.basename(header.baseImagePath) : '';
    entries.push({
      path: obj.key,
      name: obj.key.split('/').pop() ?? obj.key,
      timestamp: header.timestamp,
      size: obj.size,
      incremental: (header.flags & FLAG_INCREMENTAL) !== 0,
      baseImagePath: baseName ? keyByBasename.get(baseName) : undefined,
      encrypted: header.cipherId !== 0,
      verified: (header.flags & FLAG_VERIFIED) !== 0
    });
  }

  return planRetention(entries, options);
}

/** Apply retention to an object store prefix, deleting pruned objects (unless dry-run). */
export async function applyRetentionS3(store: CloudStore, options: RetentionOptions): Promise<RetentionPlan> {
  const plan = await planRetentionS3(store, options);
  if (!options.dryRun) {
    for (const entry of plan.prune) {
      await store.delete(entry.path);
    }
  }
  return plan;
}
