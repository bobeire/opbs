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

/**
 * Build the outer wrapper command: elevate the script with one UAC prompt and
 * report the script's exit code.
 *
 * Do NOT add -RedirectStandardOutput/-RedirectStandardError here: in Windows
 * PowerShell those belong to a different parameter set than -Verb, so binding
 * fails with `AmbiguousParameterSet`, Start-Process returns $null, and
 * elevation never even prompts (observed as "exit 5, no UAC"). Elevated
 * scripts capture their own output instead (Start-Transcript at the top of
 * each script).
 *
 * Do NOT use `Start-Process -Wait` here: with `-Verb RunAs` it can wait on a
 * handle that never signals (observed live: the elevated child exits and
 * writes its result.json, but the wrapper sits in -Wait forever, leaving the
 * caller awaiting `close` indefinitely — the UI showed no progress while the
 * build had actually finished). Polling the child's PID against the process
 * table is immune to bad handles.
 *
 * Exit codes: 5 = the elevation itself failed (prompt declined or never
 * appeared); 3 = the child exited without producing a result; anything else =
 * the inner script's own exit code when it can still be read.
 */
export function buildElevatedWrapper(powershell: string, scriptPath: string): string {
  const innerArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
    .map(psQuote)
    .join(', ');
  return (
    `$p = Start-Process -FilePath ${psQuote(powershell)} -ArgumentList @(${innerArgs})` +
    ` -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { exit 5 }; ` +
    `$opbsChild = $p.Id; ` +
    `while (Get-Process -Id $opbsChild -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }; ` +
    `$opbsCode = 3; try { if ($p.HasExited) { $opbsCode = $p.ExitCode } } catch { $opbsCode = 3 }; ` +
    `exit $opbsCode`
  );
}

/**
 * Run an elevated script and report its exit code.
 *
 * `env` is merged into this process' environment before spawning: the UAC
 * child inherits the requester's environment, so secrets can travel to the
 * elevated script in an environment variable — never in the script file and
 * never on a command line (used by the BitLocker unlock flow).
 */
export function runElevatedPowerShell(scriptPath: string, env?: Record<string, string>): Promise<number> {
  const powershell = resolvePowershell();
  return new Promise((resolve, reject) => {
    const wrapper = buildElevatedWrapper(powershell, scriptPath);
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', wrapper], {
      windowsHide: true,
      stdio: 'ignore',
      env: env ? { ...process.env, ...env } : undefined
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
}