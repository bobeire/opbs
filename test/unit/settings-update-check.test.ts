import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    isReady: () => true,
    getVersion: () => '0.0.0-test',
    getName: () => 'opbs'
  }
}));

vi.mock('../../src/main/utils/electron-access', () => ({
  getElectron: () => ({
    app: { isReady: () => true },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value, 'utf-8'),
      decryptString: (blob: Buffer) => blob.toString('utf-8')
    }
  })
}));

import { SettingsManager } from '../../src/main/utils/settings-manager';

// The Settings → Startup "Check for updates at startup" toggle (issue #7):
// default on keeps every existing install checking exactly as before; the
// opt-out must persist and pre-toggle settings.json files must backfill on.
describe('checkForUpdatesOnStartup', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-upd-'));
    mocks.userData = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to on so existing installs keep checking', () => {
    expect(new SettingsManager().getSettings().checkForUpdatesOnStartup).toBe(true);
  });

  it('persists the opt-out across a reload', () => {
    const manager = new SettingsManager();
    expect(manager.updateSettings({ checkForUpdatesOnStartup: false }).checkForUpdatesOnStartup).toBe(false);
    expect(new SettingsManager().getSettings().checkForUpdatesOnStartup).toBe(false);
  });

  it('backfills on for settings.json files written before the toggle existed', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }));
    const settings = new SettingsManager().getSettings();
    expect(settings.checkForUpdatesOnStartup).toBe(true);
    expect(settings.theme).toBe('light');
  });
});
