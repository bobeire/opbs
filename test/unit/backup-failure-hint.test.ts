import { describe, it, expect } from 'vitest';
import { backupFailureHint } from '../../src/renderer/components/backup-failure-hint';

describe('backup failure hint', () => {
  it('does not tell someone a finished-then-failed backup never started', () => {
    // 2026-11-06 field report: the post-backup filesystem check failed, and
    // the wizard answered "The backup did not start ... check the destination
    // folder" underneath an error that described an image it had just written.
    const hint = backupFailureHint('ran');
    expect(hint).not.toMatch(/did not start/i);
    expect(hint).not.toMatch(/destination folder/i);
    expect(hint).toMatch(/do not restore/i);
    expect(hint).toMatch(/Logs page/i);
  });

  it('keeps the destination advice for a failure before the job began', () => {
    const hint = backupFailureHint('not-started');
    expect(hint).toMatch(/did not start/i);
    expect(hint).toMatch(/destination folder/i);
  });

  it('still explains a refused snapshot without blaming the image', () => {
    const unsupported = backupFailureHint('snapshot-unsupported');
    expect(unsupported).toMatch(/stopped before writing anything/i);
    expect(unsupported).toMatch(/Nothing is broken/i);
    expect(unsupported).not.toMatch(/did not start/i);

    const busy = backupFailureHint('snapshot-busy');
    expect(busy).toMatch(/stopped before writing anything/i);
    expect(busy).toMatch(/try again/i);
  });
});
