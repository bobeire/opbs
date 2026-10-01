import { describe, it, expect, vi } from 'vitest';
import { CloneEngine } from '../../src/main/imaging/clone-engine';
import { DiskEnumerator } from '../../src/main/utils/disk-enumerator';
import { GPT_EFI_SYSTEM_GUID } from '../../src/main/imaging/partition-table';

const PARTITIONS = [
  { diskIndex: 0, partitionIndex: 0, offset: 1048576, size: 4096 * 10, type: 7, label: 'P0' },
  { diskIndex: 0, partitionIndex: 1, offset: 105906176, size: 4096 * 5, type: 7, label: 'P1' }
];

interface FakeOpts {
  sourceSerial?: string;
  targetSerial?: string;
  blankTarget?: boolean;
  partitions?: typeof PARTITIONS;
}

function createFakeEnumerator(opts?: FakeOpts): DiskEnumerator {
  const partitions = opts?.partitions ?? PARTITIONS;
  return {
    getDisks: vi.fn(async () => [
      { index: 0, model: 'SOURCE', size: 200000000000, serial: opts?.sourceSerial ?? 'SRC' },
      { index: 1, model: 'TARGET', size: 1_000_000_000, serial: opts?.targetSerial ?? 'TGT' }
    ]),
    getPartitions: vi.fn(async (diskIndex: number) => (diskIndex === 0 ? partitions : [])),
    isDiskBlank: vi.fn(() => opts?.blankTarget ?? false),
    getPhysicalDrivePath: vi.fn((i: number) => `\\\\.\\PhysicalDrive${i}`),
    getVolumePath: vi.fn(async () => null)
  } as unknown as DiskEnumerator;
}

function createFailingBlankEnumerator(): DiskEnumerator {
  const enumerator = createFakeEnumerator();
  (enumerator as unknown as { isDiskBlank: ReturnType<typeof vi.fn> }).isDiskBlank = vi.fn(() => {
    throw new Error('ioctl failed');
  });
  return enumerator;
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

  it('lays down a fresh GPT table on a blank target with the source ESP typed as EFI System', async () => {
    const esp = [{ ...PARTITIONS[0], type: 0xef }];
    const engine = new CloneEngine(createFakeEnumerator({ blankTarget: true, partitions: esp }));
    const job = await engine.buildJob({ sourceDiskIndex: 0, sourcePartitions: [0], targetDiskIndex: 1 });
    expect(job.writeTable).toBeDefined();
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.entries[0].typeGuid).toBe(GPT_EFI_SYSTEM_GUID);
    expect(job.warnings!.join(' ')).toMatch(/has no partition table/);
  });

  it('does not write a table on a target that already has partitions', async () => {
    const engine = new CloneEngine(createFakeEnumerator());
    const job = await engine.buildJob({ sourceDiskIndex: 0, sourcePartitions: [0], targetDiskIndex: 1 });
    expect(job.writeTable).toBeUndefined();
    expect(job.warnings).toBeUndefined();
  });

  it('treats an unreadable target layout as not blank (never overwrites blindly)', async () => {
    const engine = new CloneEngine(createFailingBlankEnumerator());
    const job = await engine.buildJob({ sourceDiskIndex: 0, sourcePartitions: [0], targetDiskIndex: 1 });
    expect(job.writeTable).toBeUndefined();
  });

  it('respects writePartitionTable:false on a blank target', async () => {
    const engine = new CloneEngine(createFakeEnumerator({ blankTarget: true }));
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1,
      writePartitionTable: false
    });
    expect(job.writeTable).toBeUndefined();
  });

  it('prefers GPT for a dissimilar clone whose source contains an ESP (auto)', async () => {
    const partitions = [
      { ...PARTITIONS[0], type: 0xef },
      { ...PARTITIONS[1], type: 7 }
    ];
    const engine = new CloneEngine(createFakeEnumerator({ partitions }));
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0, 1],
      targetDiskIndex: 1,
      targetLayout: [
        { partitionIndex: 0, offset: 1048576 },
        { partitionIndex: 1, offset: 16777216 }
      ],
      acknowledgeLayout: true
    });
    expect(job.writeTable!.scheme).toBe('gpt');
    expect(job.writeTable!.entries.find((e) => e.name === 'Partition 0')!.typeGuid).toBe(GPT_EFI_SYSTEM_GUID);
  });

  it('keeps auto→MBR for a dissimilar clone without an ESP and types partitions from the filesystem', async () => {
    const partitions = [
      { ...PARTITIONS[0], fsType: 'NTFS' },
      { ...PARTITIONS[1], fsType: 'FAT32' }
    ];
    const engine = new CloneEngine(createFakeEnumerator({ partitions }));
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0, 1],
      targetDiskIndex: 1,
      targetLayout: [
        { partitionIndex: 0, offset: 1048576 },
        { partitionIndex: 1, offset: 16777216 }
      ],
      acknowledgeLayout: true
    });
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].mbrType).toBe(0x07);
    expect(job.writeTable!.entries[0].bootable).toBe(true);
    expect(job.writeTable!.entries[1].mbrType).toBe(0x0c);
    expect(job.writeTable!.entries[1].bootable).toBe(false);
  });

  it('falls back to the mapped source type when a raw partition has no filesystem', async () => {
    const partitions = [{ ...PARTITIONS[0], type: 0x83 }];
    const engine = new CloneEngine(createFakeEnumerator({ partitions }));
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1,
      targetLayout: [{ partitionIndex: 0, offset: 4194304 }],
      acknowledgeLayout: true
    });
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].mbrType).toBe(0x83);
  });

  it('honors an explicit MBR scheme even when the source has an ESP (0xEF type byte)', async () => {
    const esp = [{ ...PARTITIONS[0], type: 0xef }];
    const engine = new CloneEngine(createFakeEnumerator({ blankTarget: true, partitions: esp }));
    const job = await engine.buildJob({
      sourceDiskIndex: 0,
      sourcePartitions: [0],
      targetDiskIndex: 1,
      tableScheme: 'mbr'
    });
    expect(job.writeTable!.scheme).toBe('mbr');
    expect(job.writeTable!.entries[0].mbrType).toBe(0xef);
    expect(job.writeTable!.entries[0].bootable).toBe(true);
    expect(job.writeTable!.entries[0].typeGuid).toBeUndefined();
  });
});