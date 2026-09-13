import { spawn } from 'child_process';
import * as path from 'path';

/**
 * Shared helpers for spawning an elevated PowerShell session (one UAC
 * confirmation) that runs a script file, then reports the script's exit code.
 * Used by the WinPE media builder, the ADK installer, and the WinFsp installer.
 */

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function runElevatedPowerShell(scriptPath: string): Promise<number> {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
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