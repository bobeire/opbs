import * as fs from 'fs';
import * as path from 'path';
import { scanBackupDirectory, groupIntoChains, RetentionChain } from './retention';

/**
 * Chain integrity analysis: a chain (full image + its deltas) is only restorable
 * if every delta's base image is still present. A delta whose base was pruned
 * or deleted silently (e.g. by ransomware) turns into a chain rooted at that
 * orphaned delta — this module surfaces exactly that so a broken chain is caught
 * before it is needed for a restore.
 */

export interface ChainHealthStatus {
  rootName: string;
  rootPath: string;
  /** The chain root is itself an incremental whose base image is missing. */
  orphaned: boolean;
  /** Every delta in the chain links back to a present base image. */
  complete: boolean;
  itemCount: number;
  oldestTimestamp: number;
  newestTimestamp: number;
  /** For orphaned chains: the basename of the referenced-but-missing base. */
  missingBaseName?: string;
  /** Name of the full (base) image in the chain, when one exists. */
  fullImageName?: string;
}

export interface MissingBase {
  /** Incremental image whose base cannot be resolved. */
  imageName: string;
  /** The absolute base path recorded in the incremental's header. */
  basePath: string;
}

export interface ChainHealthReport {
  directory: string;
  chainCount: number;
  completeChains: number;
  brokenChains: number;
  chains: ChainHealthStatus[];
  /** Incrementals whose referenced base is not present in the directory. */
  missingBases: MissingBase[];
  /** `.opbs` files that exist but could not be parsed as images. */
  unparseableImages: string[];
}

export function missingBaseFor(root: RetentionChain['root']): MissingBase | undefined {
  if (root.incremental && root.baseImagePath) {
    return { imageName: root.name, basePath: root.baseImagePath };
  }
  return undefined;
}

export function buildChainHealthReport(dir: string): ChainHealthReport {
  const entries = scanBackupDirectory(dir);
  const chains = groupIntoChains(entries);

  const statuses: ChainHealthStatus[] = [];
  const missingBases: MissingBase[] = [];
  let completeChains = 0;
  let brokenChains = 0;

  for (const chain of chains) {
    const root = chain.root;
    const missing = missingBaseFor(root);
    const orphaned = missing !== undefined && !chain.complete;
    const fullImage = chain.items.find((i) => !i.incremental);

    statuses.push({
      rootName: root.name,
      rootPath: root.path,
      orphaned,
      complete: chain.complete,
      itemCount: chain.items.length,
      oldestTimestamp: Math.min(...chain.items.map((i) => i.timestamp)),
      newestTimestamp: chain.newestTimestamp,
      missingBaseName: missing ? path.basename(missing.basePath) : undefined,
      fullImageName: fullImage?.name
    });

    if (chain.complete) {
      completeChains++;
    } else {
      brokenChains++;
      if (missing) {
        missingBases.push(missing);
      }
    }
  }

  const known = new Set(entries.map((e) => e.name));
  const unparseableImages: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.opbs') && !known.has(name)) {
      unparseableImages.push(name);
    }
  }

  return {
    directory: dir,
    chainCount: chains.length,
    completeChains,
    brokenChains,
    chains: statuses,
    missingBases,
    unparseableImages
  };
}