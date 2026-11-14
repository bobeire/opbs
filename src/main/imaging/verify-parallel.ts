import * as fs from 'fs';
import { CompressionPool } from './compression-pool';
import {
  CIPHER_NONE,
  COMPRESSION_NONE,
  GCM_IV_LENGTH,
  GCM_TAG_LENGTH,
  KEY_LENGTH,
  VerifyResult,
  baseVolumePath,
  compressionTypeOf,
  crc32,
  decompressBlock,
  readFrameCompressed,
  readImageInfo
} from './image-format';

const FRAME_HEADER_SIZE = 16;

interface PendingFrame {
  pos: number;
  rawSize: number;
  rawCrc: number;
  promise: Promise<Buffer>;
}

/**
 * Verify an image exactly as {@link verifyImage} does, but with frames read
 * ahead and decompressed on a worker pool. Runs inside the verification worker,
 * so the caller's event loop is free while a large image is re-read.
 *
 * The checks are unchanged: compressed-frame CRC, decompression, raw size and
 * raw CRC, then frame count against the stored block index. Only the order of
 * *work* changes; results and error messages are reported in frame order.
 */
export async function verifyImageParallel(
  imagePath: string,
  key?: Buffer,
  onProgress?: (done: number, total: number) => void,
  threads = 4
): Promise<VerifyResult> {
  const info = readImageInfo(imagePath);
  const hasIndex = info.header.blockIndexOffset > 0;
  const cipherId = info.header.cipherId;
  const compressionId = info.header.compressionId;

  if (cipherId !== CIPHER_NONE && (!key || key.length !== KEY_LENGTH)) {
    return { ok: false, blocksVerified: 0, error: 'Image is encrypted; a passphrase is required' };
  }

  if (hasIndex && info.blocks.length === 0) {
    return {
      ok: false,
      blocksVerified: 0,
      error: `Image flags indicate a block index but the index is empty at offset ${info.header.blockIndexOffset}`
    };
  }

  const base = baseVolumePath(imagePath);
  const volumes = [base];
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}.${String(i).padStart(3, '0')}`;
    if (!fs.existsSync(candidate)) break;
    volumes.push(candidate);
  }

  const total = info.blocks.length;
  let verified = 0;
  // Uncompressed frames have nothing to decompress in parallel; keep one frame
  // in flight and avoid starting a pool for them.
  const window = compressionId === COMPRESSION_NONE ? 1 : Math.max(2, Math.min(8, Math.floor(threads)));
  const pool =
    compressionId === COMPRESSION_NONE
      ? null
      : new CompressionPool(window, 0, compressionTypeOf(compressionId));

  try {
    for (let vi = 0; vi < volumes.length; vi++) {
      const isLast = vi === volumes.length - 1;
      const fd = fs.openSync(volumes[vi], 'r');
      try {
        const fileSize = fs.fstatSync(fd).size;
        const limit = isLast && hasIndex ? info.header.blockIndexOffset : fileSize;
        const result = await verifyVolumeFramesParallel(
          fd,
          info.dataOffset,
          limit,
          cipherId,
          key,
          compressionId,
          pool,
          window,
          onProgress ? (count) => onProgress(verified + count, total) : undefined
        );
        verified += result.verified;
        if (result.error) {
          return { ok: false, blocksVerified: verified, error: result.error };
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    pool?.stop();
  }

  if (hasIndex && verified !== info.blocks.length) {
    return {
      ok: false,
      blocksVerified: verified,
      error: `Verified ${verified} blocks but the index expects ${info.blocks.length}`
    };
  }

  return { ok: verified > 0, blocksVerified: verified };
}

interface VolumeVerifyResult {
  verified: number;
  error?: string;
}

async function verifyVolumeFramesParallel(
  fd: number,
  start: number,
  limit: number,
  cipherId: number,
  key: Buffer | undefined,
  compressionId: number,
  pool: CompressionPool | null,
  window: number,
  onFrame?: (verifiedInVolume: number) => void
): Promise<VolumeVerifyResult> {
  let verified = 0;
  let pos = start;
  let fatal: string | null = null;
  const pending: PendingFrame[] = [];
  const frameExtra = cipherId !== CIPHER_NONE ? GCM_IV_LENGTH + GCM_TAG_LENGTH : 0;

  // Read frames ahead of the decompressor. All I/O stays on this thread, so
  // there is no shared file position to race.
  const fill = (): void => {
    while (fatal === null && pending.length < window && pos + FRAME_HEADER_SIZE <= limit) {
      const framePos = pos;
      const head = Buffer.alloc(FRAME_HEADER_SIZE);
      const read = fs.readSync(fd, head, 0, FRAME_HEADER_SIZE, framePos);
      if (read < FRAME_HEADER_SIZE) return;

      const rawSize = head.readUInt32LE(0);
      const compSize = head.readUInt32LE(4);
      const rawCrc = head.readUInt32LE(8);
      const compCrc = head.readUInt32LE(12);

      if (compSize > 1024 * 1024 * 1024) {
        fatal = `Implausible frame size at offset ${framePos}`;
        return;
      }

      let comp: Buffer;
      try {
        comp = readFrameCompressed(fd, compSize, framePos + FRAME_HEADER_SIZE, cipherId, key);
      } catch (error) {
        fatal = `${error instanceof Error ? error.message : String(error)} at offset ${framePos}`;
        return;
      }

      if (crc32(comp) !== compCrc) {
        fatal = `Compressed data CRC mismatch at offset ${framePos}`;
        return;
      }

      const promise = pool
        ? pool.decompress(comp)
        : Promise.resolve().then(() => decompressBlock(comp, compressionId));
      // An early framing error returns before every queued frame is awaited,
      // and pool.stop() rejects the rest. Mark them handled; awaiting the
      // original promise still surfaces a real decompression failure.
      promise.catch(() => undefined);
      pending.push({ pos: framePos, rawSize, rawCrc, promise });
      pos += FRAME_HEADER_SIZE + frameExtra + compSize;
    }
  };

  while (true) {
    // Once a framing error is found, stop reading ahead but still finish the
    // frames already queued: they come before the bad one, so counting them
    // keeps `blocksVerified` identical to the sequential pass. A queued frame
    // that fails first is the error the sequential pass would have reported.
    if (fatal === null) fill();
    if (pending.length === 0) {
      if (fatal !== null) return { verified, error: fatal };
      break;
    }

    const item = pending.shift()!;
    let raw: Buffer;
    try {
      raw = await item.promise;
    } catch (error) {
      return {
        verified,
        error: `Failed to decompress block at offset ${item.pos}: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
    if (raw.length !== item.rawSize) {
      return { verified, error: `Decompressed size mismatch at offset ${item.pos}` };
    }
    if (crc32(raw) !== item.rawCrc) {
      return { verified, error: `Raw data CRC mismatch at offset ${item.pos}` };
    }

    verified++;
    onFrame?.(verified);
  }

  return { verified };
}
