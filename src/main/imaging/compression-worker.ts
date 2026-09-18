import { parentPort, workerData } from 'worker_threads';
import * as zlib from 'zlib';

// Load native zstd from the addon (passed by the main process).
// Falls back to zstdify (JS) if the native addon is unavailable.
let nativeCompress: ((data: Uint8Array, level?: number) => Buffer) | null = null;
let nativeDecompress: ((data: Uint8Array) => Buffer) | null = null;
let fzstdDecompress: ((data: Uint8Array) => Uint8Array) | null = null;

const addonPath = (workerData as { addonPath?: string } | null)?.addonPath;
if (addonPath) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const addon = require(addonPath);
    if (addon.zstdCompress) nativeCompress = addon.zstdCompress;
    if (addon.zstdDecompress) nativeDecompress = addon.zstdDecompress;
  } catch {
    /* native addon unavailable; fall through to JS codecs */
  }
}

// Always load fzstd for decompression fallback.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fzstdDecompress = require('fzstd').decompress;
} catch {
  /* will error at runtime if needed */
}

function compress(data: Uint8Array, level: number, codec: string): Buffer {
  if (codec === 'zstd') {
    if (nativeCompress) {
      return Buffer.from(nativeCompress(data, level));
    }
    // JS fallback: zstdify with level fallback for known FSE bugs.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zstdify = require('zstdify');
    try {
      return Buffer.from(zstdify.compress(data, { level }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const fb of [1, 4, 6]) {
        if (fb === level) continue;
        try { return Buffer.from(zstdify.compress(data, { level: fb })); } catch { /* try next */ }
      }
      throw new Error('zstdify compress failed at all levels: ' + msg);
    }
  }
  // deflate
  return zlib.deflateRawSync(Buffer.from(data), { level });
}

function decompress(data: Uint8Array, codec: string): Buffer {
  if (codec === 'zstd') {
    if (nativeDecompress) {
      return Buffer.from(nativeDecompress(data));
    }
    if (fzstdDecompress) {
      return Buffer.from(fzstdDecompress(data));
    }
    throw new Error('No zstd decompressor available');
  }
  return zlib.inflateRawSync(Buffer.from(data));
}

parentPort?.on('message', (msg: { seq: number; data: Uint8Array; op: 'compress' | 'decompress'; codec: string; level: number } | 'term') => {
  if (msg === 'term') { parentPort?.postMessage('bye'); return; }
  try {
    const out = msg.op === 'decompress'
      ? decompress(msg.data, msg.codec)
      : compress(msg.data, msg.level, msg.codec);
    const transferList: ArrayBuffer[] = out.buffer instanceof ArrayBuffer ? [out.buffer] : [];
    parentPort?.postMessage({ seq: msg.seq, ok: true, data: out }, transferList);
  } catch (err) {
    parentPort?.postMessage({
      seq: msg.seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
});
