import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  ImageHeader,
  ImageInfo,
  BlockRecord,
  PartitionEntryMeta,
  HEADER_SIZE,
  PARTITION_TABLE_ENTRY_SIZE,
  IMAGE_VERSION,
  BLOCK_INDEX_ENTRY_SIZE,
  CIPHER_NONE,
  FLAG_HAS_BLOCK_INDEX,
  FLAG_VERIFIED,
  newImageCipher,
  deriveImageKey,
  encodeHeader,
  encodePartitionEntry,
  encodeBlockIndexEntry,
  readImageInfo,
  resolveImageChain,
  resolveVolumePath,
  clearImageInfoCache,
  readFrameFromImage,
  encodeBlockFrame,
  verifyImage
} from './image-format';
import { frameLength, buildParityAsync, paritySidecarPath } from './parity';
import { detectMacriumFormat } from './mrimg';
import { isRepository } from './repository';
import {
  readBitlockerSidecar,
  writeBitlockerSidecar,
  sidecarPathFor,
  deriveBitlockerSubkey,
  decryptRecoverySecret,
  encryptRecoverySecret,
  BitlockerKeySidecar
} from '../utils/bitlocker-capture';
import { logger } from '../utils/logger';

/** Headroom added to the composed size for the free-space gate (same as cloud staging). */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

const EMPTY = Buffer.alloc(0);

export type CompactPhase = 'composing' | 'copying' | 'verifying' | 'finalizing';

export interface CompactProgress {
  phase: CompactPhase;
  percent: number;
  blocksDone: number;
  blocksTotal: number;
  bytesDone: number;
  totalBytes: number;
  createdAt: number;
}

export interface CompactMemberInfo {
  path: string;
  timestamp: number;
  blocks: number;
  bytes: number;
}

export interface CompactPlan {
  /** Root-first member list. */
  members: CompactMemberInfo[];
  uniqueBlocks: number;
  uniqueRawBytes: number;
  /** Estimated single-file output size including frame headers. */
  estimatedOutputBytes: number;
  encrypted: boolean;
  /** Present when the chain is gated (refused); dry-run reports it too. */
  refusal?: string;
}

export interface CompactResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  dryRun: boolean;
  plan: CompactPlan;
  outputPath?: string;
  blocksWritten?: number;
  bytesWritten?: number;
  durationMs: number;
  warnings: string[];
  /** Members deleted by --remove-source, newest first. */
  sourcesRemoved?: string[];
}

export interface CompactOptions {
  /** Any chain member; the whole chain is resolved from it. */
  imagePath: string;
  passphrase?: string;
  removeSource?: boolean;
  dryRun?: boolean;
  /** Final destination; defaults to `<root>.compacted-<timestamp>.opbs` beside the root. */
  outputPath?: string;
  onProgress?: (progress: CompactProgress) => void;
  shouldCancel?: () => boolean;
  /** Free-space gate; injectable for tests. Defaults to a statfs check with margin. */
  ensureFreeSpace?: (dir: string, needed: number) => Promise<void>;
}

export interface ComposedBlock {
  partitionIndex: number;
  blockIndex: number;
  memberPath: string;
  memberIndex: number;
  record: BlockRecord;
}

class CompactCancelled extends Error {
  constructor() {
    super('Compaction cancelled');
    this.name = 'CompactCancelled';
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Logical newest-wins composition of a chain: for every
 * `(partitionIndex, blockIndex)` the newest member holding an index record
 * wins — the same rule the restore apply loop and ChainPartitionReader use, so
 * the compacted image is byte-equivalent to restoring the chain.
 */
export function composeChainBlocks(
  members: Array<{ path: string; info: ImageInfo }>
): Map<string, ComposedBlock> {
  const map = new Map<string, ComposedBlock>();
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    for (const record of member.info.blocks) {
      map.set(`${record.partitionIndex}:${record.blockIndex}`, {
        partitionIndex: record.partitionIndex,
        blockIndex: record.blockIndex,
        memberPath: member.path,
        memberIndex: i,
        record
      });
    }
  }
  return map;
}

/** A repository member: lives in the repo's `images/` directory. */
function isRepositoryMember(imagePath: string): boolean {
  const dir = path.dirname(path.resolve(imagePath));
  return path.basename(dir) === 'images' && isRepository(path.dirname(dir));
}

function chainRefusal(
  members: Array<{ path: string; info: ImageInfo }>,
  encrypted: boolean,
  passphrase?: string
): string | undefined {
  if (detectMacriumFormat(members[0].path)) {
    return 'Macrium Reflect containers cannot be compacted';
  }
  if (isRepositoryMember(members[0].path)) {
    return 'repository images are compacted through the repository journal (not supported yet)';
  }
  if (members.length < 2) {
    return 'this chain has a single member; nothing to compact';
  }
  const root = members[0].info.header;
  for (const m of members) {
    const h = m.info.header;
    if (h.blockSize !== root.blockSize) {
      return `mixed block sizes across the chain (${root.blockSize} vs ${h.blockSize})`;
    }
    if (h.compressionId !== root.compressionId) {
      return 'mixed compression codecs across the chain';
    }
    if (h.cipherId !== root.cipherId) {
      return 'mixed encryption states across the chain';
    }
    if (h.totalBytes !== root.totalBytes || h.partitionCount !== root.partitionCount) {
      return 'chain members disagree on disk size or partition count';
    }
  }
  if (encrypted && !passphrase) {
    return 'this chain is encrypted; a passphrase is required';
  }
  return undefined;
}

function memberOwnFrameBytes(members: Array<{ path: string; info: ImageInfo }>): number[] {
  return members.map((m) => {
    const cipherId = m.info.header.cipherId;
    return m.info.blocks.reduce((sum, b) => sum + frameLength(b.compSize, cipherId), 0);
  });
}

function buildPlan(
  members: Array<{ path: string; info: ImageInfo }>,
  composed: Map<string, ComposedBlock>,
  encrypted: boolean,
  refusal?: string
): CompactPlan {
  const ownBytes = memberOwnFrameBytes(members);
  let uniqueRawBytes = 0;
  let estimatedOutputBytes = 0;
  const cipherId = members[0].info.header.cipherId;
  for (const c of composed.values()) {
    uniqueRawBytes += c.record.rawSize;
    estimatedOutputBytes += frameLength(c.record.compSize, cipherId);
  }
  return {
    members: members.map((m, i) => ({
      path: m.path,
      timestamp: m.info.header.timestamp,
      blocks: m.info.blocks.length,
      bytes: ownBytes[i]
    })),
    uniqueBlocks: composed.size,
    uniqueRawBytes,
    estimatedOutputBytes,
    encrypted,
    refusal
  };
}

function defaultCompactPath(rootImagePath: string): string {
  const dir = path.dirname(rootImagePath);
  const base = path.basename(rootImagePath).replace(/\.opbs$/i, '');
  return path.join(dir, `${base}.compacted-${Date.now()}.opbs`);
}

/** Scan multi-volume continuations (`.001`, `.002`, …) of an image. */
function volumeFilesOf(imagePath: string): string[] {
  const files = [imagePath];
  for (let i = 1; ; i++) {
    const vol = `${imagePath}.${String(i).padStart(3, '0')}`;
    if (!fs.existsSync(vol)) break;
    files.push(vol);
  }
  return files;
}

async function defaultEnsureFreeSpace(dir: string, needed: number): Promise<void> {
  let free: number;
  try {
    const disk = await fs.promises.statfs(dir);
    free = Number(disk.bavail) * Number(disk.bsize);
  } catch {
    return; // Unsupported/offline volume — same tolerance as cloud staging.
  }
  const required = needed + FREE_SPACE_MARGIN;
  if (free < required) {
    throw new Error(
      `Not enough free space to compact: need ~${Math.ceil(required / (1024 * 1024))} MB ` +
        `(${Math.ceil(needed / (1024 * 1024))} MB data + margin), ` +
        `${Math.floor(free / (1024 * 1024))} MB available in ${dir}`
    );
  }
}

function resealBitlockerSidecar(
  sidecar: BitlockerKeySidecar,
  oldKeyHex: string,
  newKeyHex: string
): BitlockerKeySidecar {
  const oldSubkey = deriveBitlockerSubkey(oldKeyHex);
  const newSubkey = deriveBitlockerSubkey(newKeyHex);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    volumes: sidecar.volumes.map((volume) => ({
      ...volume,
      protectors: volume.protectors.map((protector) => {
        const secret = decryptRecoverySecret(oldSubkey, protector.nonce, protector.data);
        const sealed = encryptRecoverySecret(newSubkey, secret);
        return { type: protector.type, nonce: sealed.nonce, data: sealed.data };
      })
    }))
  };
}

/**
 * Compact a delta chain into a single new image. The logical block map is the
 * chain's newest-wins composition; plaintext frames are relocated verbatim and
 * encrypted frames are decrypted with their member's key and re-encrypted under
 * a fresh image cipher (compressed payload preserved). The output is written
 * into an `opbs-compact-<id>/` temp sibling, fully verified, then atomically
 * renamed into place.
 */
export async function compactChain(options: CompactOptions): Promise<CompactResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const shouldCancel = options.shouldCancel ?? (() => false);
  const emit = (phase: CompactPhase, blocksDone: number, blocksTotal: number, bytesDone: number, totalBytes: number): void => {
    options.onProgress?.({
      phase,
      percent: blocksTotal > 0 ? Math.min(100, Math.round((blocksDone / blocksTotal) * 100)) : 0,
      blocksDone,
      blocksTotal,
      bytesDone,
      totalBytes,
      createdAt: Date.now()
    });
  };

  let members: Array<{ path: string; info: ImageInfo }>;
  try {
    const chain = resolveImageChain(options.imagePath);
    members = chain.map((p) => ({ path: p, info: readImageInfo(p) }));
  } catch (e) {
    return {
      ok: false,
      error: `Could not read the image chain: ${errText(e)}`,
      dryRun: !!options.dryRun,
      plan: { members: [], uniqueBlocks: 0, uniqueRawBytes: 0, estimatedOutputBytes: 0, encrypted: false },
      durationMs: Date.now() - started,
      warnings
    };
  }

  emit('composing', 0, 1, 0, 1);
  const rootHeader = members[0].info.header;
  const encrypted = rootHeader.cipherId !== CIPHER_NONE;
  const refusal = chainRefusal(members, encrypted, options.passphrase);
  const composed = refusal ? new Map<string, ComposedBlock>() : composeChainBlocks(members);
  const plan = buildPlan(members, composed, encrypted, refusal);

  const finalPath = options.outputPath ?? defaultCompactPath(members[0].path);
  if (!refusal && path.resolve(finalPath) === path.resolve(members[0].path)) {
    plan.refusal = 'the output path must not be a chain member';
  }
  if (!plan.refusal && !options.dryRun && fs.existsSync(finalPath)) {
    plan.refusal = `the output file already exists: ${finalPath}`;
  }

  if (!plan.refusal) {
    try {
      await (options.ensureFreeSpace ?? defaultEnsureFreeSpace)(
        path.dirname(finalPath),
        plan.estimatedOutputBytes
      );
    } catch (e) {
      plan.refusal = errText(e);
    }
  }

  if (options.dryRun) {
    return {
      ok: !plan.refusal,
      error: plan.refusal,
      dryRun: true,
      plan,
      outputPath: finalPath,
      durationMs: Date.now() - started,
      warnings
    };
  }
  if (plan.refusal) {
    return {
      ok: false,
      error: plan.refusal,
      dryRun: false,
      plan,
      outputPath: finalPath,
      durationMs: Date.now() - started,
      warnings
    };
  }

  // Group composed blocks per partition in the root's table order.
  const byPartition = new Map<number, ComposedBlock[]>();
  for (const c of composed.values()) {
    const list = byPartition.get(c.partitionIndex);
    if (list) list.push(c);
    else byPartition.set(c.partitionIndex, [c]);
  }
  for (const list of byPartition.values()) list.sort((a, b) => a.blockIndex - b.blockIndex);
  const known = new Set(members[0].info.partitions.map((p) => p.partitionIndex));
  for (const idx of byPartition.keys()) {
    if (!known.has(idx)) {
      return {
        ok: false,
        error: `Chain blocks reference partition ${idx}, which the root image's table does not list`,
        dryRun: false,
        plan,
        durationMs: Date.now() - started,
        warnings
      };
    }
  }

  const cipher = encrypted ? newImageCipher(options.passphrase!) : null;
  const memberKeys = new Map<number, Buffer>();
  const memberKeyFor = (memberIndex: number): Buffer => {
    let key = memberKeys.get(memberIndex);
    if (!key) {
      const h = members[memberIndex].info.header;
      key = deriveImageKey(options.passphrase!, h.salt, h.kdfIterations);
      memberKeys.set(memberIndex, key);
    }
    return key;
  };

  const fdCache = new Map<string, number>();
  const openForRead = (p: string): number => {
    let fd = fdCache.get(p);
    if (fd === undefined) {
      fd = fs.openSync(p, 'r');
      fdCache.set(p, fd);
    }
    return fd;
  };

  const tempDir = path.join(
    path.dirname(finalPath),
    `opbs-compact-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  );
  const tempOutput = path.join(tempDir, path.basename(finalPath));

  let blocksWritten = 0;
  let bytesWritten = 0;
  const records: BlockRecord[] = [];
  const partitionEntries: PartitionEntryMeta[] = [];
  const blocksTotal = composed.size;
  const totalBytes = plan.estimatedOutputBytes;

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const header: ImageHeader = {
      version: IMAGE_VERSION,
      timestamp: Date.now(),
      totalBytes: rootHeader.totalBytes,
      blockSize: rootHeader.blockSize,
      compressionId: rootHeader.compressionId,
      partitionCount: rootHeader.partitionCount,
      flags: FLAG_HAS_BLOCK_INDEX,
      blockIndexOffset: 0,
      cipherId: rootHeader.cipherId,
      kdfIterations: cipher ? cipher.kdfIterations : rootHeader.kdfIterations,
      salt: cipher ? cipher.salt : rootHeader.salt,
      baseImagePath: '',
      sourceDiskModel: rootHeader.sourceDiskModel,
      sourceDiskSerial: rootHeader.sourceDiskSerial
    };

    const fd = fs.openSync(tempOutput, 'w+');
    try {
      fs.writeSync(fd, encodeHeader(header), 0, HEADER_SIZE, 0);
      let cursor = HEADER_SIZE + members[0].info.partitions.length * PARTITION_TABLE_ENTRY_SIZE;
      fs.writeSync(
        fd,
        Buffer.alloc(members[0].info.partitions.length * PARTITION_TABLE_ENTRY_SIZE),
        0,
        members[0].info.partitions.length * PARTITION_TABLE_ENTRY_SIZE,
        HEADER_SIZE
      );

      emit('copying', 0, blocksTotal, 0, totalBytes);
      for (const partition of members[0].info.partitions) {
        const list = byPartition.get(partition.partitionIndex) ?? [];
        const firstBlockFileOffset = cursor;
        for (const composedBlock of list) {
          if (shouldCancel()) throw new CompactCancelled();
          const { record, memberPath, memberIndex } = composedBlock;
          const memberHeader = members[memberIndex].info.header;
          const volumePath =
            record.volumeIndex != null
              ? resolveVolumePath(memberPath, record.volumeIndex)
              : memberPath;

          let frame: Buffer;
          if (encrypted) {
            // Decrypt with the member's own key; preserve the compressed
            // payload; re-encrypt under the new image cipher (fresh IV).
            const read = readFrameFromImage(
              volumePath,
              record.fileOffset,
              memberHeader.cipherId,
              memberKeyFor(memberIndex)
            );
            frame = encodeBlockFrame(EMPTY, read.comp, cipher, {
              rawSize: read.rawSize,
              rawCrc: read.rawCrc
            });
          } else {
            // Copy-mode: relocate the exact stored frame bytes verbatim.
            const len = frameLength(record.compSize, memberHeader.cipherId);
            frame = Buffer.alloc(len);
            const read = fs.readSync(openForRead(volumePath), frame, 0, len, record.fileOffset);
            if (read !== len) {
              throw new Error(
                `Truncated frame in ${volumePath} at offset ${record.fileOffset} ` +
                  `(wanted ${len} bytes, got ${read})`
              );
            }
          }

          fs.writeSync(fd, frame, 0, frame.length, cursor);
          records.push({
            partitionIndex: record.partitionIndex,
            blockIndex: record.blockIndex,
            fileOffset: cursor,
            rawSize: record.rawSize,
            compSize: record.compSize,
            rawCrc32: record.rawCrc32
          });
          cursor += frame.length;
          blocksWritten++;
          bytesWritten += frame.length;
          if (blocksWritten % 32 === 0 || blocksWritten === blocksTotal) {
            emit('copying', blocksWritten, blocksTotal, bytesWritten, totalBytes);
          }
        }
        partitionEntries.push({
          partitionIndex: partition.partitionIndex,
          size: partition.size,
          offsetOnDisk: partition.offsetOnDisk,
          firstBlockFileOffset,
          blockCount: list.length
        });
      }

      // Block index at the end, then patch partition table + header.
      const blockIndexOffset = cursor;
      const countBuf = Buffer.alloc(8);
      countBuf.writeBigUInt64LE(BigInt(records.length), 0);
      fs.writeSync(fd, countBuf, 0, 8, cursor);
      cursor += 8;
      for (const record of records) {
        fs.writeSync(fd, encodeBlockIndexEntry(record), 0, BLOCK_INDEX_ENTRY_SIZE, cursor);
        cursor += BLOCK_INDEX_ENTRY_SIZE;
      }
      partitionEntries.forEach((entry, i) => {
        fs.writeSync(fd, encodePartitionEntry(entry), 0, PARTITION_TABLE_ENTRY_SIZE, HEADER_SIZE + i * PARTITION_TABLE_ENTRY_SIZE);
      });
      const patched = Buffer.alloc(HEADER_SIZE);
      fs.readSync(fd, patched, 0, HEADER_SIZE, 0);
      patched.writeBigUInt64LE(BigInt(blockIndexOffset), 40);
      fs.writeSync(fd, patched, 0, HEADER_SIZE, 0);
    } finally {
      fs.closeSync(fd);
    }

    for (const openFd of fdCache.values()) {
      try { fs.closeSync(openFd); } catch { /* already closed */ }
    }
    fdCache.clear();

    emit('verifying', blocksWritten, blocksTotal, bytesWritten, totalBytes);
    const verified = await verifyImage(tempOutput, cipher?.key);
    if (!verified.ok) {
      throw new Error(`Compacted image failed verification: ${verified.error ?? 'unknown error'}`);
    }

    // Mark verified, then atomically move into place.
    const verifyFd = fs.openSync(tempOutput, 'r+');
    try {
      const headerBuf = Buffer.alloc(HEADER_SIZE);
      fs.readSync(verifyFd, headerBuf, 0, HEADER_SIZE, 0);
      headerBuf.writeUInt32LE(headerBuf.readUInt32LE(36) | FLAG_VERIFIED, 36);
      fs.writeSync(verifyFd, headerBuf, 0, HEADER_SIZE, 0);
    } finally {
      fs.closeSync(verifyFd);
    }
    clearImageInfoCache();

    emit('finalizing', blocksWritten, blocksTotal, bytesWritten, totalBytes);
    if (fs.existsSync(finalPath)) {
      throw new Error(`The output file appeared while compacting: ${finalPath}`);
    }
    fs.renameSync(tempOutput, finalPath);

    // Sidecar carry: the newest member's USN cursors keep the next
    // incremental's fast path; BitLocker keys are re-sealed under the new key.
    const newest = members[members.length - 1];
    const usnSource = `${newest.path}.usn`;
    if (fs.existsSync(usnSource)) {
      try {
        fs.copyFileSync(usnSource, `${finalPath}.usn`);
      } catch (e) {
        warnings.push(`could not carry the USN cursor sidecar: ${errText(e)}`);
      }
    }
    if (encrypted && cipher) {
      const oldSidecar = readBitlockerSidecar(newest.path);
      if (oldSidecar) {
        try {
          const oldKeyHex = deriveImageKey(
            options.passphrase!,
            newest.info.header.salt,
            newest.info.header.kdfIterations
          ).toString('hex');
          writeBitlockerSidecar(finalPath, resealBitlockerSidecar(oldSidecar, oldKeyHex, cipher.key.toString('hex')));
        } catch (e) {
          warnings.push(`could not carry the BitLocker key sidecar: ${errText(e)}`);
        }
      }
    }

    // Fresh parity for the new image, best-effort (same as post-backup).
    try {
      await buildParityAsync(finalPath);
    } catch (e) {
      warnings.push(`could not build parity for the compacted image: ${errText(e)}`);
    }

    // Source removal: newest-delta-first, root last (leaf-first like retention).
    const sourcesRemoved: string[] = [];
    if (options.removeSource) {
      for (const memberPath of [...members].reverse().map((m) => m.path)) {
        try {
          for (const volume of volumeFilesOf(memberPath)) {
            fs.rmSync(volume, { force: true });
          }
          sourcesRemoved.push(memberPath);
        } catch (e) {
          // Report, don't half-delete: skip this member's sidecars entirely.
          warnings.push(`could not remove source ${memberPath}: ${errText(e)}`);
          continue;
        }
        for (const sidecar of [
          `${memberPath}.usn`,
          sidecarPathFor(memberPath),
          `${memberPath}.volumes.json`,
          paritySidecarPath(memberPath)
        ]) {
          try { fs.rmSync(sidecar, { force: true }); } catch { /* best-effort */ }
        }
      }
    }

    logger.info(
      `compact: ${members.length} member(s) -> ${finalPath} ` +
        `(${blocksWritten} blocks, ${Math.round(bytesWritten / (1024 * 1024))} MB)` +
        (sourcesRemoved.length ? `, removed ${sourcesRemoved.length} source(s)` : '')
    );

    return {
      ok: true,
      dryRun: false,
      plan,
      outputPath: finalPath,
      blocksWritten,
      bytesWritten,
      durationMs: Date.now() - started,
      warnings,
      sourcesRemoved
    };
  } catch (e) {
    for (const openFd of fdCache.values()) {
      try { fs.closeSync(openFd); } catch { /* already closed */ }
    }
    if (e instanceof CompactCancelled) {
      return {
        ok: false,
        cancelled: true,
        dryRun: false,
        plan,
        durationMs: Date.now() - started,
        warnings
      };
    }
    return {
      ok: false,
      error: errText(e),
      dryRun: false,
      plan,
      blocksWritten,
      bytesWritten,
      durationMs: Date.now() - started,
      warnings
    };
  } finally {
    // The renamed image is gone from the temp dir; a crash before the rename
    // leaves only this dir, which the startup sweep (opbs-compact-) clears.
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
