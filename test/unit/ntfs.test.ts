import { describe, it, expect } from 'vitest';
import { NtfsFile, DataRun, parseBootSector, parseFileRecord, buildTree, readFileData, readFileRecords, readStreamData, readDirectoryIndex, resolveAttributeLists } from '../../src/main/imaging/fs/ntfs';
import { PartitionReader } from '../../src/main/imaging/image-browse';
import { buildNtfsVolume, buildNtfsVolumeData, buildFileRecord, attributeListValue, indexRootValue, SECTOR, CLUSTER, FILE_RECORD, MFT_CLUSTER, standardInfo, fileNameAttr } from '../helpers/ntfs-fixture';

describe('ntfs parser', () => {
  it('parses the boot sector layout', () => {
    const layout = parseBootSector(buildNtfsVolume());
    expect(layout.bytesPerSector).toBe(SECTOR);
    expect(layout.clusterSize).toBe(CLUSTER);
    expect(layout.fileRecordSize).toBe(FILE_RECORD);
    expect(layout.mftStartCluster).toBe(MFT_CLUSTER);
  });

  it('rejects a non-NTFS boot sector', () => {
    const reader: PartitionReader = {
      size: SECTOR,
      read: () => {
        const b = Buffer.alloc(SECTOR);
        b.write('FAT32   ', 3, 'ascii');
        return b;
      }
    };
    expect(() => parseBootSector(reader)).toThrow(/not an NTFS volume/i);
  });

  it('parses a FILE record with resident data and a filename', () => {
    const rec = buildFileRecord(6, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(3000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'hello.txt', 1) },
        { type: 0x80, nonResident: false, resident: Buffer.from('Hi') }
      ]
    });
    const file: NtfsFile = parseFileRecord(rec, 6);
    expect(file.recordNumber).toBe(6);
    expect(file.inUse).toBe(true);
    expect(file.isDirectory).toBe(false);
    expect(file.name?.name).toBe('hello.txt');
    expect(file.name?.parentRecord).toBe(5);
    expect(file.residentData.toString()).toBe('Hi');
    expect(file.size).toBe(2);
  });

  it('parses a non-resident data runlist', () => {
    const rec = buildFileRecord(8, {
      inUse: true,
      attrs: [
        { type: 0x30, nonResident: false, resident: fileNameAttr(7, 'big.bin', 1) },
        { type: 0x80, nonResident: true, runs: [{ startLcn: 32, runLength: 2 }], realSize: 2 * CLUSTER }
      ]
    });
    const file = parseFileRecord(rec, 8);
    expect(file.dataRuns).toEqual([{ startLcn: 32, runLength: 2 }]);
    expect(file.size).toBe(2 * CLUSTER);
  });

  it('builds a directory tree from parent references', () => {
    const reader = buildNtfsVolume();
    const layout = parseBootSector(reader);
    const records = readFileRecords(reader, layout);
    const children = buildTree(records);
    const rootKids = (children.get(5) ?? []).map((n) => n.name);
    expect(rootKids).toContain('$MFT');
    expect(rootKids).toContain('hello.txt');
    expect(rootKids).toContain('docs');
    expect((children.get(7) ?? []).map((n) => n.name)).toContain('big.bin');
  });

  it('reads resident and non-resident file data', () => {
    const reader = buildNtfsVolume();
    const layout = parseBootSector(reader);
    const records = readFileRecords(reader, layout);
    const byRec = new Map(records.map((r) => [r.recordNumber, r]));

    expect(readFileData(reader, layout, byRec.get(6)!).toString()).toBe('Hello, OPBS world!');

    const big = readFileData(reader, layout, byRec.get(8)!);
    expect(big.length).toBe(2 * CLUSTER);
    for (let i = 0; i < big.length; i++) {
      const c = 32 + Math.floor(i / CLUSTER);
      const within = i % CLUSTER;
      expect(big[i]).toBe((c * 31 + within * 7) & 0xff);
    }
  });

  it('reads a file whose data spans multiple extents (runs)', () => {
    // Record 9 has a $DATA with two non-contiguous runs: clusters 40..41 and 48..49.
    const rec = buildFileRecord(9, {
      inUse: true,
      attrs: [
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'frag.bin', 1) },
        { type: 0x80, nonResident: true, runs: [{ startLcn: 40, runLength: 2 }, { startLcn: 48, runLength: 2 }], realSize: 4 * CLUSTER }
      ]
    });
    const file = parseFileRecord(rec, 9);
    expect(file.dataRuns).toEqual([
      { startLcn: 40, runLength: 2 },
      { startLcn: 48, runLength: 2 }
    ]);
  });

  it('merges $DATA across records via $ATTRIBUTE_LIST', () => {
    // Base record 10 carries an $ATTRIBUTE_LIST pointing at record 11 for the
    // data; record 11 holds the actual runlist. resolveAttributeLists merges.
    const attrList = attributeListValue([{ type: 0x80, lowestVcn: 0, fileReference: 11 }]);
    const base = buildFileRecord(10, {
      inUse: true,
      attrs: [
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'huge.bin', 1) },
        { type: 0x20, nonResident: false, resident: attrList }
      ]
    });
    const dataHolder = buildFileRecord(11, {
      inUse: true,
      attrs: [{ type: 0x80, nonResident: true, runs: [{ startLcn: 56, runLength: 2 }], realSize: 2 * CLUSTER, vcn: 0 }]
    });

    const [mergedBase] = resolveAttributeLists([parseFileRecord(base, 10), parseFileRecord(dataHolder, 11)]);
    expect(mergedBase.dataRuns).toEqual([{ startLcn: 56, runLength: 2 }]);
    expect(mergedBase.size).toBe(2 * CLUSTER);
  });

  it('reads sparse runs as zeros and skips the missing clusters', () => {    // File data: clusters 40-41 (allocated), then 2 sparse clusters (zeros),
    // then clusters 48-49 (allocated). Total file size = 6 clusters.
    const rec = buildFileRecord(12, {
      inUse: true,
      attrs: [
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'sparse.bin', 1) },
        {
          type: 0x80,
          nonResident: true,
          runs: [
            { startLcn: 40, runLength: 2 },
            { startLcn: 40, runLength: 2, sparse: true },
            { startLcn: 48, runLength: 2 }
          ],
          realSize: 6 * CLUSTER
        }
      ]
    });
    const file = parseFileRecord(rec, 12);
    expect(file.dataRuns[1].sparse).toBe(true);

    // Build a reader where clusters 40-41 and 48-49 hold distinct patterns.
    const data = Buffer.alloc(64 * CLUSTER);
    for (let i = 0; i < 2 * CLUSTER; i++) {
      data[40 * CLUSTER + i] = 0xa0;
      data[48 * CLUSTER + i] = 0xb0;
    }
    const reader: PartitionReader = {
      size: data.length,
      read: (offset: number, length: number) => data.subarray(offset, offset + length)
    };
    const layout = parseBootSector(buildNtfsVolume());
    const content = readFileData(reader, layout, file);
    expect(content.length).toBe(6 * CLUSTER);
    // First 2 clusters from cluster 40.
    for (let i = 0; i < 2 * CLUSTER; i++) expect(content[i]).toBe(0xa0);
    // Middle 2 clusters are sparse -> zeros.
    for (let i = 2 * CLUSTER; i < 4 * CLUSTER; i++) expect(content[i]).toBe(0);
    // Last 2 clusters from cluster 48.
    for (let i = 4 * CLUSTER; i < 6 * CLUSTER; i++) expect(content[i]).toBe(0xb0);
  });

  it('parses named (alternate) data streams', () => {
    const rec = buildFileRecord(13, {
      inUse: true,
      attrs: [
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'report.txt', 1) },
        { type: 0x80, nonResident: false, resident: Buffer.from('main body') },
        { type: 0x80, nonResident: false, resident: Buffer.from('zone-id'), fileName: 'Zone.Identifier' }
      ]
    });
    const file = parseFileRecord(rec, 13);
    expect(file.residentData.toString()).toBe('main body');
    const stream = file.streams.get('Zone.Identifier');
    expect(stream).toBeDefined();
    expect(stream!.residentData.toString()).toBe('zone-id');

    const layout = parseBootSector(buildNtfsVolume());
    const reader = buildNtfsVolume();
    expect(readStreamData(reader, layout, stream!).toString()).toBe('zone-id');
  });

  it('reads directory children via the $I30 index', () => {
    const dir = buildFileRecord(5, {
      inUse: true,
      directory: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(2000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, '.', 1) },
        {
          type: 0x90,
          nonResident: false,
          fileName: '$I30',
          resident: indexRootValue([
            { fileReference: 6, name: 'hello.txt' },
            { fileReference: 7, name: 'docs', last: true }
          ])
        }
      ]
    });
    const file = parseFileRecord(dir, 5);
    const layout = parseBootSector(buildNtfsVolume());
    const reader = buildNtfsVolume();
    const entries = readDirectoryIndex(reader, layout, file);
    expect(entries.map((e) => e.name)).toEqual(['hello.txt', 'docs']);
    expect(entries[0].fileReference).toBe(6);
    expect(entries[1].fileReference).toBe(7);
    expect(entries[1].lastEntry).toBe(true);
  });

  it('reads directory children via an $INDEX_ALLOCATION buffer (large dir)', () => {
    // Build one 4096-byte index buffer holding a real $FILE_NAME key entry.
    const key = fileNameAttr(0, 'big.dat', 1);
    const entryLength = 0x10 + key.length;
    const entry = Buffer.alloc(entryLength);
    entry.writeBigUInt64LE(13n & 0xffffffffffffn, 0);
    entry.writeUInt16LE(entryLength, 0x08);
    entry.writeUInt16LE(key.length, 0x0a);
    entry.writeUInt16LE(0x02, 0x0c); // last entry
    key.copy(entry, 0x10);

    const indexBuf = Buffer.alloc(4096);
    // INDEX_HEADER at 0, then entries at 0x10.
    indexBuf.writeUInt32LE(0x10, 0x00); // entries offset
    indexBuf.writeUInt32LE(entryLength, 0x04); // total size
    indexBuf.writeUInt32LE(entryLength, 0x08); // allocated size
    indexBuf.writeUInt8(0, 0x0c); // flags (not large)
    entry.copy(indexBuf, 0x10);

    const volume = buildNtfsVolumeData();
    indexBuf.copy(volume, 40 * CLUSTER); // index data landed at LCN 40

    const indexRoot = Buffer.alloc(0x20);
    indexRoot.writeUInt32LE(0x30, 0x00); // indexed attribute = $FILE_NAME
    indexRoot.writeUInt32LE(1, 0x04); // collation
    indexRoot.writeUInt32LE(4096, 0x08); // index buffer size
    indexRoot.writeUInt8(1, 0x0c); // clusters per buffer
    indexRoot.writeUInt32LE(0x10, 0x10); // entries offset (INDEX_HEADER)
    indexRoot.writeUInt32LE(0, 0x14); // empty root node
    indexRoot.writeUInt32LE(0, 0x18);
    indexRoot.writeUInt8(0x01, 0x1c); // LARGE_INDEX flag => allocation present

    const dir = buildFileRecord(5, {
      inUse: true,
      directory: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(2000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, '.', 1) },
        { type: 0x90, nonResident: false, fileName: '$I30', resident: indexRoot },
        {
          type: 0xa0,
          nonResident: true,
          runs: [{ startLcn: 40, runLength: 1 }],
          realSize: 4096,
          vcn: 0
        },
        {
          type: 0xb0,
          nonResident: false,
          resident: Buffer.from([0x01, 0x00, 0x00, 0x00]) // buffer 0 present
        }
      ]
    });
    const reader: PartitionReader = {
      size: volume.length,
      read: (offset: number, length: number) => volume.subarray(offset, offset + length)
    };
    const file = parseFileRecord(dir, 5);
    const layout = parseBootSector(buildNtfsVolume());
    const entries = readDirectoryIndex(reader, layout, file);
    expect(entries.map((e) => e.name)).toEqual(['big.dat']);
    expect(entries[0].fileReference).toBe(13);
    expect(entries[0].lastEntry).toBe(true);
  });

  it('reads an LZNT1-compressed file (compression unit)', () => {
    // compressionUnit=1 => CU = 2 clusters = 8192 bytes. Build a compressed CU
    // that decodes to 4096 'A' + 4096 'B'. Each chunk is one literal byte +
    // a self-overlapping back-reference to repeat it 4095 more times.
    const chunkA = Buffer.from([0x03, 0xb0, 0x02, 0x41, 0xfc, 0x0f]); // -> 4096 'A'
    const chunkB = Buffer.from([0x03, 0xb0, 0x02, 0x42, 0xfc, 0x0f]); // -> 4096 'B'
    const compressed = Buffer.concat([chunkA, chunkB]);

    const data = Buffer.alloc(64 * CLUSTER);
    compressed.copy(data, 40 * CLUSTER);

    const rec = buildFileRecord(14, {
      inUse: true,
      attrs: [
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, 'compressed.txt', 1) },
        {
          type: 0x80,
          nonResident: true,
          runs: [{ startLcn: 40, runLength: 1 }, { startLcn: 40, runLength: 1, sparse: true }],
          realSize: 2 * CLUSTER,
          vcn: 0,
          compressionUnit: 1
        }
      ]
    });
    const file = parseFileRecord(rec, 14);
    expect(file.compressionUnit).toBe(1);

    const reader: PartitionReader = {
      size: data.length,
      read: (offset: number, length: number) => data.subarray(offset, offset + length)
    };
    const layout = parseBootSector(buildNtfsVolume());
    const content = readFileData(reader, layout, file);
    expect(content.length).toBe(2 * CLUSTER);
    for (let i = 0; i < CLUSTER; i++) expect(content[i]).toBe(0x41);
    for (let i = CLUSTER; i < 2 * CLUSTER; i++) expect(content[i]).toBe(0x42);
  });

  it('recovers the $MFT runlist from $MFTMirr when record 0 is corrupt', () => {
    const data = buildNtfsVolumeData();
    const mftCluster = MFT_CLUSTER;
    const mftBase = mftCluster * CLUSTER;
    data.fill(0xff, mftBase, mftBase + FILE_RECORD); // corrupt $MFT record 0
    const mirror = buildFileRecord(0, {
      inUse: true,
      attrs: [
        { type: 0x10, nonResident: false, resident: standardInfo(1000) },
        { type: 0x30, nonResident: false, resident: fileNameAttr(5, '$MFT', 1) },
        { type: 0x80, nonResident: true, runs: [{ startLcn: mftCluster, runLength: 12 }], realSize: 12 * CLUSTER }
      ]
    });
    mirror.copy(data, (mftCluster + 1) * CLUSTER);

    const reader: PartitionReader = {
      size: data.length,
      read: (offset: number, length: number) => data.subarray(offset, offset + length)
    };
    const layout = parseBootSector(reader);
    const records = readFileRecords(reader, layout);
    const hello = records.find((r) => r.recordNumber === 6);
    expect(hello).toBeDefined();
    expect(hello!.name?.name).toBe('hello.txt');
  });
});
