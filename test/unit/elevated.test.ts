import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resolvePowershell } from '../../src/main/utils/elevated';

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