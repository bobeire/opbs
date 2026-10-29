import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectMacriumFormat,
  readMacriumImage,
  clearMacriumInfoCache,
  macriumUnsupportedReason,
  macriumRestoreRefusal,
  MacriumUnsupportedError
} from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';
import { MacriumPasswordError, getMacriumKey } from '../../src/main/imaging/mrimg/mrimg-crypto';
import { detectPartitionFilesystem } from '../../src/main/imaging/fs/file-browse';
import { buildMrimgxImage, deriveTestKey } from '../helpers/mrimg-image';

/**
 * Password-protected Reflect X (`.mrimgx`) images, built by an independent
 * encryptor in the test helper (node:crypto only) from Macrium's published
 * scheme. There is no real encrypted sample available, so this is the
 * ground-truth stand-in: a round trip here proves the reader implements the
 * documented algorithm, not merely itself.
 */

const IMAGE_ID = 'DE17A00000000001';
const PASSPHRASE = 'correct horse battery staple';
const AES = 14 as const;

function patternBlock(seed: number, len = 8192): Buffer {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (i * 7 + seed) & 0xff;
  return buf;
}

describe('mrimgx encryption (Reflect X)', () => {
  let dir: string;
  let blocks: Buffer[];
  let encryptedPath: string;
  let compressedPath: string;
  let aes128Path: string;
  let aes192Path: string;
  let plainIndexPath: string;
  let reservedPath: string;
  let reservedBlocks: Buffer[];

  const write = (name: string, buffer: Buffer): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buffer);
    return p;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimgx-enc-'));
    blocks = [patternBlock(1), patternBlock(2), patternBlock(3)];
    const tweak = (json: any): void => {
      json._header.imageid = IMAGE_ID;
    };

    encryptedPath = write(
      'encrypted.mrimgx',
      buildMrimgxImage(blocks, tweak, { encrypt: { passphrase: PASSPHRASE } }).buffer
    );
    compressedPath = write(
      'encrypted-compressed.mrimgx',
      buildMrimgxImage(blocks, tweak, { encrypt: { passphrase: PASSPHRASE, compress: true } }).buffer
    );
    aes128Path = write(
      'encrypted-aes128.mrimgx',
      buildMrimgxImage(blocks, tweak, { encrypt: { passphrase: PASSPHRASE, aes: 10 } }).buffer
    );
    aes192Path = write(
      'encrypted-aes192.mrimgx',
      buildMrimgxImage(blocks, tweak, { encrypt: { passphrase: PASSPHRASE, aes: 12 } }).buffer
    );
    plainIndexPath = write(
      'encrypted-plain-index.mrimgx',
      buildMrimgxImage(blocks, tweak, { encrypt: { passphrase: PASSPHRASE, metadata: false } }).buffer
    );
    reservedBlocks = [patternBlock(9, 4096), patternBlock(10, 4096)];
    reservedPath = write(
      'encrypted-reserved.mrimgx',
      buildMrimgxImage(blocks, tweak, {
        encrypt: { passphrase: PASSPHRASE },
        reserved: reservedBlocks
      }).buffer
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearMacriumInfoCache();
  });

  it('detects the container and records its encryption parameters', () => {
    const info = readMacriumImage(encryptedPath);
    expect(detectMacriumFormat(encryptedPath)).toBe('mrimgx');
    expect(info.encryption.enable).toBe(true);
    expect(info.encryption.keyIterations).toBe(100000);
    expect(info.encryption.aesType).toBe(AES);
    expect(info.encryption.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(info.unlocked).toBeFalsy();
  });

  it('refuses a locked image without touching the block index', () => {
    const info = readMacriumImage(encryptedPath);
    expect(info.partitions[0].blocks).toHaveLength(0);
    expect(macriumUnsupportedReason(info)).toMatch(/passphrase/);
    expect(macriumRestoreRefusal(info)).toMatch(/passphrase/);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(MacriumUnsupportedError);
    expect(() => openMacriumPartitionReader(info, 0)).toThrow(/password-protected/);
  });

  it('rejects a wrong passphrase', () => {
    let caught: unknown;
    try {
      readMacriumImage(encryptedPath, 'not the passphrase');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MacriumPasswordError);
    expect((caught as Error).message).toMatch(/incorrect passphrase/);
  });

  it('unlocks with the right passphrase and reads every block', () => {
    const info = readMacriumImage(encryptedPath, PASSPHRASE);
    expect(info.unlocked).toBe(true);
    expect(info.partitions[0].blocks).toHaveLength(blocks.length);
    expect(macriumUnsupportedReason(info)).toBeNull();
    expect(macriumRestoreRefusal(info)).toBeNull();

    const reader = openMacriumPartitionReader(info, 0);
    for (let i = 0; i < blocks.length; i++) {
      expect(reader.read(i * 8192, 8192).equals(blocks[i])).toBe(true);
    }
    // Key material is held out-of-band: never on the serializable info object.
    const material = getMacriumKey(encryptedPath);
    expect(material?.key).toHaveLength(32);
    expect(material?.aes).toBe(AES);
    expect(JSON.stringify(info)).not.toContain(material!.key.toString('hex'));
  });

  it('decrypts compressed-then-encrypted blocks (AES padding trimmed)', () => {
    const info = readMacriumImage(compressedPath, PASSPHRASE);
    const reader = openMacriumPartitionReader(info, 0);
    for (let i = 0; i < blocks.length; i++) {
      expect(reader.read(i * 8192, 8192).equals(blocks[i])).toBe(true);
    }
  });

  it('supports the AES-128 and AES-192 variants', () => {
    for (const [p, variant] of [
      [aes128Path, 10],
      [aes192Path, 12]
    ] as const) {
      const info = readMacriumImage(p, PASSPHRASE);
      expect(info.encryption.aesType).toBe(variant);
      const reader = openMacriumPartitionReader(info, 0);
      expect(reader.read(0, 8192).equals(blocks[0])).toBe(true);
    }
  });

  it('reads a container whose metadata index is left plaintext', () => {
    const info = readMacriumImage(plainIndexPath, PASSPHRASE);
    expect(info.partitions[0].blocks).toHaveLength(blocks.length);
    const reader = openMacriumPartitionReader(info, 0);
    expect(reader.read(8192, 8192).equals(blocks[1])).toBe(true);
  });

  it('decrypts the reserved boot track with its array-position IV', () => {
    const info = readMacriumImage(reservedPath, PASSPHRASE);
    expect(info.partitions[0].dataStart).toBe(8192);
    const reader = openMacriumPartitionReader(info, 0);
    expect(reader.read(0, 4096).equals(reservedBlocks[0])).toBe(true);
    expect(reader.read(4096, 4096).equals(reservedBlocks[1])).toBe(true);
    expect(reader.read(8192, 8192).equals(blocks[0])).toBe(true);
  });

  it('accepts already-derived key material (the elevated helper path)', () => {
    const key = deriveTestKey(IMAGE_ID, PASSPHRASE, 100000);
    const info = readMacriumImage(encryptedPath, { key: key.toString('hex'), aes: AES });
    expect(info.unlocked).toBe(true);
    expect(openMacriumPartitionReader(info, 0).read(0, 8192).equals(blocks[0])).toBe(true);

    clearMacriumInfoCache();
    const wrongKey = deriveTestKey(IMAGE_ID, 'a different passphrase', 100000);
    expect(() => readMacriumImage(encryptedPath, { key: wrongKey.toString('hex'), aes: AES })).toThrow(
      MacriumPasswordError
    );
  });

  it('never lets a cached success mask a later wrong passphrase', () => {
    expect(readMacriumImage(encryptedPath, PASSPHRASE).unlocked).toBe(true);
    expect(() => readMacriumImage(encryptedPath, 'wrong')).toThrow(MacriumPasswordError);
    // The locked view stays locked after a successful unlock was cached.
    const locked = readMacriumImage(encryptedPath);
    expect(locked.unlocked).toBeFalsy();
    expect(macriumUnsupportedReason(locked)).toMatch(/passphrase/);
    // ...and the right passphrase still works afterwards.
    expect(readMacriumImage(encryptedPath, PASSPHRASE).unlocked).toBe(true);
  });

  it('clears key material with the info cache', () => {
    readMacriumImage(encryptedPath, PASSPHRASE);
    expect(getMacriumKey(encryptedPath)).toBeDefined();
    clearMacriumInfoCache();
    expect(getMacriumKey(encryptedPath)).toBeUndefined();
  });

  it('reports a wrong passphrase through the filesystem probe instead of "Unknown"', () => {
    const locked = detectPartitionFilesystem(encryptedPath, 0, 'wrong');
    expect(locked.browsable).toBe(false);
    expect(locked.reason).toMatch(/passphrase/);
  });

  describe('encrypted backup sets', () => {
    const SET_ID = '6650000000000001';
    let setDir: string;
    let fullBlocks: Buffer[];
    let changed: Buffer;

    const writeSet = (dirPath: string, fullPass: string, deltaPass: string): { full: string; delta: string } => {
      const full = path.join(dirPath, 'set-full.mrimgx');
      const delta = path.join(dirPath, 'set-delta.mrimgx');
      fs.writeFileSync(
        full,
        buildMrimgxImage(fullBlocks, (json) => {
          json._header.imageid = SET_ID;
          json._header.file_number = 0;
          json._header.increment_number = 0;
          json._header.backup_type = 'full';
        }, { encrypt: { passphrase: fullPass } }).buffer
      );
      fs.writeFileSync(
        delta,
        buildMrimgxImage([...fullBlocks.slice(0, 1), changed, ...fullBlocks.slice(2)], (json) => {
          json._header.imageid = SET_ID;
          json._header.file_number = 1;
          json._header.increment_number = 1;
          json._header.backup_type = 'incremental';
        }, { delta: [1], encrypt: { passphrase: deltaPass } }).buffer
      );
      return { full, delta };
    };

    beforeAll(() => {
      setDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mrimgx-enc-set-'));
      fullBlocks = [patternBlock(21), patternBlock(22), patternBlock(23)];
      changed = patternBlock(222);
    });

    afterAll(() => {
      fs.rmSync(setDir, { recursive: true, force: true });
    });

    it('decrypts blocks routed to another member of the same set', () => {
      const memberDir = fs.mkdtempSync(path.join(setDir, 'ok-'));
      const { delta } = writeSet(memberDir, PASSPHRASE, PASSPHRASE);
      const info = readMacriumImage(delta, PASSPHRASE);
      expect(info.unlocked).toBe(true);
      expect(info.backupSet?.resolved).toBe(true);
      const reader = openMacriumPartitionReader(info, 0);
      // Block 0 and 2 live in the full member, block 1 in the delta: every one
      // of them decrypts with the same passphrase-derived key.
      expect(reader.read(0, 8192).equals(fullBlocks[0])).toBe(true);
      expect(reader.read(8192, 8192).equals(changed)).toBe(true);
      expect(reader.read(16384, 8192).equals(fullBlocks[2])).toBe(true);
    });

    it('refuses a set whose members use different passphrases', () => {
      const memberDir = fs.mkdtempSync(path.join(setDir, 'mismatch-'));
      const { delta } = writeSet(memberDir, 'the full passphrase', 'the delta passphrase');
      const info = readMacriumImage(delta, 'the delta passphrase');
      expect(macriumUnsupportedReason(info)).toMatch(/different passphrase/);
    });
  });
});
