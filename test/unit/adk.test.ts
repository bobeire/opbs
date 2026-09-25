import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { locateAdk } from '../../src/main/utils/adk';

describe('locateAdk (WinPE-SecureStartup resolution)', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adk-'));
    const pe = path.join(root, 'Windows Preinstallation Environment');
    fs.mkdirSync(pe, { recursive: true });
    fs.writeFileSync(path.join(pe, 'copype.cmd'), '');
    fs.writeFileSync(path.join(pe, 'MakeWinPEMedia.cmd'), '');
    fs.mkdirSync(path.join(root, 'Deployment Tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Deployment Tools', 'DandISetEnv.bat'), '');
    fs.mkdirSync(path.join(pe, 'amd64', 'WinPE_OCs'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves winpeSecureStartupCab when the OC cab is present', () => {
    const cab = path.join(root, 'Windows Preinstallation Environment', 'amd64', 'WinPE_OCs', 'WinPE-SecureStartup.cab');
    fs.writeFileSync(cab, '');
    const adk = locateAdk('amd64', root);
    expect(adk).not.toBeNull();
    expect(adk?.winpeSecureStartupCab).toBe(cab);
  });

  it('leaves winpeSecureStartupCab undefined when the OC cab is absent', () => {
    const cab = path.join(root, 'Windows Preinstallation Environment', 'amd64', 'WinPE_OCs', 'WinPE-SecureStartup.cab');
    fs.rmSync(cab, { force: true });
    const adk = locateAdk('amd64', root);
    expect(adk).not.toBeNull();
    expect(adk?.winpeSecureStartupCab).toBeUndefined();
  });
});
