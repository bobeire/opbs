import { describe, it, expect } from 'vitest';
import {
  buildRestoreTablePlan,
  resolveTableScheme,
  validateTableEntries,
  GPT_BASIC_DATA_GUID,
  GPT_MIN_OFFSET,
  MBR_MIN_OFFSET
} from '../../src/main/imaging/partition-table';

describe('partition-table TS planning', () => {
  it('auto-selects MBR for a representable small single-partition disk', () => {
    const entries = [{ offset: 1048576, size: 64 * 1024 * 1024 }];
    expect(resolveTableScheme(entries, 500_000_000)).toBe('mbr');
  });

  it('auto-selects GPT when more than 4 partitions or >2 TiB', () => {
    const four = Array.from({ length: 5 }, (_, i) => ({ offset: 1048576 + i * 1048576, size: 524288 }));
    expect(resolveTableScheme(four, 1_000_000_000)).toBe('gpt');
    const bigDisk = [{ offset: 1048576, size: 1024 * 1024 }];
    expect(resolveTableScheme(bigDisk, 3 * 1024 * 1024 * 1024 * 1024)).toBe('gpt');
  });

  it('auto-selects GPT when no MBR offset is representable below LBA 63', () => {
    // fine for GPT (>= LBA 34) but below the MBR minimum.
    const entries = [{ offset: GPT_MIN_OFFSET, size: 524288 }];
    expect(resolveTableScheme(entries, 1_000_000_000)).toBe('gpt');
  });

  it('detects overlap and misalignment problems', () => {
    const overlapping = [
      { offset: 1048576, size: 1048576 },
      { offset: 1048576 + 524288, size: 1048576 }
    ];
    expect(validateTableEntries(overlapping, 'gpt', 1_000_000_000)).toMatch(/overlap/i);
    const misaligned = [{ offset: 1048576 + 1, size: 1048576 }];
    expect(validateTableEntries(misaligned, 'gpt', 1_000_000_000)).toMatch(/sector-aligned/i);
  });

  it('rejects GPT placements before LBA 34', () => {
    const entry = [{ offset: 1048576, size: 524288 }];
    expect(validateTableEntries(entry, 'mbr', 1_000_000_000)).toBeNull();
    expect(validateTableEntries([{ offset: 4096, size: 524288 }], 'gpt', 1_000_000_000)).toMatch(/LBA 34/i);
    expect(validateTableEntries([{ offset: 4096, size: 524288 }], 'mbr', 1_000_000_000)).toMatch(/LBA 63/i);
  });

  it('rejects 5 MBR entries and >2 TiB MBR disks', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ offset: 1048576 + i * 1048576, size: 524288 }));
    expect(validateTableEntries(five, 'mbr', 1_000_000_000)).toMatch(/at most 4/i);
    const big = [{ offset: 1048576, size: 1024 * 1024 }];
    expect(validateTableEntries(big, 'mbr', 3 * 1024 * 1024 * 1024 * 1024)).toMatch(/2 TiB/i);
  });

  it('detects partitions that exceed the disk size', () => {
    const tooBig = [{ offset: 1048576, size: 1_000_000_000 }];
    expect(validateTableEntries(tooBig, 'gpt', 500_000_000)).toMatch(/does not fit/i);
  });

  it('sorts placements by offset and assigns GPT basics for a gpt plan', () => {
    const plan = buildRestoreTablePlan(
      [
        { partitionIndex: 1, offset: 68352471040, size: 8257536 },
        { partitionIndex: 0, offset: 1048576, size: 67108864 }
      ],
      1_000_000_000_000,
      { scheme: 'gpt', diskGuid: '11111111-2222-3333-4444-555555555555' }
    );
    expect(plan.scheme).toBe('gpt');
    expect(plan.diskGuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(plan.entries.map((e) => e.offset)).toEqual([1048576, 68352471040]);
    expect(plan.entries[0].typeGuid).toBe(GPT_BASIC_DATA_GUID);
    expect(plan.entries[0].name).toBe('Partition 0');
    expect(plan.entries[1]).toMatchObject({ offset: 68352471040, size: 8257536 });
  });

  it('honors per-partition type GUIDs and the MBR boot partition', () => {
    const plan = buildRestoreTablePlan([{ partitionIndex: 0, offset: 1048576, size: 67108864 }], 200_000_000_000, {
      scheme: 'mbr',
      bootPartition: 0
    });
    expect(plan.scheme).toBe('mbr');
    expect(plan.entries[0].bootable).toBe(true);
    expect(plan.entries[0].typeGuid).toBeUndefined();

    const gpt = buildRestoreTablePlan([{ partitionIndex: 0, offset: 1048576, size: 67108864 }], 200_000_000_000, {
      scheme: 'gpt',
      typeGuids: { 0: 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B' }
    });
    expect(gpt.entries[0].typeGuid).toBe('C12A7328-F81F-11D2-BA4B-00A0C93EC93B');
  });

  it('throws when a placement cannot be represented by the chosen scheme', () => {
    expect(() =>
      buildRestoreTablePlan([{ partitionIndex: 0, offset: 4096, size: 67108864 }], 200_000_000_000, { scheme: 'gpt' })
    ).toThrow(/Cannot build/);
    expect(() =>
      buildRestoreTablePlan([{ partitionIndex: 0, offset: GPT_MIN_OFFSET, size: 67108864 }], 200_000_000_000, {
        scheme: 'mbr'
      })
    ).toThrow(/Cannot build/);
    expect(() =>
      buildRestoreTablePlan([{ partitionIndex: 0, offset: MBR_MIN_OFFSET, size: 67108864 }], 200_000_000_000, {
        scheme: 'auto'
      })
    ).not.toThrow();
  });
});