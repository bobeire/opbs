import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { windowsPowerShellEnv } from '../../src/main/utils/powershell-env';

const CORE_MODULES =
  'c:\\program files\\windowsapps\\microsoft.powershell_7.7.0.0_x64__8wekyb3d8bbwe\\Modules';

describe('windowsPowerShellEnv', () => {
  it('drops PowerShell 7 module roots and keeps the 5.1 ones', () => {
    const env = windowsPowerShellEnv({
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\test',
      PSModulePath: [CORE_MODULES, 'C:\\Program Files\\WindowsPowerShell\\Modules'].join(';')
    });
    const roots = String(env.PSModulePath).split(';');
    expect(roots).toEqual([
      path.join('C:\\Users\\test', 'Documents', 'WindowsPowerShell', 'Modules'),
      path.join('C:\\Program Files', 'WindowsPowerShell', 'Modules'),
      path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    ]);
    expect(String(env.PSModulePath).toLowerCase()).not.toContain('microsoft.powershell_');
  });

  it('overwrites a duplicate uppercase PSMODULEPATH', () => {
    const env = windowsPowerShellEnv({
      SystemRoot: 'C:\\Windows',
      PSModulePath: 'C:\\lower',
      PSMODULEPATH: CORE_MODULES
    });
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PSMODULEPATH');
    expect(keys).toEqual(['PSModulePath']);
    expect(String(env.PSModulePath).toLowerCase()).not.toContain('microsoft.powershell_');
  });

  it('keeps the rest of the environment', () => {
    const env = windowsPowerShellEnv({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\bin',
      OPBS_BL_RECOVERY_PW: 'secret'
    });
    expect(env.PATH).toBe('C:\\bin');
    expect(env.OPBS_BL_RECOVERY_PW).toBe('secret');
  });

  it('falls back to WINDIR and omits the per-user root without USERPROFILE', () => {
    const env = windowsPowerShellEnv({ WINDIR: 'D:\\Windows' });
    const roots = String(env.PSModulePath).split(';');
    expect(roots).toEqual([
      path.join('C:\\Program Files', 'WindowsPowerShell', 'Modules'),
      path.join('D:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    ]);
  });
});
