import { describe, it, expect } from 'vitest';
import { confirmStatus, confirmReady } from '../../src/renderer/lib/passphrase';

describe('confirmStatus', () => {
  it('is empty when neither field is filled (no encryption / nothing set)', () => {
    expect(confirmStatus('', '')).toBe('empty');
  });

  it('is incomplete when the passphrase is set but not re-entered', () => {
    expect(confirmStatus('correct horse', '')).toBe('incomplete');
  });

  it('matches when both fields are identical', () => {
    expect(confirmStatus('correct horse', 'correct horse')).toBe('match');
  });

  it('mismatches when the entries differ', () => {
    expect(confirmStatus('correct horse', 'correct horse ')).toBe('mismatch');
    expect(confirmStatus('a', 'b')).toBe('mismatch');
  });

  it('mismatches when only the confirm field is filled', () => {
    expect(confirmStatus('', 'typo')).toBe('mismatch');
  });

  it('is whitespace-sensitive (the saved value is used verbatim)', () => {
    expect(confirmStatus('x ', 'x')).toBe('mismatch');
    expect(confirmStatus('x', 'x')).toBe('match');
  });
});

describe('confirmReady', () => {
  it('allows both empty (optional passphrase)', () => {
    expect(confirmReady('', '')).toBe(true);
  });

  it('allows identical entries', () => {
    expect(confirmReady('secret', 'secret')).toBe(true);
  });

  it('blocks unconfirmed and mismatched entries', () => {
    expect(confirmReady('secret', '')).toBe(false);
    expect(confirmReady('secret', 'Secret')).toBe(false);
    expect(confirmReady('', 'secret')).toBe(false);
  });
});
