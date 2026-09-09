import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { detectMacriumFormat, readMacriumImage, MacriumUnsupportedError, readImageFileRange } from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { openAnyBrowse } from '../../src/main/imaging/fs/file-browse';

const MAGIC_X = 'MACRIUM_FILE';
const BLOCK_JSON = '$JSON   ';
const BLOCK_INDEX = '$INDEX  ';

function md5(buf: Buffer): Buffer {
  return createHash('md5').update(buf).digest();
}

function buildBlock(name: string, body: Buffer, last = true): { header: Buffer; headerHash: Buffer } {
  const hdr = Buffer.alloc(32);
  Buffer.from(name, 'latin1').copy(hdr, 0);
  hdr.writeUInt32LE(body.length, 8);
  const digest = md5(body);
  digest.copy(hdr, 12);
  hdr[28] = last ? 1 : 0;
  return { header: hdr, headerHash: digest };
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

function buildMrimgxImage(partitionBlocks: Buffer[]): {
  buffer: Buffer;
  partitionSize: number;
  blockSize: number;
} {
  const blockSize = 8192;
  const json = {
    _header: {
      imageid: '00000001',
      backup_type: 'full',
      backup_format: 'file_level',
      backup_time: 1600000000,
      index_file_position: 0, // placeholder, will patch
      split_file: false,
      delta_index: false,
      file_number: 0
    },
    _compression: { compression_method: 'zstd', compression_level: 'none' },
    _encryption: { enable: false },
    disks: [
      {
        _header: { disk_number: 0, disk_format: 'gpt' },
        _geometry: { disk_size: 500107862016 },
        partitions: [
          {
            _header: { block_size: blockSize, block_count: partitionBlocks.length, partition_number: 1 },
            _file_system: { type: 'NTFS', start: 0, lcn0_offset: 0, sectors_per_cluster: 8, volume_label: 'TEST' },
            _geometry: { start: 2048, end: 976768063, length: 976766016, boot_sector_offset: 0 },
            _partition_table_entry: { type: 7 }
          }
        ]
      }
    ]
  };

  // Data blocks are stored uncompressed.
  const rawBlocks = partitionBlocks;
  const totalDataLen = rawBlocks.reduce((s, b) => s + b.length, 0);
  let jsonBody = Buffer.from(JSON.stringify(json), 'utf8');

  // Layout: [data blocks] [root $JSON meta] [index metadata]:
  //   [disk meta group] [partition $INDEX meta group] [footer]
  const diskMetaBody = Buffer.alloc(16); // fake $TRACK0; unused by reader
  diskMetaBody.writeUInt32LE(0x55aa, 0);
  const diskMetaHeader = buildBlock('$TRACK0 ', diskMetaBody, true).header;

  // index_file_position points at the first index metadata group.
  let indexMetaStart = totalDataLen + 32 + jsonBody.length;
  json._header.index_file_position = indexMetaStart;
  jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  const shifted = totalDataLen + 32 + jsonBody.length;
  if (shifted !== indexMetaStart) {
    indexMetaStart = shifted;
    json._header.index_file_position = indexMetaStart;
    jsonBody = Buffer.from(JSON.stringify(json), 'utf8');
  }

  const rootMetaHeader = buildBlock(BLOCK_JSON, jsonBody, true).header;
  const rootMetaOff = totalDataLen;

  // Index with real data positions and hashes.
  const indexBlocks: Array<{ filePosition: number; md5: Buffer; storedLength: number }> = [];
  let dataPos = 0;
  for (const raw of rawBlocks) {
    indexBlocks.push({ filePosition: dataPos, md5: md5(raw), storedLength: raw.length });
    dataPos += raw.length;
  }
  const partIndexBody = buildMrimgIndex(indexBlocks);
  const partMetaHeader = buildBlock(BLOCK_INDEX, partIndexBody, true).header;

  const fileSize =
    rawBlocks.reduce((s, b) => s + b.length, 0) +
    32 + jsonBody.length +
    32 + diskMetaBody.length +
    32 + partIndexBody.length +
    20;
  const fileBuf = Buffer.alloc(fileSize);
  let off = 0;
  for (const raw of rawBlocks) {
    raw.copy(fileBuf, off);
    off += raw.length;
  }
  rootMetaHeader.copy(fileBuf, off); off += rootMetaHeader.length;
  jsonBody.copy(fileBuf, off); off += jsonBody.length;
  diskMetaHeader.copy(fileBuf, off); off += diskMetaHeader.length;
  diskMetaBody.copy(fileBuf, off); off += diskMetaBody.length;
  partMetaHeader.copy(fileBuf, off); off += partMetaHeader.length;
  partIndexBody.copy(fileBuf, off); off += partIndexBody.length;

  // Footer
  const footerOff = fileBuf.length - 20;
  fileBuf.writeBigUInt64LE(BigInt(rootMetaOff), footerOff);
  Buffer.from(MAGIC_X, 'latin1').copy(fileBuf, footerOff + 8);

  return { buffer: fileBuf, partitionSize: rawBlocks.length * blockSize, blockSize };
}

describe('mrimg-format', () => {
  let fixtureDir: string;
  let mrimgxPath: string;
  let fixture: ReturnType<typeof buildMrimgxImage>;
  let block0Raw: Buffer;
  let block1Raw: Buffer;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimg-'));
    // Build blocks as raw NTFS boot sector-like content (just zeros for simplicity)
    block0Raw = Buffer.alloc(8192);
    block1Raw = Buffer.alloc(8192);
    // Fill with identifiable pattern
    for (let i = 0; i < 8192; i++) { block0Raw[i] = i & 0xff; block1Raw[i] = (i + 128) & 0xff; }
    fixture = buildMrimgxImage([block0Raw, block1Raw]);
    mrimgxPath = path.join(fixtureDir, 'test.mrimgx');
    fs.writeFileSync(mrimgxPath, fixture.buffer);
    fs.writeFileSync(path.join(fixtureDir, 'dummy.txt'), 'not an image');
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('detects mrimgx format', () => {
    expect(detectMacriumFormat(mrimgxPath)).toBe('mrimgx');
  });

  it('detects non-Macrium as null', () => {
    expect(detectMacriumFormat(path.join(fixtureDir, 'dummy.txt'))).toBeNull();
  });

  it('parses image metadata', () => {
    const info = readMacriumImage(mrimgxPath);
    expect(info.format).toBe('mrimgx');
    expect(info.imageId).toBe('00000001');
    expect(info.backupType).toBe('full');
    expect(info.backupTime).toBe(1600000000);
    expect(info.encryption.enable).toBe(false);
    expect(info.compression.method).toBe('zstd');
    expect(info.disks).toHaveLength(1);
    expect(info.partitions).toHaveLength(1);
    expect(info.partitions[0].blockSize).toBe(fixture.blockSize);
    expect(info.partitions[0].blockCount).toBe(2);
    expect(info.partitions[0].volumeLabel).toBe('TEST');
    expect(info.partitions[0].dataStart).toBe(0);
    expect(info.partitions[0].blocks).toHaveLength(2);
  });

  it('reads data blocks and verifies md5', () => {
    const info = readMacriumImage(mrimgxPath);
    const reader = openMacriumPartitionReader(info, 0);
    const r0 = reader.read(0, 8192);
    expect(r0.equals(block0Raw)).toBe(true);
    const r1 = reader.read(8192, 8192);
    expect(r1.equals(block1Raw)).toBe(true);
  });

  it('rejects split images', () => {
    const info = readMacriumImage(mrimgxPath);
    (info as any).splitFile = true;
    expect(() => openMacriumPartitionReader(info, 0)).toThrow('split');
  });

  it('rejects encrypted images', () => {
    const info = readMacriumImage(mrimgxPath);
    (info as any).encryption = { enable: true, keyIterations: 100000 };
    expect(() => openMacriumPartitionReader(info, 0)).toThrow('password');
  });

  it('rejects unknown format', () => {
    const empty = path.join(fixtureDir, 'empty.bin');
    fs.writeFileSync(empty, Buffer.alloc(1024));
    expect(() => readMacriumImage(empty)).toThrow('Not a Macrium Reflect image');
  });

  it('rejects a footer-only mrimg-v7 file as structurally invalid', () => {
    const v7 = path.join(fixtureDir, 'test.mrimg');
    const buf = Buffer.alloc(64);
    // v7 trailer is the last 54 bytes; magic sits at tail offset 14,
    // so with a 64-byte file it lands at absolute offset 10 + 14 = 24.
    Buffer.from('__79241006_2651_11D4_', 'latin1').copy(buf, 24);
    buf[45] = 0;
    fs.writeFileSync(v7, buf);
    expect(detectMacriumFormat(v7)).toBe('mrimg-v7');
    // A trailer alone is not a parseable image: the metadata offset field is
    // empty, so opening it must fail (it is no longer treated as an
    // unsupported-but-detectable container).
    expect(() => readMacriumImage(v7)).toThrow();
  });

  // The user-provided real .mrimg lives next to the repo root. When present it
  // doubles as an end-to-end check of the trailer/footer/index/QuickLZ path.
  const v7Sample =
    process.env.OPBS_V7_SAMPLE ??
    path.join(__dirname, '..', '..', '14CC07500E727036-00-00.mrimg');
  const v7SamplePresent = fs.existsSync(v7Sample);
  describe.skipIf(!v7SamplePresent)('mrimg-v7 container (real sample)', () => {
    it('parses the trailer, footer, indexes and reports the source disk', () => {
      const info = readMacriumImage(v7Sample);
      expect(info.format).toBe('mrimg-v7');
      expect(info.compression.method).toBe('quicklz');
      expect(info.partitions.length).toBe(1);
      const part = info.partitions[0];
      expect(part.blockCount).toBe(256);
      expect(part.blockSize).toBe(65536);
      expect(part.blocks.length).toBe(256);
      expect(part.blocks[0].filePosition).toBe(0);
      expect(info.netbiosName).toBeTruthy();
      expect(info.disks[0].diskFormat).toBeTruthy();
    });

    it('decodes a stored block through the partition reader with a valid hash', () => {
      const info = readMacriumImage(v7Sample);
      const reader = openMacriumPartitionReader(info, 0);
      expect(reader.size).toBe(256 * 65536);
      const head = reader.read(0, 64);
      expect(head.length).toBe(64);
      // Every stored block must pass the per-block MD5 gate; a read spanning
      // several blocks therefore throws on any corruption.
      expect(() => reader.read(0, 128 * 1024)).not.toThrow();
    });
  });
});