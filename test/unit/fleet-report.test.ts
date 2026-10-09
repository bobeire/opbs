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
  type PartitionEntryMeta,
  type BlockRecord,
  type ImageHeader
} from '../../src/main/imaging/image-format';
import { buildFleetReport } from '../../src/main/fleet/report';
import { fleetMachineId, deriveMachineStatus } from '../../src/main/fleet/schema';
import type { MediaInventoryEntry } from '../../src/main/utils/media-health';
import type { BackupAnalyticsEntry } from '../../src/main/utils/backup-analytics';

const BLOCK = 64 * 1024;

function writeImage(imagePath: string, raw: Buffer, timestamp: number, baseImagePath = ''): void {
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
    flags: FLAG_HAS_BLOCK_INDEX | (baseImagePath ? FLAG_INCREMENTAL : 0),
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
}

function analyticsEntry(imagePath: string, timestamp: number, overrides: Partial<BackupAnalyticsEntry> = {}): BackupAnalyticsEntry {
  return {
    imagePath,
    timestamp,
    totalBytes: 1000,
    bytesWritten: 1000,
    blocksWritten: 1,
    totalBlocks: 1,
    skippedBlocks: 0,
    incremental: true,
    compressionRatio: 2,
    durationMs: 1000,
    speedMBs: 50,
    ...overrides
  };
}

describe('fleet report builder', () => {
  let dir: string;
  let fullImage: string;
  let deltaImage: string;
  let newestBackupAt: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-report-'));
    fullImage = path.join(dir, 'pc-full.opbs');
    deltaImage = path.join(dir, 'pc-delta.opbs');
    writeImage(fullImage, Buffer.alloc(BLOCK, 0x11), Date.now() - 3 * 24 * 60 * 60 * 1000);
    writeImage(deltaImage, Buffer.alloc(BLOCK, 0x22), Date.now() - 1 * 60 * 60 * 1000, fullImage);

    // Newest run blows up 9x over the delta baseline → critical size anomaly.
    const now = Date.now();
    newestBackupAt = now - 60 * 60 * 1000;
    const history: BackupAnalyticsEntry[] = [
      analyticsEntry(deltaImage, newestBackupAt, { totalBytes: 10000, bytesWritten: 10000 }),
      analyticsEntry(deltaImage, now - 24 * 60 * 60 * 1000),
      analyticsEntry(deltaImage, now - 2 * 24 * 60 * 60 * 1000),
      analyticsEntry(deltaImage, now - 3 * 24 * 60 * 60 * 1000)
    ];
    fs.writeFileSync(path.join(dir, 'opbs-analytics.json'), JSON.stringify(history, null, 2));

    fs.writeFileSync(
      path.join(dir, 'opbs-drill-history.json'),
      JSON.stringify(
        {
          [fullImage]: { imagePath: fullImage, at: now - 7 * 24 * 60 * 60 * 1000, ok: true, partitionsValidated: 1 },
          [deltaImage]: { imagePath: deltaImage, at: now - 24 * 60 * 60 * 1000, ok: false, failures: ['fsck'] }
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('collects chain, analytics, anomaly and drill data per destination', async () => {
    const checkin = await buildFleetReport({
      directories: [dir],
      appVersion: '0.6.67',
      hostname: 'TESTPC',
      includeMedia: false,
      inventoryMedia: async () => {
        throw new Error('media must not be collected when includeMedia is false');
      }
    });

    expect(checkin.schema).toBe(1);
    expect(checkin.hostname).toBe('TESTPC');
    expect(checkin.machineId).toBe(fleetMachineId('TESTPC', os.arch()));
    expect(checkin.appVersion).toBe('0.6.67');
    expect(checkin.media).toEqual([]);

    expect(checkin.destinations).toHaveLength(1);
    const dest = checkin.destinations[0];
    expect(dest.directory).toBe(dir);
    expect(dest.exists).toBe(true);
    expect(dest.imageCount).toBe(2);
    expect(dest.chainCount).toBe(1);
    expect(dest.completeChains).toBe(1);
    expect(dest.brokenChains).toBe(0);
    expect(dest.unparseableImages).toBe(0);
    expect(dest.lastBackupAt).toBe(newestBackupAt);
    expect(dest.lastBackupImage).toBe(deltaImage);
    expect(dest.lastBackupBytes).toBe(10000);
    expect(dest.lastBackupIncremental).toBe(true);
    expect(dest.criticalAnomalies).toBeGreaterThanOrEqual(1);
    expect(dest.anomalyOk).toBe(false);
    expect(dest.drillTotal).toBe(2);
    expect(dest.drillFailed).toBe(1);
    expect(dest.drillLastOk).toBe(false);

    // The failed latest drill must surface as a critical machine status.
    const status = deriveMachineStatus(checkin, { receivedAt: checkin.sentAt });
    expect(status.status).toBe('critical');
    expect(status.reasons.some((r) => /drill FAILED/.test(r))).toBe(true);
  });

  it('maps the SMART inventory into the media section', async () => {
    const inventory: MediaInventoryEntry[] = [
      {
        diskIndex: 0,
        model: 'Samsung 990',
        serial: 'S6Z2',
        size: 1000204886016,
        driveLetters: ['C:'],
        health: { data: { temperatureCelsius: 35 }, reliable: true, warnings: [] },
        unhealthy: false
      },
      {
        diskIndex: 1,
        model: 'WDC WD10',
        serial: 'WD-1',
        size: 1000204886016,
        driveLetters: ['E:'],
        health: { data: { temperatureCelsius: 51, unreliableSectors: 20 }, reliable: false, warnings: ['unreliable sectors'] },
        unhealthy: true
      }
    ];
    const checkin = await buildFleetReport({
      directories: [dir],
      appVersion: '0.6.67',
      hostname: 'TESTPC',
      inventoryMedia: async () => inventory
    });

    expect(checkin.media).toHaveLength(2);
    expect(checkin.media[0]).toMatchObject({ diskIndex: 0, model: 'Samsung 990', healthy: true, measured: true });
    expect(checkin.media[1]).toMatchObject({ diskIndex: 1, healthy: false, measured: true });
    expect(checkin.media[1].warnings).toEqual(['unreliable sectors']);

    const status = deriveMachineStatus(checkin, { receivedAt: checkin.sentAt });
    expect(status.status).toBe('critical');
    expect(status.reasons.some((r) => /SMART reports problems/.test(r))).toBe(true);
  });

  it('reports an unreachable destination instead of throwing', async () => {
    const missing = path.join(dir, 'does-not-exist');
    const checkin = await buildFleetReport({
      directories: [missing],
      appVersion: '0.6.67',
      hostname: 'TESTPC',
      includeMedia: false
    });
    expect(checkin.destinations[0]).toMatchObject({
      directory: missing,
      exists: false,
      imageCount: 0,
      lastBackupAt: null
    });
  });

  it('reports an empty directory as no backups yet', async () => {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const checkin = await buildFleetReport({
      directories: [empty],
      appVersion: '0.6.67',
      hostname: 'TESTPC',
      includeMedia: false
    });
    expect(checkin.destinations[0]).toMatchObject({ exists: true, imageCount: 0, lastBackupAt: null });
    const status = deriveMachineStatus(checkin, { receivedAt: checkin.sentAt });
    expect(status.status).toBe('warning');
  });

  it('survives a failing media inventory', async () => {
    const checkin = await buildFleetReport({
      directories: [dir],
      appVersion: '0.6.67',
      hostname: 'TESTPC',
      inventoryMedia: async () => {
        throw new Error('powershell missing');
      }
    });
    expect(checkin.media).toEqual([]);
    expect(checkin.destinations[0].imageCount).toBe(2);
  });
});
