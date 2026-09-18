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
 * Multithreaded block (de)compressor using `worker_threads`.
 *
 * (De)compression is inherently independent per block, so each worker only
 * needs Node builtins plus the pure-JS zstd codec. Workers run inline via
 * `eval: true`, which keeps the packaged app safe (no extra asset file to
 * resolve under asar) and avoids shipping a compiled worker bundle.
 *
 * The pool resolves results in submission order regardless of which worker
 * finishes first, so the caller can append frames / write blocks sequentially
 * without reordering.
 */
export class CompressionPool {
  /** Maximum number of worker threads in the pool. */
  readonly threads: number;
  private workers: Worker[] = [];
  private cursor = 0;
  private nextSeq = 0;
  private nextResolve = 0;
  private inFlight = 0;
  private readonly pending = new Map<number, PendingOp>();
  private readonly queue: { data: Uint8Array; seq: number; op: PoolOp }[] = [];
  private stopped = false;

  constructor(
    threads: number,
    private readonly level: number,
    private readonly codec: CompressionType
  ) {
    this.threads = Math.max(1, Math.floor(threads));
  }

  /**
   * Compress a raw block. Resolves (in submission order) once the result is
   * ready. Rejects if any earlier submitted block fails.
   */
  compress(raw: Uint8Array): Promise<Buffer> {
    return this.submit(raw, 'compress');
  }

  /**
   * Decompress a stored (compressed) block. Resolves in submission order,
   * mirroring `compress`. The `level` is ignored for decompression.
   */
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
      this.queue.push({ data: Buffer.from(data), seq, op });
      this.pump();
    });
  }

  private workerSource(): string {
    // zstdify is ESM-only; the build bundles it to a CJS file the main process
    // (and these eval workers) can load. When the bundle is absent (dev/tests)
    // fall back to the package name, which modern Node can require directly.
    const zstdBundle = path.resolve(__dirname, '../zstdify.cjs');
    const zstdRequireExpr = fs.existsSync(zstdBundle) ? `require(${JSON.stringify(zstdBundle)})` : `require('zstdify')`;
    const fzstdPath = require.resolve('fzstd');
    const fzstdRequireExpr = `require(${JSON.stringify(fzstdPath)})`;
    const zstdRequires =
      this.codec === 'zstd' ? `const zstdify = ${zstdRequireExpr};\n      const fzstd = ${fzstdRequireExpr};\n      ` : '';
    const compressExpr =
      this.codec === 'zstd'
        ? `(function() {
            try {
              return Buffer.from(zstdify.compress(Uint8Array.from(data), { level: ${this.level} }));
            } catch (e) {
              var msg = e && e.message ? e.message : String(e);
              for (var fb of [1, 4, 6]) {
                if (fb === ${this.level}) continue;
                try { return Buffer.from(zstdify.compress(Uint8Array.from(data), { level: fb })); } catch (_) {}
              }
              throw new Error('zstdify compress failed at all levels: ' + msg);
            }
          })()`
        : `Buffer.from(zlib.deflateRawSync(Buffer.from(data), { level: ${this.level} }))`;
    const decompressExpr =
      this.codec === 'zstd'
        ? `Buffer.from(fzstd.decompress(Uint8Array.from(data)))`
        : `Buffer.from(zlib.inflateRawSync(Buffer.from(data)))`;
    return `
      const { parentPort } = require('worker_threads');
      const zlib = require('zlib');
      ${zstdRequires}
      parentPort.on('message', (msg) => {
        if (msg === 'term') { parentPort.postMessage('bye'); return; }
        try {
          const data = msg.data;
          const out = msg.op === 'decompress'
            ? ${decompressExpr}
            : ${compressExpr};
          parentPort.postMessage({ seq: msg.seq, ok: true, data: out });
        } catch (err) {
          parentPort.postMessage({ seq: msg.seq, ok: false, error: String(err && err.message ? err.message : err) });
        }
      });
    `;
  }

  private getWorker(): Worker {
    if (this.workers.length < this.threads && this.cursor >= this.workers.length) {
      const worker = new Worker(this.workerSource(), { eval: true });
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

  /** Dispatch queued jobs to workers, keeping at most `threads` in flight. */
  private pump(): void {
    while (this.queue.length > 0 && this.inFlight < this.threads) {
      const job = this.queue.shift()!;
      const worker = this.getWorker();
      this.inFlight++;
      worker.postMessage({ seq: job.seq, data: job.data, op: job.op });
    }
  }

  private onResult(seq: number, ok: boolean, data?: Buffer, error?: string): void {
    const op = this.pending.get(seq);
    if (!op) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    op.done = true;
    if (ok && data) {
      // Structured clone turns Buffer into Uint8Array; wrap back into a real
      // Buffer so callers (and native.writeBlocks) get a Buffer consistently.
      op.result = Buffer.from(data);
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

  /** Resolve/reject ops in submission order as soon as their turn is up. */
  private settle(): void {
    while (true) {
      const op = this.pending.get(this.nextResolve);
      if (!op) return;
      if (!op.done) return; // wait for this op before releasing later ones
      if (op.error) {
        op.reject(op.error);
      } else {
        op.resolve(op.result!);
      }
      this.pending.delete(this.nextResolve);
      this.nextResolve++;
    }
  }

  /** Stop all workers and free resources. Safe to call multiple times. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    for (const worker of this.workers) {
      try {
        worker.postMessage('term');
      } catch {
        /* already terminating */
      }
      try {
        worker.terminate();
      } catch {
        /* already terminated */
      }
    }
    this.workers = [];
    for (const op of this.pending.values()) {
      op.reject(new Error('CompressionPool stopped'));
    }
    this.pending.clear();
  }
}
