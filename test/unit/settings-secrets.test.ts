import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  userData: '',
  ready: true,
  available: true
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    isReady: () => mocks.ready,
    getVersion: () => '0.0.0-test',
    getName: () => 'opbs'
  }
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

import { SettingsManager, ScheduledBackup, BackupProfile } from '../../src/main/utils/settings-manager';

const backup = (passphrase: string): ScheduledBackup => ({
  id: '1',
  name: 'Nightly',
  cronExpression: '0 2 * * *',
  sourceDiskIndex: 0,
  sourcePartitions: [2],
  destinationPath: 'D:\\bk',
  compressionLevel: 3,
  verificationEnabled: true,
  incremental: false,
  passphrase,
  enabled: true
});

const profile = (passphrase: string): BackupProfile => ({
  id: '9',
  name: 'Enc profile',
  sourceDiskIndex: 0,
  sourcePartitions: [2],
  destinationPath: 'D:\\bk',
  compressionLevel: 3,
  verificationEnabled: true,
  incremental: false,
  passphrase
});

const readDisk = (dir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));

describe('SettingsManager secret encryption at rest', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-settings-'));
    mocks.userData = dir;
    mocks.ready = true;
    mocks.available = true;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('encrypts schedule/profile passphrases and cloud credentials on disk', () => {
    const manager = new SettingsManager();
    manager.updateSettings({
      scheduledBackups: [backup('hunter2')],
      backupProfiles: [profile('profilepw')],
      cloud: {
        ...manager.getSettings().cloud,
        s3: { ...manager.getSettings().cloud.s3, secretAccessKey: 'AKIAsecret' },
        sftp: { ...manager.getSettings().cloud.sftp, password: 'sftppw', privateKey: '-----BEGIN KEY-----' },
        ftp: { ...manager.getSettings().cloud.ftp, password: 'ftppw' }
      }
    });

    const raw = readDisk(dir);
    const schedules = (raw as { scheduledBackups: { passphrase?: string }[] }).scheduledBackups;
    const profiles = (raw as { backupProfiles: { passphrase?: string }[] }).backupProfiles;
    const cloud = (raw as { cloud: Record<string, Record<string, string>> }).cloud;

    expect(schedules[0].passphrase).toMatch(/^enc:v1:/);
    expect(profiles[0].passphrase).toMatch(/^enc:v1:/);
    expect(cloud.s3.secretAccessKey).toMatch(/^enc:v1:/);
    expect(cloud.sftp.password).toMatch(/^enc:v1:/);
    expect(cloud.sftp.privateKey).toMatch(/^enc:v1:/);
    expect(cloud.ftp.password).toMatch(/^enc:v1:/);

    const text = JSON.stringify(raw);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('profilepw');
    expect(text).not.toContain('AKIAsecret');
    expect(text).not.toContain('sftppw');
    expect(text).not.toContain('ftppw');

    // Non-secret fields stay readable.
    expect((raw as { scheduledBackups: { destinationPath: string }[] }).scheduledBackups[0].destinationPath).toBe('D:\\bk');
  });

  it('serves plaintext to consumers and survives a reload round-trip', () => {
    const manager = new SettingsManager();
    manager.updateSettings({ scheduledBackups: [backup('hunter2')] });

    expect(manager.getSettings().scheduledBackups[0].passphrase).toBe('hunter2');

    const reloaded = new SettingsManager();
    expect(reloaded.getSettings().scheduledBackups[0].passphrase).toBe('hunter2');
  });

  it('migrates a legacy plaintext file to encrypted on first read', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        scheduledBackups: [backup('legacyplain')],
        backupProfiles: [profile('legacyprofile')]
      }),
      'utf-8'
    );

    const manager = new SettingsManager();
    // In-memory plaintext…
    expect(manager.getSettings().scheduledBackups[0].passphrase).toBe('legacyplain');
    expect(manager.getSettings().backupProfiles[0].passphrase).toBe('legacyprofile');

    // …and the file was rewritten encrypted (hydrate triggers one save).
    const raw = readDisk(dir);
    expect((raw as { scheduledBackups: { passphrase?: string }[] }).scheduledBackups[0].passphrase).toMatch(/^enc:v1:/);
    expect((raw as { backupProfiles: { passphrase?: string }[] }).backupProfiles[0].passphrase).toMatch(/^enc:v1:/);
    expect(JSON.stringify(raw)).not.toContain('legacyplain');
    expect(JSON.stringify(raw)).not.toContain('legacyprofile');
  });

  it('keeps plaintext on disk when the OS secret store is unavailable', () => {
    mocks.available = false;
    const manager = new SettingsManager();
    manager.updateSettings({ scheduledBackups: [backup('plainpw')] });

    const raw = readDisk(dir);
    expect((raw as { scheduledBackups: { passphrase?: string }[] }).scheduledBackups[0].passphrase).toBe('plainpw');
  });
});
