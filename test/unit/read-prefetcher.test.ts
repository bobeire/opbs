import { describe, it, expect, vi } from 'vitest';
import { BlockPrefetcher, MAX_READ_LANES } from '../../src/main/helper/read-prefetcher';
import type { NativeImagingApi } from '../../src/main/imaging/imaging-job';

const BLOCK = 8;

function dataForOffset(offset: bigint, length: number): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Number((offset + BigInt(i)) % 251n);
  }
  return buf;
}

/** Async mock that records calls, tracks concurrent lane use, and resolves on a later microtask. */
function createLaneAwareNative() {
  const calls: Array<{ offset: bigint; length: bigint; lane: number }> = [];
  const activeLanes = new Set<number>();
  let maxConcurrent = 0;
  let concurrent = 0;
  const violations: string[] = [];

  const api: NativeImagingApi = {
    createSnapshot: vi.fn(() => ({ id: 's', devicePath: 'd' })),
    deleteSnapshot: vi.fn(() => true),
    getPhysicalDrivePath: vi.fn(() => '\\\\.\\PhysicalDrive0'),
    readBlocks: vi.fn(() => Buffer.alloc(0)),
    writeBlocks: vi.fn(() => 0),
    readBlocksAsync: vi.fn(async (_device: string, offset: bigint, length: bigint, lane = 0) => {
      calls.push({ offset, length, lane });
      if (activeLanes.has(lane)) {
        violations.push(`lane ${lane} used by two reads at once`);
      }
      activeLanes.add(lane);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      await Promise.resolve();
      concurrent--;
      activeLanes.delete(lane);
      return dataForOffset(offset, Number(length));
    })
  };

  return {
    api,
    calls,
    violations,
    get maxConcurrent() {
      return maxConcurrent;
    }
  };
}

describe('BlockPrefetcher', () => {
  it('issues reads ahead and returns every block in requested order', async () => {
    const native = createLaneAwareNative();
    const prefetcher = new BlockPrefetcher(
      native.api,
      'dev',
      0n,
      4 * BLOCK,
      BLOCK,
      () => true,
      2
    );

    expect(native.calls.length).toBe(2); // two lanes already filled
    const results: Buffer[] = [];
    for (let block = 0; block < 4; block++) {
      results.push(await prefetcher.read(block));
    }

    for (let block = 0; block < 4; block++) {
      expect(results[block]).toEqual(dataForOffset(BigInt(block * BLOCK), BLOCK));
    }
  });

  it('never runs two reads on the same lane even when the read sequence has gaps', async () => {
    const native = createLaneAwareNative();
    // Only even blocks are wanted: with lane = block % lanes every read would
    // land on lane 0 and race the shared handle.
    const wanted = new Set([0, 2, 4, 6, 8]);
    const prefetcher = new BlockPrefetcher(native.api, 'dev', 0n, 10 * BLOCK, BLOCK, (b) => wanted.has(b), 2);

    for (const block of [...wanted]) {
      await prefetcher.read(block);
    }

    expect(native.violations).toEqual([]);
    expect(native.calls.every((c) => c.lane >= 0 && c.lane < 2)).toBe(true);
    expect(native.maxConcurrent).toBeLessThanOrEqual(2);
    // 10 blocks scanned, only the five wanted ones read.
    expect(native.calls.length).toBe(5);
    expect(native.calls.map((c) => Number(c.offset / BigInt(BLOCK)))).toEqual([0, 2, 4, 6, 8]);
  });

  it('does not read blocks the caller would skip', async () => {
    const native = createLaneAwareNative();
    const prefetcher = new BlockPrefetcher(
      native.api,
      'dev',
      0n,
      4 * BLOCK,
      BLOCK,
      (block) => block === 3,
      4
    );

    await prefetcher.read(3);
    expect(native.calls.map((c) => Number(c.offset / BigInt(BLOCK)))).toEqual([3]);
  });

  it('applies the base offset to every read', async () => {
    const native = createLaneAwareNative();
    const prefetcher = new BlockPrefetcher(native.api, 'dev', 1000n, 2 * BLOCK, BLOCK, () => true, 2);

    await prefetcher.read(0);
    await prefetcher.read(1);

    expect(native.calls.map((c) => c.offset)).toEqual([1000n, 1000n + BigInt(BLOCK)]);
  });

  it('caps lanes at MAX_READ_LANES', async () => {
    const native = createLaneAwareNative();
    const prefetcher = new BlockPrefetcher(
      native.api,
      'dev',
      0n,
      64 * BLOCK,
      BLOCK,
      () => true,
      MAX_READ_LANES + 20
    );

    await prefetcher.read(0);
    expect(native.maxConcurrent).toBeLessThanOrEqual(MAX_READ_LANES);
  });

  it('propagates a read failure to the consumer without an unhandled rejection', async () => {
    const api: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: 'd' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn(() => '\\\\.\\PhysicalDrive0'),
      readBlocks: vi.fn(() => Buffer.alloc(0)),
      writeBlocks: vi.fn(() => 0),
      readBlocksAsync: vi.fn(async (_device: string, offset: bigint) => {
        if (offset === BigInt(BLOCK)) throw new Error('read exploded');
        return Buffer.alloc(BLOCK);
      })
    };
    const prefetcher = new BlockPrefetcher(api, 'dev', 0n, 2 * BLOCK, BLOCK, () => true, 2);

    await expect(prefetcher.read(0)).resolves.toEqual(Buffer.alloc(BLOCK));
    await expect(prefetcher.read(1)).rejects.toThrow('read exploded');
  });

  it('falls back to the synchronous read path when readBlocksAsync is unavailable', async () => {
    const readBlocks = vi.fn((_device: string, offset: bigint, length: bigint) =>
      dataForOffset(offset, Number(length))
    );
    const api: NativeImagingApi = {
      createSnapshot: vi.fn(() => ({ id: 's', devicePath: 'd' })),
      deleteSnapshot: vi.fn(() => true),
      getPhysicalDrivePath: vi.fn(() => '\\\\.\\PhysicalDrive0'),
      readBlocks,
      writeBlocks: vi.fn(() => 0)
    };
    const prefetcher = new BlockPrefetcher(api, 'dev', 0n, 2 * BLOCK, BLOCK, () => true, 2);

    const first = await prefetcher.read(0);
    const second = await prefetcher.read(1);
    expect(first).toEqual(dataForOffset(0n, BLOCK));
    expect(second).toEqual(dataForOffset(BigInt(BLOCK), BLOCK));
    expect(readBlocks).toHaveBeenCalled();
  });
});
