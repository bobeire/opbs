import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import {
  crc32,
  encodeHeader,
  parseHeader,
  encodePartitionEntry,
  parsePartitionEntry,
  encodeBlockIndexEntry,
  parseBlockIndexEntry,
  encodeBlockFrame,
  verifyImage,
  readImageInfo,
  clearImageInfoCache,
  decompressBlock,
  compressBlock,
  defaultImagePath,
  getCompressionId,
  ImageHeader,
  PartitionEntryMeta,
  BlockRecord,
  IMAGE_VERSION,
  DEFAULT_BLOCK_SIZE,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_VERIFIED,
  FLAG_INCREMENTAL,
  FLAG_MULTI_VOLUME,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  COMPRESSION_DEFLATE,
  COMPRESSION_ZSTD,
  COMPRESSION_NONE,
  CIPHER_NONE,
  CIPHER_AES256_GCM,
  SALT_LENGTH,
  GCM_IV_LENGTH,
  GCM_TAG_LENGTH,
  newImageCipher,
  deriveImageKey,
  scanPartialImage
} from '../../src/main/imaging/image-format';

function randomData(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf;
}

interface WrittenImage {
  path: string;
  blocks: BlockRecord[];
}

function writeValidImage(dir: string, blockSize = 1024, compressionId = COMPRESSION_DEFLATE): WrittenImage {
  const imagePath = path.join(dir, 'test.opbs');

  const partitions: PartitionEntryMeta[] = [
    { partitionIndex: 0, size: blockSize * 2, offsetOnDisk: 1048576, firstBlockFileOffset: 0, blockCount: 2 },
    { partitionIndex: 2, size: blockSize * 2, offsetOnDisk: 122683392, firstBlockFileOffset: 0, blockCount: 2 }
  ];

  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: Date.now(),
    totalBytes: blockSize * 4,
    blockSize,
    compressionId,
    partitionCount: partitions.length,
    flags: FLAG_HAS_BLOCK_INDEX,
    blockIndexOffset: 0
  };

  const fd = fs.openSync(imagePath, 'w+');
  fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);

  const tableSize = partitions.length * PARTITION_TABLE_ENTRY_SIZE;
  fs.writeSync(fd, Buffer.alloc(tableSize), 0, tableSize, HEADER_SIZE);

  const blocks: BlockRecord[] = [];
  let cursor = HEADER_SIZE + tableSize;

  for (let p = 0; p < partitions.length; p++) {
    partitions[p].firstBlockFileOffset = cursor;
    for (let b = 0; b < partitions[p].blockCount; b++) {
      const raw = randomData(blockSize);
      const comp = compressBlock(raw, compressionId, 3);
      const frame = encodeBlockFrame(raw, comp);
      fs.writeSync(fd, frame, 0, frame.length, cursor);

      blocks.push({
        partitionIndex: partitions[p].partitionIndex,
        blockIndex: b,
        fileOffset: cursor,
        rawSize: raw.length,
        compSize: comp.length,
        rawCrc32: crc32(raw)
      });
      cursor += frame.length;
    }
  }

  const blockIndexOffset = cursor;
  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(blocks.length));
  fs.writeSync(fd, countBuf, 0, 8, cursor);
  cursor += 8;
  for (const block of blocks) {
    const e = encodeBlockIndexEntry(block);
    fs.writeSync(fd, e, 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    cursor += BLOCK_INDEX_ENTRY_SIZE;
  }

  for (let i = 0; i < partitions.length; i++) {
    const e = encodePartitionEntry(partitions[i]);
    fs.writeSync(fd, e, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE + i * PARTITION_TABLE_ENTRY_SIZE);
  }

  const patch = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, patch, 0, HEADER_SIZE, 0);
  patch.writeBigUInt64LE(BigInt(blockIndexOffset), 40);
  fs.writeSync(fd, patch, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);

  return { path: imagePath, blocks };
}

describe('image-format', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-format-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('crc32', () => {
    it('matches the standard CRC-32 test vector', () => {
      expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
    });

    it('is deterministic', () => {
      const a = randomData(4096);
      expect(crc32(a)).toBe(crc32(Buffer.from(a)));
    });
  });

  describe('header round-trip', () => {
    it('encodes and parses a header', () => {
      const header: ImageHeader = {
        version: IMAGE_VERSION,
        timestamp: 1234567890123,
        totalBytes: 998686136832,
        blockSize: 1024 * 1024,
        compressionId: COMPRESSION_DEFLATE,
        partitionCount: 5,
        flags: FLAG_HAS_BLOCK_INDEX | FLAG_VERIFIED,
        blockIndexOffset: 4096,
        cipherId: CIPHER_NONE,
        kdfIterations: 0,
        salt: Buffer.alloc(SALT_LENGTH),
        baseImagePath: '',
        sourceDiskModel: '',
        sourceDiskSerial: ''
      };
      const parsed = parseHeader(encodeHeader(header));
      expect(parsed).toEqual(header);
    });

    it('round-trips source disk identity (model/serial)', () => {
      const header: ImageHeader = {
        version: IMAGE_VERSION,
        timestamp: 1234567890123,
        totalBytes: 12345,
        blockSize: 1024 * 1024,
        compressionId: COMPRESSION_NONE,
        partitionCount: 1,
        flags: FLAG_HAS_BLOCK_INDEX,
        blockIndexOffset: 4096,
        cipherId: CIPHER_NONE,
        kdfIterations: 0,
        salt: Buffer.alloc(SALT_LENGTH),
        baseImagePath: '',
        sourceDiskModel: 'SAMSUNG MZVLB1T0HBLR-000L2',
        sourceDiskSerial: 'S5XXNX0T987654'
      };
      const parsed = parseHeader(encodeHeader(header));
      expect(parsed.sourceDiskModel).toBe('SAMSUNG MZVLB1T0HBLR-000L2');
      expect(parsed.sourceDiskSerial).toBe('S5XXNX0T987654');
    });

    it('truncates over-long identity fields and tolerates legacy headers', () => {
      const parsed = parseHeader(encodeHeader({
        version: IMAGE_VERSION,
        timestamp: 1,
        totalBytes: 1,
        blockSize: 512,
        compressionId: COMPRESSION_NONE,
        partitionCount: 1,
        flags: 0,
        blockIndexOffset: 0,
        cipherId: CIPHER_NONE,
        kdfIterations: 0,
        salt: Buffer.alloc(SALT_LENGTH),
        baseImagePath: '',
        sourceDiskModel: 'X'.repeat(100),
        sourceDiskSerial: 'Y'.repeat(100)
      } as ImageHeader));
      expect(parsed.sourceDiskModel.length).toBeLessThanOrEqual(27);
      expect(parsed.sourceDiskSerial.length).toBeLessThanOrEqual(27);

      // A legacy header (zeroed identity region) decodes to empty strings.
      const legacy = parseHeader(encodeHeader({
        version: IMAGE_VERSION,
        timestamp: 1,
        totalBytes: 1,
        blockSize: 512,
        compressionId: COMPRESSION_NONE,
        partitionCount: 1,
        flags: 0,
        blockIndexOffset: 0,
        cipherId: CIPHER_NONE,
        kdfIterations: 0,
        salt: Buffer.alloc(SALT_LENGTH),
        baseImagePath: ''
      } as ImageHeader));
      expect(legacy.sourceDiskModel).toBe('');
      expect(legacy.sourceDiskSerial).toBe('');
    });

    it('round-trips cipher and base-image-path fields', () => {
      const salt = crypto.randomBytes(SALT_LENGTH);
      const header: ImageHeader = {
        version: IMAGE_VERSION,
        timestamp: 1234567890123,
        totalBytes: 12345,
        blockSize: 1024 * 1024,
        compressionId: COMPRESSION_DEFLATE,
        partitionCount: 2,
        flags: FLAG_HAS_BLOCK_INDEX | FLAG_INCREMENTAL,
        blockIndexOffset: 4096,
        cipherId: CIPHER_AES256_GCM,
        kdfIterations: 210000,
        salt,
        baseImagePath: 'D:\\backups\\full-1.opbs',
        sourceDiskModel: '',
        sourceDiskSerial: ''
      };
      const parsed = parseHeader(encodeHeader(header));
      expect(parsed).toEqual(header);
      expect(parsed.baseImagePath).toBe('D:\\backups\\full-1.opbs');
      expect(parsed.sourceDiskModel).toBe('');
      expect(parsed.sourceDiskSerial).toBe('');
    });

    it('rejects non-OPBS data', () => {
      expect(() => parseHeader(Buffer.alloc(HEADER_SIZE))).toThrow(/magic/i);
    });

    it('rejects truncated input', () => {
      expect(() => parseHeader(Buffer.alloc(100))).toThrow(/truncated/i);
    });
  });

  describe('partition/block entry round-trip', () => {
    it('encodes and parses partition entries', () => {
      const entry: PartitionEntryMeta = {
        partitionIndex: 2,
        size: 998686136832,
        offsetOnDisk: 122683392,
        firstBlockFileOffset: 4096,
        blockCount: 100000
      };
      expect(parsePartitionEntry(encodePartitionEntry(entry))).toEqual(entry);
    });

    it('encodes and parses block index entries', () => {
      const block: BlockRecord = {
        partitionIndex: 2,
        blockIndex: 42,
        fileOffset: 123456789,
        rawSize: 1048576,
        compSize: 512000,
        rawCrc32: 0xdeadbeef
      };
      expect(parseBlockIndexEntry(encodeBlockIndexEntry(block))).toEqual(block);
    });
  });

  describe('compression/decompression', () => {
    it('decompresses deflate blocks', () => {
      const raw = randomData(2048);
      const comp = zlib.deflateRawSync(raw);
      expect(decompressBlock(comp, COMPRESSION_DEFLATE)).toEqual(raw);
    });

    it('returns data unchanged for no compression', () => {
      const raw = randomData(2048);
      expect(decompressBlock(raw, 0)).toEqual(raw);
    });

    it('throws on unknown compression id', () => {
      expect(() => decompressBlock(Buffer.from('x'), 99)).toThrow(/unsupported compression/i);
    });

    it('compressBlock/decompressBlock round-trips zstd blocks', () => {
      const raw = randomData(4096);
      const comp = compressBlock(raw, COMPRESSION_ZSTD, 3);
      expect(decompressBlock(comp, COMPRESSION_ZSTD)).toEqual(raw);
    });

    it('compressBlock round-trips compressible zstd data deterministically vs decompressor', () => {
      const raw = Buffer.alloc(8192, 0x41);
      const comp = compressBlock(raw, COMPRESSION_ZSTD, 3);
      expect(comp.length).toBeLessThan(raw.length / 2);
      expect(decompressBlock(comp, COMPRESSION_ZSTD)).toEqual(raw);
    });

    it('compressBlock with zstd level 1 still compressible', () => {
      const raw = Buffer.alloc(8192, 0x55);
      const comp = compressBlock(raw, COMPRESSION_ZSTD, 1);
      expect(decompressBlock(comp, COMPRESSION_ZSTD)).toEqual(raw);
    });

    it('compressBlock survives zstdify buggy level by falling back to a safe level', () => {
      // Boot-sector-like data triggers zstdify's encoder bug at level 3; the
      // fallback must produce a decodable frame regardless of the chosen level.
      const raw = Buffer.alloc(4096);
      raw.write('NTFS    ', 3, 'ascii');
      raw.writeUInt16LE(512, 0x0b);
      raw.writeUInt8(8, 0x0d);
      raw.writeInt8(-10, 0x28);
      raw.writeBigUInt64LE(BigInt(4), 0x40);
      raw.writeBigUInt64LE(BigInt(5), 0x48);
      const comp = compressBlock(raw, COMPRESSION_ZSTD, 3);
      expect(decompressBlock(comp, COMPRESSION_ZSTD)).toEqual(raw);
    });

    it('compressBlock passes through raw data for no compression', () => {
      const raw = randomData(2048);
      const out = compressBlock(raw, 0, 3);
      expect(Buffer.compare(Buffer.from(out), raw)).toBe(0);
    });
  });

  describe('verifyImage', () => {
    it('verifies a valid image', async () => {
      const image = writeValidImage(dir);
      const result = await verifyImage(image.path);
      expect(result.ok).toBe(true);
      expect(result.blocksVerified).toBe(4);
    });

    it('verifies a valid zstd image', async () => {
      const image = writeValidImage(dir, 1024, COMPRESSION_ZSTD);
      const info = readImageInfo(image.path);
      expect(info.header.compressionId).toBe(COMPRESSION_ZSTD);
      const result = await verifyImage(image.path);
      expect(result.ok).toBe(true);
      expect(result.blocksVerified).toBe(4);
    });

    it('detects corruption in a block frame', async () => {
      const image = writeValidImage(dir);
      const info = readImageInfo(image.path);
      // Flip a byte inside the first block's compressed payload.
      const corruptOffset = info.dataOffset + 16 + 4;
      const fd = fs.openSync(image.path, 'r+');
      const data = Buffer.from([0xff]);
      fs.writeSync(fd, data, 0, 1, corruptOffset);
      fs.closeSync(fd);

      const result = await verifyImage(image.path);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/CRC mismatch|Failed to decompress/i);
    });

    it('reports block count mismatch when a frame is removed', async () => {
      const image = writeValidImage(dir);
      const info = readImageInfo(image.path);
      // Truncate the file so the last frame is gone.
      const lastBlock = info.blocks[info.blocks.length - 1];
      fs.truncateSync(image.path, lastBlock.fileOffset);

      const result = await verifyImage(image.path);
      expect(result.ok).toBe(false);
    });
  });

  describe('encryption', () => {
    it('derives a deterministic key from passphrase + salt', () => {
      const salt = Buffer.alloc(SALT_LENGTH, 7);
      const k1 = deriveImageKey('hunter2', salt, 1000);
      const k2 = deriveImageKey('hunter2', salt, 1000);
      const k3 = deriveImageKey('hunter3', salt, 1000);
      expect(k1).toEqual(k2);
      expect(k1).not.toEqual(k3);
      expect(k1.length).toBe(32);
    });

    it('newImageCipher produces a random salt per call', () => {
      const a = newImageCipher('pass');
      const b = newImageCipher('pass');
      expect(a.salt).not.toEqual(b.salt);
      expect(a.cipherId).toBe(CIPHER_AES256_GCM);
      expect(a.kdfIterations).toBeGreaterThan(1000);
    });

    it('round-trips encrypted frames via encodeBlockFrame + verifyImage with key', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-enc-'));
      try {
        const imagePath = path.join(dir2, 'enc.opbs');
        const cipher = newImageCipher('correct horse');
        const raw = randomData(2048);
        const comp = zlib.deflateRawSync(raw);
        const frame = encodeBlockFrame(raw, comp, cipher);
        expect(frame.length).toBe(16 + GCM_IV_LENGTH + GCM_TAG_LENGTH + comp.length);

        const partitions: PartitionEntryMeta[] = [
          { partitionIndex: 0, size: raw.length, offsetOnDisk: 4096, firstBlockFileOffset: 0, blockCount: 1 }
        ];
        const header: ImageHeader = {
          version: IMAGE_VERSION,
          timestamp: Date.now(),
          totalBytes: raw.length,
          blockSize: 2048,
          compressionId: COMPRESSION_DEFLATE,
          partitionCount: 1,
          flags: FLAG_HAS_BLOCK_INDEX,
          blockIndexOffset: 0,
          cipherId: cipher.cipherId,
          kdfIterations: cipher.kdfIterations,
          salt: cipher.salt,
          baseImagePath: ''
        };

        const fd = fs.openSync(imagePath, 'w+');
        fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
        fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
        const dataOffset = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
        fs.writeSync(fd, frame, 0, frame.length, dataOffset);
        const block: BlockRecord = {
          partitionIndex: 0,
          blockIndex: 0,
          fileOffset: dataOffset,
          rawSize: raw.length,
          compSize: comp.length,
          rawCrc32: crc32(raw)
        };
        const indexOffset = dataOffset + frame.length;
        const countBuf = Buffer.alloc(8);
        countBuf.writeBigUInt64LE(1n);
        fs.writeSync(fd, countBuf, 0, 8, indexOffset);
        fs.writeSync(fd, encodeBlockIndexEntry(block), 0, BLOCK_INDEX_ENTRY_SIZE, indexOffset + 8);
        const patch = Buffer.alloc(HEADER_SIZE);
        fs.readSync(fd, patch, 0, HEADER_SIZE, 0);
        patch.writeBigUInt64LE(BigInt(indexOffset), 40);
        fs.writeSync(fd, patch, 0, HEADER_SIZE, 0);
        const entry = encodePartitionEntry(partitions[0]);
        fs.writeSync(fd, entry, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
        fs.closeSync(fd);

        // Verify without a key must fail with a passphrase error.
        const noKey = await verifyImage(imagePath);
        expect(noKey.ok).toBe(false);
        expect(noKey.error).toMatch(/passphrase/i);

        // Verify with the right key must pass.
        const key = deriveImageKey('correct horse', cipher.salt, cipher.kdfIterations);
        const ok = await verifyImage(imagePath, key);
        expect(ok.ok).toBe(true);
        expect(ok.blocksVerified).toBe(1);

        // Wrong key must fail on auth/CRC, not crash.
        const wrongKey = deriveImageKey('bad horse', cipher.salt, cipher.kdfIterations);
        const bad = await verifyImage(imagePath, wrongKey);
        expect(bad.ok).toBe(false);
      } finally {
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    it('rejects tampered encrypted data via GCM auth', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-enc-'));
      try {
        const imagePath = path.join(dir2, 'tamper.opbs');
        const cipher = newImageCipher('secret');
        const raw = randomData(1500);
        const comp = zlib.deflateRawSync(raw);
        const frame = encodeBlockFrame(raw, comp, cipher);

        const header: ImageHeader = {
          version: IMAGE_VERSION,
          timestamp: Date.now(),
          totalBytes: raw.length,
          blockSize: 2048,
          compressionId: COMPRESSION_DEFLATE,
          partitionCount: 0,
          flags: 0,
          blockIndexOffset: 0,
          cipherId: CIPHER_AES256_GCM,
          kdfIterations: cipher.kdfIterations,
          salt: cipher.salt,
          baseImagePath: ''
        };
        const fd = fs.openSync(imagePath, 'w+');
        fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
        fs.writeSync(fd, frame, 0, frame.length, HEADER_SIZE);
        fs.closeSync(fd);

        // Flip a byte in the ciphertext.
        const ctext = HEADER_SIZE + 16 + GCM_IV_LENGTH + GCM_TAG_LENGTH;
        const tamperFd = fs.openSync(imagePath, 'r+');
        fs.writeSync(tamperFd, Buffer.from([0x00]), 0, 1, ctext);
        fs.closeSync(tamperFd);

        const key = deriveImageKey('secret', cipher.salt, cipher.kdfIterations);
        const result = await verifyImage(imagePath, key);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/authenticat/i);
      } finally {
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });
  });

  describe('defaults', () => {
    it('maps a compression level to an id', () => {
      expect(getCompressionId(0)).toBe(0);
      expect(getCompressionId(1)).toBe(COMPRESSION_DEFLATE);
      expect(getCompressionId(9)).toBe(COMPRESSION_DEFLATE);
      expect(getCompressionId(3, 'zstd')).toBe(COMPRESSION_ZSTD);
      expect(getCompressionId(0, 'zstd')).toBe(0);
      expect(getCompressionId(2, 'deflate')).toBe(COMPRESSION_DEFLATE);
    });

    it('builds a timestamped image path', () => {
      const p = defaultImagePath('C:\\backups', 0, new Date('2026-09-07T10:15:30.000Z').getTime());
      expect(p).toMatch(/^C:\\backups\\opbs-disk0-2026-09-07T10-15-30\.opbs$/);
      expect(DEFAULT_BLOCK_SIZE).toBe(1024 * 1024);
    });
  });

  describe('scanPartialImage', () => {
    // Partitions in array order; real disk partition indices differ from slots.
    const partitions = [
      { partitionIndex: 2, size: 1024 * 2 },
      { partitionIndex: 4, size: 1024 * 4 }
    ];
    const tableSize = partitions.length * PARTITION_TABLE_ENTRY_SIZE;
    const dataStart = HEADER_SIZE + tableSize;

    // Writes a header + zero table and then `fullPartitions` completed
    // partitions (no block index), optionally followed by `partialFrames`
    // frames of the next partition. Returns the exact boundary offsets so
    // assertions never depend on compressed sizes.
    function writePartialImage(
      imagePath: string,
      fullPartitions: number,
      partialFrames: number
    ): { perPartitionEnds: number[] } {
      const blockSize = 1024;
      const header: ImageHeader = {
        version: IMAGE_VERSION,
        timestamp: Date.now(),
        totalBytes: blockSize * 6,
        blockSize,
        compressionId: COMPRESSION_DEFLATE,
        partitionCount: partitions.length,
        flags: FLAG_HAS_BLOCK_INDEX,
        blockIndexOffset: 0,
        cipherId: CIPHER_NONE,
        kdfIterations: 0,
        salt: Buffer.alloc(SALT_LENGTH),
        baseImagePath: ''
      };
      const fd = fs.openSync(imagePath, 'w+');
      fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
      fs.writeSync(fd, Buffer.alloc(tableSize), 0, tableSize, HEADER_SIZE);

      const framesFor = (partitionIndex: number): number => partitions[partitionIndex].size / 1024;
      function writeFrames(count: number): void {
        for (let b = 0; b < count; b++) {
          const raw = randomData(1024);
          const comp = compressBlock(raw, COMPRESSION_DEFLATE, 3);
          const frame = encodeBlockFrame(raw, comp);
          fs.writeSync(fd, frame, 0, frame.length, cursor);
          cursor += frame.length;
        }
      }
      const perPartitionEnds: number[] = [];
      let cursor = dataStart;
      for (let p = 0; p < fullPartitions; p++) {
        writeFrames(framesFor(p));
        perPartitionEnds.push(cursor);
      }
      writeFrames(partialFrames);
      fs.closeSync(fd);
      return { perPartitionEnds };
    }

    it('reports complete for an image with a block index', () => {
      const { path: completePath } = writeValidImage(dir, 1024);
      const scan = scanPartialImage(completePath, partitions, 1024);
      expect(scan.complete).toBe(true);
      expect(scan.blocks.length).toBe(0);
    });

    it('rejects a file too small to hold the header', () => {
      const p = path.join(dir, 'tiny.opbs');
      fs.writeFileSync(p, Buffer.alloc(16));
      expect(() => scanPartialImage(p, partitions, 1024)).toThrow(/too small/i);
    });

    it('recovers an interrupted partition-0 prefix and no completed partitions', () => {
      const p = path.join(dir, 'partial0.opbs');
      writePartialImage(p, 0, 1);
      const scan = scanPartialImage(p, partitions, 1024);
      expect(scan.complete).toBe(false);
      expect(scan.completedPartitions).toBe(0);
      expect(scan.blocks.length).toBe(1);
      expect(scan.blocks[0].partitionIndex).toBe(2); // real disk index, not slot
      expect(scan.blocks[0].blockIndex).toBe(0);
      expect(scan.partitionStartOffsets[0]).toBe(dataStart);
    });

    it('recovers completed partition 0 with the correct resume cursor', () => {
      const p = path.join(dir, 'partial1.opbs');
      const { perPartitionEnds } = writePartialImage(p, 1, 0);
      const scan = scanPartialImage(p, partitions, 1024);
      expect(scan.complete).toBe(false);
      expect(scan.completedPartitions).toBe(1);
      expect(scan.blocks.length).toBe(2);
      expect(scan.blocks.map((b) => b.partitionIndex)).toEqual([2, 2]);
      expect(scan.blocks.map((b) => b.blockIndex)).toEqual([0, 1]);
      // Cursor is exactly partition 1's first-frame offset so a resumed run
      // appends there without gaps.
      expect(scan.cursor).toBe(perPartitionEnds[0]);
      expect(scan.partitionStartOffsets[1]).toBe(perPartitionEnds[0]);
    });

    it('recovers multiple completed partitions mapping to real indices', () => {
      const p = path.join(dir, 'patch2.opbs');
      const { perPartitionEnds } = writePartialImage(p, 2, 0);
      const scan = scanPartialImage(p, partitions, 1024);
      expect(scan.complete).toBe(false);
      expect(scan.completedPartitions).toBe(2);
      expect(scan.blocks.length).toBe(6);
      expect(scan.blocks.slice(0, 2).map((b) => b.partitionIndex)).toEqual([2, 2]);
      expect(scan.blocks.slice(2).map((b) => b.partitionIndex)).toEqual([4, 4, 4, 4]);
      expect(scan.partitionStartOffsets[1]).toBe(perPartitionEnds[0]);
      expect(scan.cursor).toBe(perPartitionEnds[1]);
    });

    it('stops at a truncated tail and still recovers completed partitions', () => {
      const p = path.join(dir, 'truncated.opbs');
      const { perPartitionEnds } = writePartialImage(p, 1, 1);
      // Truncate the file inside the incomplete partition's first frame.
      fs.truncateSync(p, perPartitionEnds[0] + 8);
      const scan = scanPartialImage(p, partitions, 1024);
      expect(scan.complete).toBe(false);
      expect(scan.completedPartitions).toBe(1);
      expect(scan.blocks.length).toBe(2);
      // Cursor is the start of the truncated frame: partition 0's end.
      expect(scan.cursor).toBe(perPartitionEnds[0]);
      expect(scan.resumePartitionFrames).toBe(0);
    });

    it('stops at a corrupt payload (CRC mismatch) without losing prior frames', () => {
      const p = path.join(dir, 'crc.opbs');
      const { perPartitionEnds } = writePartialImage(p, 1, 1);
      // Flip a byte inside the incomplete partition's payload. The scan has
      // already validated partition 0, so it should stop at that frame's start
      // rather than scanning garbage.
      const partialStart = perPartitionEnds[0];
      const fd = fs.openSync(p, 'r+');
      fs.writeSync(fd, Buffer.from([0x00]), 0, 1, partialStart + 18);
      fs.closeSync(fd);
      const scan = scanPartialImage(p, partitions, 1024);
      expect(scan.complete).toBe(false);
      expect(scan.completedPartitions).toBe(1);
      expect(scan.blocks.length).toBe(2);
      expect(scan.cursor).toBe(partialStart);
      expect(scan.resumePartitionFrames).toBe(0);
    });
  });
});

describe('readImageInfo (multi-volume)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mv-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the block index from the last volume when the base header offset is 0', () => {
    const base = path.join(dir, 'mv.opbs');
    const last = `${base}.001`;
    const blockSize = 1024;
    const partition: PartitionEntryMeta = {
      partitionIndex: 0,
      size: blockSize * 2,
      offsetOnDisk: 0,
      firstBlockFileOffset: 0,
      blockCount: 2
    };

    const writeVolume = (p: string, blockIndexOffset: number, withIndex: boolean): void => {
      const header: ImageHeader = {
        version: IMAGE_VERSION,
        timestamp: Date.now(),
        totalBytes: blockSize * 2,
        blockSize,
        compressionId: COMPRESSION_DEFLATE,
        partitionCount: 1,
        flags: FLAG_HAS_BLOCK_INDEX | FLAG_MULTI_VOLUME,
        blockIndexOffset
      };
      const fd = fs.openSync(p, 'w+');
      fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
      fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
      if (withIndex) {
        const blocks: BlockRecord[] = [
          { partitionIndex: 0, blockIndex: 0, fileOffset: 0, rawSize: blockSize, compSize: 10, rawCrc32: 1 },
          { partitionIndex: 0, blockIndex: 1, fileOffset: 0, rawSize: blockSize, compSize: 10, rawCrc32: 2 }
        ];
        let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
        const countBuf = Buffer.alloc(8);
        countBuf.writeBigUInt64LE(BigInt(blocks.length));
        fs.writeSync(fd, countBuf, 0, 8, cursor);
        cursor += 8;
        for (const b of blocks) {
          fs.writeSync(fd, encodeBlockIndexEntry(b), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
          cursor += BLOCK_INDEX_ENTRY_SIZE;
        }
      }
      fs.closeSync(fd);
    };

    // The base volume's header has blockIndexOffset 0 (only the LAST volume's
    // header is patched once the index is written) — the classic multi-volume
    // browse bug: reading the base header alone finds no block index.
    writeVolume(base, 0, false);
    const indexOffset = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
    writeVolume(last, indexOffset, true);

    clearImageInfoCache();
    const info = readImageInfo(base);
    expect(info.header.blockIndexOffset).toBe(indexOffset);
    expect(info.blocks).toHaveLength(2);
    expect(info.blocks[0].partitionIndex).toBe(0);
  });

  it('verifies frames across every volume of a multi-volume image', async () => {
    const base = path.join(dir, 'mv-verify.opbs');
    const last = `${base}.001`;
    const blockSize = 1024;
    const partition: PartitionEntryMeta = {
      partitionIndex: 0,
      size: blockSize * 3,
      offsetOnDisk: 0,
      firstBlockFileOffset: 0,
      blockCount: 3
    };
    const blocks: BlockRecord[] = [];

    const writeVolume = (p: string, frameCount: number, withIndex: boolean): void => {
      const fd = fs.openSync(p, 'w+');
      let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
      const header: ImageHeader = {
        version: IMAGE_VERSION,
        timestamp: Date.now(),
        totalBytes: blockSize * 3,
        blockSize,
        compressionId: COMPRESSION_NONE,
        partitionCount: 1,
        flags: FLAG_HAS_BLOCK_INDEX | FLAG_MULTI_VOLUME,
        blockIndexOffset: 0
      };
      fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
      fs.writeSync(fd, encodePartitionEntry(partition), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
      for (let i = 0; i < frameCount; i++) {
        const raw = randomData(blockSize);
        const comp = compressBlock(raw, COMPRESSION_NONE, 0);
        const frame = encodeBlockFrame(raw, comp);
        fs.writeSync(fd, frame, 0, frame.length, cursor);
        blocks.push({
          partitionIndex: 0,
          blockIndex: blocks.length,
          fileOffset: cursor,
          rawSize: raw.length,
          compSize: comp.length,
          rawCrc32: crc32(raw)
        });
        cursor += frame.length;
      }
      if (withIndex) {
        const indexOffset = cursor;
        const countBuf = Buffer.alloc(8);
        countBuf.writeBigUInt64LE(BigInt(blocks.length));
        fs.writeSync(fd, countBuf, 0, 8, cursor);
        cursor += 8;
        for (const b of blocks) {
          fs.writeSync(fd, encodeBlockIndexEntry(b), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
          cursor += BLOCK_INDEX_ENTRY_SIZE;
        }
        const patch = Buffer.alloc(HEADER_SIZE);
        fs.readSync(fd, patch, 0, HEADER_SIZE, 0);
        patch.writeBigUInt64LE(BigInt(indexOffset), 40);
        fs.writeSync(fd, patch, 0, HEADER_SIZE, 0);
      }
      fs.closeSync(fd);
    };

    writeVolume(base, 2, false);
    writeVolume(last, 1, true);

    clearImageInfoCache();
    const result = await verifyImage(base);
    expect(result.ok).toBe(true);
    expect(result.blocksVerified).toBe(3);
  });
});