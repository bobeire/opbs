import type { NativeImagingApi } from '../imaging/imaging-job';

/**
 * Upper bound on overlapping source reads. Node's libuv thread pool defaults to
 * four threads and each blocking disk read occupies one, so more lanes than
 * that only queue. The cap is a sanity bound, not a promise of throughput.
 */
export const MAX_READ_LANES = 8;

interface QueueEntry {
  promise: Promise<Buffer>;
  lane: number;
}

/**
 * Reads partition blocks ahead of the frame writer.
 *
 * The capture loop is ordered: frames must be written in source order, and
 * progress/CRC/incremental decisions are made as each block is consumed. This
 * class keeps that contract and only moves the disk reads earlier: up to
 * `lanes` reads are in flight, each on its own native handle (`lane`), and
 * `read()` still returns blocks in the order the caller asks for them.
 *
 * Each lane is used by at most one outstanding read. Lanes are handed out from
 * a free list rather than derived from the block index, because used-block and
 * USN filtering makes the read sequence non-contiguous and `block % lanes`
 * could hand the same lane to two concurrent reads.
 */
export class BlockPrefetcher {
  private readonly queue = new Map<number, QueueEntry>();
  private readonly freeLanes: number[];
  private nextScanBlock = 0;

  constructor(
    private readonly api: NativeImagingApi,
    private readonly device: string,
    private readonly baseOffset: bigint,
    private readonly partitionSize: number,
    private readonly blockSize: number,
    private readonly shouldRead: (blockIndex: number) => boolean,
    lanes: number
  ) {
    this.freeLanes = [];
    const laneCount = Math.max(1, Math.min(MAX_READ_LANES, Math.floor(lanes)));
    for (let lane = 0; lane < laneCount; lane++) {
      this.freeLanes.push(lane);
    }
    this.fill();
  }

  /** Number of reads currently in flight. Exposed for tests and diagnostics. */
  get inFlight(): number {
    return this.queue.size;
  }

  /**
   * Resolve one block, in caller order. The block must have been prefetched;
   * callers walk the partition in ascending block order, which is exactly the
   * order `fill()` scans, so it always has been.
   */
  async read(blockIndex: number): Promise<Buffer> {
    let entry = this.queue.get(blockIndex);
    if (!entry) {
      if (this.freeLanes.length === 0) {
        throw new Error(
          `Read prefetcher has no free lane for block ${blockIndex} ` +
            `(${this.queue.size} reads in flight)`
        );
      }
      entry = this.issue(blockIndex);
    }
    this.queue.delete(blockIndex);
    try {
      return await entry.promise;
    } finally {
      this.freeLanes.push(entry.lane);
      this.fill();
    }
  }

  private fill(): void {
    while (this.freeLanes.length > 0) {
      const blockIndex = this.nextScanBlock;
      const offset = blockIndex * this.blockSize;
      if (offset >= this.partitionSize) {
        return;
      }
      this.nextScanBlock++;
      if (!this.shouldRead(blockIndex)) {
        continue;
      }
      this.issue(blockIndex);
    }
  }

  private issue(blockIndex: number): QueueEntry {
    const lane = this.freeLanes.pop();
    if (lane === undefined) {
      throw new Error(`Read prefetcher has no free lane for block ${blockIndex}`);
    }

    const offset = this.baseOffset + BigInt(blockIndex * this.blockSize);
    const length = Math.min(this.blockSize, this.partitionSize - blockIndex * this.blockSize);
    const promise = this.api.readBlocksAsync
      ? this.api.readBlocksAsync(this.device, offset, BigInt(length), lane)
      : Promise.resolve().then(() =>
          Buffer.from(this.api.readBlocks(this.device, offset, BigInt(length), lane))
        );

    // A prefetched read can fail before the consumer asks for it (and may never
    // be asked for if the job is cancelled). Mark it handled now; awaiting the
    // original promise later still throws the real error.
    promise.catch(() => undefined);

    const entry: QueueEntry = { promise, lane };
    this.queue.set(blockIndex, entry);
    return entry;
  }
}
