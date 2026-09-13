import { describe, it, expect } from 'vitest';
import { buildWinFspInstallScript, chooseWinFspMsi } from '../../src/main/utils/winfsp-install';

describe('buildWinFspInstallScript', () => {
  it('runs msiexec with /i, /qn and /norestart for the given MSI', () => {
    const script = buildWinFspInstallScript('C:\\Users\\me\\Downloads\\WinFsp.msi');
    expect(script).toContain("$msi = 'C:\\Users\\me\\Downloads\\WinFsp.msi'");
    expect(script).toContain("Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart')");
    expect(script).toContain('exit $p.ExitCode');
  });

  it('doubles single quotes in MSI paths containing apostrophes', () => {
    const script = buildWinFspInstallScript("C:\\It's a dir\\WinFsp.msi");
    expect(script).toContain("$msi = 'C:\\It''s a dir\\WinFsp.msi'");
  });
});

describe('chooseWinFspMsi', () => {
  const assets = [
    'winfsp-2.0.23075.exe',
    'winfsp-2.0.23075.msi',
    'winfsp-2.0.23075-x64.msi',
    'winfsp-2.0.23075-arm64.msi'
  ];

  it('prefers the arch-specific x64 MSI for amd64', () => {
    expect(chooseWinFspMsi(assets, 'amd64')).toBe('winfsp-2.0.23075-x64.msi');
  });

  it('prefers the arch-specific arm64 MSI for arm64', () => {
    expect(chooseWinFspMsi(assets, 'arm64')).toBe('winfsp-2.0.23075-arm64.msi');
  });

  it('falls back to a platform-neutral MSI when no arch-specific one exists', () => {
    expect(chooseWinFspMsi(['winfsp-2.0.23075.exe', 'winfsp-2.0.23075.msi'], 'amd64')).toBe(
      'winfsp-2.0.23075.msi'
    );
  });

  it('ignores non-MSI assets', () => {
    expect(chooseWinFspMsi(['winfsp-2.0.23075.exe'], 'amd64')).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(chooseWinFspMsi([], 'amd64')).toBeNull();
  });
});