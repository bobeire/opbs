import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { isNonFilesystemLocation } from './location';

/**
 * Disk write/read performance test.
 *
 * Measures sustained sequential throughput of a backup destination by writing
 * a scratch file (default 256 MiB) to the destination directory, fsync-ing it,
 * reading it back, then cleaning up. Never touches existing data and never
 * formats anything. Results are persisted next to the backups themselves
 * (`opbs-perf.json`) so the storage-health dashboard and trending can replay
 * them without re-running a multi-second test on every render.
 *
 * The write-speed rubric is kept pure and small (`assessWriteSpeed`) so the
 * exact thresholds feeding the storage-health score are unit-tested and
 * documented.
 */

export interface DiskPerfResult {
  /** Destination directory the test was run against. */
  directory: string;
  /** When the test finished (epoch ms). */
  at: number;
  /** Bytes written and read back. */
  bytes: number;
  /** Sustained sequential write throughput (MiB/s). */
  seqWriteMBs: number;
  /** Sustained sequential read throughput (MiB/s). */
  seqReadMBs: number;
  /** Wall-clock time for the write pass (ms). */
  writeDurationMs: number;
  /** Wall-clock time for the read pass (ms). */
  readDurationMs: number;
  ok: boolean;
  error?: string;
}

export interface DiskPerfOptions {
  /** Test size in bytes (default 256 MiB). */
  sizeBytes?: number;
  /** I/O block size (default 1 MiB). */
  blockSize?: number;
}

/**
 * Transparent write-speed rubric. Conservative enough not to punish a
 * slow-but-healthy drive, aggressive enough to flag a degrading one:
 *  - >= 100 MiB/s : no penalty (healthy HDD / SSD)
 *  - >= 40  MiB/s : -5  (slower than typical; SMR/USB-class media)
 *  - >= 15  MiB/s : -10 (suspicious sustained throughput)
 *  - <  15  MiB/s : -15 (severely degraded)
 */
export function assessWriteSpeed(speedMBs: number): {
  penalty: number;
  label: 'good' | 'fair' | 'slow' | 'critical';
} {
  if (!Number.isFinite(speedMBs) || speedMBs < 0) {
    return { penalty: 0, label: 'good' };
  }
  if (speedMBs >= 100) return { penalty: 0, label: 'good' };
  if (speedMBs >= 40) return { penalty: -5, label: 'fair' };
  if (speedMBs >= 15) return { penalty: -10, label: 'slow' };
  return { penalty: -15, label: 'critical' };
}

const PERF_FILE = 'opbs-perf.json';
const MAX_HISTORY = 20;

export function perfPath(dir: string): string {
  return path.join(dir, PERF_FILE);
}

/** All recorded runs, newest first. Returns [] on any read problem. */
export function readPerfHistory(dir: string): DiskPerfResult[] {
  try {
    const data = fs.readFileSync(perfPath(dir), 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => !!r && typeof r.at === 'number')
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** The most recent recorded run, or null. */
export function latestPerf(dir: string): DiskPerfResult | null {
  return readPerfHistory(dir)[0] ?? null;
}

export function recordPerfResult(dir: string, result: DiskPerfResult): void {
  try {
    const history = readPerfHistory(dir).filter((r) => r.at !== result.at);
    history.unshift(result);
    fs.writeFileSync(perfPath(dir), JSON.stringify(history.slice(0, MAX_HISTORY), null, 2), 'utf-8');
  } catch {
    /* best-effort: destination may be offline or read-only */
  }
}

/**
 * Run a sustained write + read benchmark against a directory. Non-destructive:
 * writes `.opbs-perf-*.tmp`, fsyncs, reads back, always deletes the scratch
 * file. Records the result into the destination's `opbs-perf.json`.
 */
export function runDiskPerfTest(directory: string, options: DiskPerfOptions = {}): DiskPerfResult {
  const dir = String(directory ?? '').trim();
  if (!dir) {
    return { directory: dir, at: Date.now(), bytes: 0, seqWriteMBs: 0, seqReadMBs: 0, writeDurationMs: 0, readDurationMs: 0, ok: false, error: 'No directory provided' };
  }
  if (isNonFilesystemLocation(dir)) {
    return {
      directory: dir,
      at: Date.now(),
      bytes: 0,
      seqWriteMBs: 0,
      seqReadMBs: 0,
      writeDurationMs: 0,
      readDurationMs: 0,
      ok: false,
      error: 'Not a local filesystem path — a disk write test can only run on local destinations'
    };
  }

  const sizeBytes = Math.max(1, Math.floor(options.sizeBytes ?? 256 * 1024 * 1024));
  const blockSize = Math.max(1, Math.min(sizeBytes, Math.floor(options.blockSize ?? 1024 * 1024)));

  const scratch = path.join(dir, `.opbs-perf-${process.pid}-${Date.now()}.tmp`);
  let fd: number | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = undefined;
    }
    if (!cleaned) {
      cleaned = true;
      try {
        fs.unlinkSync(scratch);
      } catch {
        /* ignore */
      }
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });

    const buffer = Buffer.alloc(blockSize, 0x5a);
    const base = { directory: dir, at: Date.now(), bytes: sizeBytes };

    // Write pass.
    fd = fs.openSync(scratch, 'w');
    const writeStart = performance.now();
    let written = 0;
    while (written < sizeBytes) {
      const chunk = Math.min(blockSize, sizeBytes - written);
      fs.writeSync(fd, buffer, 0, chunk);
      written += chunk;
    }
    fs.fsyncSync(fd);
    const writeDurationMs = performance.now() - writeStart;
    fs.closeSync(fd);
    fd = undefined;

    // Read pass.
    fd = fs.openSync(scratch, 'r');
    const readBuffer = Buffer.allocUnsafe(blockSize);
    const readStart = performance.now();
    let readTotal = 0;
    let readBytes = 0;
    while (readTotal < sizeBytes) {
      readBytes = fs.readSync(fd, readBuffer, 0, blockSize, readTotal);
      if (readBytes <= 0) break;
      readTotal += readBytes;
    }
    const readDurationMs = performance.now() - readStart;
    cleanup();

    const seqWriteMBs = writeDurationMs > 0 ? (sizeBytes / (1024 * 1024)) / (writeDurationMs / 1000) : 0;
    const seqReadMBs = readDurationMs > 0 ? (readTotal / (1024 * 1024)) / (readDurationMs / 1000) : 0;

    const result: DiskPerfResult = {
      ...base,
      seqWriteMBs,
      seqReadMBs,
      writeDurationMs,
      readDurationMs,
      ok: true
    };
    recordPerfResult(dir, result);
    return result;
  } catch (error) {
    cleanup();
    const message = error instanceof Error ? error.message : String(error);
    return {
      directory: dir,
      at: Date.now(),
      bytes: 0,
      seqWriteMBs: 0,
      seqReadMBs: 0,
      writeDurationMs: 0,
      readDurationMs: 0,
      ok: false,
      error: message
    };
  }
}