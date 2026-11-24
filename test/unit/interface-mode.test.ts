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
import { normalizeInterfaceMode } from '../../src/renderer/lib/interface-mode';

describe('interface mode', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-iface-'));
    mocks.userData = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes every non-opt-in value to Advanced', () => {
    expect(normalizeInterfaceMode('standard')).toBe('standard');
    expect(normalizeInterfaceMode('advanced')).toBe('advanced');
    expect(normalizeInterfaceMode(undefined)).toBe('advanced');
    expect(normalizeInterfaceMode(null)).toBe('advanced');
    expect(normalizeInterfaceMode('STANDARD')).toBe('advanced');
    expect(normalizeInterfaceMode({ mode: 'standard' })).toBe('advanced');
  });

  it('defaults new installs to Standard', () => {
    expect(new SettingsManager().getSettings().interfaceMode).toBe('standard');
  });

  it('persists the first-run Standard default and explicit Advanced choice', () => {
    const fresh = new SettingsManager();
    expect(fresh.updateSettings({ theme: 'light' }).interfaceMode).toBe('standard');
    expect(new SettingsManager().getSettings().interfaceMode).toBe('standard');

    expect(fresh.updateSettings({ interfaceMode: 'advanced' }).interfaceMode).toBe('advanced');
    expect(new SettingsManager().getSettings().interfaceMode).toBe('advanced');
  });

  it('persists an existing Advanced choice across a reload', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ interfaceMode: 'advanced' }));
    expect(new SettingsManager().getSettings().interfaceMode).toBe('advanced');
  });

  it('persists the Standard opt-in across a reload', () => {
    const manager = new SettingsManager();
    expect(manager.updateSettings({ interfaceMode: 'standard' }).interfaceMode).toBe('standard');
    expect(new SettingsManager().getSettings().interfaceMode).toBe('standard');
  });

  it('backfills Advanced for pre-feature settings files', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }));
    const settings = new SettingsManager().getSettings();
    expect(settings.interfaceMode).toBe('advanced');
    expect(settings.theme).toBe('light');
  });

  it('falls back to Advanced for a damaged settings file', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    expect(new SettingsManager().getSettings().interfaceMode).toBe('advanced');
  });

  it('repairs malformed persisted and partial-update values', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ interfaceMode: ' Standard ' }));
    const manager = new SettingsManager();
    expect(manager.getSettings().interfaceMode).toBe('advanced');

    expect(manager.updateSettings({ interfaceMode: 'oops' as never }).interfaceMode).toBe('advanced');
    expect(new SettingsManager().getSettings().interfaceMode).toBe('advanced');

    manager.updateSettings({ interfaceMode: 'standard' });
    expect(manager.updateSettings({ interfaceMode: null as never }).interfaceMode).toBe('advanced');
  });

  it('keeps the current mode when an unrelated setting is saved', () => {
    const manager = new SettingsManager();
    manager.updateSettings({ interfaceMode: 'standard' });
    expect(manager.updateSettings({ theme: 'light' }).interfaceMode).toBe('standard');
    expect(new SettingsManager().getSettings().interfaceMode).toBe('standard');
  });
});
