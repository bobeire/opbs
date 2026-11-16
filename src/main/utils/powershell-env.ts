import * as path from 'path';

/**
 * Environment for a Windows PowerShell 5.1 child process.
 *
 * PowerShell 7 publishes its own module directory on PSModulePath. A 5.1 child
 * that inherits that value resolves cmdlets such as `Get-Acl`, `New-Item`,
 * `Start-Process` and `Compress-Archive` to the Core-only copy of the module,
 * fails to load it, and reports:
 *
 *   The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security',
 *   but the module could not be loaded.
 *
 * The failure is silent in code that treats a non-zero exit as "best effort"
 * (file protection degraded to the read-only attribute), and it already broke
 * the portable-ZIP build once (`scripts/after-build.js`). Point the child at
 * 5.1's own module roots instead, whatever shell launched OPBS.
 */
export function windowsPowerShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const systemRoot = base.SystemRoot ?? base.WINDIR ?? 'C:\\Windows';
  const roots: string[] = [];
  if (base.USERPROFILE) {
    roots.push(path.join(base.USERPROFILE, 'Documents', 'WindowsPowerShell', 'Modules'));
  }
  roots.push(path.join('C:\\Program Files', 'WindowsPowerShell', 'Modules'));
  roots.push(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
  // Windows variable names are case-insensitive, but a plain object can hold
  // both `PSModulePath` and `PSMODULEPATH` (Vitest's environment exposes the
  // uppercase form). The child then sees whichever duplicate the environment
  // block resolves first, so drop every casing before setting ours.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toUpperCase() !== 'PSMODULEPATH') env[key] = value;
  }
  env.PSModulePath = roots.join(';');
  return env;
}
