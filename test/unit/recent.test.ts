import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mock = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mock.userData : '')
  }
}));

describe('recent backup destinations', () => {
  beforeEach(() => {
    mock.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-recent-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(mock.userData, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('records a destination and lists it most-recent-first', async () => {
    const { recordBackupDestination, getRecentDestinations } = await import('../../src/main/utils/recent');
    recordBackupDestination('D:\\OPBS');
    recordBackupDestination('C:\\backups');
    const list = getRecentDestinations();
    expect(list).toEqual(['C:\\backups', 'D:\\OPBS']);
  });

  it('deduplicates destinations case-insensitively', async () => {
    const { recordBackupDestination, getRecentDestinations } = await import('../../src/main/utils/recent');
    recordBackupDestination('d:\\opbs');
    recordBackupDestination('D:\\OPBS');
    expect(getRecentDestinations()).toEqual(['D:\\OPBS']);
  });

  it('ignores cloud-only (S3/SFTP) destinations', async () => {
    const { recordBackupDestination, getRecentDestinations } = await import('../../src/main/utils/recent');
    recordBackupDestination('s3://bucket/prefix');
    recordBackupDestination('\\\\server\\share');
    expect(getRecentDestinations()).toEqual(['\\\\server\\share']);
  });

  it('addRecentDestination returns the updated list', async () => {
    const { addRecentDestination, getRecentDestinations } = await import('../../src/main/utils/recent');
    const list = addRecentDestination('E:\\images');
    expect(list).toContain('E:\\images');
    expect(getRecentDestinations()).toEqual(['E:\\images']);
  });

  it('recording an unreachable UNC path still tracks it', async () => {
    const { recordBackupDestination, getRecentDestinations } = await import('../../src/main/utils/recent');
    recordBackupDestination('\\\\nohost\\share');
    expect(getRecentDestinations()).toContain('\\\\nohost\\share');
  });
});