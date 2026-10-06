import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  decryptEfsStream,
  efsStreamSizes,
  parseEfsAttribute,
  parseFek
} from '../../src/main/imaging/fs/efs';

/**
 * Golden vectors captured from a real Windows EFS encryption (see
 * `test/integration/efs-live.test.ts`, run with `OPBS_EFS_FIXTURE=1` to
 * refresh). They pin the `$EFS` parser and the sector decryptor to data that
 * this machine's `cipher.exe` actually produced, so the offline suite does not
 * depend on Windows being available.
 */

const GOLDEN_PATH = path.join(__dirname, '..', 'fixtures', 'efs-golden.json');

interface GoldenVector {
  plain: string;
  cipher: string;
  efsAttr: string;
  thumbprint: string;
  fek: string;
  algId: number;
}

interface GoldenFile {
  generatedFrom: string;
  vectors: GoldenVector[];
}

function loadGolden(): GoldenFile | null {
  if (!fs.existsSync(GOLDEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile;
}

const golden = loadGolden();

describe.skipIf(!golden)('golden EFS vectors captured from Windows', () => {
  it('decodes the real $EFS attribute', () => {
    const vectors = golden!.vectors;
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      const info = parseEfsAttribute(Buffer.from(vector.efsAttr, 'base64'));
      expect(info.version).toBe(2);
      expect(info.entries.length).toBeGreaterThan(0);
      const entry = info.entries[0];
      expect(entry.thumbprint).toBe(vector.thumbprint);
      expect(entry.credentialType).toBe(3);
      expect(entry.efek.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it('decrypts the real ciphertext with the captured FEK', () => {
    for (const vector of golden!.vectors) {
      const plain = Buffer.from(vector.plain, 'base64');
      const cipher = Buffer.from(vector.cipher, 'base64');
      const fek = parseFek(Buffer.from(vector.fek, 'base64'));
      expect(fek.algId).toBe(vector.algId);
      expect(cipher.length % 512).toBe(0);
      expect(cipher.length).toBeGreaterThanOrEqual(plain.length);
      expect(efsStreamSizes(cipher, plain.length)).toEqual({
        plain: plain.length,
        cipher: cipher.length
      });
      const out = decryptEfsStream(cipher, cipher.length, plain.length, fek);
      expect(out.equals(plain)).toBe(true);
    }
  });
});
