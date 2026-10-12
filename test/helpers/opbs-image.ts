import * as fs from 'fs';
import {
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  encodeBlockFrame,
  compressBlock,
  crc32,
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_INCREMENTAL,
  FLAG_MULTI_VOLUME,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  COMPRESSION_ZSTD,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader,
  ImageCipher
} from '../../src/main/imaging/image-format';

/** Write a .opbs image whose single partition holds `raw` bytes. */
export function writeImageFromBytes(
  imagePath: string,
  raw: Buffer,
  blockSize: number,
  compressionId = COMPRESSION_ZSTD,
  opts?: { cipher?: ImageCipher; baseImagePath?: string; timestamp?: number }
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
    timestamp: opts?.timestamp ?? Date.now(),
    totalBytes: raw.length,
    blockSize,
    compressionId,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX | (opts?.baseImagePath ? FLAG_INCREMENTAL : 0),
    blockIndexOffset: 0,
    cipherId: opts?.cipher ? opts.cipher.cipherId : 0,
    kdfIterations: opts?.cipher ? opts.cipher.kdfIterations : 0,
    salt: opts?.cipher ? opts.cipher.salt : Buffer.alloc(16),
    baseImagePath: opts?.baseImagePath ?? ''
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
    const frame = encodeBlockFrame(blockRaw, comp, opts?.cipher);
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

/**
 * Write a multi-volume .opbs image the way runBackupJob lays one out: header +
 * partition table at the start of every volume, frames rolled into `.001`,
 * `.002`, ... when the current volume would exceed `maxVolumeSize`, offsets
 * volume-relative, block index at the end of the last volume (only the last
 * volume's header gets the index offset). Returns the block records with
 * `volumeIndex` set.
 */
export function writeMultiVolumeImage(
  imagePath: string,
  raw: Buffer,
  blockSize: number,
  maxVolumeSize: number,
  opts?: { compressionId?: number; cipher?: ImageCipher; timestamp?: number }
): BlockRecord[] {
  const compressionId = opts?.compressionId ?? COMPRESSION_ZSTD;
  const partition: PartitionEntryMeta = {
    partitionIndex: 0,
    size: raw.length,
    offsetOnDisk: 0,
    firstBlockFileOffset: 0,
    blockCount: Math.ceil(raw.length / blockSize)
  };
  const header: ImageHeader = {
    version: IMAGE_VERSION,
    timestamp: opts?.timestamp ?? Date.now(),
    totalBytes: raw.length,
    blockSize,
    compressionId,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX | FLAG_MULTI_VOLUME,
    blockIndexOffset: 0,
    cipherId: opts?.cipher ? opts.cipher.cipherId : 0,
    kdfIterations: opts?.cipher ? opts.cipher.kdfIterations : 0,
    salt: opts?.cipher ? opts.cipher.salt : Buffer.alloc(16),
    baseImagePath: '',
    sourceDiskModel: '',
    sourceDiskSerial: '',
    maxVolumeSize
  };

  const dataOffset = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
  const volumePath = (v: number): string =>
    v === 0 ? imagePath : `${imagePath}.${String(v).padStart(3, '0')}`;
  const volumePaths: string[] = [imagePath];

  const writeVolumeHead = (fd: number): void => {
    fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
    fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
  };

  let volume = 0;
  let fd = fs.openSync(volumePath(volume), 'w+');
  writeVolumeHead(fd);
  let cursor = dataOffset;
  partition.firstBlockFileOffset = cursor;

  const blocks: BlockRecord[] = [];
  for (let b = 0; b < partition.blockCount; b++) {
    const start = b * blockSize;
    const blockRaw = raw.subarray(start, Math.min(start + blockSize, raw.length));
    const comp = compressBlock(blockRaw, compressionId, 3);
    const frame = encodeBlockFrame(blockRaw, comp, opts?.cipher);

    // Same roll condition as runBackupJob: never split a frame across volumes.
    if (cursor + frame.length > maxVolumeSize && cursor > dataOffset) {
      fs.closeSync(fd);
      volume++;
      volumePaths.push(volumePath(volume));
      fd = fs.openSync(volumePath(volume), 'w+');
      writeVolumeHead(fd);
      cursor = dataOffset;
    }

    fs.writeSync(fd, frame, 0, frame.length, cursor);
    blocks.push({
      partitionIndex: 0,
      blockIndex: b,
      fileOffset: cursor,
      rawSize: blockRaw.length,
      compSize: comp.length,
      rawCrc32: crc32(blockRaw),
      volumeIndex: volume
    });
    cursor += frame.length;
  }

  // Block index at the end of the last volume, then patch that volume's
  // header (index offset) and partition table.
  const blockIndexOffset = cursor;
  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(blocks.length));
  fs.writeSync(fd, countBuf, 0, 8, cursor);
  cursor += 8;
  for (const block of blocks) {
    fs.writeSync(fd, encodeBlockIndexEntry(block), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
    cursor += BLOCK_INDEX_ENTRY_SIZE;
  }
  const tableEntry = encodePartitionEntry(partition);
  fs.writeSync(fd, tableEntry, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
  const patched = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
  patched.writeBigUInt64LE(BigInt(blockIndexOffset), 40);
  fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);

  // Earlier volumes keep header.blockIndexOffset = 0 (readImageInfo redirects
  // to the last volume); they only need the real partition table.
  for (let v = 0; v < volumePaths.length - 1; v++) {
    const vfd = fs.openSync(volumePaths[v], 'r+');
    fs.writeSync(vfd, tableEntry, 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);
    fs.closeSync(vfd);
  }

  return blocks;
}
