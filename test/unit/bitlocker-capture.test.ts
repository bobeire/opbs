import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BITLOCKER_CAPTURE_PS,
  BITLOCKER_HKDF_INFO,
  deriveBitlockerSubkey,
  encryptRecoverySecret,
  decryptRecoverySecret,
  parseCaptureJson,
  buildSidecar,
  sidecarPathFor,
  writeBitlockerSidecar,
  readBitlockerSidecar,
  collectAndWriteSidecar,
  readRecoveryKeys,
  CapturedVolume
} from '../../src/main/utils/bitlocker-capture';
import {
  encodeHeader,
  encodePartitionEntry,
  deriveImageKey,
  IMAGE_VERSION,
  PARTITION_TABLE_ENTRY_SIZE,
  CIPHER_AES256_GCM,
  CIPHER_NONE
} from '../../src/main/imaging/image-format';

const KEY_HEX = 'a'.repeat(64);
const PASSWORD = '123456-234567-345678-456789-567890-678901-789012-890123';

function captured(over: Partial<CapturedVolume> = {}): CapturedVolume {
  return {
    letter: 'C',
    conversion: 'FullyEncrypted',
    protectionOn: true,
    locked: false,
    protos: [{ type: 'RecoveryPassword', secret: PASSWORD }, { type: 'TPM' }],
    ...over
  };
}

const CAPTURE_FIXTURE = JSON.stringify([
  {
    letter: 'C',
    conversion: 'FullyEncrypted',
    protectionOn: true,
    locked: false,
    protos: [{ type: 'RecoveryPassword', secret: PASSWORD }, { type: 'TPM' }]
  },
  {
    letter: 'D',
    conversion: 'FullyDecrypted',
    protectionOn: false,
    locked: false,
    protos: [{ type: 'TPM' }]
  }
]);

describe('deriveBitlockerSubkey', () => {
  it('is deterministic, 32 bytes, and bound to the image key', () => {
    const a = deriveBitlockerSubkey(KEY_HEX);
    const b = deriveBitlockerSubkey(KEY_HEX);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(deriveBitlockerSubkey('b'.repeat(64)))).toBe(false);
    expect(a.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(false);
    expect(BITLOCKER_HKDF_INFO).toBe('opbs-bitlocker-recovery-v1');
  });

  it('rejects missing keys', () => {
    expect(() => deriveBitlockerSubkey('')).toThrow();
    expect(() => deriveBitlockerSubkey('zz')).toThrow();
  });
});

describe('encryptRecoverySecret / decryptRecoverySecret', () => {
  it('round-trips a recovery password', () => {
    const subkey = deriveBitlockerSubkey(KEY_HEX);
    const sealed = encryptRecoverySecret(subkey, PASSWORD);
    expect(decryptRecoverySecret(subkey, sealed.nonce, sealed.data)).toBe(PASSWORD);
  });

  it('uses a fresh nonce per protector (same plaintext → different ciphertext)', () => {
    const subkey = deriveBitlockerSubkey(KEY_HEX);
    const one = encryptRecoverySecret(subkey, PASSWORD);
    const two = encryptRecoverySecret(subkey, PASSWORD);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.data).not.toBe(two.data);
  });

  it('detects tampering and wrong subkeys', () => {
    const subkey = deriveBitlockerSubkey(KEY_HEX);
    const sealed = encryptRecoverySecret(subkey, PASSWORD);
    const raw = Buffer.from(sealed.data, 'base64');
    raw[0] ^= 0xff;
    expect(() => decryptRecoverySecret(subkey, sealed.nonce, raw.toString('base64'))).toThrow();
    expect(() => decryptRecoverySecret(deriveBitlockerSubkey('b'.repeat(64)), sealed.nonce, sealed.data)).toThrow();
    expect(() => decryptRecoverySecret(subkey, sealed.nonce, Buffer.alloc(4).toString('base64'))).toThrow();
  });
});

describe('parseCaptureJson', () => {
  it('parses the PowerShell capture shape with secrets', () => {
    const volumes = parseCaptureJson(CAPTURE_FIXTURE);
    expect(volumes).toHaveLength(2);
    expect(volumes![0].letter).toBe('C');
    expect(volumes![0].conversion).toBe('FullyEncrypted');
    expect(volumes![0].locked).toBe(false);
    expect(volumes![0].protos).toHaveLength(2);
    expect(volumes![0].protos[0]).toEqual({ type: 'RecoveryPassword', secret: PASSWORD });
    expect(volumes![0].protos[1]).toEqual({ type: 'TPM' });
    expect(volumes![1].letter).toBe('D');
    expect(volumes![1].conversion).toBe('FullyDecrypted');
  });

  it('accepts a single object and normalizes letters', () => {
    const volumes = parseCaptureJson('{"letter":"e:","conversion":"FullyEncrypted","locked":true,"protos":[]}');
    expect(volumes).toHaveLength(1);
    expect(volumes![0].letter).toBe('E');
    expect(volumes![0].locked).toBe(true);
  });

  it('returns null for garbage, empty and non-array roots', () => {
    expect(parseCaptureJson('')).toBeNull();
    expect(parseCaptureJson('not json')).toBeNull();
    expect(parseCaptureJson('null')).toBeNull();
    expect(parseCaptureJson('"string"')).toBeNull();
  });

  it('drops entries without a valid single-letter drive', () => {
    expect(parseCaptureJson('[{"letter":"","protos":[]},{"letter":"XY","protos":[]}]')).toEqual([]);
  });
});

describe('buildSidecar', () => {
  const partition = { label: 'OS', offset: 1048576, size: 512000000, driveLetter: 'C:' };

  it('matches by drive letter, seals secrets, and copies job geometry', () => {
    const { sidecar, skipped } = buildSidecar({
      keyHex: KEY_HEX,
      captured: [captured()],
      partitions: [partition],
      now: new Date('2026-09-25T00:00:00Z')
    });
    expect(skipped).toEqual([]);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.version).toBe(1);
    expect(sidecar!.createdAt).toBe('2026-09-25T00:00:00.000Z');
    expect(sidecar!.volumes).toHaveLength(1);
    const v = sidecar!.volumes[0];
    expect(v.letter).toBe('C');
    expect(v.label).toBe('OS');
    expect(v.offset).toBe(1048576);
    expect(v.size).toBe(512000000);
    expect(v.conversion).toBe('FullyEncrypted');
    expect(v.protectors).toHaveLength(1);
    expect(v.protectors[0].type).toBe('RecoveryPassword');

    // The sealed blob decrypts with the subkey derived from the image key.
    const subkey = deriveBitlockerSubkey(KEY_HEX);
    expect(decryptRecoverySecret(subkey, v.protectors[0].nonce, v.protectors[0].data)).toBe(PASSWORD);
  });

  it('never leaks plaintext passwords into the serialised sidecar', () => {
    const { sidecar } = buildSidecar({
      keyHex: KEY_HEX,
      captured: [captured()],
      partitions: [partition]
    });
    const json = JSON.stringify(sidecar);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain(PASSWORD.replace(/-/g, ''));
    expect(json).toContain('RecoveryPassword');
  });

  it('ignores decrypted volumes and encrypted volumes outside the selection', () => {
    const { sidecar, skipped } = buildSidecar({
      keyHex: KEY_HEX,
      captured: [captured({ letter: 'D', conversion: 'FullyDecrypted' }), captured({ letter: 'Z' })],
      partitions: [partition]
    });
    expect(sidecar).toBeNull();
    expect(skipped).toEqual([]);
  });

  it('reports locked volumes as skipped', () => {
    const { sidecar, skipped } = buildSidecar({
      keyHex: KEY_HEX,
      captured: [captured({ locked: true, conversion: '' })],
      partitions: [partition]
    });
    expect(sidecar).toBeNull();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].letter).toBe('C');
    expect(skipped[0].reason).toContain('locked');
  });

  it('reports encrypted volumes that lack a recovery-password protector', () => {
    const { sidecar, skipped } = buildSidecar({
      keyHex: KEY_HEX,
      captured: [captured({ protos: [{ type: 'TPM' }] })],
      partitions: [partition]
    });
    expect(sidecar).toBeNull();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('recoverypassword');
    expect(skipped[0].reason).toContain('manage-bde');
  });
});

describe('sidecar file round-trip', () => {
  it('writes, reads back and validates; missing/malformed → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-sidecar-'));
    try {
      const image = path.join(dir, 'backup.opbs');
      expect(readBitlockerSidecar(image)).toBeNull();
      expect(sidecarPathFor(image)).toBe(`${image}.bitlocker.json`);

      const { sidecar } = buildSidecar({
        keyHex: KEY_HEX,
        captured: [captured()],
        partitions: [{ label: 'OS', offset: 0, size: 1, driveLetter: 'C' }]
      });
      writeBitlockerSidecar(image, sidecar!);

      const read = readBitlockerSidecar(image);
      expect(read).toEqual(sidecar);

      fs.writeFileSync(sidecarPathFor(image), '{"version":99}');
      expect(readBitlockerSidecar(image)).toBeNull();
      fs.writeFileSync(sidecarPathFor(image), 'not json');
      expect(readBitlockerSidecar(image)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BITLOCKER_CAPTURE_PS', () => {
  it('reads protector types and only extracts RecoveryPassword secrets', () => {
    expect(BITLOCKER_CAPTURE_PS).toContain('Get-BitLockerVolume');
    expect(BITLOCKER_CAPTURE_PS).toContain('$kp.KeyProtectorType');
    expect(BITLOCKER_CAPTURE_PS).toContain("if ($typeName -eq 'RecoveryPassword'");
    expect(BITLOCKER_CAPTURE_PS).toContain('$kp.RecoveryPassword');
    expect(BITLOCKER_CAPTURE_PS).toContain('ConvertTo-Json');
  });
});

describe('collectAndWriteSidecar (live, non-elevated — must never prompt)', () => {
  it('is a no-op without an encryption key (Decision A)', () => {
    const warnings: string[] = [];
    const written = collectAndWriteSidecar(
      { imagePath: path.join(os.tmpdir(), 'opbs-nokey.opbs'), partitions: [] },
      warnings
    );
    expect(written).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('never throws and never writes when no partition matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cap-'));
    try {
      const image = path.join(dir, 'img.opbs');
      const warnings: string[] = [];
      const written = collectAndWriteSidecar(
        { imagePath: image, encryptionKeyHex: KEY_HEX, partitions: [] },
        warnings
      );
      expect(written).toBe(false);
      expect(fs.existsSync(sidecarPathFor(image))).toBe(false);
      expect(warnings.length).toBeLessThanOrEqual(1);
      for (const w of warnings) expect(w).toContain('BitLocker');
      // Warning text must never contain key material.
      for (const w of warnings) expect(w).not.toContain(PASSWORD);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('readRecoveryKeys (key viewer)', () => {
  const PASSPHRASE = 'correct horse battery staple';
  const KDF_ITERS = 1000;

  function writeImage(imagePath: string, cipherId: number): { salt: Buffer } {
    const salt = crypto.randomBytes(16);
    const header = {
      version: IMAGE_VERSION,
      timestamp: Date.now(),
      totalBytes: 8192,
      blockSize: 4096,
      compressionId: 0,
      partitionCount: 1,
      flags: 0,
      blockIndexOffset: 0,
      cipherId,
      kdfIterations: cipherId ? KDF_ITERS : 0,
      salt,
      baseImagePath: '',
      sourceDiskModel: '',
      sourceDiskSerial: ''
    };
    const partition = {
      partitionIndex: 0,
      size: 4096,
      offsetOnDisk: 1048576,
      firstBlockFileOffset: 0,
      blockCount: 0
    };
    fs.writeFileSync(imagePath, Buffer.concat([encodeHeader(header), encodePartitionEntry(partition)]));
    return { salt };
  }

  function writeSidecar(imagePath: string, keyHex: string): void {
    const subkey = deriveBitlockerSubkey(keyHex);
    const sealed = encryptRecoverySecret(subkey, PASSWORD);
    writeBitlockerSidecar(imagePath, {
      version: 1,
      createdAt: new Date().toISOString(),
      volumes: [
        {
          letter: 'D',
          label: 'Data',
          offset: 1048576,
          size: 4096,
          conversion: 'FullyEncrypted',
          protectors: [{ type: 'RecoveryPassword', nonce: sealed.nonce, data: sealed.data }]
        }
      ]
    });
  }

  const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-keys-read-'));

  it('round-trips passphrase → plaintext recovery password', () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'enc.opbs');
      const { salt } = writeImage(imagePath, CIPHER_AES256_GCM);
      const keyHex = deriveImageKey(PASSPHRASE, salt, KDF_ITERS).toString('hex');
      writeSidecar(imagePath, keyHex);

      const result = readRecoveryKeys(imagePath, PASSPHRASE);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.keys).toHaveLength(1);
        expect(result.keys[0].letter).toBe('D');
        expect(result.keys[0].label).toBe('Data');
        expect(result.keys[0].recoveryPassword).toBe(PASSWORD);
      }
      // The on-disk sidecar still never contains the plaintext password.
      expect(fs.readFileSync(sidecarPathFor(imagePath), 'utf-8')).not.toContain(PASSWORD);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a wrong passphrase with the generic decryption error', () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'enc.opbs');
      const { salt } = writeImage(imagePath, CIPHER_AES256_GCM);
      const keyHex = deriveImageKey(PASSPHRASE, salt, KDF_ITERS).toString('hex');
      writeSidecar(imagePath, keyHex);

      const result = readRecoveryKeys(imagePath, 'wrong passphrase');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Could not decrypt the BitLocker keys. Check the backup passphrase.');
        expect(result.error).not.toContain(PASSWORD);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing sidecar distinctly', () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'enc.opbs');
      writeImage(imagePath, CIPHER_AES256_GCM);
      const result = readRecoveryKeys(imagePath, PASSPHRASE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('No BitLocker key sidecar');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asks for the passphrase when none is supplied', () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'enc.opbs');
      const { salt } = writeImage(imagePath, CIPHER_AES256_GCM);
      const keyHex = deriveImageKey(PASSPHRASE, salt, KDF_ITERS).toString('hex');
      writeSidecar(imagePath, keyHex);

      const result = readRecoveryKeys(imagePath, '');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('backup passphrase');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a plaintext image because there is nothing to derive a key from', () => {
    const dir = tempDir();
    try {
      const imagePath = path.join(dir, 'plain.opbs');
      writeImage(imagePath, CIPHER_NONE);
      writeSidecar(imagePath, KEY_HEX);

      const result = readRecoveryKeys(imagePath, PASSPHRASE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not encrypted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
