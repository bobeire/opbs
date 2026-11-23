import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  deriveMacriumV7Key,
  verifyMacriumV7PasswordHash,
  macriumV7AesVariant,
  macriumV7BlockIv,
  isMacriumV7LowIter,
  decryptMacriumBlock
} from '../../src/main/imaging/mrimg/mrimg-crypto';
import {
  readMacriumImage,
  clearMacriumInfoCache,
  macriumUnsupportedReason
} from '../../src/main/imaging/mrimg/mrimg-format';
import { openMacriumPartitionReader } from '../../src/main/imaging/mrimg/mrimg-reader';

afterEach(() => {
  clearMacriumInfoCache();
});

describe('mrimg v7 encrypted (low-iter, RE-verified vectors)', () => {
  it('maps v7 aes values to Macrium AES variants', () => {
    expect(macriumV7AesVariant(1)).toBe(10);
    expect(macriumV7AesVariant(2)).toBe(12);
    expect(macriumV7AesVariant(3)).toBe(14);
    expect(macriumV7AesVariant(0)).toBeUndefined();
  });

  it('identifies low-iteration range', () => {
    expect(isMacriumV7LowIter(256)).toBe(true);
    expect(isMacriumV7LowIter(0x493e0)).toBe(true);
    expect(isMacriumV7LowIter(0x493e1)).toBe(false);
  });

  it('derives v7 key with PBKDF2-HMAC-SHA1 fixed salt (dummy password vector)', () => {
    const mat = deriveMacriumV7Key('test-password', 256, 10);
    expect(mat.aes).toBe(10);
    expect(mat.key.toString('hex')).toBe(
      'f84619b0e780d9ab46779330dbf2d206bc3708b4291bf1e63efecaa15a513283'
    );
    expect(verifyMacriumV7PasswordHash(mat, 'a8a6a658daa73d3141d57c0eb7db3e54')).toBe(true);
    expect(verifyMacriumV7PasswordHash(mat, '00000000000000000000000000000000')).toBe(false);
  });

  it('computes v7 low-iter IV as u64_le(blockIndex)||imageid8', () => {
    const imageId8 = Buffer.from('1d7d3893616335f3', 'hex');
    expect(macriumV7BlockIv(imageId8, 0).toString('hex')).toBe(
      '00000000000000001d7d3893616335f3'
    );
    expect(macriumV7BlockIv(imageId8, 820).toString('hex')).toBe(
      '34030000000000001d7d3893616335f3'
    );
  });

  it('decrypts an AES-128-CBC block with v7 IV (synthetic vector)', () => {
    const key16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const imageId8 = Buffer.from('0102030405060708', 'hex');
    const iv = macriumV7BlockIv(imageId8, 7);
    const plain = Buffer.from('00112233445566778899aabbccddeeff', 'hex'); // 16 bytes
    const cipher = crypto.createCipheriv('aes-128-cbc', key16, iv);
    cipher.setAutoPadding(false);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const material = { key: Buffer.concat([key16, Buffer.alloc(16, 0)]), aes: 10 as const };
    const dec = decryptMacriumBlock(enc, material, iv);
    expect(dec.toString('hex')).toBe(plain.toString('hex'));
  });
});

const SAMPLE_IMG = 'D:/1D7D3893616335F3-00-00.mrimg';
const SAMPLE_PW = 'D:/mrpass.txt';
const hasSample = fs.existsSync(SAMPLE_IMG) && fs.existsSync(SAMPLE_PW);

describe.skipIf(!hasSample)('mrimg v7 encrypted local sample (gated)', () => {
  it('parses locked, unlocks, and reads verified blocks', async () => {
    const passphrase = fs.readFileSync(SAMPLE_PW, 'utf8').replace(/\r?\n$/, '');
    const locked = readMacriumImage(SAMPLE_IMG);
    expect(locked.format).toBe('mrimg-v7');
    expect(locked.encryption.enable).toBe(true);
    expect(locked.unlocked).toBeFalsy();
    expect(macriumUnsupportedReason(locked)).toMatch(/passphrase/);

    const info = readMacriumImage(SAMPLE_IMG, passphrase);
    expect(info.unlocked).toBe(true);
    expect(macriumUnsupportedReason(info)).toBeNull();
    expect(info.partitions[0].fsType).toBe('ntfs');
    expect(info.partitions[0].blockCount).toBe(14176);

    const reader = openMacriumPartitionReader(info, 0);
    const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest('hex');
    expect(md5(await reader.read(0, 65536))).toBe('50fd54c3c9dc8b55b877f53b2b1f3e87');
    expect(md5(await reader.read(820 * 65536, 65536))).toBe('8e40d1cfd0cde6a625bdcfe198075044');
    expect(md5(await reader.read(821 * 65536, 65536))).toBe('6ba52e63538681b16b341bb4a24f3fa1');
    expect(md5(await reader.read(884 * 65536, 65536))).toBe('b5511cb83f44d5fd727aab97ffe2ec38');
    expect(md5(await reader.read(947 * 65536, 65536))).toBe('3ccbfbf827c229030ff7fbc9ab2ead63');
    expect(md5(await reader.read(948 * 65536, 65536))).toBe('a31752f42f7c4f15947e559de102e3a8');
  });
});
