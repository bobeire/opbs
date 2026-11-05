import { describe, it, expect } from 'vitest';
import { isPermanentBackupFailure } from '../../src/main/backup/scheduler';
import { UndecryptableSecretError } from '../../src/main/utils/secret-store';

describe('scheduled backup failures that retrying cannot fix', () => {
  it('treats an undecryptable saved passphrase as permanent', () => {
    // It will fail identically on every attempt, so retries only delay the alert.
    expect(isPermanentBackupFailure(new UndecryptableSecretError('backup passphrase'))).toBe(true);
  });

  it('leaves ordinary failures retryable', () => {
    expect(isPermanentBackupFailure(new Error('disk busy'))).toBe(false);
    expect(isPermanentBackupFailure(new Error('VSS_E_SNAPSHOT_SET_IN_PROGRESS'))).toBe(false);
    expect(isPermanentBackupFailure('a string')).toBe(false);
    expect(isPermanentBackupFailure(undefined)).toBe(false);
  });
});
