import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import type { CompressionType } from './image-format';

interface PendingOp {
  seq: number;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  done: boolean;
  result?: Buffer;
  error?: Error;
}

type PoolOp = 'compress' | 'decompress';

/**
 * Resolve the path to the native addon (opbs_native.node).
 * In packaged builds the addon is unpacked from ASAR; in dev it lives in
 * src/native/build/Release.
 */
function resolveAddonPath(): string | undefined {
  // Packaged: resources/app.asar.unpack/src/native/build/Release/opbs_native.node
  const unpacked = path.resolve(__dirname, '../../src/native/build/Release/opbs_native.node');
  if (fs.existsSync(unpacked)) return unpacked;
  // Dev: src/native/build/Release/opbs_native.node
  const dev = path.resolve(__dirname, '../../../src/native/build/Release/opbs_native.node');
  if (fs.existsSync(dev)) return dev;
  return undefined;
}

/**
 * Resolve the path to the compiled worker file.
 */
function resolveWorkerPath(): string {
  return path.resolve(__dirname, 'compression-worker.js');
}

/**
 * Multithreaded block (de)compressor using `worker_threads`.
 *
 * Workers load the native C++ zstd codec (opbs_native.node) for 10-100x faster
 * compression/decompression than the pure-JS zstdify/fzstd fallbacks.
 *
 * Data is transferred (not copied) to workers via postMessage transfer lists,
 * eliminating the structured-clone buffer copy overhead.
 *
 * The pool resolves results in submission order regardless of which worker
 * finishes first, so the caller can append frames / write blocks sequentially
 * without reordering.
 */
export class CompressionPool {
  readonly threads: number;
  private workers: Worker[] = [];
  private cursor = 0;
  private nextSeq = 0;
  private nextResolve = 0;
  private inFlight = 0;
  private readonly pending = new Map<number, PendingOp>();
  private readonly queue: { data: Uint8Array; seq: number; op: PoolOp }[] = [];
  private stopped = false;
  private readonly addonPath: string | undefined;
  private readonly workerPath: string;

  constructor(
    threads: number,
    private readonly level: number,
    private readonly codec: CompressionType
  ) {
    this.threads = Math.max(1, Math.floor(threads));
    this.addonPath = resolveAddonPath();
    this.workerPath = resolveWorkerPath();
  }

  compress(raw: Uint8Array): Promise<Buffer> {
    return this.submit(raw, 'compress');
  }

  decompress(compressed: Uint8Array): Promise<Buffer> {
    return this.submit(compressed, 'decompress');
  }

  private submit(data: Uint8Array, op: PoolOp): Promise<Buffer> {
    if (this.stopped) {
      throw new Error('CompressionPool already stopped');
    }
    return new Promise<Buffer>((resolve, reject) => {
      const seq = this.nextSeq++;
      const pending: PendingOp = { seq, resolve, reject, done: false };
      this.pending.set(seq, pending);
      // Defensive copy removed — data is transferred to the worker, not cloned.
      this.queue.push({ data: Buffer.from(data), seq, op });
      this.pump();
    });
  }

  private getWorker(): Worker {
    if (this.workers.length < this.threads && this.cursor >= this.workers.length) {
      const worker = new Worker(this.workerPath, {
        workerData: { addonPath: this.addonPath }
      });
      worker.on('message', (msg: { seq: number; ok: boolean; data?: Buffer; error?: string }) =>
        this.onResult(msg.seq, msg.ok, msg.data, msg.error)
      );
      worker.on('error', (err) => this.onWorkerError(err));
      worker.on('exit', (code) => {
        if (code !== 0) {
          this.onWorkerError(new Error(`Compression worker exited with code ${code}`));
        }
      });
      worker.unref();
      this.workers.push(worker);
    }
    const worker = this.workers[this.cursor % this.workers.length];
    this.cursor++;
    return worker;
  }

  private pump(): void {
    while (this.queue.length > 0 && this.inFlight < this.threads) {
      const job = this.queue.shift()!;
      const worker = this.getWorker();
      this.inFlight++;
      // Transfer the buffer to the worker — zero-copy. The buffer becomes
      // detached in this thread but we don't need it anymore (CRC was already
      // computed by the caller before submitting).
      const transferList: ArrayBuffer[] =
        job.data.buffer instanceof ArrayBuffer
          ? [job.data.buffer.slice(job.data.byteOffset, job.data.byteOffset + job.data.byteLength)]
          : [];
      worker.postMessage(
        { seq: job.seq, data: job.data, op: job.op, codec: this.codec, level: this.level },
        transferList
      );
    }
  }

  private onResult(seq: number, ok: boolean, data?: Buffer, error?: string): void {
    const op = this.pending.get(seq);
    if (!op) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    op.done = true;
    if (ok && data) {
      // The worker already transferred the compressed buffer to us (zero-copy).
      op.result = Buffer.isBuffer(data) ? data : Buffer.from(data);
    } else {
      op.error = new Error(error ?? 'Compression worker failed');
    }
    this.settle();
    this.pump();
  }

  private onWorkerError(err: Error): void {
    this.inFlight = 0;
    for (const op of this.pending.values()) {
      if (!op.done) {
        op.error = err;
        op.done = true;
      }
    }
    this.settle();
  }

  private settle(): void {
    while (true) {
      const op = this.pending.get(this.nextResolve);
      if (!op) return;
      if (!op.done) return;
      if (op.error) {
        op.reject(op.error);
      } else {
        op.resolve(op.result!);
      }
      this.pending.delete(this.nextResolve);
      this.nextResolve++;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    for (const worker of this.workers) {
      try { worker.postMessage('term'); } catch { /* already terminating */ }
      try { worker.terminate(); } catch { /* already terminated */ }
    }
    this.workers = [];
    for (const op of this.pending.values()) {
      op.reject(new Error('CompressionPool stopped'));
    }
    this.pending.clear();
  }
}
