import { describe, it, expect } from 'vitest';
import { pickDrillImage, BackupImageEntry } from '../../src/main/backup/retention';

const entry = (overrides: Partial<BackupImageEntry>): BackupImageEntry => ({
  path: 'D:\\bk\\image.opbs',
  name: 'image.opbs',
  timestamp: 1000,
  size: 1024,
  incremental: false,
  encrypted: false,
  verified: true,
  ...overrides
});

describe('pickDrillImage', () => {
  it('picks the newest image when none are encrypted', () => {
    const older = entry({ path: 'D:\\bk\\1.opbs', name: '1.opbs', timestamp: 1000 });
    const newer = entry({ path: 'D:\\bk\\2.opbs', name: '2.opbs', timestamp: 2000 });
    expect(pickDrillImage([older, newer])?.path).toBe('D:\\bk\\2.opbs');
  });

  it('skips encrypted images when no passphrase is configured', () => {
    const encrypted = entry({ path: 'D:\\bk\\enc.opbs', timestamp: 3000, encrypted: true });
    const plain = entry({ path: 'D:\\bk\\plain.opbs', timestamp: 1000 });
    expect(pickDrillImage([encrypted, plain])?.path).toBe('D:\\bk\\plain.opbs');
  });

  it('drills encrypted images when a passphrase is available', () => {
    const encrypted = entry({ path: 'D:\\bk\\enc.opbs', timestamp: 3000, encrypted: true });
    const plain = entry({ path: 'D:\\bk\\plain.opbs', timestamp: 1000 });
    expect(pickDrillImage([encrypted, plain], 'hunter2')?.path).toBe('D:\\bk\\enc.opbs');
  });

  it('treats an empty passphrase as absent', () => {
    const encrypted = entry({ path: 'D:\\bk\\enc.opbs', encrypted: true });
    expect(pickDrillImage([encrypted], '')).toBeUndefined();
  });

  it('returns undefined when only encrypted images exist without a passphrase', () => {
    const encrypted = entry({ path: 'D:\\bk\\enc.opbs', timestamp: 3000, encrypted: true });
    expect(pickDrillImage([encrypted])).toBeUndefined();
    expect(pickDrillImage([])).toBeUndefined();
  });
});
