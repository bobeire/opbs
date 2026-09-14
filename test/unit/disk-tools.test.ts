import { describe, it, expect } from 'vitest';
import { parseMbrRaw, partitionTypeLabel, chsToString } from '../../src/main/utils/disk-tools';

function buildMbr(opts: { sig?: number; entries?: Array<{ active: boolean; type: number; startLba: number; sectors: number }> }): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf[510] = 0x55;
  buf[511] = 0xaa;
  if (opts.sig !== undefined) buf.writeUInt32LE(opts.sig, 440);
  if (opts.entries) {
    for (let i = 0; i < opts.entries.length && i < 4; i++) {
      const e = opts.entries[i];
      const off = 446 + i * 16;
      buf[off] = e.active ? 0x80 : 0x00;
      buf[off + 4] = e.type;
      buf.writeUInt32LE(e.startLba, off + 8);
      buf.writeUInt32LE(e.sectors, off + 12);
    }
  }
  return buf;
}

describe('parseMbrRaw', () => {
  it('parses a valid MBR with two NTFS partitions', () => {
    const buf = buildMbr({
      sig: 0x12345678,
      entries: [
        { active: true, type: 0x07, startLba: 2048, sectors: 1048576 },
        { active: false, type: 0x07, startLba: 1050624, sectors: 2097152 }
      ]
    });

    const mbr = parseMbrRaw(buf);

    expect(mbr.bootSignature).toBe('0xAA55');
    expect(mbr.diskSignature).toBe(0x12345678);
    expect(mbr.partitionStyle).toBe('mbr');
    expect(mbr.partitions).toHaveLength(2);
    expect(mbr.bootable).toBe(0);

    const p0 = mbr.partitions[0];
    expect(p0.active).toBe(true);
    expect(p0.type).toBe(0x07);
    expect(p0.typeLabel).toBe('NTFS / exFAT / HPFS');
    expect(p0.startLba).toBe(2048);
    expect(p0.sectorCount).toBe(1048576);
    expect(p0.sizeBytes).toBe(1048576 * 512);
  });

  it('parses a GPT-protective MBR', () => {
    const buf = buildMbr({ entries: [{ active: false, type: 0xEE, startLba: 1, sectors: 0xFFFFFFFF }] });
    const mbr = parseMbrRaw(buf);
    expect(mbr.partitionStyle).toBe('gpt');
    expect(mbr.partitions).toHaveLength(1);
    expect(mbr.partitions[0].typeLabel).toBe('GPT Protective');
  });

  it('handles an empty MBR (no partitions)', () => {
    const buf = buildMbr({});
    const mbr = parseMbrRaw(buf);
    expect(mbr.partitionStyle).toBe('raw');
    expect(mbr.partitions).toHaveLength(0);
    expect(mbr.bootable).toBeUndefined();
  });

  it('detects the active partition index', () => {
    const buf = buildMbr({
      entries: [
        { active: false, type: 0x0B, startLba: 100, sectors: 1000 },
        { active: true, type: 0x0C, startLba: 2000, sectors: 2000 },
        { active: false, type: 0x07, startLba: 5000, sectors: 5000 }
      ]
    });
    const mbr = parseMbrRaw(buf);
    expect(mbr.bootable).toBe(1);
  });

  it('reports CHS coordinates for partitions', () => {
    const buf = buildMbr({
      entries: [{ active: true, type: 0x07, startLba: 2048, sectors: 4096 }]
    });
    const mbr = parseMbrRaw(buf);
    // all-zero CHS fields in the synthetic buffer
    expect(mbr.partitions[0].startChs).toBe('C0/H0/S0');
    expect(mbr.partitions[0].endChs).toBe('C0/H0/S0');
  });
});

describe('partitionTypeLabel', () => {
  it('maps known types', () => {
    expect(partitionTypeLabel(0x07)).toBe('NTFS / exFAT / HPFS');
    expect(partitionTypeLabel(0x83)).toBe('Linux');
    expect(partitionTypeLabel(0x0C)).toBe('FAT32 (LBA)');
  });
  it('formats unknown types', () => {
    expect(partitionTypeLabel(0xFF)).toBe('Unknown (0xFF)');
  });
});

describe('chsToString', () => {
  it('computes C/H/S', () => {
    expect(chsToString(0, 1, 0)).toBe('C0/H0/S1');
    expect(chsToString(0, 0x3f, 0)).toBe('C0/H0/S63');
  });
});