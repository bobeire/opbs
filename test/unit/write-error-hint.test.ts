import { describe, it, expect } from 'vitest';
import { writeErrorHint, lockFailureMessage } from '../../src/main/helper/job-runner';

describe('writeErrorHint', () => {
  it('explains ERROR_ACCESS_DENIED as a held or BitLocker-locked volume', () => {
    const hint = writeErrorHint(
      'Write failed for Partition 2 block 0 at 332398592: WriteFile failed on \\\\.\\PhysicalDrive0 at offset 332398592 (1048576 bytes): Access is denied. (error 5 / 0x5)'
    );
    expect(hint).toContain('BitLocker');
    expect(hint).toContain('manage-bde -status');
    expect(hint).toContain('block 0');
    expect(hint).toContain('nothing has been written to that partition yet');
  });

  it('is case-insensitive on the denial text', () => {
    expect(writeErrorHint('access is denied (error 5)')).not.toBe('');
    expect(writeErrorHint('ACCESS IS DENIED')).not.toBe('');
  });

  it('stays silent for unrelated errors', () => {
    expect(writeErrorHint('The device is not ready. (error 21)')).toBe('');
    expect(writeErrorHint('')).toBe('');
    expect(writeErrorHint('CRC mismatch in block 4')).toBe('');
  });
});

describe('lockFailureMessage', () => {
  it('covers the WinPE dirty-volume (read-only mount) case and its fixes', () => {
    const msg = lockFailureMessage('Partition 2');
    expect(msg).toContain('Cannot lock Partition 2');
    // The dirty-flag case is what "Access is denied" on the volume means in
    // WinPE, and it needs a different remedy than an open file or BitLocker.
    expect(msg).toContain('dirty flag');
    expect(msg).toContain('Access is denied');
    expect(msg).toContain('chkdsk');
    expect(msg).toContain('remove letter');
    expect(msg).toContain('manage-bde -status');
    // The promise that matters most to someone restoring: the disk is intact.
    expect(msg).toContain('Nothing has been written to the disk');
  });

  it('embeds the native step that failed, so a report identifies the cause', () => {
    const msg = lockFailureMessage(
      'Partition 2',
      '\\\\?\\Volume{c33d64ca-495d-4e5a-8d0a-5aeebfa59c61}\\',
      'the volume stayed in use for 10s (lock error 5) and the forced dismount was refused too (error 32)'
    );
    expect(msg).toContain('\\\\?\\Volume{c33d64ca');
    expect(msg).toContain('Step that failed: the volume stayed in use for 10s');
    expect(msg).toContain('forced dismount was refused');
    // Without a note from the native layer, nothing is invented.
    expect(lockFailureMessage('Partition 2')).not.toContain('Step that failed');
  });
});
