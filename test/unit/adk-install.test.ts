import { describe, it, expect } from 'vitest';
import { buildAdkInstallScript } from '../../src/main/utils/adk-install';

const plan = (overrides: Partial<{ adkSetup: string; adkWinPe: string; installPath: string; resultPath: string }> = {}) => ({
  adkSetup: 'C:\\temp\\adksetup.exe',
  adkWinPe: 'C:\\temp\\adkwinpesetup.exe',
  resultPath: 'C:\\temp\\result.json',
  installPath: undefined as string | undefined,
  ...overrides
});

describe('buildAdkInstallScript', () => {
  it('runs both ADK features silently with /features + /quiet + /norestart + /ceip off', () => {
    const script = buildAdkInstallScript(plan());
    expect(script).toContain("'OptionId.DeploymentTools'");
    expect(script).toContain("'OptionId.WindowsPreinstallationEnvironment'");
    expect(script).toContain("'/quiet'");
    expect(script).toContain("'/norestart'");
    expect(script).toContain("'/ceip'");
    expect(script).toContain("'off'");
  });

  it('references both bootstrap executables by their full paths', () => {
    const script = buildAdkInstallScript(plan());
    expect(script).toContain("'C:\\temp\\adksetup.exe'");
    expect(script).toContain("'C:\\temp\\adkwinpesetup.exe'");
  });

  it('tracks per-step exit codes and writes the combined result to resultPath', () => {
    const script = buildAdkInstallScript(plan());
    expect(script).toContain('$script:steps += [pscustomobject]@{ name = $Name; exitCode = $p.ExitCode }');
    expect(script).toContain("'C:\\temp\\result.json'");
    expect(script).toContain('ConvertTo-Json');
    expect(script).toContain('if ($code1 -ne 0 -or $code2 -ne 0) { $overall = 1 }');
  });

  it('adds /installpath after the feature flags when one is provided', () => {
    const script = buildAdkInstallScript(plan({ installPath: 'C:\\Kits\\ADK' }));
    expect(script).toContain("'/installpath'");
    expect(script).toContain("'C:\\Kits\\ADK'");
    expect(script.indexOf('/installpath')).toBeGreaterThan(script.indexOf('OptionId.DeploymentTools'));
  });

  it('drops /installpath when the path is empty', () => {
    const script = buildAdkInstallScript(plan({ installPath: '' }));
    expect(script).not.toContain("'/installpath'");
  });

  it('doubles single quotes when a path contains an apostrophe', () => {
    const script = buildAdkInstallScript(plan({ installPath: "C:\\It's a path" }));
    expect(script).toContain("'C:\\It''s a path'");
  });
});