import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readMacriumImage,
  clearMacriumInfoCache,
  closeImageFds,
  macriumUnsupportedReason,
  macriumRestoreRefusal
} from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { buildMrimgxImage, md5 } from '../helpers/mrimg-image';

const BLOCK = 8192;
const SET1_ID = 'D317A00000000001';

function pattern(fill: number): Buffer {
  const b = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i++) b[i] = (fill + i) & 0xff;
  return b;
}

describe('mrimgx delta backup set', () => {
  let dir: string;
  const A = pattern(0x10);
  const B = pattern(0x20);
  const C = pattern(0x30);
  const D = pattern(0x40);
  const B2 = pattern(0xb2);
  const D2 = pattern(0xd2);
  const composed = Buffer.concat([A, B2, C, D2]);
  let fullPath: string;
  let deltaPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimgx-chain-'));
    const full = buildMrimgxImage([A, B, C, D], (json) => {
      json._header.imageid = SET1_ID;
      json._header.file_number = 0;
      json._header.increment_number = 0;
    });
    fullPath = path.join(dir, 'SET1-full-00-00.mrimgx');
    fs.writeFileSync(fullPath, full.buffer);

    const delta = buildMrimgxImage(
      [A, B2, C, D2],
      (json) => {
        json._header.imageid = SET1_ID;
        json._header.file_number = 1;
        json._header.increment_number = 1;
        json._header.backup_type = 'incremental';
      },
      { delta: [1, 3] }
    );
    deltaPath = path.join(dir, 'SET1-inc-01-01.mrimgx');
    fs.writeFileSync(deltaPath, delta.buffer);
    clearMacriumInfoCache();
  });

  afterAll(() => {
    clearMacriumInfoCache();
    closeImageFds();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('composes the delta index from its backup set', () => {
    const info = readMacriumImage(deltaPath);
    expect(info.deltaIndex).toBe(true);
    expect(info.backupSet).toBeDefined();
    const set = info.backupSet!;
    expect(set.role).toBe('incremental');
    expect(set.basePath).toBe(fullPath);
    expect(set.resolved).toBe(true);
    expect(set.members).toHaveLength(2);
    const part = info.partitions[0];
    expect(part.deltaBlocks).toHaveLength(2);
    expect(part.blocks).toHaveLength(4);
    // Slots 0/2 route to the full, 1/3 to this delta member.
    expect(part.blocks[0].fileNumber).toBe(0);
    expect(part.blocks[1].fileNumber).toBe(1);
    expect(part.blocks[1].md5.equals(md5(B2))).toBe(true);
    expect(part.blocks[3].fileNumber).toBe(1);
    expect(part.blocks[3].md5.equals(md5(D2))).toBe(true);
    expect(macriumUnsupportedReason(info)).toBeNull();
    expect(macriumRestoreRefusal(info)).toBeNull();
  });

  it('reads the composed volume through the partition reader', () => {
    const info = readMacriumImage(deltaPath);
    const reader = openMacriumPartitionReader(info, 0);
    expect(reader.size).toBe(4 * BLOCK);
    expect(reader.read(0, 4 * BLOCK).equals(composed)).toBe(true);
    expect(reader.read(BLOCK, BLOCK).equals(B2)).toBe(true);
    expect(reader.read(3 * BLOCK, BLOCK).equals(D2)).toBe(true);
  });

  it('fails hash verification when a base block is corrupted', () => {
    const info = readMacriumImage(deltaPath);
    const slot0 = info.partitions[0].blocks[0];
    const fd = fs.openSync(fullPath, 'r+');
    fs.writeSync(fd, Buffer.alloc(BLOCK, 0xee), 0, BLOCK, slot0.filePosition);
    fs.closeSync(fd);
    try {
      const reader = openMacriumPartitionReader(info, 0);
      expect(() => reader.read(0, BLOCK)).toThrow(/hash verification/);
    } finally {
      const fd2 = fs.openSync(fullPath, 'r+');
      fs.writeSync(fd2, A, 0, BLOCK, slot0.filePosition);
      fs.closeSync(fd2);
    }
  });

  it('does not join files from another backup set in the same folder', () => {
    const foreign = buildMrimgxImage(
      [A, B2, C, D2],
      (json) => {
        json._header.imageid = 'F0RE1GN0000000001';
        json._header.file_number = 1;
        json._header.increment_number = 1;
        json._header.backup_type = 'incremental';
      },
      { delta: [1, 3] }
    );
    const foreignPath = path.join(dir, 'FOREIGN-inc-01-01.mrimgx');
    fs.writeFileSync(foreignPath, foreign.buffer);
    try {
      const info = readMacriumImage(foreignPath);
      // SET1's full image has a different image ID and must not be adopted.
      expect(info.backupSet?.members).toHaveLength(1);
      expect(info.backupSet?.basePath).toBeUndefined();
      expect(macriumUnsupportedReason(info)).toMatch(/delta-incremental/);
    } finally {
      fs.rmSync(foreignPath, { force: true });
    }
  });

  it('refuses the member when its base image disappears', () => {
    // Parse while the base is present, then remove it: the refusal is
    // reported against the base path recorded during set resolution.
    const info = readMacriumImage(deltaPath);
    expect(macriumUnsupportedReason(info)).toBeNull();
    closeImageFds();
    fs.renameSync(fullPath, `${fullPath}.moved`);
    try {
      expect(macriumUnsupportedReason(info)).toMatch(/base image SET1-full-00-00\.mrimgx not found/);
      expect(() => openMacriumPartitionReader(info, 0)).toThrow(/base image/);
    } finally {
      fs.renameSync(`${fullPath}.moved`, fullPath);
    }
  });

  it('refuses a delta whose middle increment was pruned', () => {
    const gapDir = fs.mkdtempSync(path.join(dir, 'gap-'));
    const id = '66500000000000001';
    const full = buildMrimgxImage([A, B, C, D], (json) => {
      json._header.imageid = id;
      json._header.file_number = 0;
      json._header.increment_number = 0;
    });
    fs.writeFileSync(path.join(gapDir, 'GAP-full-00-00.mrimgx'), full.buffer);
    const inc2 = buildMrimgxImage(
      [A, B2, C, D2],
      (json) => {
        json._header.imageid = id;
        json._header.file_number = 2;
        json._header.increment_number = 2;
        json._header.backup_type = 'incremental';
      },
      { delta: [1, 3] }
    );
    const inc2Path = path.join(gapDir, 'GAP-inc-02-02.mrimgx');
    fs.writeFileSync(inc2Path, inc2.buffer);

    const info = readMacriumImage(inc2Path);
    expect(info.backupSet?.basePath).toBeDefined();
    expect(info.backupSet?.missingIncrements).toEqual([1]);
    expect(macriumUnsupportedReason(info)).toMatch(/missing increment 1/);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(/missing increment 1/);
  });

  it('browses a non-delta incremental whose backup set is present', () => {
    const ndDir = fs.mkdtempSync(path.join(dir, 'nondelta-'));
    const id = 'N0ND317A00000001';
    const full = buildMrimgxImage([A, B, C, D], (json) => {
      json._header.imageid = id;
      json._header.file_number = 0;
      json._header.increment_number = 0;
    });
    fs.writeFileSync(path.join(ndDir, 'ND-full-00-00.mrimgx'), full.buffer);
    // No delta opt: the incremental stores a plain full-extent index of its
    // own blocks (file_number 1), so it reads standalone once its set shows up.
    const inc = buildMrimgxImage([A, B2, C, D2], (json) => {
      json._header.imageid = id;
      json._header.file_number = 1;
      json._header.increment_number = 1;
      json._header.backup_type = 'incremental';
    });
    const incPath = path.join(ndDir, 'ND-inc-01-01.mrimgx');
    fs.writeFileSync(incPath, inc.buffer);

    const info = readMacriumImage(incPath);
    expect(info.backupSet?.resolved).toBe(true);
    expect(macriumUnsupportedReason(info)).toBeNull();
    const reader = openMacriumPartitionReader(info, 0);
    expect(reader.read(0, 4 * BLOCK).equals(composed)).toBe(true);
  });
});
