import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

const NATIVE_PATH = path.join(__dirname, '../../src/native/build/Release/opbs_native.node');

interface PartitionTableNative {
  buildPartitionTable(
    scheme: 'gpt' | 'mbr',
    lbaCount: bigint | number,
    entries: Array<{ offset: number; size: number; typeGuid?: string; name?: string; bootable?: boolean }>,
    opts?: { diskGuid?: string }
  ): { firstUsableLBA: number; lastUsableLBA: number; regions: Array<{ offset: number; data: Buffer }> };
}

let native: PartitionTableNative | null = null;

const DISK_GUID = '11111111-2222-3333-4444-555555555555';
const LBA_COUNT = 234441648;
const LAST_LBA = LBA_COUNT - 1;

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & (0 - (crc & 1)));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function guidHex(text: string): Buffer {
  // "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" -> stored LE form for fields 1-3.
  const hex = text.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16));
  return Buffer.from(hex);
}

try {
  if (fs.existsSync(NATIVE_PATH)) {
    native = require(NATIVE_PATH) as PartitionTableNative;
  }
} catch {
  native = null;
}

describe('native GPT partition table builder', () => {
    const entries = [
      { offset: 1048576, size: 67108864, typeGuid: 'CB2FC206-64A9-4CD4-9A24-8A7F1A2E7F2E', name: 'System' },
      { offset: 68352471040, size: 8257536, typeGuid: 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7', name: 'Data' }
    ];

    it('returns the 5 standard regions at the expected offsets', () => {
      const table = native!.buildPartitionTable('gpt', LBA_COUNT, entries, { diskGuid: DISK_GUID });
      expect(table.firstUsableLBA).toBe(34);
      expect(table.lastUsableLBA).toBe(LAST_LBA - 34);
      expect(table.regions.map((r) => [r.offset, r.data.length])).toEqual([
        [0, 512],
        [512, 512],
        [1024, 16384],
        [(LAST_LBA - 32) * 512, 16384],
        [LAST_LBA * 512, 512]
      ]);
    });

    it('writes a protective MBR at sector 0', () => {
      const table = native!.buildPartitionTable('gpt', LBA_COUNT, entries, { diskGuid: DISK_GUID });
      const mbr = table.regions[0].data;
      expect(mbr[510]).toBe(0x55);
      expect(mbr[511]).toBe(0xaa);
      const entry = mbr.subarray(0x1be, 0x1be + 16);
      expect(entry[4]).toBe(0xee); // GPT protective type
      expect(entry.readUInt32LE(8)).toBe(1); // start LBA
      expect(entry.readUInt32LE(12)).toBe(LBA_COUNT - 1); // size
    });

    it('writes a valid primary GPT header with matching CRCs', () => {
      const table = native!.buildPartitionTable('gpt', LBA_COUNT, entries, { diskGuid: DISK_GUID });
      const hdr = table.regions[1].data; // LBA1
      expect(hdr.subarray(0, 8).toString('ascii')).toBe('EFI PART');
      expect(hdr.readUInt32LE(8)).toBe(0x00010000);
      expect(hdr.readUInt32LE(12)).toBe(92);
      expect(hdr.readBigUInt64LE(24)).toBe(1n); // current LBA
      expect(hdr.readBigUInt64LE(32)).toBe(BigInt(LAST_LBA)); // backup LBA
      expect(hdr.readBigUInt64LE(40)).toBe(34n); // first usable
      expect(hdr.readBigUInt64LE(48)).toBe(BigInt(LAST_LBA - 34)); // last usable
      expect(hdr.readBigUInt64LE(72)).toBe(2n); // entries LBA
      expect(hdr.readUInt32LE(80)).toBe(128);
      expect(hdr.readUInt32LE(84)).toBe(128);

      // Header CRC covers the 92-byte header with the CRC field zeroed.
      const zeroed = Buffer.from(hdr.subarray(0, 92));
      zeroed.writeUInt32LE(0, 16);
      expect(hdr.readUInt32LE(16)).toBe(crc32(zeroed));

      // Entries CRC covers the full 32-sector entry region.
      const entriesRegion = table.regions[2].data;
      expect(hdr.readUInt32LE(88)).toBe(crc32(entriesRegion));
    });

    it('stores type GUIDs, first/last LBA and UTF-16LE names in entries', () => {
      const table = native!.buildPartitionTable('gpt', LBA_COUNT, entries, { diskGuid: DISK_GUID });
      const region = table.regions[2].data;

      const e0 = region.subarray(0, 128);
      expect(Buffer.from(e0.subarray(0, 16))).toEqual(guidHex('CB2FC206-64A9-4CD4-9A24-8A7F1A2E7F2E'));
      expect(e0.readBigUInt64LE(32)).toBe(2048n);
      expect(e0.readBigUInt64LE(40)).toBe(2048n + 131072n - 1n);
      expect(e0.subarray(56, 128).toString('utf16le').split('\u0000')[0]).toBe('System');

      const e1 = region.subarray(128, 256);
      expect(Buffer.from(e1.subarray(0, 16))).toEqual(guidHex('EBD0A0A2-B9E5-4433-87C0-68B6B72699C7'));
      expect(e1.readBigUInt64LE(32)).toBe(133500920n);
      expect(e1.subarray(56, 128).toString('utf16le').split('\u0000')[0]).toBe('Data');
    });

    it('mirrors the entries and header at the end of the disk', () => {
      const table = native!.buildPartitionTable('gpt', LBA_COUNT, entries, { diskGuid: DISK_GUID });
      const backupEntries = table.regions[3].data;
      const backupHdr = table.regions[4].data;

      expect(Buffer.from(backupEntries)).toEqual(table.regions[2].data);
      expect(backupHdr.subarray(0, 8).toString('ascii')).toBe('EFI PART');
      expect(backupHdr.readBigUInt64LE(24)).toBe(BigInt(LAST_LBA)); // current = last
      expect(backupHdr.readBigUInt64LE(32)).toBe(1n); // backup = first
      expect(backupHdr.readBigUInt64LE(72)).toBe(BigInt(LAST_LBA - 32)); // entries LBA

      const zeroed = Buffer.from(backupHdr.subarray(0, 92));
      zeroed.writeUInt32LE(0, 16);
      expect(backupHdr.readUInt32LE(16)).toBe(crc32(zeroed));
      expect(backupHdr.readUInt32LE(88)).toBe(backupEntries.length > 0 ? crc32(backupEntries) : 0);
    });

    it('derives a deterministic disk GUID when none is supplied', () => {
      const a = native!.buildPartitionTable('gpt', LBA_COUNT, entries);
      const b = native!.buildPartitionTable('gpt', LBA_COUNT, entries);
      const guidA = Buffer.from(a.regions[1].data.subarray(56, 72));
      const guidB = Buffer.from(b.regions[1].data.subarray(56, 72));
      expect(guidA).toEqual(guidB);
      expect(guidA).not.toEqual(Buffer.alloc(16));
    });

    it('rejects partitions below LBA 34, overlaps, misalignment and bad schemes', () => {
      const nativeApi = native!;
      expect(() =>
        nativeApi.buildPartitionTable('gpt', LBA_COUNT, [{ offset: 4096, size: 1048576 }], { diskGuid: DISK_GUID })
      ).toThrow(/LBA 34/);
      expect(() =>
        nativeApi.buildPartitionTable(
          'gpt',
          LBA_COUNT,
          [
            { offset: 1048576, size: 1048576 },
            { offset: 1048576 + 512, size: 1048576 }
          ],
          { diskGuid: DISK_GUID }
        )
      ).toThrow(/overlap|out of order/);
      expect(() =>
        nativeApi.buildPartitionTable('gpt', LBA_COUNT, [{ offset: 1048576 + 1, size: 1048576 }], { diskGuid: DISK_GUID })
      ).toThrow(/sector-aligned/);
      expect(() => nativeApi.buildPartitionTable('banana', LBA_COUNT, [], { diskGuid: DISK_GUID })).toThrow(
        /Unknown partition-table scheme/
      );
    });
});

describe('native MBR partition table builder', () => {
  let nativeMbr: PartitionTableNative | null = null;

  try {
    if (fs.existsSync(NATIVE_PATH)) {
      nativeMbr = require(NATIVE_PATH) as PartitionTableNative;
    }
  } catch {
    nativeMbr = null;
  }

  describe.skipIf(!nativeMbr)('mbr', () => {
    const entries = [
      { offset: 1048576, size: 67108864 },
      { offset: 104857600, size: 52428800 },
      { offset: 209715200, size: 8589934592 },
      { offset: 10485760000, size: 4294967296 }
    ];

    it('builds a single 512-byte region with an 0x55AA signature', () => {
      const table = nativeMbr!.buildPartitionTable('mbr', LBA_COUNT, entries);
      expect(table.regions).toHaveLength(1);
      expect(table.regions[0]).toMatchObject({ offset: 0, data: { length: 512 } });
      const mbr = table.regions[0].data;
      expect(mbr[510]).toBe(0x55);
      expect(mbr[511]).toBe(0xaa);
    });

    it('writes start/size LBAs and marks the bootable entry', () => {
      const bootable = [...entries];
      bootable[0] = { ...entries[0], bootable: true };
      const mbr = nativeMbr!.buildPartitionTable('mbr', LBA_COUNT, bootable).regions[0].data;

      for (let i = 0; i < 4; i++) {
        const entry = mbr.subarray(0x1be + i * 16, 0x1be + (i + 1) * 16);
        expect(entry[4]).toBe(0x07); // NTFS/basic data
        expect(entry.readUInt32LE(8)).toBe(entries[i].offset / 512);
        expect(entry.readUInt32LE(12)).toBe(entries[i].size / 512);
        if (i === 0) {
          expect(entry[0]).toBe(0x80);
        } else {
          expect(entry[0]).toBe(0x00);
        }
      }
    });

    it('rejects more than 4 partitions and 32-bit LBA overflows', () => {
      const five = Array.from({ length: 5 }, (_, i) => ({ offset: 1048576 + i * 1048576, size: 524288 }));
      expect(() => nativeMbr!.buildPartitionTable('mbr', LBA_COUNT, five)).toThrow(/at most 4/);
      const big = [{ offset: 1048576, size: 0x100000000 * 512 }];
      expect(() => nativeMbr!.buildPartitionTable('mbr', 0x200000000, big)).toThrow(/32-bit LBA limit/);
    });
  });
});