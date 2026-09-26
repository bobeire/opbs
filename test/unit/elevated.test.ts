import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resolvePowershell, buildElevatedWrapper, psQuote } from '../../src/main/utils/elevated';

describe('buildElevatedWrapper', () => {
  it('elevates the script and reports its exit code', () => {
    const script = 'C:\\Users\\rober\\AppData\\Local\\Temp\\opbs-winpe-AbC123\\build.ps1';
    const wrapper = buildElevatedWrapper('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', script);
    expect(wrapper).toContain('-Verb RunAs');
    expect(wrapper).toContain(`'-File', ${psQuote(script)}`);
    expect(wrapper).toContain('-WindowStyle Hidden');
    // Elevation failure sentinel.
    expect(wrapper).toContain('if ($null -eq $p) { exit 5 }');
    // Child exit must be observed via the process table, NOT -Wait: with
    // -Verb RunAs, Start-Process -Wait sat forever after the child exited
    // (result.json written, caller awaiting close indefinitely).
    expect(wrapper).not.toContain('-Wait');
    expect(wrapper).toContain('Get-Process -Id $opbsChild');
    expect(wrapper).toContain('exit $opbsCode');
  });

  it('never combines -Verb RunAs with -RedirectStandard* (AmbiguousParameterSet breaks elevation)', () => {
    const wrapper = buildElevatedWrapper('powershell.exe', 'C:\\work\\build.ps1');
    expect(wrapper).toContain('-Verb RunAs');
    expect(wrapper).not.toContain('-RedirectStandardOutput');
    expect(wrapper).not.toContain('-RedirectStandardError');
    expect(wrapper).not.toContain('-RedirectStandardInput');
  });
});

describe('resolvePowershell', () => {
  it('resolves to a real powershell.exe path that exists', () => {
    const pw = resolvePowershell();
    expect(pw).toBeTruthy();
    expect(fs.existsSync(pw)).toBe(true);
  });

  it('prefers the SystemRoot System32 location over WINDIR', () => {
    if (!fs.existsSync('C:\\WINDOWS')) {
      return; // non-Windows test host; covered by the fallback test
    }
    const prevSystemRoot = process.env.SystemRoot;
    const prevWindows = process.env.WINDIR;
    process.env.SystemRoot = 'C:\\WINDOWS';
    process.env.WINDIR = 'C:\\NotUsed';
    try {
      expect(resolvePowershell()).toBe(
        path.join('C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      );
    } finally {
      if (prevSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = prevSystemRoot;
      if (prevWindows === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = prevWindows;
    }
  });

  it('declines to resolve a non-existent SystemRoot, falling back to the bare name', () => {
    const prevSystemRoot = process.env.SystemRoot;
    const prevWindows = process.env.WINDIR;
    process.env.SystemRoot = 'C:\\DefinitelyNotARealDirectory12345';
    process.env.WINDIR = 'C:\\DefinitelyNotARealDirectory12345';
    try {
      expect(resolvePowershell()).toBe('powershell.exe');
    } finally {
      if (prevSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = prevSystemRoot;
      if (prevWindows === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = prevWindows;
    }
  });
});