import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ready: true,
  available: true,
  encryptThrows: false,
  decryptThrows: false
}));

vi.mock('../../src/main/utils/electron-access', () => ({
  getElectron: () => ({
    app: {
      isReady: () => mocks.ready
    },
    safeStorage: {
      isEncryptionAvailable: () => mocks.available,
      encryptString: (value: string) => {
        if (mocks.encryptThrows) throw new Error('encrypt failed');
        return Buffer.from(`C:${value}`, 'utf-8');
      },
      decryptString: (blob: Buffer) => {
        const text = blob.toString('utf-8');
        if (mocks.decryptThrows || !text.startsWith('C:')) throw new Error('bad blob');
        return text.slice(2);
      }
    }
  })
}));

import { encryptSecret, decryptSecret, isSecretEncrypted } from '../../src/main/utils/secret-store';

describe('secret-store', () => {
  beforeEach(() => {
    mocks.ready = true;
    mocks.available = true;
    mocks.encryptThrows = false;
    mocks.decryptThrows = false;
  });

  it('round-trips a secret through encrypt + decrypt', () => {
    const stored = encryptSecret('correct horse');
    expect(isSecretEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('correct horse');
    expect(decryptSecret(stored)).toBe('correct horse');
  });

  it('leaves plaintext (legacy / hand-written configs) untouched', () => {
    expect(encryptSecret('plaintext')).not.toBe('plaintext'); // encrypts when it can
    expect(decryptSecret('plaintext')).toBe('plaintext');
  });

  it('never double-encrypts an already-encrypted value', () => {
    const once = encryptSecret('pw');
    expect(encryptSecret(once)).toBe(once);
  });

  it('keeps empty strings empty', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('stores plaintext when the OS secret store is unavailable', () => {
    mocks.available = false;
    expect(encryptSecret('pw')).toBe('pw');
    // and such a value decrypts as legacy plaintext
    expect(decryptSecret('pw')).toBe('pw');
  });

  it('stores plaintext before the app is ready', () => {
    mocks.ready = false;
    expect(encryptSecret('pw')).toBe('pw');
  });

  it('returns an encrypted blob unchanged before the app is ready', () => {
    const stored = (() => {
      mocks.ready = true;
      return encryptSecret('pw');
    })();
    mocks.ready = false;
    expect(decryptSecret(stored)).toBe(stored);
  });

  it('returns a foreign blob unchanged when decryption fails', () => {
    const foreign = 'enc:v1:AAAA';
    mocks.decryptThrows = true;
    expect(decryptSecret(foreign)).toBe(foreign);
  });

  it('falls back to plaintext when encryptString throws', () => {
    mocks.encryptThrows = true;
    expect(encryptSecret('pw')).toBe('pw');
  });
});
