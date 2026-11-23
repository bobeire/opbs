import { describe, it, expect } from 'vitest';
import {
  browsePartitionHint,
  browsePassphraseAttemptKey,
  needsBrowsePartitionError,
  needsBrowsePassphrase,
  shouldReopenForPassphrase
} from '../../src/renderer/lib/browse-passphrase';

describe('needsBrowsePassphrase', () => {
  it('shows the field for a locked Macrium v7 (.mrimg) image', () => {
    expect(needsBrowsePassphrase(true)).toBe(true);
  });

  it('hides the field for an unencrypted image', () => {
    expect(needsBrowsePassphrase(false)).toBe(false);
    expect(needsBrowsePassphrase(undefined)).toBe(false);
  });
});

describe('shouldReopenForPassphrase', () => {
  it('re-opens an encrypted .mrimg after the passphrase changes', () => {
    expect(shouldReopenForPassphrase('D:\\image.mrimg', true, 'mrimg')).toBe(true);
  });

  it('still re-opens an encrypted .mrimgx', () => {
    expect(shouldReopenForPassphrase('D:\\image.mrimgx', true, 'mrimgx')).toBe(true);
  });

  it('does not re-open without an image path or encryption', () => {
    expect(shouldReopenForPassphrase('', true, 'mrimg')).toBe(false);
    expect(shouldReopenForPassphrase(undefined, true, 'mrimgx')).toBe(false);
    expect(shouldReopenForPassphrase('D:\\image.mrimg', false, 'mrimg')).toBe(false);
    expect(shouldReopenForPassphrase('D:\\image.mrimg', undefined, 'mrimg')).toBe(false);
  });

  it('keeps the existing OPBS image flow unchanged', () => {
    expect(shouldReopenForPassphrase('D:\\image.opbs', true, 'opbs')).toBe(false);
  });
});

describe('browsePassphraseAttemptKey', () => {
  it('changes with either the image or the passphrase', () => {
    const first = browsePassphraseAttemptKey('D:\\a.mrimg', 'one');
    expect(first).toBe(browsePassphraseAttemptKey('D:\\a.mrimg', 'one'));
    expect(first).not.toBe(browsePassphraseAttemptKey('D:\\a.mrimg', 'two'));
    expect(first).not.toBe(browsePassphraseAttemptKey('D:\\b.mrimg', 'one'));
  });
});

describe('browsePartitionHint', () => {
  it('shows the exact refusal reason for a locked partition', () => {
    expect(
      browsePartitionHint({
        partitionIndex: 0,
        fsType: 'Unsupported',
        reason: 'D:\\image.mrimg: this Macrium image is password-protected; enter its passphrase to open it.'
      })
    ).toContain('password-protected');
  });

  it('falls back to the filesystem hint when no reason is given', () => {
    expect(browsePartitionHint({ partitionIndex: 2, fsType: 'FAT16' })).toContain(
      'Partition 2 uses FAT16'
    );
  });
});

describe('needsBrowsePartitionError', () => {
  it('does not add a second message when the hint shows the exact refusal reason', () => {
    expect(needsBrowsePartitionError('this Macrium image is password-protected')).toBe(false);
  });

  it('still shows the generic error when there is no refusal reason', () => {
    expect(needsBrowsePartitionError(undefined)).toBe(true);
  });
});
