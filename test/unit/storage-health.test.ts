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
  FLAG_VERIFIED,
  COMPRESSION_ZSTD,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  BLOCK_INDEX_ENTRY_SIZE,
  PartitionEntryMeta,
  BlockRecord,
  ImageHeader
} from '../../src/main/imaging/image-format';
import {
  buildStorageHealthReport,
  computeReliabilityScore,
  ReliabilitySignals,
  StorageHealthReport
} from '../../src/main/utils/storage-health';

const BLOCK = 64 * 1024;

function writeImage(
  imagePath: string,
  raw: Buffer,
  blockSize: number,
  timestamp: number,
  baseImagePath = '',
  verified = false
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
    compressionId: COMPRESSION_ZSTD,
    partitionCount: 1,
    flags: FLAG_HAS_BLOCK_INDEX | (baseImagePath ? FLAG_INCREMENTAL : 0) | (verified ? FLAG_VERIFIED : 0),
    blockIndexOffset: 0,
    cipherId: 0,
    kdfIterations: 0,
    salt: Buffer.alloc(16),
    baseImagePath,
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

  return blocks;
}

function makeRaw(blocks: number): Buffer {
  const raw = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 3 + 7) & 0xff;
  return raw;
}

function healthySignals(overrides: Partial<ReliabilitySignals> = {}): ReliabilitySignals {
  return {
    reachable: true,
    imageCount: 2,
    verifiedImages: 2,
    parityProtectedImages: 2,
    brokenChains: 0,
    tamperDrift: false,
    newestDate: Date.now() - 60 * 60 * 1000,
    freeBytes: 500_000_000,
    totalBytes: 1_000_000_000,
    smartOk: true,
    scrubFailed: false,
    hasDrill: true,
    ...overrides
  };
}

const FAKE_DEPS = {
  resolveDisk: async () => ({ diskIndex: 0, driveLetter: 'C' }),
  querySmart: () => ({
    model: 'TestDrive',
    healthStatus: 'Healthy',
    temperatureCelsius: 30,
    wear: 5,
    unreliableSectors: 0
  })
};

async function writeHealthyDest(dir: string): Promise<{ full: string; delta: string }> {
  const full = path.join(dir, 'C0000000.opbs');
  const delta = path.join(dir, 'C0000001.opbs');
  writeImage(full, makeRaw(2), BLOCK, Date.now() - 3600_000, '', true);
  writeImage(delta, makeRaw(1), BLOCK, Date.now() - 1800_000, full, true);
  fs.writeFileSync(`${full}.opar`, Buffer.alloc(8));
  fs.writeFileSync(`${delta}.opar`, Buffer.alloc(8));
  return { full, delta };
}

describe('computeReliabilityScore', () => {
  it('scores a fully healthy destination at 100 / good', () => {
    const result = computeReliabilityScore(healthySignals());
    expect(result.status).toBe('good');
    expect(result.score).toBe(100);
    expect(result.warnings).toEqual([]);
  });

  it('penalises broken chains to 80 / degraded', () => {
    const result = computeReliabilityScore(healthySignals({ brokenChains: 1 }));
    expect(result.score).toBe(80);
    expect(result.status).toBe('degraded');
    expect(result.warnings.join(' ')).toContain('chain');
  });

  it('penalises manifest drift to 85 / degraded', () => {
    const result = computeReliabilityScore(healthySignals({ tamperDrift: true }));
    expect(result.score).toBe(85);
    expect(result.status).toBe('degraded');
    expect(result.warnings.join(' ')).toContain('drift');
  });

  it('penalises unverified images, stale newest date and missing drill', () => {
    const result = computeReliabilityScore(
      healthySignals({ verifiedImages: 0, newestDate: Date.now() - 20 * 24 * 3600_000, hasDrill: false })
    );
    // -10 (coverage) -5 (never verified) -10 (stale) -5 (no drill) = 70
    expect(result.score).toBe(70);
    expect(result.status).toBe('degraded');
    expect(result.warnings.length).toBe(3);
  });

  it('penalises low parity protection and low free space', () => {
    const result = computeReliabilityScore(
      healthySignals({ parityProtectedImages: 0, freeBytes: 30_000_000, totalBytes: 1_000_000_000 })
    );
    // -10 (parity) -10 (free < 8%) = 80
    expect(result.score).toBe(80);
    expect(result.warnings.length).toBe(2);
  });

  it('flags an unreachable destination as at-risk', () => {
    const result = computeReliabilityScore(healthySignals({ reachable: false }));
    expect(result.score).toBe(60);
    // Unreachable destinations are always at-risk regardless of the score.
    expect(result.status).toBe('at-risk');
    expect(result.warnings.join(' ')).toContain('unreachable');
  });

  it('floors at 0 for a worst-case destination', () => {
    const result = computeReliabilityScore(
      healthySignals({
        reachable: false,
        verifiedImages: 0,
        parityProtectedImages: 0,
        brokenChains: 1,
        tamperDrift: true,
        smartOk: false,
        newestDate: 0,
        freeBytes: 1,
        totalBytes: 1_000_000_000,
        scrubFailed: true,
        hasDrill: false
      })
    );
    expect(result.score).toBe(0);
    expect(result.status).toBe('at-risk');
  });
});

describe('buildStorageHealthReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-storage-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const emptyOptions = { keepFull: 0, keepDeltasPerFull: 0, retentionDays: 30, autoCleanup: true };

  it('reports a covered, smart-healthy destination as good', async () => {
    const { full, delta } = await writeHealthyDest(dir);
    fs.writeFileSync(
      path.join(dir, 'opbs-drill-history.json'),
      JSON.stringify({
        [delta]: { imagePath: delta, at: Date.now() - 60_000 },
        [full]: { imagePath: full, at: Date.now() - 60_000 }
      })
    );
    fs.writeFileSync(
      path.join(dir, 'opbs-scrub.json'),
      JSON.stringify([{ imagePath: delta, name: 'C0000001.opbs', at: Date.now() - 30_000, blocksChecked: 2, corruptionFound: 0, parityPresent: true, repaired: 0, stillFailed: 0, ok: true, firstError: '' }])
    );

    const report = (await buildStorageHealthReport(dir, emptyOptions, FAKE_DEPS)) as StorageHealthReport;
    expect(report.reachable).toBe(true);
    expect(report.score).toBe(100);
    expect(report.status).toBe('good');
    expect(report.verifiedImages).toBe(2);
    expect(report.parityProtectedImages).toBe(2);
    expect(report.imagesScrubbed).toBe(1);
    expect(report.hasDrill).toBe(true);
    expect(report.completeChains).toBe(1);
    expect(report.brokenChains).toBe(0);
    expect(report.smart.available).toBe(true);
    expect(report.smartOk).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it('detects a broken chain when the delta base is missing', async () => {
    const { full, delta } = await writeHealthyDest(dir);
    fs.writeFileSync(
      path.join(dir, 'opbs-drill-history.json'),
      JSON.stringify({ [delta]: { imagePath: delta, at: Date.now() - 60_000 } })
    );
    fs.rmSync(full, { force: true });

    const report = (await buildStorageHealthReport(dir, emptyOptions, FAKE_DEPS)) as StorageHealthReport;
    expect(report.brokenChains).toBe(1);
    expect(report.status).toBe('degraded');
    expect(report.score).toBe(80);
  });

  it('reports an unreachable destination without throwing', async () => {
    const missing = path.join(os.tmpdir(), 'opbs-storage-missing-' + Date.now());
    const report = (await buildStorageHealthReport(missing, emptyOptions, FAKE_DEPS)) as StorageHealthReport;
    expect(report.reachable).toBe(false);
    expect(report.status).toBe('at-risk');
    expect(report.warnings.join(' ')).toContain('unreachable');
  });

  it('handles SMART being unavailable without shifting the score', async () => {
    const { delta } = await writeHealthyDest(dir);
    fs.writeFileSync(
      path.join(dir, 'opbs-drill-history.json'),
      JSON.stringify({ [delta]: { imagePath: delta, at: Date.now() - 60_000 } })
    );
    const report = (await buildStorageHealthReport(dir, emptyOptions, {
      resolveDisk: async () => ({ driveLetter: 'C' }),
      querySmart: () => null
    })) as StorageHealthReport;
    expect(report.smart.available).toBe(false);
    expect(report.smartOk).toBe(null);
    expect(report.smart.driveLetter).toBe('C');
    expect(report.score).toBe(100);
  });

  it('flags at-risk when the backing drive reports health warnings', async () => {
    const { delta } = await writeHealthyDest(dir);
    fs.writeFileSync(
      path.join(dir, 'opbs-drill-history.json'),
      JSON.stringify({ [delta]: { imagePath: delta, at: Date.now() - 60_000 } })
    );
    const report = (await buildStorageHealthReport(dir, emptyOptions, {
      resolveDisk: async () => ({ diskIndex: 0, driveLetter: 'C' }),
      querySmart: () => ({ model: 'TestDrive', healthStatus: 'Warning', temperatureCelsius: 70, wear: 90, unreliableSectors: 4 })
    })) as StorageHealthReport;
    expect(report.smart.available).toBe(true);
    expect(report.smartOk).toBe(false);
    expect(report.smart.warnings.length).toBeGreaterThan(0);
    expect(report.score).toBe(85);
    expect(report.status).toBe('degraded');
  });
});