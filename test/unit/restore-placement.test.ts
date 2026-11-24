import { describe, it, expect } from 'vitest';
import {
  buildRestoreTargetLayout,
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
