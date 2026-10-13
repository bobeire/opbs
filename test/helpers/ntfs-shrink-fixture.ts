import { buildFileRecord, standardInfo, fileNameAttr } from './ntfs-fixture';
import { PartitionReader } from '../../src/main/imaging/image-browse';
import { DataRun } from '../../src/main/imaging/fs/ntfs';
import { NtfsShrinkPlan } from '../../src/main/imaging/fs/ntfs-shrink';

export const SK_SECTOR = 512;
export const SK_CLUSTER = 4096;
export const SK_SPC = SK_CLUSTER / SK_SECTOR;
export const SK_TOTAL_CLUSTERS = 1024; // 4 MiB volume
export const SK_MFT_LCN = 4;
export const SK_MFT_CLUSTERS = 12; // records 0..47
export const SK_MFT_RECORDS = (SK_MFT_CLUSTERS * SK_CLUSTER) / 1024;
export const SK_MIRROR_LCN = 16;
export const SK_BITMAP_LCN = 3;
export const SK_TARGET_CLUSTERS = 640;
export const SK_TARGET_SECTORS = SK_TARGET_CLUSTERS * SK_SPC;
/** used (18 clusters) + 1 MiB margin, 1 MiB-aligned. */
export const SK_MIN_TARGET_CLUSTERS = 512;
export const SK_USER_LCN = 900;
export const SK_USER_CLUSTERS = 4;
export const SK_USER_RECORD = 16;

/** Deterministic per-cluster filler so relocated data can be verified. */
export function clusterPattern(lcn: number): Buffer {
  const b = Buffer.alloc(SK_CLUSTER);
  for (let i = 0; i < SK_CLUSTER; i++) b[i] = (lcn * 31 + i * 7) & 0xff;
  return b;
}

export interface ShrinkUserRun {
  recordNumber: number;
  startLcn: number;
  runLength: number;
}

export interface ShrinkFixtureOpts {
  /** User DATA runs (default: record 16 at LCN 900, 4 clusters). */
  userRuns?: ShrinkUserRun[];
  /** Below-boundary user runs that stay put during the shrink. */
  stayingRuns?: ShrinkUserRun[];
  /** Bitmap bits to clear after normal marking (disagreement tests). */
  bitmapClear?: Array<{ start: number; count: number }>;
  /** Override $BadClus's unnamed $DATA run (default: one sparse run). */
  badClusRun?: DataRun;
  /** Record 17: compressed $DATA above the boundary. */
  compressedUser?: boolean;
  /** Record 17: $EFS-encrypted record with $DATA above the boundary. */
  efsUser?: boolean;
  /** Record 17: ATTRIBUTE_LIST record with $DATA above the boundary. */
  attributeListUser?: boolean;
}

/** A synthetic NTFS volume laid out for shrink tests: system records low,
 *  user data at the tail (LCN 900+), free space in between. */
export function buildShrinkVolumeData(opts?: ShrinkFixtureOpts): Buffer {
  const totalClusters = SK_TOTAL_CLUSTERS;
  const userRuns: ShrinkUserRun[] = opts?.userRuns ?? [
    { recordNumber: SK_USER_RECORD, startLcn: SK_USER_LCN, runLength: SK_USER_CLUSTERS }
  ];
  const stayingRuns = opts?.stayingRuns ?? [];
  const badClusRun: DataRun = opts?.badClusRun ?? {
    startLcn: 0,
    runLength: totalClusters,
    sparse: true
  };
  const buf = Buffer.alloc(totalClusters * SK_CLUSTER);

  // Boot sector (canonical NTFS offsets).
  buf.write('NTFS    ', 3, 'ascii');
  buf.writeUInt16LE(SK_SECTOR, 0x0b);
  buf.writeUInt8(SK_SPC, 0x0d);
  buf.writeUInt8(0xf8, 0x15);
  buf.writeBigUInt64LE(BigInt(totalClusters * SK_SPC), 0x28);
  buf.writeBigUInt64LE(BigInt(SK_MFT_LCN), 0x30);
  buf.writeBigUInt64LE(BigInt(SK_MIRROR_LCN), 0x38);
  buf.writeInt8(-10, 0x40); // 1024-byte file record

  const mftBase = SK_MFT_LCN * SK_CLUSTER;
  const bitmapBytes = Math.ceil(totalClusters / 8);

  const rec0 = buildFileRecord(0, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(1000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFT', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: [{ startLcn: SK_MFT_LCN, runLength: SK_MFT_CLUSTERS }],
        realSize: SK_MFT_CLUSTERS * SK_CLUSTER
      }
    ]
  });
  rec0.copy(buf, mftBase);

  const rec1 = buildFileRecord(1, {
    inUse: true,
    attrs: [
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFTMirr', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: [{ startLcn: SK_MIRROR_LCN, runLength: 1 }],
        realSize: SK_CLUSTER
      }
    ]
  });
  rec1.copy(buf, mftBase + 1 * 1024);

  const rec6 = buildFileRecord(6, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(3000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$Bitmap', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: [{ startLcn: SK_BITMAP_LCN, runLength: 1 }],
        realSize: bitmapBytes
      }
    ]
  });
  rec6.copy(buf, mftBase + 6 * 1024);

  const rec8 = buildFileRecord(8, {
    inUse: true,
    attrs: [
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$BadClus', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: [badClusRun],
        realSize: totalClusters * SK_CLUSTER
      }
    ]
  });
  rec8.copy(buf, mftBase + 8 * 1024);

  const userRecord = (recordNumber: number, run: ShrinkUserRun): void => {
    const rec = buildFileRecord(recordNumber, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(4000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, `file${recordNumber}.bin`, 1) },
        {
          type: 0x80,
          nonResident: true,
          runs: [{ startLcn: run.startLcn, runLength: run.runLength }],
          realSize: run.runLength * SK_CLUSTER
        }
      ]
    });
    rec.copy(buf, mftBase + recordNumber * 1024);
    for (let c = 0; c < run.runLength; c++) {
      clusterPattern(run.startLcn + c).copy(buf, (run.startLcn + c) * SK_CLUSTER);
    }
  };
  for (const run of userRuns) userRecord(run.recordNumber, run);
  for (const run of stayingRuns) userRecord(run.recordNumber, run);

  if (opts?.compressedUser || opts?.efsUser || opts?.attributeListUser) {
    const attrs: Array<{ type: number; nonResident: boolean; resident?: Buffer; runs?: DataRun[]; realSize?: number }> = [
      { type: 0x10, nonResident: false, resident: standardInfo(5000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'special.bin', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: [{ startLcn: 905, runLength: 2 }],
        realSize: 2 * SK_CLUSTER
      }
    ];
    if (opts?.efsUser) attrs.push({ type: 0x100, nonResident: false, resident: Buffer.alloc(0x10) });
    if (opts?.attributeListUser) attrs.push({ type: 0x20, nonResident: false, resident: Buffer.alloc(0x18) });
    const rec = buildFileRecord(17, { inUse: true, attrs });
    if (opts?.compressedUser) patchAttrFlags(rec, 0x80, 0x0001);
    rec.copy(buf, mftBase + 17 * 1024);
  }

  // $Bitmap content: system clusters + user/staying runs, minus explicit clears.
  const bm = Buffer.alloc(SK_CLUSTER);
  const markUsed = (start: number, count: number): void => {
    for (let c = start; c < start + count; c++) bm[c >> 3] |= 1 << (c & 7);
  };
  markUsed(0, SK_MIRROR_LCN + 1); // boot + $Bitmap + $MFT + $MFTMirr
  for (const run of userRuns) markUsed(run.startLcn, run.runLength);
  for (const run of stayingRuns) markUsed(run.startLcn, run.runLength);
  if (!badClusRun.sparse) markUsed(badClusRun.startLcn, badClusRun.runLength);
  for (const clear of opts?.bitmapClear ?? []) {
    for (let i = 0; i < clear.count; i++) {
      const cluster = clear.start + i;
      bm[cluster >> 3] &= ~(1 << (cluster & 7));
    }
  }
  bm.copy(buf, SK_BITMAP_LCN * SK_CLUSTER);

  return buf;
}

/** Set the flags field (offset 0x0c) of the first attribute of `attrType`. */
function patchAttrFlags(record: Buffer, attrType: number, flags: number): void {
  let pos = record.readUInt16LE(0x14);
  while (pos + 8 <= record.length) {
    const type = record.readUInt32LE(pos);
    if (type === 0xffffffff) return;
    const length = record.readUInt32LE(pos + 4);
    if (length < 8) return;
    if (type === attrType) {
      record.writeUInt16LE(flags, pos + 0x0c);
      return;
    }
    pos += length;
  }
}

export function shrinkVolumeReader(data: Buffer): PartitionReader {
  return {
    size: data.length,
    read: (offset: number, length: number) => data.subarray(offset, offset + length)
  };
}

/** In-test reference applier mirroring the Phase-1 helper contract: boot
 *  sector first (plus its backup at the new last sector), then data moves,
 *  then MFT record patches, then $Bitmap regions. */
export function applyShrinkPlan(data: Buffer, plan: NtfsShrinkPlan): Buffer {
  plan.bootSector.copy(data, 0);
  plan.bootSector.copy(data, (plan.newTotalSectors - 1) * SK_SECTOR);
  for (const move of plan.moves) {
    data.copy(
      data,
      move.dstCluster * SK_CLUSTER,
      move.srcCluster * SK_CLUSTER,
      (move.srcCluster + move.clusterCount) * SK_CLUSTER
    );
  }
  for (const patch of plan.recordPatches) patch.data.copy(data, patch.relativeOffset);
  for (const region of plan.bitmapRegions) region.data.copy(data, region.relativeOffset);
  return data;
}
