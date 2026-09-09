import { buildFileRecord, FILE_RECORD, standardInfo, fileNameAttr } from './ntfs-fixture';
import { DataRun } from '../../src/main/imaging/fs/ntfs';

export const GR_SECTOR = 512;
export const GR_CLUSTER = 4096;
export const GR_SPC = GR_CLUSTER / GR_SECTOR;
export const GR_MFT_LCN = 4;

/**
 * A synthetic NTFS volume using the *canonical* BPB layout (total sectors at
 * 0x28, $MFT LCN at 0x30, clusters-per-record at 0x40) as the grow-on-restore
 * planner expects. Differs from `ntfs-fixture.buildNtfsVolume`, which uses
 * non-standard offsets that only its own reader understands.
 *
 * Record 6 ($Bitmap) holds a single non-resident run at LCN 3 storing the
 * volume's cluster bitmap (first 16 clusters marked in use). Record 8
 * ($BadClus) is a sparse run covering the whole volume by default.
 */
export function buildCanonicalNtfsVolumeData(opts?: {
  totalClusters?: number;
  bitmapRuns?: DataRun[];
  bitmapRealSize?: number;
  badClusAllocated?: boolean;
}): Buffer {
  const totalClusters = opts?.totalClusters ?? 64;
  const buf = Buffer.alloc(totalClusters * GR_CLUSTER);
  const bitmapBytes = opts?.bitmapRealSize ?? Math.ceil(totalClusters / 8);
  const bitmapClusters = Math.ceil(bitmapBytes / GR_CLUSTER);

  // Boot sector (canonical NTFS offsets).
  buf.write('NTFS    ', 3, 'ascii');
  buf.writeUInt16LE(GR_SECTOR, 0x0b);
  buf.writeUInt8(GR_SPC, 0x0d);
  buf.writeUInt8(0xf8, 0x15);
  buf.writeBigUInt64LE(BigInt(totalClusters * GR_SPC), 0x28);
  buf.writeBigUInt64LE(BigInt(GR_MFT_LCN), 0x30);
  buf.writeBigUInt64LE(BigInt(GR_MFT_LCN + 1), 0x38);
  buf.writeInt8(-10, 0x40); // 1024-byte file record

  const mftBase = GR_MFT_LCN * GR_CLUSTER;

  const rec0 = buildFileRecord(0, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(1000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFT', 1) },
      { type: 0x80, nonResident: true, runs: [{ startLcn: GR_MFT_LCN, runLength: 12 }], realSize: 12 * GR_CLUSTER }
    ]
  });
  rec0.copy(buf, mftBase);

  const rec6 = buildFileRecord(6, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(3000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$Bitmap', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: opts?.bitmapRuns ?? [{ startLcn: 3, runLength: bitmapClusters }],
        realSize: bitmapBytes
      }
    ]
  });
  rec6.copy(buf, mftBase + 6 * FILE_RECORD);

  const badClusRuns: DataRun[] = opts?.badClusAllocated
    ? [{ startLcn: 40, runLength: 4 }]
    : [{ startLcn: 0, runLength: totalClusters, sparse: true }];
  const rec8 = buildFileRecord(8, {
    inUse: true,
    attrs: [
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$BadClus', 1) },
      { type: 0x80, nonResident: true, runs: badClusRuns, realSize: totalClusters * GR_CLUSTER }
    ]
  });
  rec8.copy(buf, mftBase + 8 * FILE_RECORD);

  // $Bitmap content at LCN 3: clusters 0..15 are in use, the rest free.
  const bmBase = 3 * GR_CLUSTER;
  buf[bmBase] = 0xff;
  buf[bmBase + 1] = 0xff;

  return buf;
}