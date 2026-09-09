import { describe, it, expect, vi } from 'vitest';
import { CloneEngine } from '../../src/main/imaging/clone-engine';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';

const PARTITIONS = [
  { diskIndex: 0, partitionIndex: 0, offset: 1048576, size: 4096 * 10, type: 7, label: 'P0' },
  { diskIndex: 0, partitionIndex: 1, offset: 105906176, size: 4096 * 5, type: 7, label: 'P1' }
];

function createFakeEnumerator(opts?: { sourceSerial?: string; targetSerial?: string }): DiskEnumerator {
  return {
    getDisks: vi.fn(async () => [
      { index: 0, model: 'SOURCE', size: 200000000000, serial: opts?.sourceSerial ?? 'SRC' },
      { index: 1, model: 'TARGET', size: 1_000_000_000, serial: opts?.targetSerial ?? 'TGT' }
    ]),
    getPartitions: vi.fn(async (diskIndex: number) => (diskIndex === 0 ? PARTITIONS : [])),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async () => null)
  } as unknown as DiskEnumerator;
}

describe('CloneEngine.buildJob', () => {
  it('places targets at the captured on-disk offsets by default', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0, 1],
      targetDiskIndex: 1
    });
    expect(job.targets.map((t) => t.offset)).toEqual([1048576, 105906176]);
    expect(job.partitions.map((p) => p.readSource)).toEqual(['physical', 'physical']);
    expect(job.usedBlocksOnly).toBeUndefined();
  });

  it('honors a custom targetLayout and writes a partition table', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0, 1],
      targetDiskIndex: 1,
      targetLayout: [
        { partitionIndex: 1, offset: 16777216 },
        { partitionIndex: 0, offset: 17408 }
      ],
      acknowledgeLayout: true,
      tableScheme: 'gpt'
    });
    expect(job.targets.find((t) => t.partitionIndex === 0)!.offset).toBe(17408);
    expect(job.targets.find((t) => t.partitionIndex === 1)!.offset).toBe(16777216);
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('gpt');
  });

  it('requires --confirm-layout for a moving layout', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        targetDiskIndex: 1,
        targetLayout: [{ partitionIndex: 0, offset: 9999999 }]
      })
    ).rejects.toThrow(/fresh partition table/i);
  });

  it('skips the partition table when writePartitionTable is false', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1,
      targetLayout: [{ partitionIndex: 0, offset: 9999999 }],
      acknowledgeLayout: true,
      writePartitionTable: false
    });
    expect(job.writeTable).toBeUndefined();
    expect(job.targets[0].offset).toBe(9999999);
  });

  it('refuses to shrink a partition', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        targetDiskIndex: 1,
        targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 4096 }]
      })
    ).rejects.toThrow(/cannot shrink/i);
  });

  it('guards against cloning onto the source disk (by index) with a custom layout', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({
        sourceDiskIndex: 0,
        sourcePartitions: [0],
        targetDiskIndex: 0,
        targetLayout: [{ partitionIndex: 0, offset: 8388608 }],
        acknowledgeLayout: true
      })
    ).rejects.toThrow(/same disk/i);

    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 0,
      targetLayout: [{ partitionIndex: 0, offset: 8388608 }],
      acknowledgeLayout: true,
      acknowledgeSameDisk: true
    });
    expect(job.warnings!.some((w) => w.includes('cloning onto the source disk in place'))).toBe(true);
  });

  it('accepts an untouched same-disk clone layout without acknowledgement', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 0,
      targetLayout: [{ partitionIndex: 0, offset: 1048576 }],
      acknowledgeLayout: true
    });
    expect(job.targets[0].offset).toBe(1048576);
    expect(job.warnings).toBeUndefined();
  });

  it('fails when the target disk does not exist', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({ sourceDiskIndex: 0, sourcePartitions: [0], targetDiskIndex: 9 })
    ).rejects.toThrow(/not found/i);
  });

  it('fails when no source partition matches', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    await expect(
      engine.buildJob({ sourceDiskIndex: 0, sourcePartitions: [5], targetDiskIndex: 1 })
    ).rejects.toThrow(/no matching partitions/i);
  });

  it('propagates usedBlocksOnly into the job', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1,
      usedBlocksOnly: true
    });
    expect(job.usedBlocksOnly).toBe(true);
    expect(job.blockSize).toBeGreaterThan(0);
  });
});