import * as fs from 'fs';
import * as path from 'path';
import { scanBackupDirectory, groupIntoChains } from '../backup/retention';
import { readImageInfo, FLAG_INCREMENTAL } from '../imaging/image-format';

export interface BackupAnalyticsEntry {
  imagePath: string;
  timestamp: number;
  totalBytes: number;
  bytesWritten: number;
  blocksWritten: number;
  totalBlocks: number;
  skippedBlocks: number;
  incremental: boolean;
  compressionRatio: number;
  durationMs: number;
  speedMBs: number;
}

export interface ChainInsight {
  chainPath: string[];
  totalDiskBytes: number;
  totalImageBytes: number;
  uniqueBlocks: number;
  totalBlocksAcrossImages: number;
  chainEfficiency: number;
  avgCompressionRatio: number;
  estimatedRestoreTimeSec: number;
  oldestTimestamp: number;
  newestTimestamp: number;
  fullCount: number;
  deltaCount: number;
}

export interface AnalyticsSummary {
  directory: string;
  imageCount: number;
  chainCount: number;
  totalDiskBytes: number;
  totalImageBytes: number;
  avgCompressionRatio: number;
  chains: ChainInsight[];
}

const ANALYTICS_FILE = 'opbs-analytics.json';

function analyticsPath(dir: string): string {
  return path.join(dir, ANALYTICS_FILE);
}

export function readAnalytics(dir: string): BackupAnalyticsEntry[] {
  try {
    const data = fs.readFileSync(analyticsPath(dir), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordAnalytics(dir: string, entry: BackupAnalyticsEntry): void {
  const entries = readAnalytics(dir);
  // Replace any existing entry for the same image path.
  const filtered = entries.filter((e) => e.imagePath !== entry.imagePath);
  filtered.push(entry);
  filtered.sort((a, b) => b.timestamp - a.timestamp);
  try {
    fs.writeFileSync(analyticsPath(dir), JSON.stringify(filtered, null, 2), 'utf-8');
  } catch {
    /* best-effort: destination may be offline */
  }
}

/**
 * Compute chain-level insights from image headers. Chains are passed
 * oldest-first (full image first, then its deltas). The logical disk the
 * chain captures is defined by the root full image.
 */
function computeChainInsight(chainPaths: string[]): ChainInsight | null {
  if (chainPaths.length === 0) return null;

  let diskTotalBytes = 0;
  let blockSize = 0;
  let totalImageBytes = 0;
  let totalBlocksAcrossImages = 0;
  const seenBlocks = new Set<number>();
  let fullCount = 0;
  let deltaCount = 0;
  let oldestTimestamp = Infinity;
  let newestTimestamp = 0;

  for (const imagePath of chainPaths) {
    try {
      const info = readImageInfo(imagePath);
      const stat = fs.statSync(imagePath);

      totalImageBytes += stat.size;
      totalBlocksAcrossImages += info.blocks.length;

      for (const block of info.blocks) {
        seenBlocks.add(block.blockIndex);
      }

      if (info.header.flags & FLAG_INCREMENTAL) {
        deltaCount++;
      } else {
        fullCount++;
        // The logical disk size comes from the root full image.
        diskTotalBytes = info.header.totalBytes;
        blockSize = info.header.blockSize;
      }

      const ts = info.header.timestamp ?? 0;
      if (ts > 0 && ts < oldestTimestamp) oldestTimestamp = ts;
      if (ts > newestTimestamp) newestTimestamp = ts;
    } catch {
      // Image may be corrupt or missing — skip
    }
  }

  if (diskTotalBytes === 0) return null;

  const uniqueBytes = seenBlocks.size * blockSize;
  // Fraction of the logical disk still covered by unique blocks (churn-aware).
  const chainEfficiency = diskTotalBytes > 0 ? uniqueBytes / diskTotalBytes : 0;
  // Storage factor of the chain's unique content against what is on disk.
  const avgCompressionRatio = totalImageBytes > 0 && uniqueBytes > 0 ? uniqueBytes / totalImageBytes : 1;
  // Restore speed estimate: assume ~200 MB/s sequential read + decompress
  const estimatedRestoreTimeSec = totalImageBytes / (200 * 1024 * 1024);

  return {
    chainPath: chainPaths,
    totalDiskBytes: diskTotalBytes,
    totalImageBytes,
    uniqueBlocks: seenBlocks.size,
    totalBlocksAcrossImages,
    chainEfficiency,
    avgCompressionRatio,
    estimatedRestoreTimeSec,
    oldestTimestamp,
    newestTimestamp,
    fullCount,
    deltaCount
  };
}

/**
 * Compute analytics for all chains in a backup directory.
 */
export function computeAnalytics(dir: string): AnalyticsSummary {
  const entries = scanBackupDirectory(dir);
  const chains = groupIntoChains(entries);

  let totalDiskBytes = 0;
  let totalImageBytes = 0;
  let totalCompressionNum = 0;
  let totalCompressionDen = 0;

  const chainInsights: ChainInsight[] = [];

  for (const chain of chains) {
    // Chains are ordered newest-first; reverse for processing oldest-first
    const sortedPaths = [...chain.items]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((e) => e.path);

    const insight = computeChainInsight(sortedPaths);
    if (insight) {
      chainInsights.push(insight);
      totalDiskBytes += insight.totalDiskBytes;
      totalImageBytes += insight.totalImageBytes;
      totalCompressionNum += insight.chainEfficiency * insight.totalDiskBytes;
      totalCompressionDen += insight.totalImageBytes;
    }
  }

  return {
    directory: dir,
    imageCount: entries.length,
    chainCount: chains.length,
    totalDiskBytes,
    totalImageBytes,
    avgCompressionRatio: totalCompressionDen > 0 ? totalCompressionNum / totalCompressionDen : 1,
    chains: chainInsights
  };
}

/**
 * After a successful backup, record the analytics entry for the new image.
 */
export function recordBackupAnalytics(
  dir: string,
  imagePath: string,
  result: {
    totalBytes: number;
    bytesWritten: number;
    blocksWritten: number;
    skippedBlocks?: number;
    incremental?: boolean;
    durationMs: number;
  }
): void {
  const totalBlocks = (() => {
    try {
      return readImageInfo(imagePath).blocks.length;
    } catch {
      return result.blocksWritten;
    }
  })();

  const compressionRatio = result.bytesWritten > 0 ? result.totalBytes / result.bytesWritten : 1;
  const speedMBs = result.durationMs > 0 ? result.bytesWritten / (result.durationMs / 1000) / (1024 * 1024) : 0;

  recordAnalytics(dir, {
    imagePath: path.resolve(imagePath),
    timestamp: Date.now(),
    totalBytes: result.totalBytes,
    bytesWritten: result.bytesWritten,
    blocksWritten: result.blocksWritten,
    totalBlocks,
    skippedBlocks: result.skippedBlocks ?? 0,
    incremental: result.incremental ?? false,
    compressionRatio,
    durationMs: result.durationMs,
    speedMBs
  });
}
