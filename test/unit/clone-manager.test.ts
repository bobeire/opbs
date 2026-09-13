import { describe, it, expect } from 'vitest';
import { CloneManager } from '../../src/main/clone/manager';
import { CloneEngine } from '../../src/main/imaging/clone-engine';

const GiB = 1024 * 1024 * 1024;

function stubDisks(sourceOffsets: Array<{ partitionIndex: number; offset: number; size: number }>) {
  return {
    getDisks: async () => [
      {
        index: 0,
        size: 100 * GiB,
        model: 'SourceDrive',
        serial: 'SRC123',
        partitions: sourceOffsets.map((p) => ({
          partitionIndex: p.partitionIndex,
          offset: p.offset,
          size: p.size,
          label: `Partition ${p.partitionIndex}`,
          driveLetter: null,
          fsType: 'Unknown',
          type: 0
        }))
      },
      {
        index: 1,
        size: 100 * GiB,
        model: 'TargetDrive',
        serial: 'TGT123',
        partitions: []
      }
    ],
    getPartitions: async (_diskIndex: number) =>
      sourceOffsets.map((p) => ({
        diskIndex: 0,
        partitionIndex: p.partitionIndex,
        offset: p.offset,
        size: p.size,
        type: 0,
        label: `Partition ${p.partitionIndex}`,
        driveLetter: null,
        fsType: 'Unknown',
        usedSpace: 0,
        isSystem: false,
        isBoot: false
      })),
    getVolumePath: async () => null
  };
}

describe('CloneManager.preflight (dry-run)', () => {
  it('plans a sequential copy onto a blank target without writing', async () => {
    const engine = new CloneEngine(stubDisks([
      { partitionIndex: 0, offset: 1048576, size: 16 * GiB },
      { partitionIndex: 1, offset: 1048576 + 16 * GiB, size: 40 * GiB }
    ]) as never);
    const manager = new CloneManager(engine, stubDisks([
      { partitionIndex: 0, offset: 1048576, size: 16 * GiB },
      { partitionIndex: 1, offset: 1048576 + 16 * GiB, size: 40 * GiB }
    ]) as never);

    const result = await manager.preflight({
      sourceDiskIndex: 0,
      sourcePartitions: [0, 1],
      targetDiskIndex: 1,
      usedBlocksOnly: true,
      targetLayout: [
        { partitionIndex: 0, offset: 1048576, size: 16 * GiB },
        { partitionIndex: 1, offset: 1048576 + 20 * GiB, size: 60 * GiB }
      ],
      acknowledgeLayout: true,
      tableScheme: 'gpt'
    });

    expect(result.ok).toBe(true);
    expect(result.targets).toHaveLength(2);
    expect(result.requiredBytes).toBe(76 * GiB);
    expect(result.targetDiskBytes).toBe(100 * GiB);
    expect(result.targetDiskModel).toBe('TargetDrive');
    expect(result.targetDiskPartitionCount).toBe(0);
    expect(result.writeTableScheme).toBe('gpt');
    expect(result.sameDisk).toBe(false);
  });

  it('warns when the target disk already has partitions (data-loss signal)', async () => {
    const disks = stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]);
    (disks as any).getDisks = async () => [
      { index: 0, size: 100 * GiB, model: 'SourceDrive', serial: 'SRC123', partitions: [{ partitionIndex: 0 }] },
      { index: 1, size: 100 * GiB, model: 'TargetDrive', serial: 'TGT123', partitions: [{ partitionIndex: 0 }] }
    ];
    const manager = new CloneManager(new CloneEngine(disks as never), disks as never);

    const result = await manager.preflight({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1,
      targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }],
      acknowledgeLayout: true,
      tableScheme: 'gpt'
    });

    expect(result.ok).toBe(true);
    expect(result.targetDiskPartitionCount).toBe(1);
    expect(result.warnings?.join()).toMatch(/erases them/);
  });

  it('refuses to copy a disk onto itself', async () => {
    const manager = new CloneManager(
      new CloneEngine(stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]) as never),
      stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]) as never
    );

    const result = await manager.preflight({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 0,
      targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }],
      acknowledgeLayout: true,
      tableScheme: 'gpt'
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be the same disk/);
  });

  it('fails preflight when the target disk is missing', async () => {
    const manager = new CloneManager(
      new CloneEngine(stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]) as never),
      stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]) as never
    );

    const result = await manager.preflight({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 9,
      targetLayout: [{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }],
      acknowledgeLayout: true,
      tableScheme: 'gpt'
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Target disk 9 not found/);
  });

  it('rejects a copy with no planned layout', async () => {
    const manager = new CloneManager(
      new CloneEngine(stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]) as never),
      stubDisks([{ partitionIndex: 0, offset: 1048576, size: 16 * GiB }]) as never
    );

    const result = await manager.preflight({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No target layout/);
  });
});