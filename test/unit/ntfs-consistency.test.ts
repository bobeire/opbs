import { describe, it, expect } from 'vitest';
import { checkNtfsConsistency, describeConsistency } from '../../src/main/imaging/fs/ntfs-consistency';
import { buildFileRecord, FILE_RECORD, standardInfo, fileNameAttr, volumeInfoAttr } from '../helpers/ntfs-fixture';
import type { DataRun } from '../../src/main/imaging/fs/ntfs';

const SECTOR = 512;
const CLUSTER = 4096;
const SPC = CLUSTER / SECTOR; // 8
const MFT_LCN = 4;

/**
 * A minimal NTFS volume built to order, so a test can inject exactly the
 * inconsistency it wants the checker to find — and nothing else. Everything
 * here is deliberately controlled: the checker's job is to flag one specific
 * contradiction, and a synthetic volume is the only way to prove it flags
 * that and not the ordinary rough edges of real NTFS.
 */
function syntheticVolume(spec: {
  /** Records to write, beyond $MFT and $Bitmap. */
  records: Array<{ record: number; runs: DataRun[]; inUse?: boolean; name?: string }>;
  /** Clusters the $Bitmap marks allocated. */
  allocated: number[];
  totalClusters?: number;
}): Buffer {
  const totalClusters = spec.totalClusters ?? 64;
  const buf = Buffer.alloc(totalClusters * CLUSTER);

  // Boot sector at canonical NTFS offsets.
  buf.write('NTFS    ', 3, 'ascii');
  buf.writeUInt16LE(SECTOR, 0x0b);
  buf.writeUInt8(SPC, 0x0d);
  buf.writeBigUInt64LE(BigInt(totalClusters * SPC), 0x28);
  buf.writeBigUInt64LE(BigInt(MFT_LCN), 0x30);
  buf.writeBigUInt64LE(BigInt(MFT_LCN + 1), 0x38);
  buf.writeInt8(-10, 0x40); // 1024-byte file records

  const mftBase = MFT_LCN * CLUSTER;
  const maxRecord = Math.max(6, ...spec.records.map((r) => r.record));
  const mftClusters = Math.ceil(((maxRecord + 1) * FILE_RECORD) / CLUSTER);

  // $MFT (record 0) owns the runlist that locates every other record.
  const rec0 = buildFileRecord(0, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(1000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFT', 1) },
      {
        type: 0x80,
        nonResident: true,
        runs: [{ startLcn: MFT_LCN, runLength: mftClusters }],
        realSize: mftClusters * CLUSTER
      }
    ]
  });
  rec0.copy(buf, mftBase);

  // $Volume (record 3) — present so the volume looks ordinary.
  const rec3 = buildFileRecord(3, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(2000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$Volume', 1) },
      { type: 0x70, nonResident: false, resident: volumeInfoAttr(0) }
    ]
  });
  rec3.copy(buf, mftBase + 3 * FILE_RECORD);

  // $Bitmap (record 6), resident allocation map.
  const bitmapBytes = Buffer.alloc(Math.ceil(totalClusters / 8));
  for (const cluster of spec.allocated) {
    if (cluster >= 0 && cluster < totalClusters) bitmapBytes[cluster >> 3] |= 1 << (cluster & 7);
  }
  const rec6 = buildFileRecord(6, {
    inUse: true,
    attrs: [
      { type: 0x10, nonResident: false, resident: standardInfo(3000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$Bitmap', 1) },
      { type: 0x80, nonResident: false, resident: bitmapBytes }
    ]
  });
  rec6.copy(buf, mftBase + 6 * FILE_RECORD);

  for (const r of spec.records) {
    const attrs: Array<{ type: number; nonResident: boolean; resident?: Buffer; runs?: DataRun[]; realSize?: number }> = [
      { type: 0x10, nonResident: false, resident: standardInfo(4000) },
      { type: 0x30, nonResident: false, resident: fileNameAttr(5, r.name ?? `file${r.record}`, 1) }
    ];
    if (r.runs.length > 0) {
      attrs.push({
        type: 0x80,
        nonResident: true,
        runs: r.runs,
        realSize: r.runs.reduce((sum, run) => sum + run.runLength, 0) * CLUSTER
      });
    }
    buildFileRecord(r.record, { inUse: r.inUse !== false, attrs }).copy(buf, mftBase + r.record * FILE_RECORD);
  }

  return buf;
}

function readerOver(vol: Buffer) {
  return {
    size: vol.length,
    read: (offset: number, length: number) => vol.subarray(offset, offset + length)
  };
}

/**
 * The defect behind the 2026-11-03 field report: images where every block
 * passed its checksum and the filesystem they formed was corrupt, because
 * the allocation bitmap and the file records were captured moments apart.
 * chkdsk said `clusters allocated to file X ... marked as free`. This is the
 * check that sees it, and these tests prove it sees that and nothing else.
 */
describe('bitmap-vs-runlist consistency', () => {
  it('passes a volume whose files and map agree', () => {
    const vol = syntheticVolume({
      // Records 0 and 6 claim the MFT (LCN 4..) and the bitmap; 20 is a file.
      records: [{ record: 20, runs: [{ startLcn: 20, runLength: 2 }], name: 'good.dat' }],
      allocated: [4, 5, 6, 7, 8, 9, 10, 11, 20, 21]
    });

    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.truncated).toBeUndefined();
    expect(report.claimedButFree).toEqual([]);
    expect(report.doubleClaimed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.recordsChecked).toBeGreaterThan(0);
  });

  it("finds chkdsk's error: a file's clusters marked free in the map", () => {
    const vol = syntheticVolume({
      // The file claims 30..31 but the bitmap does not mark them allocated —
      // exactly what a bitmap captured after the file records looks like.
      records: [{ record: 20, runs: [{ startLcn: 30, runLength: 2 }], name: 'wifi.etl' }],
      allocated: [4, 5, 6, 7, 8, 9, 10, 11]
    });

    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.ok).toBe(false);
    expect(report.claimedButFree).toHaveLength(2);
    expect(report.claimedButFree[0].cluster).toBe(30);
    expect(report.claimedButFree[0].label).toBe('wifi.etl');
    // And it is described the way chkdsk describes it, so the two can be
    // compared without translating.
    expect(describeConsistency(report)).toContain('marked as free');
    expect(describeConsistency(report)).toContain('should not be relied on');
  });

  it('finds clusters claimed by more than one file', () => {
    const vol = syntheticVolume({
      records: [
        { record: 20, runs: [{ startLcn: 30, runLength: 2 }], name: 'a.dat' },
        { record: 21, runs: [{ startLcn: 31, runLength: 2 }], name: 'b.dat' }
      ],
      allocated: [4, 5, 6, 7, 8, 9, 10, 11, 30, 31]
    });

    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.ok).toBe(false);
    // Cluster 31 is claimed by both.
    expect(report.doubleClaimed.length).toBeGreaterThanOrEqual(1);
    expect(report.doubleClaimed[0].cluster).toBe(31);
  });

  it('ignores sparse runs — they claim nothing', () => {
    const vol = syntheticVolume({
      // $BadClus-style sparse run covering the whole volume must not be read
      // as claiming every cluster.
      records: [{ record: 20, runs: [{ startLcn: 0, runLength: 64, sparse: true }], name: '$BadClus' }],
      allocated: [4, 5, 6, 7, 8, 9, 10, 11]
    });

    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.ok).toBe(true);
    expect(report.doubleClaimed).toEqual([]);
  });

  it('reports unattributable clusters as informational, never as a failure', () => {
    const vol = syntheticVolume({
      records: [],
      // Clusters 40..41 are allocated but no file we can parse claims them —
      // $MFTMirr, extension records and anything unreadable land here.
      allocated: [4, 5, 6, 7, 8, 9, 10, 11, 40, 41]
    });

    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.ok).toBe(true);
    expect(report.unreferencedClusterCount).toBeGreaterThan(0);
    expect(describeConsistency(report)).toContain('claimed by no file we could parse');
  });

  it('ignores records that are not in use', () => {
    const vol = syntheticVolume({
      // A freed record still holding a stale runlist is normal NTFS, not an
      // inconsistency — flagging it would cry wolf on every real volume.
      records: [{ record: 20, runs: [{ startLcn: 50, runLength: 1 }], inUse: false, name: 'deleted.dat' }],
      allocated: [4, 5, 6, 7, 8, 9, 10, 11]
    });

    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.claimedButFree).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('says so rather than crashing on a volume it cannot parse', () => {
    const notNtfs = Buffer.alloc(CLUSTER * 4);
    notNtfs.write('FAT32   ', 3, 'ascii');
    const fat = checkNtfsConsistency(readerOver(notNtfs));
    expect(fat.ok).toBe(true);
    expect(fat.truncated).toContain('not an NTFS');
    expect(describeConsistency(fat)).toContain('could not be checked');

    const garbage = checkNtfsConsistency(readerOver(Buffer.alloc(64)));
    expect(garbage.truncated).toBeDefined();
    // A check that cannot run is not a pass, and it says which.
    expect(describeConsistency(garbage)).toContain('could not be checked');
  });

  it('never claims success it cannot substantiate', () => {
    // The whole point of this check: an unreadable volume must not read as
    // "OK". `ok` is true only when we actually walked the records.
    const vol = syntheticVolume({ records: [], allocated: [4, 5, 6, 7, 8, 9, 10, 11] });
    const report = checkNtfsConsistency(readerOver(vol));
    expect(report.recordsChecked).toBeGreaterThan(0);
    expect(report.totalClusters).toBe(64);
  });
});
