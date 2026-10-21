import { spawnSync } from 'child_process';
import * as path from 'path';
import { resolvePowershell } from '../../utils/elevated';
import type { MigrateOwnerRewrite } from './types';

/**
 * Identity primitives for the phase-2 tiers: elevation detection, profile
 * SID resolution (owner rewrite) and the owner/SID rewrite itself. All
 * process spawns sit behind injectable runners so tests never touch the
 * live registry, `whoami` or `icacls`.
 */

export type CmdRun = (cmd: string, args: string[]) => { status: number | null; stdout?: string; error?: string };
export type RegArgRun = (args: string[]) => { status: number | null; stdout?: string; error?: string };

const execCmd: CmdRun = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? '', ...(res.error ? { error: res.error.message } : {}) };
};

function exePath(name: string): string {
  const windir = process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows';
  const full = path.join(windir, 'System32', name);
  return full;
}

function normalized(p: string): string {
  return path.resolve(p).replace(/\\+$/, '').toLowerCase();
}

/**
 * True when this process holds administrator rights. The PowerShell
 * principal check is authoritative (unlike `net session`, which also fails
 * on systems with the Server service disabled). Non-Windows always false.
 */
export function isElevatedSync(run: CmdRun = execCmd): boolean {
  if (process.platform !== 'win32') return false;
  const script =
    '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
  try {
    const res = run(resolvePowershell(), ['-NoProfile', '-NonInteractive', '-Command', script]);
    return (res.stdout ?? '').trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/** SID of the account this process runs as, via `whoami /user` CSV output. */
export function currentProcessSid(run: CmdRun = execCmd): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const res = run(path.join(process.env.windir ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const match = /"(S-1-\d+(?:-\d+)+)"/i.exec(res.stdout ?? '');
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function expandProfileImagePath(value: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const systemDrive = process.env.SystemDrive ?? 'C:';
  return value
    .replace(/%systemroot%/gi, systemRoot)
    .replace(/%windir%/gi, systemRoot)
    .replace(/%systemdrive%/gi, systemDrive)
    .replace(/%userprofile%/gi, process.env.USERPROFILE ?? '~');
}

/** First `reg query` value text for `<key> /v <name>` (REG_SZ/REG_EXPAND_SZ aware). */
function queryRegValue(run: RegArgRun, key: string, name: string): string | null {
  const res = run(['query', key, '/v', name]);
  if (res.status !== 0) return null;
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('HKEY_')) continue;
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 3 && parts[0].toLowerCase() === name.toLowerCase()) return parts.slice(2).join('  ');
    if (parts.length >= 2 && parts[0].toLowerCase() === name.toLowerCase()) return '';
  }
  return null;
}

const execReg: RegArgRun = (args) => execCmd(exePath('reg.exe'), args);

/**
 * Resolve a Windows profile directory to its SID via the live
 * `ProfileList` key (unelevated read). Returns null when the directory is
 * not a registered profile (temp dirs, foreign volumes).
 */
export function resolveProfileSid(profileDir: string, run: RegArgRun = execReg): string | null {
  if (process.platform !== 'win32') return null;
  const listKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList';
  const res = run(['query', listKey]);
  if (res.status !== 0) return null;
  const target = normalized(profileDir);
  const sids: string[] = [];
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    if (!line.startsWith('HKEY_')) continue;
    const sidMatch = /(S-1-\d+(?:-\d+)+)\s*$/i.exec(line.trim());
    if (sidMatch) sids.push(sidMatch[1]);
  }
  for (const sid of sids) {
    const value = queryRegValue(run, `${listKey}\\${sid}`, 'ProfileImagePath');
    if (value && normalized(expandProfileImagePath(value)) === target) return sid;
  }
  return null;
}

/** The injectable identity surface the migrate executor uses. */
export interface IdentityOps {
  elevated(): boolean;
  currentSid(): string | null;
  sidForProfileDir(dir: string): string | null;
}

export const realIdentity: IdentityOps = {
  elevated: () => isElevatedSync(),
  currentSid: () => currentProcessSid(),
  sidForProfileDir: (dir: string): string | null => {
    const userprofile = process.env.USERPROFILE;
    if (userprofile && normalized(dir) === normalized(userprofile)) return currentProcessSid();
    return resolveProfileSid(dir);
  }
};

export type IcaclsRun = (args: string[]) => { status: number | null; stdout?: string; error?: string };

const execIcacls: IcaclsRun = (args) => {
  const res = spawnSync(path.join(process.env.windir ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, { encoding: 'utf8', windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? '', ...(res.error ? { error: res.error.message } : {}) };
};

/**
 * Set the owner of the copied tree to the target profile's SID
 * (MIGRATE.md §9): files are created by the migrating account, so on the
 * default SID-mismatch case ownership must be rewritten. Rights themselves
 * come from ACL inheritance at the target profile root — only the owner
 * needs fixing. One `icacls /setowner /T` per copied folder root.
 */
export function rewriteCopiedOwner(destRoots: string[], sid: string, run: IcaclsRun = execIcacls): MigrateOwnerRewrite {
  if (destRoots.length === 0) {
    return { status: 'not-needed', roots: 0, detail: 'no copied folder roots to rewrite' };
  }
  const failed: string[] = [];
  for (const root of destRoots) {
    try {
      const res = run([root, '/setowner', sid, '/T', '/C', '/Q']);
      if (res.status !== 0) failed.push(`${root} (${res.error ?? `exit ${res.status ?? 'unknown'}`})`);
    } catch (error) {
      failed.push(`${root} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (failed.length === 0) return { status: 'ok', sid, roots: destRoots.length };
  const detail = failed.join('; ');
  if (failed.length === destRoots.length) return { status: 'failed', sid, roots: destRoots.length, detail };
  return { status: 'partial', sid, roots: destRoots.length, detail };
}
