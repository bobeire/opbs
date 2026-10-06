import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import {
  decryptEfsStream,
  desDecrypt,
  desEncrypt,
  efsStreamSizes,
  expandDesx,
  parseFek,
  EfsEncryptedError
} from '../../src/main/imaging/fs/efs';

/** Encrypt one 512-byte sector the way EFS stores it (CBC with the offset IV). */
function encryptSector(plain: Buffer, offset: number, alg: string, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv(alg, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function aesIv(offset: number): Buffer {
  const lo = Buffer.alloc(8);
  const hi = Buffer.alloc(8);
  lo.writeBigUInt64LE(0x5816657be9161312n + BigInt(offset));
  hi.writeBigUInt64LE(0x1989adbe44918961n + BigInt(offset));
  return Buffer.concat([lo, hi]);
}

function legacyIv(offset: number): Buffer {
  const iv = Buffer.alloc(8);
  iv.writeBigUInt64LE(0x169119629891ad13n + BigInt(offset));
  return iv;
}

describe('EFS file encryption keys', () => {
  it('parses an AES-256 FEK', () => {
    const fek = Buffer.alloc(16 + 32);
    fek.writeUInt32LE(32, 0);
    fek.writeUInt32LE(32, 4);
    fek.writeUInt32LE(0x6610, 8);
    randomBytes(32).copy(fek, 16);
    const key = parseFek(fek);
    expect(key.algId).toBe(0x6610);
    expect(key.key).toEqual(fek.subarray(16));
  });

  it('rejects unknown algorithms and mismatched key lengths', () => {
    const bad = Buffer.alloc(24);
    bad.writeUInt32LE(16, 0);
    bad.writeUInt32LE(0x1234, 8);
    expect(() => parseFek(bad)).toThrow(/unsupported EFS cipher algorithm/);

    const short = Buffer.alloc(16 + 8);
    short.writeUInt32LE(8, 0);
    short.writeUInt32LE(0x6610, 8);
    expect(() => parseFek(short)).toThrow(/does not match aes-256-cbc/);

    expect(() => parseFek(Buffer.alloc(4))).toThrow(/truncated/);
  });

  it('reports the missing-key condition as an EFS error', () => {
    const err = new EfsEncryptedError('"secret.txt" is EFS-encrypted and no local private key can unwrap it');
    expect(err.code).toBe('EFS_ENCRYPTED');
    expect(err.message).toMatch(/EFS-encrypted/);
  });
});

describe('EFS stream sizing', () => {
  const extent = (plainLength: number): Buffer => {
    const raw = Buffer.alloc(Math.ceil(plainLength / 512) * 512 + 2);
    raw.writeUInt16LE(raw.length - 2 - plainLength, raw.length - 2);
    return raw;
  };

  it('reads the raw-extent convention (data_size spans ciphertext + pad field)', () => {
    const raw = extent(26);
    expect(raw.length % 512).toBe(2);
    expect(efsStreamSizes(raw, raw.length)).toEqual({ plain: 26, cipher: 512 });
    expect(efsStreamSizes(extent(511), 514)).toEqual({ plain: 511, cipher: 512 });
    expect(efsStreamSizes(extent(512), 514)).toEqual({ plain: 512, cipher: 512 });
    expect(efsStreamSizes(extent(513), 1026)).toEqual({ plain: 513, cipher: 1024 });
  });

  it('reads the plaintext convention (data_size is the plain count)', () => {
    const raw = Buffer.alloc(512);
    expect(efsStreamSizes(raw, 26)).toEqual({ plain: 26, cipher: 512 });
    expect(efsStreamSizes(raw, 26, 512)).toEqual({ plain: 26, cipher: 512 });
    // initialized_size larger than data_size picks this convention even when
    // the plaintext length itself is ≡ 2 (mod 512).
    const raw2 = Buffer.alloc(1024);
    expect(efsStreamSizes(raw2, 514, 1024)).toEqual({ plain: 514, cipher: 1024 });
  });

  it('trusts initialized_size when the two conventions could be confused', () => {
    const raw = extent(26);
    // Same data_size, but a larger initialized_size means data_size is plain.
    expect(efsStreamSizes(raw, 514, 514)).toEqual({ plain: 26, cipher: 512 });
    expect(efsStreamSizes(Buffer.alloc(1024), 514, 1024)).toEqual({ plain: 514, cipher: 1024 });
  });

  it('handles empty streams and truncated extents', () => {
    expect(efsStreamSizes(Buffer.alloc(0), 0)).toEqual({ plain: 0, cipher: 0 });
    // Too short to hold the declared extent: no pad field to consult, so the
    // declared size is reported as-is and the decryptor rejects the extent.
    expect(efsStreamSizes(Buffer.alloc(100), 514)).toEqual({ plain: 514, cipher: 100 });
  });
});

describe('EFS sector decryption (AES-256)', () => {
  const key = randomBytes(32);
  const fek = { algId: 0x6610, key };

  it('round-trips a single sector', () => {
    const plain = Buffer.alloc(512);
    Buffer.from('hello EFS world').copy(plain);
    const cipher = encryptSector(plain, 0, 'aes-256-cbc', key, aesIv(0));
    const out = decryptEfsStream(cipher, 512, 15, fek);
    expect(out.toString()).toBe('hello EFS world');
  });

  it('uses a per-sector IV so identical plaintext blocks differ', () => {
    const sector = Buffer.alloc(512, 0x41);
    const first = encryptSector(sector, 0, 'aes-256-cbc', key, aesIv(0));
    const second = encryptSector(sector, 512, 'aes-256-cbc', key, aesIv(512));
    expect(first.equals(second)).toBe(false);

    const both = Buffer.concat([first, second]);
    const out = decryptEfsStream(both, 1024, 1024, fek);
    expect(out.equals(Buffer.alloc(1024, 0x41))).toBe(true);
  });

  it('drops the zero padding of the final sector', () => {
    const plain = Buffer.alloc(5000, 0x5a);
    const padded = Buffer.alloc(5120, 0x5a);
    const cipher = Buffer.concat(
      [0, 512, 1024, 1536, 2048, 2560, 3072, 3584, 4096, 4608].map((offset) =>
        encryptSector(padded.subarray(offset, offset + 512), offset, 'aes-256-cbc', key, aesIv(offset))
      )
    );
    const out = decryptEfsStream(cipher, 5120, 5000, fek);
    expect(out.equals(plain)).toBe(true);
  });

  it('refuses inconsistent sizes', () => {
    expect(() => decryptEfsStream(Buffer.alloc(512), 100, 100, fek)).toThrow(/multiple of 512/);
    expect(() => decryptEfsStream(Buffer.alloc(100), 512, 512, fek)).toThrow(/truncated/);
    expect(() => decryptEfsStream(Buffer.alloc(512), 512, 1024, fek)).toThrow(/exceeds ciphertext/);
    // An extent that is too short for its declared size must not decrypt.
    expect(() => decryptEfsStream(Buffer.alloc(100), 100, 1026, fek)).toThrow(/multiple of 512/);
  });
});

describe('EFS sector decryption (3DES)', () => {
  const key = randomBytes(24);
  const fek = { algId: 0x6603, key };

  it('round-trips with the legacy sector IV', () => {
    const plain = Buffer.alloc(512, 0x33);
    const cipher = encryptSector(plain, 0, 'des-ede3-cbc', key, legacyIv(0));
    const out = decryptEfsStream(cipher, 512, 512, fek);
    expect(out.equals(plain)).toBe(true);
  });
});

describe('EFS single-DES primitive', () => {
  // Known-answer vectors from ntfs-3g's ntfsdecrypt.c test code (which uses
  // libgcrypt): E_K(plain) for the DESX-expanded key.
  const key = Buffer.from('27d19309cb78931f', 'hex');
  const plain = 0xd8d915235b880e09n;
  const cipher = 0xdcf7682aaf48530fn;

  it('matches the ntfs-3g known-answer vector', () => {
    // ntfs-3g's vector is written the way EFS uses the cipher: encrypting the
    // stored block yields the plaintext block (and vice versa).
    expect(desEncrypt(key, cipher)).toBe(plain);
    expect(desDecrypt(key, plain)).toBe(cipher);
  });

  it('agrees with OpenSSL 3DES when all three keys are equal', () => {
    for (let i = 0; i < 20; i++) {
      const desKey = randomBytes(8);
      const block = randomBytes(8);
      const triple = Buffer.concat([desKey, desKey, desKey]);
      const enc = createCipheriv('des-ede3-cbc', triple, Buffer.alloc(8));
      enc.setAutoPadding(false);
      const openssl = Buffer.concat([enc.update(block), enc.final()]);
      expect(desEncrypt(desKey, block.readBigUInt64BE(0))).toBe(openssl.readBigUInt64BE(0));
    }
  });

  it('round-trips random blocks', () => {
    for (let i = 0; i < 50; i++) {
      const desKey = randomBytes(8);
      const block = randomBytes(8).readBigUInt64BE(0);
      expect(desDecrypt(desKey, desEncrypt(desKey, block))).toBe(block);
    }
  });

  it('expands the 128-bit on-disk DESX key like ntfs-3g does', () => {
    const expanded = expandDesx(Buffer.from('a1f9e0b253239e8f0f9145d98e20ec30', 'hex'));
    expect(expanded.desKey.toString('hex')).toBe('27d19309cb78931f');
    expect(expanded.outWhitening.toString(16)).toBe('8ddb4960474cdaed');
    expect(expanded.inWhitening.toString(16)).toBe('1e28cac01aa0f675');
    expect(() => expandDesx(Buffer.alloc(8))).toThrow(/16 bytes/);
  });
});

describe('EFS DESX sector decryption', () => {
  const onDiskKey = randomBytes(16);
  const fek = { algId: 0x6601, key: onDiskKey };

  /** Build the on-disk form of a sector from its plaintext. */
  function desxEncryptSector(plain: Buffer, sectorOffset: number): Buffer {
    const { desKey, outWhitening, inWhitening } = expandDesx(onDiskKey);
    const iv = 0x169119629891ad13n + BigInt(sectorOffset);
    const out = Buffer.alloc(plain.length);
    let previous = 0n;
    for (let offset = 0; offset < plain.length; offset += 8) {
      let block = plain.readBigUInt64LE(offset);
      if (offset === 0) block ^= iv;
      const t = desDecrypt(desKey, BigInt.asUintN(64, block ^ inWhitening ^ previous));
      const stored = t ^ outWhitening;
      previous = stored;
      out.writeBigUInt64LE(stored, offset);
    }
    return out;
  }

  it('decrypts a sector built by the inverse transformation', () => {
    const plain = randomBytes(512);
    const cipher = desxEncryptSector(plain, 0);
    const out = decryptEfsStream(cipher, 512, 512, fek);
    expect(out.equals(plain)).toBe(true);
  });

  it('resets the block chain and IV per sector', () => {
    const first = randomBytes(512);
    const second = randomBytes(512);
    const cipher = Buffer.concat([desxEncryptSector(first, 0), desxEncryptSector(second, 512)]);
    const out = decryptEfsStream(cipher, 1024, 1024, fek);
    expect(out.subarray(0, 512).equals(first)).toBe(true);
    expect(out.subarray(512).equals(second)).toBe(true);
  });
});
