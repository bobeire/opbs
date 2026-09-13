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