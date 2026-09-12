import * as fs from 'fs';
import * as path from 'path';
import {
  readImageInfo,
  crc32,
  GCM_IV_LENGTH,
  GCM_TAG_LENGTH,
  CIPHER_NONE
} from './image-format';
import { logger } from '../utils/logger';

/**
 * Per-image XOR parity (PAR2-lite) for self-healing against bit-rot.
 *
 * A `.opar` sidecar stores, for every group of up to PARITY_GROUP_SIZE
 * consecutive blocks, a parity block computed as the XOR of the *stored frame
 * bytes* (16-byte frame header + compressed payload, or IV + auth tag +
 * ciphertext for encrypted images), zero-padded to the longest frame in the
 * group. Because parity is computed over the exact stored bytes, no
 * decompression or passphrase is needed to build or verify it — and for
 * encrypted images the parity is the XOR of ciphertexts only, leaking no
 * plaintext. Repairing a corrupted block XORs the surviving frames and the
 * parity block to recover the exact original frame bytes (same length), which
 * is written back in place, so the restored frame re-passes verification.
 *
 * A single corrupted block per group can be rebuilt (typical sector-level
 * bit-rot). If more than one block in a group is damaged, the XOR check fails
 * and repair is refused rather than guessing.
 */

export const PARITY_MAGIC = 'OPAR';
export const PARITY_VERSION = 1;
/** Number of data blocks covered by one parity block (SnapRAID-style group). */
export const PARITY_GROUP_SIZE = 31;

const MEMBER_ENTRY_SIZE = 16;
const GROUP_HEADER_SIZE = 8;

export interface ParityMember {
  /** Disc block index inside the image. */
  blockIndex: number;
  /** Byte offset of the frame inside the image file. */
  fileOffset: number;
  /** Total frame length (16 + payload, +IV+tag for encrypted). */
  frameLen: number;
}

export interface ParityGroup {
  members: ParityMember[];
  /** Byte offset of the XOR parity payload inside the `.opar`. */
  parityOffset: number;
  /** Number of bytes in the parity payload. */
  parityLen: number;
}

export interface ParityFile {
  version: number;
  groupSize: number;
  imageBlockSize: number;
  /** Base name of the image file this sidecar protects (for mismatch checks). */
  imageName: string;
  groups: ParityGroup[];
}

export interface ParityBuildReport {
  sidecarPath: string;
  groups: number;
  blocksProtected: number;
  parityBytes: number;
}

export function paritySidecarPath(imagePath: string): string {
  return `${imagePath}.opar`;
}

/** Frame payload length: 16-byte header + compressed payload (+IV+tag if encrypted). */
export function frameLength(compSize: number, cipherId: number): number {
  return 16 + (cipherId !== CIPHER_NONE ? GCM_IV_LENGTH + GCM_TAG_LENGTH : 0) + compSize;
}

function xorInto(target: Buffer, src: Buffer, length: number): void {
  for (let i = 0; i < length; i++) {
    target[i] ^= src[i];
  }
}

/**
 * Build (or rebuild) the `.opar` sidecar for an image. Reads frame bytes from
 * the image and XORs them into per-group parity blocks. Does not touch the
 * image itself. Returns the group count (0 for images with no block index).
 */
export function buildParity(imagePath: string): ParityBuildReport {
  const info = readImageInfo(imagePath);
  const nameBuf = Buffer.from(path.basename(imagePath), 'utf-8');
  const headerBufferLen = 24 + nameBuf.length;

  const blocks = info.header.blockIndexOffset > 0 ? info.blocks : [];
  const groups: ParityGroup[] = [];
  for (let i = 0; i < blocks.length; i += PARITY_GROUP_SIZE) {
    const chunk = blocks.slice(i, i + PARITY_GROUP_SIZE);
    if (chunk.length < 2) continue;
    const members = chunk.map((block) => ({
      blockIndex: block.blockIndex,
      fileOffset: block.fileOffset,
      frameLen: frameLength(block.compSize, info.header.cipherId)
    }));
    const maxLen = Math.max(...members.map((m) => m.frameLen));
    groups.push({ members, parityOffset: 0, parityLen: maxLen });
  }

  const imgFd = fs.openSync(imagePath, 'r');
  const sidecarPath = paritySidecarPath(imagePath);
  const outFd = fs.openSync(sidecarPath, 'w');

  const label = `parity for ${path.basename(imagePath)}`;
  let blocksProtected = 0;
  let parityBytes = 0;
  try {
    const headerBuf = Buffer.alloc(headerBufferLen);
    headerBuf.write(PARITY_MAGIC, 0, 'ascii');
    headerBuf.writeUInt16LE(PARITY_VERSION, 4);
    headerBuf.writeUInt16LE(0, 6);
    headerBuf.writeUInt32LE(PARITY_GROUP_SIZE, 8);
    headerBuf.writeUInt32LE(info.header.blockSize, 12);
    headerBuf.writeUInt32LE(groups.length, 16);
    headerBuf.writeUInt32LE(nameBuf.length, 20);
    nameBuf.copy(headerBuf, 24);
    fs.writeSync(outFd, headerBuf, 0, headerBuf.length, 0);

    let cursor = headerBufferLen;
    const memberBuf = Buffer.alloc(MEMBER_ENTRY_SIZE);
    const parityBuf = Buffer.alloc(4 * 1024 * 1024);
    const frameBuf = Buffer.alloc(4 * 1024 * 1024);

    for (const group of groups) {
      if (group.parityLen > parityBuf.length) {
        throw new Error(`${label}: group parity exceeds scratch buffer`);
      }
      parityBuf.fill(0);
      for (const member of group.members) {
        if (member.frameLen > frameBuf.length) {
          throw new Error(`${label}: frame ${member.blockIndex} exceeds scratch buffer`);
        }
        const read = fs.readSync(imgFd, frameBuf, 0, member.frameLen, member.fileOffset);
        if (read !== member.frameLen) {
          throw new Error(`${label}: truncated frame for block ${member.blockIndex}`);
        }
        xorInto(parityBuf, frameBuf, member.frameLen);
      }

      const groupHead = Buffer.alloc(GROUP_HEADER_SIZE);
      groupHead.writeUInt16LE(group.members.length, 0);
      groupHead.writeUInt16LE(0, 2);
      groupHead.writeUInt32LE(group.parityLen, 4);
      fs.writeSync(outFd, groupHead, 0, GROUP_HEADER_SIZE, cursor);
      cursor += GROUP_HEADER_SIZE;

      for (const member of group.members) {
        memberBuf.writeUInt32LE(member.blockIndex, 0);
        memberBuf.writeBigUInt64LE(BigInt(member.fileOffset), 4);
        memberBuf.writeUInt32LE(member.frameLen, 12);
        fs.writeSync(outFd, memberBuf, 0, MEMBER_ENTRY_SIZE, cursor);
        cursor += MEMBER_ENTRY_SIZE;
        blocksProtected++;
      }

      group.parityOffset = cursor;
      fs.writeSync(outFd, parityBuf, 0, group.parityLen, cursor);
      cursor += group.parityLen;
      parityBytes += group.parityLen;
    }

    return { sidecarPath, groups: groups.length, blocksProtected, parityBytes };
  } catch (error) {
    logger.warn(`Build ${label} failed: ${error instanceof Error ? error.message : error}`);
    fs.rmSync(sidecarPath, { force: true });
    throw error;
  } finally {
    fs.closeSync(imgFd);
    fs.closeSync(outFd);
  }
}

/**
 * Parse a `.opar` metadata (member tables + parity offsets). Does not load the
 * parity payloads. Throws when the sidecar is missing, malformed, or names a
 * different image than `imagePath`.
 */
export function readParity(imagePath: string): ParityFile {
  const sidecarPath = paritySidecarPath(imagePath);
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`No parity sidecar for ${imagePath}`);
  }
  const fd = fs.openSync(sidecarPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const head = Buffer.alloc(24);
    const headRead = fs.readSync(fd, head, 0, 24, 0);
    if (headRead < 24 || head.toString('ascii', 0, 4) !== PARITY_MAGIC) {
      throw new Error('Not an OPAR parity sidecar (bad magic)');
    }
    if (head.readUInt16LE(4) !== PARITY_VERSION) {
      throw new Error('Unsupported parity sidecar version');
    }
    const groupSize = head.readUInt32LE(8);
    const imageBlockSize = head.readUInt32LE(12);
    const groupCount = head.readUInt32LE(16);
    const nameLen = head.readUInt32LE(20);

    const nameBuf = Buffer.alloc(nameLen);
    const nameRead = fs.readSync(fd, nameBuf, 0, nameLen, 24);
    if (nameRead !== nameLen) {
      throw new Error('Truncated parity sidecar header');
    }
    const imageName = nameBuf.toString('utf-8');
    if (imageName !== path.basename(imagePath)) {
      throw new Error(`Parity sidecar is for a different image (${imageName})`);
    }

    let cursor = 24 + nameLen;
    const groups: ParityGroup[] = [];
    const memberBuf = Buffer.alloc(MEMBER_ENTRY_SIZE);
    for (let g = 0; g < groupCount; g++) {
      const groupHead = Buffer.alloc(GROUP_HEADER_SIZE);
      fs.readSync(fd, groupHead, 0, GROUP_HEADER_SIZE, cursor);
      cursor += GROUP_HEADER_SIZE;
      const memberCount = groupHead.readUInt16LE(0);
      const parityLen = groupHead.readUInt32LE(4);
      const members: ParityMember[] = [];
      for (let m = 0; m < memberCount; m++) {
        fs.readSync(fd, memberBuf, 0, MEMBER_ENTRY_SIZE, cursor);
        cursor += MEMBER_ENTRY_SIZE;
        members.push({
          blockIndex: memberBuf.readUInt32LE(0),
          fileOffset: Number(memberBuf.readBigUInt64LE(4)),
          frameLen: memberBuf.readUInt32LE(12)
        });
      }
      groups.push({ members, parityOffset: cursor, parityLen });
      cursor += parityLen;
    }
    if (cursor > stat.size) {
      throw new Error(`Truncated parity sidecar (expected ${cursor} bytes, got ${stat.size})`);
    }

    return { version: PARITY_VERSION, groupSize, imageBlockSize, imageName, groups };
  } finally {
    fs.closeSync(fd);
  }
}

export interface ParityVerifyReport {
  ok: boolean;
  sidecarPath: string;
  groupsChecked: number;
  mismatchedGroups: number[];
  imageName: string;
}

/**
 * Re-compute each group's XOR from the image and compare with the stored
 * parity. Mismatches mean either the stored parity or one of the group's
 * frames was damaged.
 */
export function verifyParity(imagePath: string): ParityVerifyReport {
  const parity = readParity(imagePath);
  const result: ParityVerifyReport = {
    ok: true,
    sidecarPath: paritySidecarPath(imagePath),
    groupsChecked: parity.groups.length,
    mismatchedGroups: [],
    imageName: parity.imageName
  };

  const sidecarPath = paritySidecarPath(imagePath);
  const sidecarFd = fs.openSync(sidecarPath, 'r');
  const imgFd = fs.openSync(imagePath, 'r');
  const scratch = Buffer.alloc(64 * 1024 * 1024);
  try {
    for (let g = 0; g < parity.groups.length; g++) {
      const group = parity.groups[g];
      const payload = Buffer.alloc(group.parityLen);
      const payloadLen = fs.readSync(sidecarFd, payload, 0, group.parityLen, group.parityOffset);
      if (payloadLen !== group.parityLen) {
        result.ok = false;
        result.mismatchedGroups.push(g);
        continue;
      }

      const computed = Buffer.alloc(group.parityLen);
      for (const member of group.members) {
        if (member.frameLen > scratch.length) {
          throw new Error(`Frame ${member.blockIndex} exceeds scratch buffer`);
        }
        fs.readSync(imgFd, scratch, 0, member.frameLen, member.fileOffset);
        xorInto(computed, scratch, member.frameLen);
      }
      if (!computed.equals(payload)) {
        result.ok = false;
        result.mismatchedGroups.push(g);
      }
    }
  } finally {
    fs.closeSync(sidecarFd);
    fs.closeSync(imgFd);
  }
  return result;
}

export interface ParityRepairReport {
  blockIndex: number;
  repaired: boolean;
  groupIndex: number;
  message?: string;
}

/**
 * Rebuild one block from its parity group and write the recovered frame back
 * in place. The recovered bytes are validated against the frame's own CRCs
 * (for unencrypted images; encrypted frames cannot be checked without the
 * key, so the repair is confirmed by the next verify pass instead).
 */
export function repairParityBlock(imagePath: string, blockIndex: number): ParityRepairReport {
  const parity = readParity(imagePath);
  const groupIndex = parity.groups.findIndex((g) => g.members.some((m) => m.blockIndex === blockIndex));
  if (groupIndex === -1) {
    throw new Error(`Block ${blockIndex} is not covered by parity`);
  }
  const group = parity.groups[groupIndex];
  const target = group.members.find((m) => m.blockIndex === blockIndex)!;

  const info = readImageInfo(imagePath);
  const isEncrypted = info.header.cipherId !== CIPHER_NONE;

  const sidecarPath = paritySidecarPath(imagePath);
  const sidecarFd = fs.openSync(sidecarPath, 'r');
  const imgFd = fs.openSync(imagePath, 'r+');
  const scratch = Buffer.alloc(64 * 1024 * 1024);
  try {
    const recovered = Buffer.alloc(group.parityLen);
    for (const member of group.members) {
      if (member.blockIndex === blockIndex) continue;
      if (member.frameLen > scratch.length) {
        throw new Error(`Frame ${member.blockIndex} exceeds scratch buffer`);
      }
      fs.readSync(imgFd, scratch, 0, member.frameLen, member.fileOffset);
      xorInto(recovered, scratch, member.frameLen);
    }
    const parityPayload = Buffer.alloc(group.parityLen);
    const parityRead = fs.readSync(sidecarFd, parityPayload, 0, group.parityLen, group.parityOffset);
    if (parityRead !== group.parityLen) {
      throw new Error('Truncated parity sidecar');
    }
    xorInto(recovered, parityPayload, group.parityLen);

    const frame = Buffer.alloc(target.frameLen);
    recovered.copy(frame, 0, 0, target.frameLen);

    if (!isEncrypted && target.frameLen >= 16) {
      const compSize = frame.readUInt32LE(4);
      const compCrc = frame.readUInt32LE(12);
      if (compSize !== target.frameLen - 16 || crc32(frame.subarray(16)) !== compCrc) {
        throw new Error(
          `Block ${blockIndex} XOR recovery failed CRC validation ` +
            `(${group.members.length} members, parity ${group.parityLen} bytes) — ` +
            'likely more than one corrupted block in the group'
        );
      }
    }

    const written = fs.writeSync(imgFd, frame, 0, target.frameLen, target.fileOffset);
    if (written !== target.frameLen) {
      throw new Error(`Short write repairing block ${blockIndex}`);
    }
    fs.fsyncSync(imgFd);

    return { blockIndex, repaired: true, groupIndex, message: isEncrypted ? 'frame rewritten; confirm with a verify pass' : 'frame rewritten and CRC-validated' };
  } finally {
    fs.closeSync(sidecarFd);
    fs.closeSync(imgFd);
  }
}