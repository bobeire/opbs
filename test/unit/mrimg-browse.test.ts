import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { openAnyBrowse, listDirectory, extractPath } from '../../src/main/imaging/fs/file-browse';
import { buildNtfsVolumeData } from '../helpers/ntfs-fixture';
import { readImageFileRange } from '../../src/main/imaging/mrimg/mrimg-format';

const MAGIC_X = 'MACRIUM_FILE';
const BLOCK_JSON = '$JSON   ';
const BLOCK_INDEX = '$INDEX  ';

function md5(buf: Buffer): Buffer {
  return createHash('md5').update(buf).digest();
}

function buildMrimgIndex(blocks: Array<{ filePosition: number; md5: Buffer; storedLength: number }>): Buffer {
  const buf = Buffer.alloc(4 + 4 + blocks.length * 30);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(blocks.length, 4);
  let off = 8;
  for (const b of blocks) {
    buf.writeBigInt64LE(BigInt(b.filePosition), off);
    b.md5.copy(buf, off + 8);
    buf.writeUInt32LE(b.storedLength, off + 24);
    buf.writeUInt16LE(0, off + 28);
    off += 30;
  }
  return buf;
}

function metaBlockHeader(name: string, body: Buffer): Buffer {
  const hdr = Buffer.alloc(32);
  Buffer.from(name, 'latin1').copy(hdr, 0);
  hdr.writeUInt32LE(body.length, 8);
  md5(body).copy(hdr, 12);
  hdr[28] = 1;
  return hdr;
}

function createMrimgxWithNtfs(ntfsData: Buffer, blockSize: number): Buffer {
  const blockCount = Math.ceil(ntfsData.length / blockSize);
  // pad last block if needed
  const rawBlocks: Buffer[] = [];
  for (let i = 0; i < blockCount; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, ntfsData.length);
    const raw = Buffer.alloc(blockSize);
    ntfsData.copy(raw, 0, start, end);
    rawBlocks.push(raw);
  }

  // Build JSON metadata (no compression for simplicity)
  const json = {
    _header: {
      imageid: 'BROWSE-TEST-001',
      backup_type: 'full',
      backup_format: 'file_level',
      backup_time: 1600000000,
      index_file_position: 0,
      split_file: false,
      delta_index: false,
      file_number: 0
    },
    _compression: { compression_method: 'none', compression_level: 'none' },
    _encryption: { enable: false },
    disks: [
      {
        _header: { disk_number: 0, disk_format: 'mbr' },
        _geometry: { disk_size: ntfsData.length },
        partitions: [
          {
            _header: { block_size: blockSize, block_count: blockCount, partition_number: 1 },
            _file_system: { type: 'NTFS', start: 0, lcn0_offset: 0, sectors_per_cluster: 8, volume_label: 'VOL' },
            _geometry: { start: 0, end: ntfsData.length, length: ntfsData.length, boot_sector_offset: 0 },
            _partition_table_entry: { type: 7 }
          }
        ]
      }
    ]
  };

  let jsonBody = Buffer.from(JSON.stringify(json), 'utf8');

  const totalDataLen = rawBlocks.reduce((s, b) => s + b.length, 0);

  // Layout: [data blocks] [root $JSON meta] [index metadata]:
  //   [disk meta group] [partition $INDEX meta group] [footer]
  // index_file_position points at the first group in the index metadata region.
  const rootMetaOff = totalDataLen;
  const diskMetaBody = Buffer.alloc(16); // fake $TRACK0; unused by reader
  diskMetaBody.writeUInt32LE(0x55aa, 0);
  const diskMetaHeader = metaBlockHeader('$TRACK0 ', diskMetaBody);

  let indexMetaStart = totalDataLen + 32 + jsonBody.length;
  json._header.index_file_position = indexMetaStart;
  jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  // If the digit count changed, the offsets shift; recompute exactly once.
  const shifted = totalDataLen + 32 + jsonBody.length;
  if (shifted !== indexMetaStart) {
    indexMetaStart = shifted;
    json._header.index_file_position = indexMetaStart;
    jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  }
  const rootMetaHeader = metaBlockHeader(BLOCK_JSON, jsonBody);

  // Build index with real data positions and hashes.
  const indexBlocks: Array<{ filePosition: number; md5: Buffer; storedLength: number }> = [];
  let dataPos = 0;
  for (const raw of rawBlocks) {
    indexBlocks.push({ filePosition: dataPos, md5: md5(raw), storedLength: raw.length });
    dataPos += raw.length;
  }
  const partMetaBody = buildMrimgIndex(indexBlocks);
  const partMetaHeader = metaBlockHeader(BLOCK_INDEX, partMetaBody);

  const fileSize =
    totalDataLen + 32 + jsonBody.length + 32 + diskMetaBody.length + 32 + partMetaBody.length + 20;
  const file = Buffer.alloc(fileSize);
  let off = 0;
  for (const raw of rawBlocks) {
    raw.copy(file, off);
    off += raw.length;
  }
  rootMetaHeader.copy(file, off); off += rootMetaHeader.length;
  jsonBody.copy(file, off); off += jsonBody.length;
  diskMetaHeader.copy(file, off); off += diskMetaHeader.length;
  diskMetaBody.copy(file, off); off += diskMetaBody.length;
  partMetaHeader.copy(file, off); off += partMetaHeader.length;
  partMetaBody.copy(file, off); off += partMetaBody.length;

  // Footer
  const footerOff = fileSize - 20;
  file.writeBigUInt64LE(BigInt(rootMetaOff), footerOff);
  Buffer.from(MAGIC_X, 'latin1').copy(file, footerOff + 8);
  return file;
}

describe('mrimg browse end-to-end', () => {
  let fixtureDir: string;
  let mrimgxPath: string;
  let ntfsData: Buffer;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimg-browse-'));
    ntfsData = buildNtfsVolumeData(); // 262144 bytes
    const imgBuf = createMrimgxWithNtfs(ntfsData, 262144); // one block covering the whole volume
    mrimgxPath = path.join(fixtureDir, 'browse-test.mrimgx');
    fs.writeFileSync(mrimgxPath, imgBuf);
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('lists root directory from mrimgx volume', () => {
    const session = openAnyBrowse(mrimgxPath, 0);
    const entries = listDirectory(session, '');
    expect(entries).toBeInstanceOf(Array);
    const names = entries.map((e: any) => e.name);
    expect(names).toContain('hello.txt');
    expect(names).toContain('docs');
  });

  it('lists subdirectory', () => {
    const session = openAnyBrowse(mrimgxPath, 0);
    const entries = listDirectory(session, 'docs');
    const names = entries.map((e: any) => e.name);
    expect(names).toContain('big.bin');
  });

  it('reads file data from mrimgx volume', () => {
    const session = openAnyBrowse(mrimgxPath, 0);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-extract-'));
    try {
      const outFile = path.join(extracted, 'hello.txt');
      const result = extractPath(session, 'hello.txt', outFile);
      expect(result).toBe(1);
      const content = fs.readFileSync(outFile, 'utf8');
      expect(content).toContain('Hello, OPBS world!');
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
});