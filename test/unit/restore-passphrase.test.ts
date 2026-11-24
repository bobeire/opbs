import { describe, it, expect } from 'vitest';
import { restorePassphraseOption } from '../../src/renderer/lib/restore-passphrase';

describe('restorePassphraseOption', () => {
  it('sends a trimmed passphrase to the restore config', () => {
    expect(restorePassphraseOption('  hunter2  ')).toEqual({ passphrase: 'hunter2' });
  });

  it('omits the field for empty or whitespace-only input', () => {
    expect(restorePassphraseOption('')).toEqual({});
    expect(restorePassphraseOption('   \t\n ')).toEqual({});
  });

  it('keeps internal whitespace (passphrases are not single tokens)', () => {
    expect(restorePassphraseOption('  correct horse battery  ')).toEqual({
      passphrase: 'correct horse battery'
    });
  });
});
