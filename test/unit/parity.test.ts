import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  encodeBlockFrame,
  compressBlock,
  crc32,
  readImageInfo,
  verifyImage,
  deriveImageKey,
  newImageCipher,
  metadataFromCipher,
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  COMPRESSION_ZSTD,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';
import {
  buildParity,
  verifyParity,
  repairParityBlock,
  paritySidecarPath,
  PARITY_GROUP_SIZE
} from '../../src/main/imaging/parity';
import { classifyImage } from '../../src/main/imaging/scrub';

const BLOCK = 64 * 1024;

function writeImageFromBytes(
  imagePath: string,
  raw: Buffer,
  blockSize: number,
  compressionId = COMPRESSION_ZSTD,
  timestamp = Date.now(),
  cipher?: { cipherId: number; salt: Buffer; kdfIterations: number; key: Buffer }
): BlockRecord[] {
  const partition: PartitionEntryMeta = {
    partitionIndex: 0,
    size: raw.length,
    offsetOnDisk: 0,
    firstBlockFileOffset: 0,
    blockCount: Math.ceil(raw.length / blockSize)
  };
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp,
    totalBytes: raw.length,
    blockSize,
    compressionId,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX,
    blockIndexOffset: 0,
    cipherId: cipher?.cipherId ?? 0,
    kdfIterations: cipher?.kdfIterations ?? 0,
    salt: cipher?.salt ?? Buffer.alloc(16),
    baseImagePath: '',
    sourceDiskModel: '',
    sourceDiskSerial: ''
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
    const frame = encodeBlockFrame(blockRaw, comp, cipher ?? null);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    blocks.push({
      partitionIndex: 0,
      blockIndex: b,
      fileOffset: cursor,
      rawSize: blockRaw.length,
      compSize: cipher ? comp.length : frame.length - 16,
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

function makeRaw(blocks: number, seed = 3): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * seed + 7) & 0xff;
  return raw;
}

function corruptFrame(imagePath: string, block: BlockRecord, byteOffset: number): void {
  const fd = fs.openSync(imagePath, 'r+');
  const pos = block.fileOffset + 16 + byteOffset;
  const buf = Buffer.alloc(1);
  fs.readSync(fd, buf, 0, 1, pos);
  buf[0] = buf[0] ^ 0xff;
  fs.writeSync(fd, buf, 0, 1, pos);
  fs.closeSync(fd);
}

describe('parity (XOR repair)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-parity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds a sidecar and verifies cleanly', () => {
    const imagePath = path.join(dir, 'img.opbs');
    writeImageFromBytes(imagePath, makeRaw(40), BLOCK);

    const report = buildParity(imagePath);
    expect(report.groups).toBeGreaterThan(0);
    expect(report.blocksProtected).toBe(40);
    expect(fs.existsSync(paritySidecarPath(imagePath))).toBe(true);
    expect(verifyParity(imagePath).ok).toBe(true);
  });

  it('detects a corrupted block and repairs it back to the exact stored bytes', async () => {
    const imagePath = path.join(dir, 'img.opbs');
    const blocks = writeImageFromBytes(imagePath, makeRaw(40), BLOCK);
    buildParity(imagePath);

    const victim = blocks[5];
    corruptFrame(imagePath, victim, 10);

    expect(verifyParity(imagePath).ok).toBe(false);
    const before = classifyImage(imagePath);
    const bad = before.checks.find((c) => c.blockIndex === 5);
    expect(bad?.ok).toBe(false);
    expect(before.checks.filter((c) => !c.ok).length).toBe(1);

    const repair = repairParityBlock(imagePath, 5);
    expect(repair.repaired).toBe(true);

    const after = classifyImage(imagePath);
    expect(after.checks.filter((c) => !c.ok).length).toBe(0);
    const verified = await verifyImage(imagePath);
    expect(verified.ok).toBe(true);
    expect(verifyParity(imagePath).ok).toBe(true);
  });

  it('repairs without needing a passphrase for encrypted images', async () => {
    const imagePath = path.join(dir, 'enc.opbs');
    const passphrase = 'correct horse battery staple';
    const cipher = newImageCipher(passphrase);
    const meta = metadataFromCipher(cipher);
    const raw = makeRaw(6, 11);
    const blocks = writeImageFromBytes(imagePath, raw, BLOCK, COMPRESSION_ZSTD, Date.now(), {
      cipherId: meta.cipherId,
      salt: Buffer.from(meta.saltHex, 'hex'),
      kdfIterations: meta.kdfIterations,
      key: cipher.key
    });
    buildParity(imagePath);

    const victim = blocks[2];
    corruptFrame(imagePath, victim, 20);

    // Key-less detect: frame-level structural scan flags corruption but cannot
    // decompress; either way repair must not need the key.
    const repair = repairParityBlock(imagePath, victim.blockIndex);
    expect(repair.repaired).toBe(true);

    // Confirm with the key: the repaired image verifies and raw data intact.
    const key = deriveImageKey(passphrase, readImageInfo(imagePath).header.salt, meta.kdfIterations);
    const verified = await verifyImage(imagePath, key);
    expect(verified.ok).toBe(true);
    const after = classifyImage(imagePath, passphrase);
    expect(after.checks.filter((c) => !c.ok).length).toBe(0);
    expect(verifyParity(imagePath).ok).toBe(true);
  });

  it('refuses repair when two blocks in a group are damaged', () => {
    const imagePath = path.join(dir, 'img.opbs');
    const blocks = writeImageFromBytes(imagePath, makeRaw(40), BLOCK);
    buildParity(imagePath);

    const a = blocks[0];
    const b = blocks[1];
    corruptFrame(imagePath, a, 5);
    corruptFrame(imagePath, b, 5);

    expect(() => repairParityBlock(imagePath, a.blockIndex)).toThrow();
    const scan = classifyImage(imagePath);
    expect(scan.checks.filter((c) => !c.ok).length).toBe(2);
  });

  it('is self-consistent with the PAR2-style group size', () => {
    const imagePath = path.join(dir, 'img.opbs');
    writeImageFromBytes(imagePath, makeRaw(PARITY_GROUP_SIZE + 2), BLOCK);
    const report = buildParity(imagePath);
    expect(report.groups).toBe(2);
    expect(report.blocksProtected).toBe(PARITY_GROUP_SIZE + 2);
  });
});