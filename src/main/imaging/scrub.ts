import * as fs from 'fs';
import * as path from 'path';
import {
  readImageInfo,
  deriveImageKey,
  decompressBlock,
  readFrameCompressed,
  crc32,
  CIPHER_NONE
} from './image-format';
import { scanBackupDirectory } from '../backup/retention';
import {
  paritySidecarPath,
  buildParity,
  repairParityBlock
} from './parity';
import { logger } from '../utils/logger';

/**
 * Idle scrub with self-healing.
 *
 * Detection: classify every block of an image (frame CRC + decompress + raw
 * CRC, per block index) so failures are attributed precisely. Repair: when a
 * block fails and a `.opar` sidecar exists, rebuild it via XOR parity and
 * re-run the block classification to confirm. Results are recorded per image
 * in an `opbs-scrub.json` history sidecar.
 *
 * NOTE: parity is built against the stored bytes when the image was written
 * (post-backup). Scrub never auto-builds parity from possibly-damaged data —
 * if a sidecar is missing, the image is reported as unprotected rather than
 * generating corrupt parity.
 */

export interface BlockCheck {
  blockIndex: number;
  ok: boolean;
  error?: string;
}

export interface ImageBlockScan {
  encrypted: boolean;
  keyRequired: boolean;
  checks: BlockCheck[];
}

export interface ScrubImageRecord {
  imagePath: string;
  name: string;
  at: number;
  blocksChecked: number;
  corruptionFound: number;
  repaired: number;
  stillFailed: number;
  parityPresent: boolean;
  parityMatched: boolean;
  ok: boolean;
  firstError?: string;
}

export interface ScrubSummary {
  ok: boolean;
  directory: string;
  scope: 'newest' | 'all';
  checked: number;
  okCount: number;
  failed: number;
  skippedEncrypted: number;
  repairedBlocks: number;
  images: ScrubImageRecord[];
}

export interface ScrubOptions {
  scope?: 'newest' | 'all';
  repair?: boolean;
  passphrase?: string;
}

const SCRUB_FILE = 'opbs-scrub.json';

function scrubHistoryPath(dir: string): string {
  return path.join(dir, SCRUB_FILE);
}

export function readScrubHistory(dir: string): ScrubImageRecord[] {
  try {
    const data = fs.readFileSync(scrubHistoryPath(dir), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordScrubResult(dir: string, record: ScrubImageRecord): void {
  const entries = readScrubHistory(dir).filter((e) => e.imagePath !== record.imagePath);
  entries.push(record);
  entries.sort((a, b) => b.at - a.at);
  try {
    fs.writeFileSync(scrubHistoryPath(dir), JSON.stringify(entries, null, 2), 'utf-8');
  } catch (error) {
    logger.warn(`Could not write scrub history: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Full per-block classification of one image. Frames are located from the
 * block index and validated individually so failures map to block indices.
 */
export function classifyImage(imagePath: string, passphrase?: string): ImageBlockScan {
  const info = readImageInfo(imagePath);
  const encrypted = info.header.cipherId !== CIPHER_NONE;
  const keyRequired = encrypted && !(passphrase && passphrase.length > 0);

  const checks: BlockCheck[] = [];
  if (info.header.blockIndexOffset === 0 || info.blocks.length === 0) {
    return { encrypted, keyRequired, checks };
  }

  let key: Buffer | undefined;
  if (encrypted && passphrase) {
    key = deriveImageKey(passphrase, info.header.salt, info.header.kdfIterations);
  }

  const fd = fs.openSync(imagePath, 'r');
  try {
    for (const block of info.blocks) {
      const dataPos = block.fileOffset + 16;
      const check: BlockCheck = { blockIndex: block.blockIndex, ok: true };
      try {
        const head = Buffer.alloc(16);
        const headRead = fs.readSync(fd, head, 0, 16, block.fileOffset);
        if (headRead < 16) {
          throw new Error('Truncated frame header');
        }
        const rawSize = head.readUInt32LE(0);
        const compSize = head.readUInt32LE(4);
        const headRawCrc = head.readUInt32LE(8);
        const compCrc = head.readUInt32LE(12);
        if (compSize !== block.compSize || rawSize !== block.rawSize) {
          throw new Error('Frame header disagrees with block index');
        }
        if (headRawCrc !== block.rawCrc32) {
          throw new Error('Frame raw CRC disagrees with block index');
        }

        const comp = readFrameCompressed(fd, compSize, dataPos, info.header.cipherId, key);
        if (crc32(comp) !== compCrc) {
          throw new Error('Compressed payload CRC mismatch');
        }
        const raw = decompressBlock(comp, info.header.compressionId);
        if (raw.length !== rawSize) {
          throw new Error('Decompressed size mismatch');
        }
        if (crc32(raw) !== block.rawCrc32) {
          throw new Error('Raw data CRC mismatch');
        }
      } catch (error) {
        check.ok = false;
        check.error = error instanceof Error ? error.message : String(error);
      }
      checks.push(check);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { encrypted, keyRequired, checks };
}

function newestEntry(entries: { path: string; timestamp: number; name: string }[]): Array<{ path: string; timestamp: number; name: string }> {
  let best = entries[0];
  for (const e of entries) {
    if (e.timestamp > best.timestamp) best = e;
  }
  return [best];
}

/**
 * Scrub a backup directory: detect per-block corruption, repair via parity
 * when available, then re-verify repaired images. Records per-image results.
 */
export function scrubDirectory(dir: string, options: ScrubOptions = {}): ScrubSummary {
  if (!fs.existsSync(dir)) {
    throw new Error(`Backup directory does not exist: ${dir}`);
  }
  const scope = options.scope ?? 'all';
  const repair = options.repair ?? true;
  const entries = scanBackupDirectory(dir);
  const selected = scope === 'newest' ? newestEntry(entries) : entries;

  const summary: ScrubSummary = {
    ok: true,
    directory: dir,
    scope,
    checked: 0,
    okCount: 0,
    failed: 0,
    skippedEncrypted: 0,
    repairedBlocks: 0,
    images: []
  };

  for (const entry of selected) {
    const scan = classifyImage(entry.path, options.passphrase);
    if (scan.encrypted && scan.keyRequired) {
      summary.skippedEncrypted++;
      const record: ScrubImageRecord = {
        imagePath: entry.path,
        name: entry.name,
        at: Date.now(),
        blocksChecked: 0,
        corruptionFound: 0,
        repaired: 0,
        stillFailed: 0,
        parityPresent: false,
        parityMatched: true,
        ok: true
      };
      summary.images.push(record);
      recordScrubResult(dir, record);
      continue;
    }

    summary.checked++;
    const corrupted = scan.checks.filter((c) => !c.ok);
    const sidecarExists = fs.existsSync(paritySidecarPath(entry.path));
    const record: ScrubImageRecord = {
      imagePath: entry.path,
      name: entry.name,
      at: Date.now(),
      blocksChecked: scan.checks.length,
      corruptionFound: corrupted.length,
      repaired: 0,
      stillFailed: corrupted.length,
      parityPresent: sidecarExists,
      parityMatched: true,
      ok: corrupted.length === 0,
      firstError: corrupted[0]?.error
    };

    if (corrupted.length > 0 && repair && sidecarExists) {
      // A corrupt block makes the group's recomputed XOR differ from the stored
      // sidecar — that is the signal to repair, not a reason to skip. The
      // heal-or-refuse decision belongs to repairParityBlock's CRC validation.
      for (const corrupt of corrupted) {
        try {
          repairParityBlock(entry.path, corrupt.blockIndex);
          record.repaired++;
        } catch (error) {
          record.parityMatched = false;
          logger.warn(
            `Repair of block ${corrupt.blockIndex} in ${entry.name} failed: ` +
              `${error instanceof Error ? error.message : error}`
          );
        }
      }

      if (record.repaired > 0) {
        const rescan = classifyImage(entry.path, options.passphrase);
        record.stillFailed = rescan.checks.filter((c) => !c.ok).length;
        record.blocksChecked = rescan.checks.length;
        record.firstError = rescan.checks.find((c) => !c.ok)?.error ?? record.firstError;
        record.ok = record.stillFailed === 0;
      }
    }

    summary.repairedBlocks += record.repaired;
    if (record.stillFailed > 0) {
      summary.failed++;
      summary.ok = false;
    } else {
      summary.okCount++;
    }
    summary.images.push(record);
    recordScrubResult(dir, record);
  }

  return summary;
}

export { buildParity };