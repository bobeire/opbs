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
  IMAGE_VERSION,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_INCREMENTAL,
  COMPRESSION_ZSTD,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';
import { planRetention, applyRetention, RetentionPlan, BackupImageEntry } from '../../src/main/backup/retention';

const BLOCK = 64 * 1024;
const DAY = 24 * 3600 * 1000;

function writeImage(
  imagePath: string,
  raw: Buffer,
  timestamp: number,
  opts: { base?: string; serial: string; model: string; verified?: boolean } = { serial: 'SN', model: 'Disk', verified: false }
): void {
  const blockSize = BLOCK;
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
    compressionId: COMPRESSION_ZSTD,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX | (opts.base ? FLAG_INCREMENTAL : 0) | (opts.verified ? 0x2 : 0),
    blockIndexOffset: 0,
    cipherId: 0,
    kdfIterations: 0,
    salt: Buffer.alloc(16),
    baseImagePath: opts.base ?? '',
    sourceDiskModel: opts.model,
    sourceDiskSerial: opts.serial
  };

  const fd = fs.openSync(imagePath, 'w+');
  fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
  fs.writeSync(fd, Buffer.alloc(PARTITION_TABLE_ENTRY_SIZE), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE);

  const blocks: BlockRecord[] = [];
  let cursor = HEADER_SIZE + PARTITION_TABLE_ENTRY_SIZE;
  for (let b = 0; b < partition.blockCount; b++) {
    const start = b * blockSize;
    const blockRaw = raw.subarray(start, Math.min(start + blockSize, raw.length));
    const comp = compressBlock(blockRaw, COMPRESSION_ZSTD, 3);
    const frame = encodeBlockFrame(blockRaw, comp);
    fs.writeSync(fd, frame, 0, frame.length, cursor);
    blocks.push({
      partitionIndex: 0,
      blockIndex: b,
      fileOffset: cursor,
      rawSize: blockRaw.length,
      compSize: frame.length - 16,
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
}

function makeRaw(blocks: number): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 5 + 3) & 0xff;
  return raw;
}

/**
 * Two source disks, each with an old full→delta chain (SN-A older, SN-B newer,
 * both already verified).
 */
async function populateTwoLineages(dir: string): Promise<{ a0: string; a1: string; b0: string; b1: string }> {
  const a0 = path.join(dir, 'C0000000.opbs');
  const a1 = path.join(dir, 'C0000001.opbs');
  const b0 = path.join(dir, 'C0000002.opbs');
  const b1 = path.join(dir, 'C0000003.opbs');
  writeImage(a0, makeRaw(1), Date.now() - 40 * DAY, { serial: 'SN-A', model: 'DiskA', verified: true });
  writeImage(a1, makeRaw(1), Date.now() - 38 * DAY, { base: a0, serial: 'SN-A', model: 'DiskA', verified: true });
  writeImage(b0, makeRaw(1), Date.now() - 10 * DAY, { serial: 'SN-B', model: 'DiskB', verified: true });
  writeImage(b1, makeRaw(1), Date.now() - 8 * DAY, { base: b0, serial: 'SN-B', model: 'DiskB', verified: true });
  return { a0, a1, b0, b1 };
}

describe('age-aware retention lineage guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-guard-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rescues the last surviving restore point of a source disk about to be fully pruned', async () => {
    const { a0, a1, b0, b1 } = await populateTwoLineages(dir);
    const plan = planRetention(dir, { keepFull: 1, keepDeltasPerFull: 1 });

    const kept = plan.keep.map((e) => e.path);
    expect(kept).toContain(a0); // rescued
    expect(kept).toContain(b0);
    expect(kept).toContain(b1);
    expect(plan.prune.map((e) => e.path)).toEqual([a1]);
    expect(plan.reason[a0]).toContain('last surviving backup');
    expect(plan.reminders.some((r) => r.includes('SN-A'))).toBe(true);
  });

  it('does not rescue when the lineage still has a surviving chain', async () => {
    // Same source disk (SN-X) for both chains — the newer chain survives, so
    // the older chain is pruned normally and no rescue reminder fires.
    const a0 = path.join(dir, 'C0000000.opbs');
    const a1 = path.join(dir, 'C0000001.opbs');
    const b0 = path.join(dir, 'C0000002.opbs');
    const b1 = path.join(dir, 'C0000003.opbs');
    writeImage(a0, makeRaw(1), Date.now() - 40 * DAY, { serial: 'SN-X', model: 'DiskX', verified: true });
    writeImage(a1, makeRaw(1), Date.now() - 38 * DAY, { base: a0, serial: 'SN-X', model: 'DiskX', verified: true });
    writeImage(b0, makeRaw(1), Date.now() - 10 * DAY, { serial: 'SN-X', model: 'DiskX', verified: true });
    writeImage(b1, makeRaw(1), Date.now() - 8 * DAY, { base: b0, serial: 'SN-X', model: 'DiskX', verified: true });
    const plan = planRetention(dir, { keepFull: 1, keepDeltasPerFull: 1 });

    const kept = plan.keep.map((e) => e.path);
    const pruned = plan.prune.map((e) => e.path);
    // The newer chain is kept; the old chain is fully pruned (lineage survives).
    expect(kept).toContain(b0);
    expect(kept).toContain(b1);
    expect(pruned).toContain(a0);
    expect(plan.reminders.some((r) => r.includes('lone surviving'))).toBe(false);
  });

  it('guards every lineage when keepFull is 0', async () => {
    const { a0, b0, b1 } = await populateTwoLineages(dir);
    const plan = planRetention(dir, { keepFull: 0, keepDeltasPerFull: 0 });

    const kept = plan.keep.map((e) => e.path);
    expect(kept).toContain(a0);
    expect(kept).toContain(b0);
    // Only the newest chain root of each lineage is rescued; their deltas go.
    expect(plan.prune.map((e) => e.path)).toContain(b1);
    expect(plan.reminders.some((r) => r.includes('keepFull is 0'))).toBe(true);
  });

  it('leaves the rescued full on disk after applyRetention', async () => {
    const { a0, a1, b0, b1 } = await populateTwoLineages(dir);
    const plan = await applyRetention(dir, { keepFull: 1, keepDeltasPerFull: 1 });

    expect(fs.existsSync(a0)).toBe(true);
    expect(fs.existsSync(a1)).toBe(false);
    expect(fs.existsSync(b0)).toBe(true);
    expect(fs.existsSync(b1)).toBe(true);
    void plan;
  });

  it('reminds when unverified images are pruned, but not for encrypted ones', async () => {
    const entries: BackupImageEntry[] = [
      {
        path: path.join(dir, 'C0000000.opbs'),
        name: 'C0000000.opbs',
        timestamp: Date.now() - 60 * DAY,
        size: 1000,
        incremental: false,
        encrypted: false,
        verified: false
      },
      {
        path: path.join(dir, 'C0000002.opbs'),
        name: 'C0000002.opbs',
        timestamp: Date.now() - 5 * DAY,
        size: 1000,
        incremental: false,
        encrypted: false,
        verified: true
      }
    ];
    const plan = planRetention(entries, { keepFull: 1, keepDeltasPerFull: 0 });
    expect(plan.prune.map((e) => e.name)).toContain('C0000000.opbs');
    expect(plan.reminders.some((r) => r.includes('unverified'))).toBe(true);

    const encryptedEntries = entries.map((e) => ({ ...e, encrypted: true, name: e.name }));
    const planEncrypted = planRetention(encryptedEntries, { keepFull: 1, keepDeltasPerFull: 0 });
    expect(planEncrypted.reminders.some((r) => r.includes('unverified'))).toBe(false);
  });
});