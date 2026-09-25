import { execFileSync } from 'child_process';
import * as path from 'path';
import { psQuote } from './elevated';
import { runElevated } from './disk-tools';
import {
  BITLOCKER_STATUS_PS,
  isRecoveryProtectorType,
  isWinPE,
  invalidateBitlockerCache,
  parseBitlockerJson,
  parseManageBdeStatus,
  setBitlockerCache,
  BitlockerVolumeStatus
} from './bitlocker';
import { logger } from './logger';

/**
 * Unlock a BitLocker-locked volume with a 48-digit recovery password
 * (Phase 1 supports exactly this one unlock route).
 *
 * Password custody rules, enforced by tests:
 *   - Windows: the password travels ONLY in an environment variable
 *     (`OPBS_BL_RECOVERY_PW`) that the elevated PowerShell child inherits.
 *     It never appears in the script file, on any command line, in logs, or
 *     in progress/state files.
 *   - WinPE: always admin already, so `manage-bde -unlock` runs directly;
 *     the password is in that one child's argv, inside a single-user
 *     RAM-only recovery environment (spec-approved Phase 1 tradeoff).
 *
 * A successful Windows unlock also re-reads BitLocker status inside the same
 * elevation, so the caller can refresh its cache without a second UAC prompt.
 */

export const UNLOCK_OK_MARKER = 'OPBS_UNLOCK_OK';
const ENV_PASSWORD = 'OPBS_BL_RECOVERY_PW';

export type BitlockerUnlockResult =
  | {
      ok: true;
      letter: string;
      source: 'windows' | 'winpe';
      /** Fresh volume status fetched in the same elevation (Windows) or via
       *  manage-bde (WinPE); null when the refresh itself failed. */
      volumes: BitlockerVolumeStatus[] | null;
    }
  | { ok: false; letter: string; source: 'windows' | 'winpe'; error: string };

/**
 * Validate + canonicalise a recovery password: 48 digits in 8 groups of 6,
 * no all-zero group (Microsoft reserves `000000`), joined with dashes.
 * Accepts dashed, space-separated or contiguous input. Anything else —
 * including injection attempts — is rejected before it can reach a process.
 */
export function validateRecoveryPassword(
  raw: string
): { ok: true; normalized: string } | { ok: false; error: string } {
  const stripped = String(raw ?? '').trim();
  if (!stripped) {
    return { ok: false, error: 'Enter the 48-digit BitLocker recovery password.' };
  }
  const digits = stripped.replace(/[-\s]/g, '');
  if (!/^\d{48}$/.test(digits)) {
    return {
      ok: false,
      error: 'A BitLocker recovery password is 48 digits (8 groups of 6, e.g. 123456-234567-...).'
    };
  }
  const groups = digits.match(/\d{6}/g)!;
  if (groups.some((g) => g === '000000')) {
    return { ok: false, error: 'Invalid recovery password: group "000000" is never valid.' };
  }
  return { ok: true, normalized: groups.join('-') };
}

/**
 * The elevated Windows unlock script. Takes no password literal — it reads
 * the inherited environment — then prints the success marker followed by the
 * standard status projection, so one UAC covers unlock + refresh.
 */
export function buildWindowsUnlockScript(letter: string): string {
  const mount = psQuote(`${letter.toUpperCase()}:`);
  const preamble = [
    `$ErrorActionPreference = 'Stop'`,
    `$pw = $env:${ENV_PASSWORD}`,
    `if (-not $pw) { throw 'Recovery password missing from environment.' }`,
    `Unlock-BitLocker -MountPoint ${mount} -RecoveryPassword $pw`,
    `$after = Get-BitLockerVolume -MountPoint ${mount}`,
    `if ([int]$after.LockStatus -eq 1) { throw 'Volume ${letter.toUpperCase()}: is still locked.' }`,
    `Write-Output '${UNLOCK_OK_MARKER}'`
  ];
  return preamble.join('\r\n') + '\r\n' + BITLOCKER_STATUS_PS;
}

/**
 * Split an elevated unlock script's captured stdout into the success marker
 * and the fresh status JSON that follows it.
 */
export function parseUnlockOutput(raw: string): { ok: boolean; volumes: BitlockerVolumeStatus[] | null } {
  const text = String(raw ?? '');
  const idx = text.indexOf(UNLOCK_OK_MARKER);
  if (idx < 0) return { ok: false, volumes: null };
  const rest = text.slice(idx + UNLOCK_OK_MARKER.length);
  const jsonStart = rest.indexOf('[');
  if (jsonStart < 0) return { ok: true, volumes: null };
  return { ok: true, volumes: parseBitlockerJson(rest.slice(jsonStart)) };
}

function unlockWinPE(letter: string, normalized: string): BitlockerUnlockResult {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'manage-bde.exe');
  try {
    execFileSync(exe, ['-unlock', `${letter}:`, '-recoverypassword', normalized], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = String(e.stderr ?? '').trim() || String(e.message ?? '').split('\n')[0];
    return { ok: false, letter, source: 'winpe', error: detail || 'manage-bde -unlock failed.' };
  }
  try {
    const status = execFileSync(exe, ['-status', `${letter}:`], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const volumes = parseManageBdeStatus(String(status));
    const self = volumes?.find((v) => v.letter === letter.toUpperCase());
    if (self?.locked) {
      return { ok: false, letter, source: 'winpe', error: `Volume ${letter}: is still locked.` };
    }
    invalidateBitlockerCache();
    if (volumes) setBitlockerCache(volumes, 'manage-bde');
    return { ok: true, letter, source: 'winpe', volumes: volumes ?? null };
  } catch {
    // Unlock succeeded but the status re-read failed — report success anyway.
    invalidateBitlockerCache();
    return { ok: true, letter, source: 'winpe', volumes: null };
  }
}

async function unlockWindows(letter: string, normalized: string): Promise<BitlockerUnlockResult> {
  try {
    const result = await runElevated(buildWindowsUnlockScript(letter), { [ENV_PASSWORD]: normalized });
    const parsed = parseUnlockOutput(result.stdout);
    if (parsed.ok) {
      invalidateBitlockerCache();
      if (parsed.volumes) setBitlockerCache(parsed.volumes);
      return { ok: true, letter, source: 'windows', volumes: parsed.volumes };
    }
    const stderr = String(result.stderr ?? '').trim();
    const stdout = String(result.stdout ?? '').trim();
    let error =
      stderr ||
      stdout.slice(-600) ||
      'The unlock script failed before confirming the volume was unlocked.';
    if (result.exitCode === 5) {
      error = 'Administrator approval was declined or never appeared.';
    }
    return { ok: false, letter, source: 'windows', error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, letter, source: 'windows', error: message };
  }
}

/**
 * Unlock `letter` with `recoveryPassword`. Never throws; never logs the
 * password; updates the status cache on success.
 */
export async function unlockVolume(
  letter: string,
  recoveryPassword: string
): Promise<BitlockerUnlockResult> {
  const trimmedLetter = String(letter ?? '').trim().replace(/:$/, '').toUpperCase();
  if (!/^[A-Z]$/.test(trimmedLetter)) {
    return { ok: false, letter: String(letter ?? ''), source: 'windows', error: 'Invalid drive letter.' };
  }
  const password = validateRecoveryPassword(recoveryPassword);
  if (!password.ok) {
    return { ok: false, letter: trimmedLetter, source: 'windows', error: password.error };
  }

  const winpe = isWinPE();
  logger.info(`Unlock requested for ${trimmedLetter}: (${winpe ? 'WinPE' : 'Windows'} path)`);
  const result = winpe
    ? unlockWinPE(trimmedLetter, password.normalized)
    : await unlockWindows(trimmedLetter, password.normalized);
  logger.info(
    `Unlock ${result.ok ? 'succeeded' : 'failed'} for ${trimmedLetter}:` +
      (result.ok ? '' : ` ${result.error}`)
  );
  return result;
}

/** True when the protector list contains a recovery-password protector. */
export function volumesHaveRecoveryProtector(volumes: BitlockerVolumeStatus[]): boolean {
  return volumes.some((v) => v.protectors.some((p) => isRecoveryProtectorType(p.type)));
}
