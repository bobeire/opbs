import { NtfsLayout, parseBootSector, readNtfsBitmap, readFileRecords, type DataRun, type NtfsFile } from './ntfs';
import type { PartitionReader } from '../image-browse';

/**
 * Filesystem-level consistency: does the allocation map agree with what the
 * files actually claim?
 *
 * Block verification cannot answer this. The 2026-11-03 field report produced
 * images where every block passed its checksum and the filesystem those blocks
 * formed was corrupt — chkdsk's complaint was `clusters allocated to file X
 * ... marked as free`, because the bitmap and the file records had been
 * captured moments apart. This is the check that sees that.
 *
 * Design rule: **tolerate everything, flag only the specific contradiction.**
 * Real NTFS has attribute lists, sparse runs, compressed streams, resident
 * data and hard links, and a checker that cries wolf on healthy volumes is
 * worth less than no checker — it teaches people to ignore it. So:
 *
 *   - `claimedButFree`   — a file's non-sparse run covers a cluster the
 *     bitmap calls free. This is exactly chkdsk's error, and there is no
 *     legitimate version of it.
 *   - `doubleClaimed`    — two different records claim the same cluster.
 *     Also unambiguous.
 *   - `unreferenced`     — allocated in the bitmap, claimed by no file we
 *     could parse. INFORMATIONAL ONLY, never a failure: $MFTMirr, extension
 *     records we could not resolve, and anything we failed to read all land
 *     here legitimately.
 *
 * Anything unusual is skipped rather than flagged. A run past the end of the
 * map, a sparse run, a record that is not in use: all ignored.
 */

export interface ConsistencyIssue {
  /** First cluster of the offending run (for locating it). */
  cluster: number;
  clusterCount: number;
  /** Which file claimed it, when we know. */
  recordNumber?: number;
  label?: string;
}

export interface ConsistencyReport {
  ok: boolean;
  clusterSize: number;
  totalClusters: number;
  /** Records we managed to parse and walk. */
  recordsChecked: number;
  /** The serious signals. `ok` is false when either is non-empty. */
  claimedButFree: ConsistencyIssue[];
  doubleClaimed: ConsistencyIssue[];
  /** Informational. Never makes `ok` false. */
  unreferencedClusterCount: number;
  /** Set when the check could not run to completion. */
  truncated?: string;
}

/** How many issues we report before summarising the rest. */
const MAX_ISSUES = 50;

/**
 * Check an NTFS volume's allocation map against its file runlists.
 * Never throws: a volume we cannot parse is a report with `truncated` set,
 * not a crash and not a pass.
 */
export function checkNtfsConsistency(reader: PartitionReader): ConsistencyReport {
  const empty = (clusterSize: number, totalClusters: number, truncated?: string): ConsistencyReport => ({
    ok: true,
    clusterSize,
    totalClusters,
    recordsChecked: 0,
    claimedButFree: [],
    doubleClaimed: [],
    unreferencedClusterCount: 0,
    ...(truncated ? { truncated } : {})
  });

  let layout: NtfsLayout;
  try {
    const bpb = reader.read(0, 512);
    if (bpb.toString('ascii', 3, 11) !== 'NTFS    ') {
      return empty(0, 0, 'not an NTFS volume');
    }
    layout = parseBootSector(reader);
  } catch (error) {
    return empty(0, 0, `boot sector unreadable: ${error instanceof Error ? error.message : error}`);
  }

  let bitmapBytes: Buffer;
  let totalClusters: number;
  try {
    const bitmap = readNtfsBitmap(reader, layout);
    bitmapBytes = bitmap.bitmapBytes;
    totalClusters = bitmap.totalClusters;
  } catch (error) {
    return empty(layout.clusterSize, 0, `$Bitmap unreadable: ${error instanceof Error ? error.message : error}`);
  }
  if (totalClusters <= 0) {
    return empty(layout.clusterSize, 0, 'allocation map is empty');
  }

  const isFree = (cluster: number): boolean => {
    if (cluster < 0 || cluster >= totalClusters) return false; // outside the map: no verdict
    const byte = cluster >> 3;
    if (byte >= bitmapBytes.length) return true;
    return (bitmapBytes[byte] & (1 << (cluster & 7))) === 0;
  };

  // claimedBy[cluster] = record number that claimed it, for double-claim
  // detection. A Map rather than an array: most volumes have far fewer
  // claimed clusters than totalClusters in the cases we care about.
  const claimedBy = new Map<number, number>();
  const claimedButFree: ConsistencyIssue[] = [];
  const doubleClaimed: ConsistencyIssue[] = [];

  let records: NtfsFile[];
  try {
    records = readFileRecords(reader, layout);
  } catch (error) {
    return empty(layout.clusterSize, totalClusters, `$MFT unreadable: ${error instanceof Error ? error.message : error}`);
  }

  const addIssue = (list: ConsistencyIssue[], issue: ConsistencyIssue): void => {
    if (list.length < MAX_ISSUES) list.push(issue);
  };

  let recordsChecked = 0;
  for (const file of records) {
    // Skip anything we should not reason about.
    if (!file.inUse) continue;
    const runs: DataRun[] = file.dataRuns ?? [];
    if (runs.length === 0) continue; // resident data claims no clusters
    recordsChecked++;

    for (const run of runs) {
      // Sparse runs claim nothing; compressed and zero-length runs are
      // skipped too — anything we are not certain about is not flagged.
      if (run.sparse) continue;
      const length = Number(run.runLength);
      const start = Number(run.startLcn);
      if (!Number.isFinite(length) || !Number.isFinite(start) || length <= 0) continue;

      const end = Math.min(start + length, totalClusters);
      for (let cluster = Math.max(0, start); cluster < end; cluster++) {
        const other = claimedBy.get(cluster);
        if (other !== undefined && other !== file.recordNumber) {
          addIssue(doubleClaimed, {
            cluster,
            clusterCount: 1,
            recordNumber: file.recordNumber,
            label: `also claimed by record ${other}`
          });
          continue;
        }
        claimedBy.set(cluster, file.recordNumber);
        if (isFree(cluster)) {
          addIssue(claimedButFree, {
            cluster,
            clusterCount: 1,
            recordNumber: file.recordNumber,
            label: file.name?.name
          });
        }
      }
    }
  }

  // Informational: allocated in the map, claimed by nothing we walked.
  let unreferencedClusterCount = 0;
  for (let cluster = 0; cluster < totalClusters; cluster++) {
    if (!isFree(cluster) && !claimedBy.has(cluster)) unreferencedClusterCount++;
  }

  return {
    ok: claimedButFree.length === 0 && doubleClaimed.length === 0,
    clusterSize: layout.clusterSize,
    totalClusters,
    recordsChecked,
    claimedButFree,
    doubleClaimed,
    unreferencedClusterCount
  };
}

/**
 * Check one partition of an image file. Builds the reader from the image
 * chain, so verification can answer "is this filesystem consistent?" without
 * restoring anything first.
 *
 * Returns null when the partition is not NTFS or cannot be read — callers
 * report that as "not checked", never as "fine".
 */
export function checkImageConsistency(
  imagePath: string,
  partitionIndex: number,
  passphrase?: string
): ConsistencyReport | null {
  try {
    // Lazy imports: this module is also used from the helper, where the image
    // readers must not be pulled in eagerly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { baseVolumePath, resolveImageChain } = require('../image-format') as typeof import('../image-format');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { partitionReaderForChain } = require('../image-browse') as typeof import('../image-browse');
    const chain = resolveImageChain(baseVolumePath(imagePath));
    const { reader } = partitionReaderForChain(chain, partitionIndex, passphrase);
    return checkNtfsConsistency(reader);
  } catch {
    return null;
  }
}

/**
 * The summary line. `claimedButFree` is the chkdsk error a tester saw, so the
 * wording matches it rather than inventing new vocabulary.
 */
export function describeConsistency(report: ConsistencyReport): string {
  if (report.truncated) {
    return `Filesystem consistency could not be checked (${report.truncated}).`;
  }
  if (report.ok) {
    return (
      `Filesystem consistency: OK — ${report.recordsChecked} file record(s) agree with the ` +
      `allocation map${report.unreferencedClusterCount > 0 ? ` (${report.unreferencedClusterCount} allocated cluster(s) claimed by no file we could parse, which is usually metadata we do not walk)` : ''}.`
    );
  }
  const parts: string[] = [];
  if (report.claimedButFree.length > 0) {
    parts.push(
      `${report.claimedButFree.length} cluster(s) are allocated to a file but marked free in the ` +
        `allocation map — the same error chkdsk reports as "clusters allocated to file ... marked as free"`
    );
  }
  if (report.doubleClaimed.length > 0) {
    parts.push(`${report.doubleClaimed.length} cluster(s) are claimed by more than one file`);
  }
  return `Filesystem consistency FAILED: ${parts.join('; ')}. The image is internally inconsistent and should not be relied on.`;
}
