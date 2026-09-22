import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeHeader, encodePartitionEntry, encodeBlockIndexEntry, encodeBlockFrame, compressBlock, crc32, readImageInfo, IMAGE_VERSION, FLAG_HAS_BLOCK_INDEX, HEADER_SIZE, PARTITION_TABLE_ENTRY_SIZE, BLOCK_INDEX_ENTRY_SIZE, COMPRESSION_ZSTD, COMPRESSION_NONE, PartitionEntryMeta, BlockRecord, ImageHeader } from '../../src/main/imaging/image-format';
import { ChainPartitionReader, partitionReaderForChain } from '../../src/main/imaging/image-browse';
import { openBrowse, listDirectory, readPath, resolvePath } from '../../src/main/imaging/fs/file-browse';
import { buildNtfsVolume, CLUSTER } from '../helpers/ntfs-fixture';

/** Write a .opbs image whose single partition holds `raw` bytes. */
function writeImageFromBytes(imagePath: string, raw: Buffer, blockSize: number, compressionId = COMPRESSION_ZSTD): BlockRecord[] {
  const partition: PartitionEntryMeta = {
    partitionIndex: 0,
    size: raw.length,
    offsetOnDisk: 0,
    firstBlockFileOffset: 0,
    blockCount: Math.ceil(raw.length / blockSize)
  };
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: Date.now(),
    totalBytes: raw.length,
    blockSize,
    compressionId,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX,
    blockIndexOffset: 0
  };

  const fd = fs.openSync(imagePath, 'w+');
  fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
  fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);

  const blocks: BlockRecord[] = [];
  let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
  partition.firstBlockFileOffset = cursor;
  for (let b = 0; b < partition.blockCount; b++) {
    const start = b * blockSize;
    const blockRaw = raw.subarray(start, Math.min(start + blockSize, raw.length));
    const comp = compressBlock(blockRaw, compressionId, 3);
    const frame = encodeBlockFrame(blockRaw, comp);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    blocks.push({
      partitionIndex: 0,
      blockIndex: b,
      fileOffset: cursor,
      rawSize: blockRaw.length,
      compSize: comp.length,
      rawCrc32: crc32(blockRaw)
    });
    cursor += frame.length;
  }

  const blockIndexOffset = cursor;
  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(blocks.length));
  fs.writeSync(fd, countBuf, 0, 8, cursor);
  cursor += 8;
  for (const block of blocks) {
    const entryBuf = encodeBlockIndexEntry(block);
    fs.writeSync(fd, entryBuf, 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    cursor += BLOCK_INDEX_ENTRY_SIZE;
  }

  fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
  const patched = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
  patched.writeBigUInt64LE(BigInt(blockIndexOffset), 40);
  fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);

  return blocks;
}

describe('image browse', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-browse-'));
    imagePath = path.join(dir, 'ntfs.opbs');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps partition byte ranges to decompressed blocks via ChainPartitionReader', () => {
    const raw = Buffer.alloc(CLUSTER * 4);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 13) & 0xff;
    writeImageFromBytes(imagePath, raw, CLUSTER);

    const { reader, partition } = partitionReaderForChain([imagePath], 0);
    expect(partition.size).toBe(raw.length);

    // Whole range
    expect(Buffer.compare(reader.read(0, raw.length), raw)).toBe(0);

    // A range crossing a block boundary
    const sub = raw.subarray(CLUSTER - 10, CLUSTER + 10);
    expect(Buffer.compare(reader.read(CLUSTER - 10, 20), sub)).toBe(0);

    // A single byte in the middle
    expect(reader.read(CLUSTER * 2 + 5, 1)[0]).toBe(raw[CLUSTER * 2 + 5]);
  });

  it('throws on an out-of-bounds read', () => {
    writeImageFromBytes(imagePath, Buffer.alloc(CLUSTER), CLUSTER);
    const { reader } = partitionReaderForChain([imagePath], 0);
    expect(() => reader.read(CLUSTER, 10)).toThrow(/out of bounds/i);
  });

  it('does not misdetect a real NTFS boot sector as FAT32', () => {
    // Real NTFS boot sectors set a non-zero physical drive number at 0x24
    // (typically 0x80) and a 0x55/0xAA signature — bytes detectFatType()
    // treats as FAT32's sectorsPerFat32. Checking FAT before the NTFS OEM id
    // sent every real volume down the FAT32 parser, which returned an empty
    // listing instead of throwing.
    const volume = buildNtfsVolume();
    const raw = Buffer.from(volume.read(0, volume.size));
    raw.writeUInt8(0x55, 510);
    raw.writeUInt8(0xaa, 511);
    raw.writeUInt8(0x80, 0x24);
    writeImageFromBytes(imagePath, raw, CLUSTER, COMPRESSION_NONE);

    const session = openBrowse(imagePath, 0);
    expect((session as { filesystem: string }).filesystem).toBe('ntfs');
    const root = listDirectory(session);
    expect(root.map((n) => n.name)).toContain('hello.txt');
  });

  it('browses and extracts NTFS files from the image', () => {
    const volume = buildNtfsVolume();
    writeImageFromBytes(imagePath, volume.read(0, volume.size), CLUSTER, COMPRESSION_NONE);

    const session = openBrowse(imagePath, 0);
    const root = listDirectory(session);
    const names = root.map((n) => n.name);
    expect(names).toContain('hello.txt');
    expect(names).toContain('docs');

    // Resident file content
    expect(readPath(session, 'hello.txt').toString()).toBe('Hello, OPBS world!');

    // Non-resident file inside a subdirectory
    const big = readPath(session, 'docs/big.bin');
    expect(big.length).toBe(2 * CLUSTER);
    expect(big[0]).toBe((32 * 31) & 0xff);

    // Path resolution is case-insensitive
    const rec = resolvePath(session, 'DOCS/BIG.BIN');
    expect(rec?.name).toBe('big.bin');
    expect(rec?.id).toBeDefined();
    expect(typeof rec?.id).toBe('number');
  });

  it('falls back to the directory tree when index entries miss the MFT cache', () => {
    const volume = buildNtfsVolume();
    writeImageFromBytes(imagePath, volume.read(0, volume.size), CLUSTER, COMPRESSION_NONE);

    const session = openBrowse(imagePath, 0);
    expect(session.filesystem).toBe('ntfs');
    if (session.filesystem !== 'ntfs') return;

    // Simulate a truncated readFileRecords() pass: keep only the root.
    for (const key of [...session.records.keys()]) {
      if (key !== session.rootId) session.records.delete(key);
    }
    session.children.clear();

    // The $I30 index still lists entries, but none resolve against the
    // gutted cache — listNtfs must fall back to the tree (empty here) with
    // a warning rather than pretend the folder has no children silently.
    // Re-populate children from a fresh parse to prove the fallback works.
    const fresh = openBrowse(imagePath, 0);
    if (fresh.filesystem !== 'ntfs') return;
    session.children = fresh.children;

    const root = listDirectory(session, '');
    expect(root.map((n) => n.name)).toContain('hello.txt');
  });
});
