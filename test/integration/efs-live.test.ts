import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadNative } from '../../src/main/utils/native-loader';
import {
  decryptEfsStream,
  efsStreamSizes,
  parseEfsAttribute,
  parseFek,
  unwrapFek
} from '../../src/main/imaging/fs/efs';

/**
 * End-to-end check against a real Windows EFS encryption: encrypt a probe file
 * with `cipher /e`, read it back through the native `ReadEncryptedFileRaw`
 * helper (which returns the on-disk `$EFS` attribute and ciphertext), and run
 * the product's parser + FEK unwrap + sector decrypt on it.
 *
 * Skipped on platforms without `cipher.exe`, and skipped when the machine has
 * no private key for the file (a fresh key pair is created by `cipher` here, so
 * that only happens on restricted setups). Run with `OPBS_EFS_FIXTURE=1` to
 * refresh `test/fixtures/efs-golden.json` from the live machine.
 */

const GOLDEN_PATH = path.join(__dirname, '..', 'fixtures', 'efs-golden.json');
const REGENERATE = process.env.OPBS_EFS_FIXTURE === '1';
const CIPHER_EXE = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cipher.exe');

interface GoldenVector {
  /** Base64 plaintext. */
  plain: string;
  /** Base64 ciphertext (a whole number of 512-byte sectors). */
  cipher: string;
  /** Base64 `$EFS` attribute value exactly as Windows wrote it. */
  efsAttr: string;
  /** Thumbprint whose private key unwraps the EFEK. */
  thumbprint: string;
  /** Base64 plaintext FEK produced by the RSA unwrap. */
  fek: string;
  algId: number;
}

interface NativeWithEfs {
  readEncryptedRaw?: (file: string) => Buffer;
  unwrapEfsFek?: (thumbprint: string, efek: Buffer) => Buffer;
}

function deterministicBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

function tryEncrypt(file: string): boolean {
  try {
    execFileSync(CIPHER_EXE, ['/e', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Find the `$EFS` attribute header inside a raw encrypted-file export. */
function locateEfsAttribute(raw: Buffer): Buffer | null {
  for (let i = 0; i + 0x4c <= raw.length; i++) {
    const length = raw.readUInt32LE(i);
    if (length < 0x54 || length > 0x40000 || i + length > raw.length) continue;
    if (raw.readUInt32LE(i + 8) !== 2) continue;
    const ddf = raw.readUInt32LE(i + 0x40);
    if (ddf < 0x4c || ddf >= length) continue;
    const count = raw.readUInt32LE(i + ddf);
    if (count < 1 || count > 16) continue;
    return raw.subarray(i, i + length);
  }
  return null;
}

function encryptProbe(native: NativeWithEfs, plain: Buffer): { attr: Buffer; cipher: Buffer } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-efs-live-'));
  const file = path.join(dir, 'probe.bin');
  try {
    fs.writeFileSync(file, plain);
    if (!tryEncrypt(file)) return null;
    const raw = native.readEncryptedRaw!(file);
    const attr = locateEfsAttribute(raw);
    if (!attr) return null;
    const cipherLength = Math.ceil(plain.length / 512) * 512;
    return { attr, cipher: Buffer.from(raw.subarray(raw.length - cipherLength)) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'win32')('EFS live round-trip against cipher /e', () => {
  it('parses, unwraps and decrypts files Windows just encrypted', (ctx) => {
    let native: NativeWithEfs;
    try {
      native = loadNative<NativeWithEfs>();
    } catch {
      ctx.skip();
      return;
    }
    if (typeof native.readEncryptedRaw !== 'function' || typeof native.unwrapEfsFek !== 'function') {
      ctx.skip();
      return;
    }

    const vectors: GoldenVector[] = [];
    for (const size of [26, 5000]) {
      const plain = deterministicBytes(size, 0x5eed + size);
      const probe = encryptProbe(native, plain);
      if (!probe) {
        // EFS unavailable on this machine/volume.
        ctx.skip();
        return;
      }
      const info = parseEfsAttribute(probe.attr);
      expect(info.version).toBe(2);
      expect(info.entries.length).toBeGreaterThan(0);

      const entry = info.entries[0];
      expect(entry.thumbprint).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.credentialType).toBe(3);
      expect(entry.efek.length).toBeGreaterThan(0);

      let fekRaw: Buffer;
      try {
        fekRaw = unwrapFek(entry.thumbprint, entry.efek);
      } catch {
        // No private key for this certificate on this machine.
        ctx.skip();
        return;
      }
      const fek = parseFek(fekRaw);
      expect(fek.key.length).toBeGreaterThanOrEqual(16);

      const cipherLength = Math.ceil(plain.length / 512) * 512;
      const sizes = efsStreamSizes(probe.cipher, plain.length);
      expect(sizes).toEqual({ plain: plain.length, cipher: cipherLength });

      const out = decryptEfsStream(probe.cipher, cipherLength, plain.length, fek);
      expect(out.equals(plain)).toBe(true);

      vectors.push({
        plain: plain.toString('base64'),
        cipher: probe.cipher.toString('base64'),
        efsAttr: probe.attr.toString('base64'),
        thumbprint: entry.thumbprint,
        fek: fekRaw.toString('base64'),
        algId: fek.algId
      });
    }

    expect(vectors).toHaveLength(2);
    if (REGENERATE) {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(
        GOLDEN_PATH,
        `${JSON.stringify({ generatedFrom: 'cipher /e on this machine', vectors }, null, 2)}\n`
      );
    }
  });
});
