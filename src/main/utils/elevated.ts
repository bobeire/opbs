import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Shared helpers for spawning an elevated PowerShell session (one UAC
 * confirmation) that runs a script file, then reports the script's exit code.
 * Used by the WinPE media builder, the ADK installer, and the WinFsp installer.
 */

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Resolve the full path to Windows PowerShell. Spawning `powershell.exe` by
 * bare name fails with ENOENT when the environment's PATH does not include
 * System32 (e.g. a process launched from a Git Bash / msys2 shell), which
 * silently broke elevated jobs. system32 is the standard location on modern
 * Windows; fall back to the bare name if it is somehow missing.
 */
export function resolvePowershell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const full = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

export function runElevatedPowerShell(scriptPath: string): Promise<number> {
  const powershell = resolvePowershell();
  return new Promise((resolve, reject) => {
    const wrapper =
      `$p = Start-Process -FilePath ${psQuote(powershell)} -ArgumentList @(${[
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath
      ]
        .map(psQuote)
        .join(', ')}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $p) { exit 5 }; exit $p.ExitCode`;
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', wrapper], {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
}