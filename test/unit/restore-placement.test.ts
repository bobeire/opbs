import { describe, it, expect } from 'vitest';
import {
  buildRestoreTargetLayout,
  friendlyRestorePlacementError,
  needsExplicitPlacement,
  parseByteOffset
} from '../../src/renderer/lib/restore-placement';

describe('needsExplicitPlacement', () => {
  const partitions = [
    { index: 0, offsetOnDisk: 1_048_576 },
    { index: 1, offsetOnDisk: 0 }
  ];

  it('is false for the usual restored partition with a captured offset', () => {
    expect(needsExplicitPlacement(partitions, [0])).toBe(false);
  });

  it('is true for a selected partition with no captured offset', () => {
    expect(needsExplicitPlacement(partitions, [1])).toBe(true);
  });

  it('ignores partitions that were not selected', () => {
    expect(needsExplicitPlacement(partitions, [0, 2])).toBe(false);
  });
});

describe('parseByteOffset', () => {
  it('accepts decimal and hex byte offsets', () => {
    expect(parseByteOffset('1048576')).toBe(1_048_576);
    expect(parseByteOffset(' 0x100000 ')).toBe(1_048_576);
    expect(parseByteOffset('0')).toBe(0);
  });

  it('ignores empty, fractional, negative and non-numeric input', () => {
    expect(parseByteOffset('')).toBeUndefined();
    expect(parseByteOffset('  ')).toBeUndefined();
    expect(parseByteOffset('1.5')).toBeUndefined();
    expect(parseByteOffset('-1')).toBeUndefined();
    expect(parseByteOffset('later')).toBeUndefined();
  });
});

describe('friendlyRestorePlacementError', () => {
  it('replaces the missing-source-offset error with GUI guidance', () => {
    const friendly = friendlyRestorePlacementError(
      'Cannot restore: Cannot determine the source on-disk offset of partition 0 in this Macrium image. ' +
        'Provide explicit placement (CLI: --layout 0:<offsetBytes>).'
    );

    expect(friendly).toContain('does not record where partition 0 started');
    expect(friendly).toContain('a target byte offset is required for this restore');
    expect(friendly).toContain('does not mean the target drive is unsuitable');
    expect(friendly).toContain('In the Target step');
    expect(friendly).toContain('target drive\'s layout');
    expect(friendly).toContain('Use 1 MiB');
    expect(friendly).not.toContain('CLI');
    expect(friendly).not.toContain('--layout');
    expect(friendly).not.toContain('Cannot restore');
  });

  it('explains that offset 0 is invalid for a new GPT or MBR table', () => {
    const gpt = friendlyRestorePlacementError(
      'Cannot build a GPT partition table: GPT partitions must start at or after LBA 34 ' +
        '(byte 17408); offset 0 cannot be represented'
    );
    const mbr = friendlyRestorePlacementError(
      'Cannot build an MBR partition table: MBR partitions must start at or after LBA 63 ' +
        '(byte 32256); offset 0 cannot be represented'
    );

    expect(gpt).toContain('Byte offset 0 cannot be used');
    expect(gpt).toContain('partition-table validation check, not a drive failure');
    expect(gpt).toContain('1048576 bytes / 1 MiB');
    expect(mbr).toContain('Byte offset 0 cannot be used');
  });

  it('leaves unrelated and missing errors alone', () => {
    expect(friendlyRestorePlacementError(undefined)).toBeUndefined();
    expect(friendlyRestorePlacementError('Cannot unlock encrypted image')).toBeUndefined();
  });
});

describe('buildRestoreTargetLayout', () => {
  const partitions = [
    { index: 0, offsetOnDisk: 1_048_576 },
    { index: 1, offsetOnDisk: 0 }
  ];

  it('keeps the captured placement when nothing was overridden', () => {
    expect(
      buildRestoreTargetLayout({
        partitions,
        targetPartitions: [0],
        partitionSizesGb: {},
        placementOffsets: {}
      })
    ).toBeUndefined();
  });

  it('emits an explicit offset for a partition with no captured offset', () => {
    expect(
      buildRestoreTargetLayout({
        partitions,
        targetPartitions: [1],
        partitionSizesGb: {},
        placementOffsets: { 1: '1048576' }
      })
    ).toEqual([{ partitionIndex: 1, offset: 1_048_576 }]);
  });

  it('combines an explicit offset with a size override', () => {
    expect(
      buildRestoreTargetLayout({
        partitions,
        targetPartitions: [1],
        partitionSizesGb: { 1: '128' },
        placementOffsets: { 1: '0x100000' }
      })
    ).toEqual([{ partitionIndex: 1, offset: 1_048_576, size: 128 * 1024 ** 3 }]);
  });

  it('falls back to the captured offset for a size-only override', () => {
    expect(
      buildRestoreTargetLayout({
        partitions,
        targetPartitions: [0],
        partitionSizesGb: { 0: '10' },
        placementOffsets: {}
      })
    ).toEqual([{ partitionIndex: 0, offset: 1_048_576, size: 10 * 1024 ** 3 }]);
  });
});
