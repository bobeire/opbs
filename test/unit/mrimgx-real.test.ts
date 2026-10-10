import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'node:crypto';
import {
  detectMacriumFormat,
  readMacriumImage,
  clearMacriumInfoCache,
  macriumUnsupportedReason,
  macriumRestoreRefusal,
  MacriumImageInfo,
  MacriumUnsupportedError
} from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { compressBlock, COMPRESSION_ZSTD } from '../../src/main/imaging/image-format';
import { openAnyBrowse, detectPartitionFilesystem } from '../../src/main/imaging/fs/file-browse';
import { findMrimgxSamples } from './helpers/v7-sample';

const SAMPLES = findMrimgxSamples();

/**
 * Real Reflect X (`.mrimgx`) samples, discovered from `imagefilesamples/`
 * (gitignored, user-provided — never a fixed filename). Covers the
 * reserved-boot-region fix: FAT32 volumes store their boot area + FATs in
 * the index's reserved track, and the partition reader must map it in front
 * of the data blocks so the filesystem layers see the boot sector at
 * offset 0.
 */
describe.each(SAMPLES.length ? SAMPLES : [])('mrimgx real sample: %s', (sample) => {
  afterEach(() => clearMacriumInfoCache());

  it('detects and parses the container', () => {
    expect(detectMacriumFormat(sample)).toBe('mrimgx');
    const info = readMacriumImage(sample);
    expect(info.format).toBe('mrimgx');
    expect(info.partitions.length).toBeGreaterThanOrEqual(1);
    expect(macriumUnsupportedReason(info)).toBeNull();
    expect(macriumRestoreRefusal(info)).toBeNull();
  });

  it('has a readable partition with its reserved boot region captured', () => {
    const info = readMacriumImage(sample);
    const part = info.partitions[0];
    expect(part.blockSize).toBeGreaterThan(0);
    expect(part.blockCount).toBeGreaterThan(0);
    if (part.dataStart > 0) {
      // FAT32-style layout: the boot area lives in the reserved track.
      expect((part.reserved ?? []).some((el) => el.storedLength > 0)).toBe(true);
      expect(part.geometry.length).toBeGreaterThan(part.dataStart);
    } else {
      // NTFS-style layout: block 0 is the boot sector.
      expect(part.fsType.toLowerCase()).toContain('ntfs');
    }
  });

  it('opens a partition reader whose offset 0 is the boot sector', () => {
    const info = readMacriumImage(sample);
    const part = info.partitions[0];
    const reader = openMacriumPartitionReader(info, 0);
    const expectedSize =
      part.dataStart > 0
        ? Math.min(
            part.dataStart + part.blockCount * part.blockSize,
            part.geometry.length > 0 ? part.geometry.length : Number.MAX_SAFE_INTEGER
          )
        : part.blockCount * part.blockSize;
    expect(reader.size).toBe(expectedSize);
    const boot = reader.read(0, 512);
    expect(boot.length).toBe(512);
    if (part.dataStart > 0) {
      // FAT32 boot sector: valid jump + OEM name, "FAT32   " signature at 0x52.
      expect(boot.subarray(0, 2).toString('hex')).toBe('eb58');
      expect(boot.subarray(0x52, 0x5a).toString('latin1')).toBe('FAT32   ');
      expect(boot[510]).toBe(0x55);
      expect(boot[511]).toBe(0xaa);
    } else {
      expect(boot.subarray(3, 8).toString('latin1').trim().length).toBeGreaterThan(0);
    }
  });

  it('verifies stored blocks through the reader', () => {
    const info = readMacriumImage(sample);
    const part = info.partitions[0];
    const reader = openMacriumPartitionReader(info, 0);
    let checked = 0;
    for (let i = 0; i < part.blocks.length && checked < 6; i++) {
      const b = part.blocks[i];
      if (b.storedLength <= 0 || b.filePosition < 0) continue;
      const off = part.dataStart + i * part.blockSize;
      const len = Math.min(part.blockSize, reader.size - off);
      const raw = reader.read(off, len);
      expect(crypto.createHash('md5').update(raw).digest().equals(b.md5)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('browses the filesystem through the shared layer', () => {
    const probe = detectPartitionFilesystem(sample, 0);
    expect(probe.browsable).toBe(true);
    const session = openAnyBrowse(sample, 0);
    expect(['ntfs', 'fat32', 'exfat']).toContain(session.filesystem);
    expect(session.reader.read(0, 512).length).toBe(512);
  });
});

if (!SAMPLES.length) {
  describe('mrimgx real sample', () => {
    it('is skipped (no .mrimgx samples present)', () => {
      expect(SAMPLES).toEqual([]);
    });
  });
}

/**
 * Synthetic regressions for the reserved-track mapping — no real samples
 * needed. A minimal mrimgx-shaped info with one reserved element and two
 * data blocks, the boot blob zstd-compressed at the head of a temp file.
 */
describe('mrimgx reserved-boot-region mapping (synthetic)', () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const f of tmp.splice(0)) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  function makeSample(opts: { withReserved: boolean }): {
    info: MacriumImageInfo;
    bootBlob: Buffer;
    block0: Buffer;
  } {
    const bootBlob = crypto.randomBytes(4096);
    const block0 = crypto.randomBytes(4096);
    const storedBoot = compressBlock(bootBlob, COMPRESSION_ZSTD, 3);
    const storedBlock0 = compressBlock(block0, COMPRESSION_ZSTD, 3);
    const file = path.join(os.tmpdir(), `opbs-mrimgx-synth-${process.pid}-${tmp.length}.mrimgx`);
    tmp.push(file);
    fs.writeFileSync(file, Buffer.concat([storedBoot, storedBlock0]));
    const bootEl = {
      filePosition: 0,
      storedLength: storedBoot.length,
      md5: crypto.createHash('md5').update(bootBlob).digest(),
      fileNumber: 0
    };
    const blockEl = {
      filePosition: storedBoot.length,
      storedLength: storedBlock0.length,
      md5: crypto.createHash('md5').update(block0).digest(),
      fileNumber: 0
    };
    const dataStart = bootBlob.length;
    const info: MacriumImageInfo = {
      imagePath: file,
      format: 'mrimgx',
      imageId: 'SYNTHETIC1',
      backupType: 'full',
      backupFormat: 'partition',
      fileNumber: 0,
      compression: { level: 'medium' },
      encryption: { enable: false, keyIterations: 0 },
      splitFile: false,
      deltaIndex: false,
      disks: [{ diskNumber: 0 }],
      partitions: [
        {
          diskIndex: 0,
          partitionIndex: 0,
          partitionNumber: 1,
          blockSize: 4096,
          blockCount: 2,
          dataStart,
          fsType: 'FAT32',
          fsStart: 0,
          lcn0Offset: dataStart,
          sectorsPerCluster: 8,
          volumeLabel: '',
          geometry: { start: 0, end: dataStart + 8191, length: dataStart + 8192, bootSectorOffset: 0 },
          blocks: [
            blockEl,
            { filePosition: -1, storedLength: 0, md5: Buffer.alloc(16), fileNumber: 0 }
          ],
          ...(opts.withReserved ? { reserved: [bootEl] } : {})
        }
      ]
    };
    return { info, bootBlob, block0 };
  }

  it('maps the reserved track in front of the data blocks', () => {
    const { info, bootBlob, block0 } = makeSample({ withReserved: true });
    const reader = openMacriumPartitionReader(info, 0);
    expect(reader.size).toBe(4096 + 8192);
    expect(reader.read(0, 4096).equals(bootBlob)).toBe(true);
    expect(reader.read(4096, 4096).equals(block0)).toBe(true);
    // Unallocated block: zeroes.
    expect(reader.read(8192, 4096).equals(Buffer.alloc(4096))).toBe(true);
    // A read spanning the reserved/data boundary stitches both sources.
    const span = reader.read(4090, 12);
    expect(span.subarray(0, 6).equals(bootBlob.subarray(4090))).toBe(true);
    expect(span.subarray(6).equals(block0.subarray(0, 6))).toBe(true);
  });

  it('refuses a dataStart > 0 image whose boot region was never captured', () => {
    const { info } = makeSample({ withReserved: false });
    expect(macriumUnsupportedReason(info)).toBeNull(); // container itself is fine
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(/boot region that is not captured/);
  });
});
