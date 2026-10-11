import { describe, it, expect, vi } from 'vitest';
import { buildSchTasksArgs, buildUnattendedBackupConfig } from '../../src/main/utils/task-scheduler';

const mocks = vi.hoisted(() => ({
  ready: true,
  available: true
}));

vi.mock('../../src/main/utils/electron-access', () => ({
  getElectron: () => ({
    app: { isReady: () => mocks.ready },
    safeStorage: {
      isEncryptionAvailable: () => mocks.available,
      encryptString: (value: string) => Buffer.from(`C:${value}`, 'utf-8'),
      decryptString: (blob: Buffer) => {
        const text = blob.toString('utf-8');
        if (!text.startsWith('C:')) throw new Error('bad blob');
        return text.slice(2);
      }
    }
  })
}));

describe('buildUnattendedBackupConfig', () => {
  it('encrypts the passphrase at rest', () => {
    const config = buildUnattendedBackupConfig({
      sourceDiskIndex: 0,
      sourcePartitions: [2],
      destinationPath: 'D:\\bk',
      compressionLevel: 3,
      verificationEnabled: true,
      incremental: true,
      passphrase: 'hunter2'
    });

    expect(config.passphrase).toMatch(/^enc:v1:/);
    expect(String(config.passphrase)).not.toContain('hunter2');
    // Everything the CLI needs stays readable.
    expect(config.destinationPath).toBe('D:\\bk');
    expect(config.incremental).toBe(true);
  });

  it('omits the passphrase when the schedule has none', () => {
    const config = buildUnattendedBackupConfig({
      sourceDiskIndex: 0,
      sourcePartitions: [2],
      destinationPath: 'D:\\bk',
      compressionLevel: 3,
      verificationEnabled: true,
      incremental: false
    });
    expect(config).not.toHaveProperty('passphrase');
  });

  it('falls back to plaintext when the OS secret store is unavailable', () => {
    mocks.available = false;
    const config = buildUnattendedBackupConfig({
      sourceDiskIndex: 0,
      sourcePartitions: [2],
      destinationPath: 'D:\\bk',
      compressionLevel: 3,
      verificationEnabled: true,
      incremental: false,
      passphrase: 'plainpw'
    });
    expect(config.passphrase).toBe('plainpw');
    mocks.available = true;
  });
});

describe('buildSchTasksArgs', () => {
  it('creates a daily task at a default time with /RL HIGHEST', () => {
    const args = buildSchTasksArgs('OPBS verify', '"C:\\prog.exe" --cli verify --dir "D:\\bk"');
    expect(args).toEqual([
      '/Create',
      '/TN',
      'OPBS verify',
      '/TR',
      '"\"C:\\prog.exe\" --cli verify --dir \"D:\\bk\""',
      '/F',
      '/SC',
      'DAILY',
      '/ST',
      '02:00',
      '/RL',
      'HIGHEST'
    ]);
  });

  it('honors an explicit time and asSystem', () => {
    const args = buildSchTasksArgs('OPBS backup', '"exe" --cli backup c.json --elevated', {
      time: '03:30',
      asSystem: true
    });
    expect(args).toContain('/SC');
    expect(args).toContain('DAILY');
    expect(args).toContain('/ST');
    expect(args).toContain('03:30');
    expect(args).toContain('/RU');
    expect(args).toContain('SYSTEM');
    expect(args).not.toContain('/RL');
  });

  it('creates an on-login task when requested', () => {
    const args = buildSchTasksArgs('OPBS verify', '"exe" --cli verify --dir D:\\bk', {
      onLogin: true
    });
    expect(args).toContain('/SC');
    expect(args).toContain('ONLOGON');
    expect(args).not.toContain('/ST');
  });

  it('omits /F when overwrite is explicitly disabled', () => {
    const args = buildSchTasksArgs('task', 'cmd', { overwrite: false });
    expect(args).not.toContain('/F');
  });
});