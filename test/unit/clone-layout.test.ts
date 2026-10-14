import { describe, it, expect } from 'vitest';
import { planTargetLayout, CloneLayoutPartition } from '../../src/main/utils/clone-layout';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function part(partitionIndex: number, size: number): CloneLayoutPartition {
  return { partitionIndex, offset: 1048576, size };
}

describe('planTargetLayout (auto sequential placement)', () => {
  it('lays partitions out at 1 MiB alignment in order', () => {
    const target = 100 * GiB;
    const plan = planTargetLayout([part(2, 20 * GiB), part(3, 30 * GiB)], target, { growLast: false });

    expect(plan.ok).toBe(true);
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets[0]).toEqual({ partitionIndex: 2, offset: 1 * MiB, size: 20 * GiB });
    expect(plan.targets[1].offset).toBe(1 * MiB + 20 * GiB);
    expect(plan.targets[1].size).toBe(30 * GiB);
    expect(plan.totalBytes).toBe(50 * GiB);
    expect(plan.growBytes).toBe(0);
  });

  it('grows the last partition to fill the remaining budget', () => {
    const target = 100 * GiB;
    const plan = planTargetLayout([part(2, 20 * GiB), part(3, 30 * GiB)], target, { growLast: true });

    expect(plan.ok).toBe(true);
    const last = plan.targets[1];
    expect(last.size).toBeGreaterThan(30 * GiB);
    expect(last.size).toBe(plan.totalBytes - 20 * GiB);
    expect(plan.growBytes).toBe(last.size - 30 * GiB);
  });

  it('reports a clear error when partitions overflow the target', () => {
    const plan = planTargetLayout([part(2, 90 * GiB), part(3, 90 * GiB)], 100 * GiB, { growLast: false });

    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/Partition 3/);
    expect(plan.targets).toHaveLength(0);
  });

  it('reports an error for a single oversized partition', () => {
    const plan = planTargetLayout([part(1, 200 * GiB)], 100 * GiB, { growLast: true });

    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/Partition 1/);
  });

  it('handles an empty selection as a trivial plan', () => {
    const plan = planTargetLayout([], 100 * GiB);

    expect(plan.ok).toBe(true);
    expect(plan.targets).toHaveLength(0);
    expect(plan.totalBytes).toBe(0);
  });

  it('rejects a target disk that is too small to be a valid destination', () => {
    const plan = planTargetLayout([part(1, 1 * MiB)], 2 * MiB);
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/too small/);
  });
});

describe('planTargetLayout (shrink-to-fit)', () => {
  it('scales partitions down proportionally to fit a smaller target', () => {
    const target = 70 * GiB;
    const plan = planTargetLayout([part(2, 50 * GiB), part(3, 50 * GiB)], target, {
      growLast: false,
      shrinkToFit: true
    });

    expect(plan.ok).toBe(true);
    expect(plan.shrunk).toBe(true);
    expect(plan.targets[0].size).toBeLessThan(50 * GiB);
    expect(plan.targets[1].size).toBeLessThan(50 * GiB);
    expect(plan.targets[0].size % MiB).toBe(0);
    expect(plan.targets[1].size % MiB).toBe(0);
    expect(plan.totalBytes).toBe(plan.targets[0].size + plan.targets[1].size);
    expect(plan.totalBytes).toBeLessThanOrEqual(target - 3 * MiB);
    expect(plan.freeBytes).toBeGreaterThanOrEqual(0);
  });

  it('never scales a partition below minSize and shares the rest by headroom', () => {
    const plan = planTargetLayout(
      [{ ...part(2, 30 * GiB), minSize: 16 * GiB }, part(3, 30 * GiB)],
      30 * GiB,
      { growLast: false, shrinkToFit: true }
    );

    expect(plan.ok).toBe(true);
    expect(plan.shrunk).toBe(true);
    expect(plan.targets[0].size).toBeGreaterThanOrEqual(16 * GiB);
    expect(plan.targets[1].size).toBeLessThan(30 * GiB);
    expect(plan.totalBytes).toBeLessThanOrEqual(30 * GiB - 3 * MiB);
  });

  it('is a no-op when the partitions already fit', () => {
    const plan = planTargetLayout([part(2, 20 * GiB), part(3, 30 * GiB)], 100 * GiB, {
      growLast: false,
      shrinkToFit: true
    });

    expect(plan.ok).toBe(true);
    expect(plan.shrunk).toBeUndefined();
    expect(plan.targets[0].size).toBe(20 * GiB);
    expect(plan.targets[1].size).toBe(30 * GiB);
  });

  it('keeps the last partition at full size and grows it when growLast is set', () => {
    const plan = planTargetLayout([part(2, 50 * GiB), part(3, 50 * GiB)], 70 * GiB, {
      growLast: true,
      shrinkToFit: true
    });

    expect(plan.ok).toBe(true);
    expect(plan.shrunk).toBe(true);
    const last = plan.targets[1];
    expect(last.size).toBeGreaterThanOrEqual(plan.targets[0].size);
    expect(last.size).toBe(plan.totalBytes - plan.targets[0].size);
  });

  it('errors when a noShrink partition cannot be scaled down', () => {
    const plan = planTargetLayout(
      [{ ...part(2, 70 * GiB), noShrink: true }, part(3, 50 * GiB)],
      70 * GiB,
      { growLast: false, shrinkToFit: true }
    );

    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/Partition 2/);
    expect(plan.error).toMatch(/unsupported filesystem/);
  });

  it('errors when minSize floors alone exceed the target', () => {
    const plan = planTargetLayout(
      [
        { ...part(2, 30 * GiB), minSize: 20 * GiB },
        { ...part(3, 30 * GiB), minSize: 20 * GiB }
      ],
      30 * GiB,
      { growLast: false, shrinkToFit: true }
    );

    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/cannot shrink below/);
  });
});

describe('planTargetLayout (fixedSize — user-pinned partition sizes)', () => {
  it('honours a pinned size and leaves the rest as free space', () => {
    const plan = planTargetLayout(
      [{ ...part(2, 20 * GiB), fixedSize: true }, part(3, 30 * GiB)],
      100 * GiB,
      { growLast: false, shrinkToFit: false }
    );

    expect(plan.ok).toBe(true);
    expect(plan.targets[0].size).toBe(20 * GiB);
    expect(plan.targets[1].size).toBe(30 * GiB);
    expect(plan.freeBytes).toBeGreaterThan(40 * GiB);
  });

  it('grows a pinned partition down to an explicit smaller size', () => {
    const plan = planTargetLayout(
      [{ ...part(2, 20 * GiB), size: 10 * GiB, fixedSize: true }, part(3, 30 * GiB)],
      100 * GiB,
      { growLast: false, shrinkToFit: false }
    );

    expect(plan.ok).toBe(true);
    expect(plan.targets[0].size).toBe(10 * GiB);
    expect(plan.freeBytes).toBeGreaterThan(50 * GiB);
  });

  it('does not grow the last partition when it is pinned, even with growLast', () => {
    const plan = planTargetLayout(
      [part(2, 20 * GiB), { ...part(3, 30 * GiB), fixedSize: true }],
      100 * GiB,
      { growLast: true, shrinkToFit: false }
    );

    expect(plan.ok).toBe(true);
    expect(plan.targets[1].size).toBe(30 * GiB);
    expect(plan.freeBytes).toBeGreaterThan(40 * GiB);
    expect(plan.growBytes).toBe(0);
  });

  it('keeps a pinned size during shrink-to-fit while others scale', () => {
    const plan = planTargetLayout(
      [
        { ...part(2, 40 * GiB), fixedSize: true },
        { ...part(3, 40 * GiB), minSize: 5 * GiB }
      ],
      60 * GiB,
      { growLast: false, shrinkToFit: true }
    );

    expect(plan.ok).toBe(true);
    expect(plan.targets[0].size).toBe(40 * GiB);
    expect(plan.targets[1].size).toBeLessThan(40 * GiB);
    expect(plan.targets[1].size).toBeGreaterThanOrEqual(5 * GiB);
    expect(plan.shrunk).toBe(true);
  });

  it('errors when a pinned size alone exceeds the target', () => {
    const plan = planTargetLayout(
      [{ ...part(2, 70 * GiB), fixedSize: true }, part(3, 50 * GiB)],
      60 * GiB,
      { growLast: false, shrinkToFit: true }
    );

    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/Partition 2/);
    expect(plan.error).toMatch(/explicitly set to/);
  });

  it('rejects a non-last partition that overflows even with growLast on', () => {
    // growLast only grows the last partition; a non-last overflow must still
    // error immediately (previously it slipped through and surfaced later as
    // a confusing negative-remaining message on the next partition).
    const plan = planTargetLayout(
      [part(2, 110 * GiB), part(3, 1 * GiB)],
      100 * GiB,
      { growLast: true, shrinkToFit: false }
    );

    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/Partition 2/);
  });
});