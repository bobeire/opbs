import { execFileSync } from 'child_process';
import * as path from 'path';
import { resolvePowershell } from './elevated';
import { runElevated } from './disk-tools';
import { logger } from './logger';

/**
 * BitLocker status detection (Phase 1 of the native Windows driver stack).
 *
 * Reality check that shaped this module: on Windows 10/11 non-admin processes
 * cannot read BitLocker status by any route — Get-BitLockerVolume comes back
 * empty, the Win32_EncryptableVolume CIM namespace denies access, and
 * manage-bde -status is admin-only. Status therefore only works elevated (one
 * UAC prompt, triggered by an explicit user action, never automatically) or
 * inside WinPE where everything already runs as SYSTEM.
 *
 * Two live backends:
 *   - Windows: Get-BitLockerVolume serialized to JSON (elevated), parsed
 *     tolerantly because ConvertTo-Json renders PS enums as numbers.
 *   - WinPE:   manage-bde -status text, parsed line-by-line. No elevation
 *     concept exists there — the recovery environment is always admin.
 *
 * Invariant: this module NEVER reads or handles key material — only protector
 * TYPE names. Recovery password values are handled exclusively by the backup
 * helper (capture) and the unlock tool, both of which run elevated.
 */

export interface BitlockerProtector {
  /** Display name as the tool printed it: "TPM", "Numerical Password", "RecoveryPassword", ... */
  type: string;
}

export interface BitlockerVolumeStatus {
  /** Drive letter without colon, uppercase. */
  letter: string;
  /** manage-bde bracket type ("OS Volume", "Data Volume"); "" from Get-BitLockerVolume. */
  volumeType: string;
  /** True when the volume is BitLocker-locked (unreadable until unlocked). */
  locked: boolean;
  /** Protection On/Off (a.k.a. "protection enabled"). */
  protectionOn: boolean;
  /** Normalized token: FullyDecrypted, FullyEncrypted, EncryptionInProgress, ... ('' unknown). */
  conversion: string;
  protectors: BitlockerProtector[];
}

export interface BitlockerStatusResult {
  ok: boolean;
  /** Which backend produced the answer. */
  source: 'bitlocker-json' | 'bitlocker-json-elevated' | 'manage-bde' | 'cache';
  volumes: BitlockerVolumeStatus[];
  error?: string;
  /** True when the only thing missing is administrator approval. */
  needsElevation?: boolean;
}

export interface BitlockerStatusOptions {
  /** Query elevated (one UAC prompt). WinPE ignores this — it is always admin. */
  elevate?: boolean;
  /** Ignore the session cache and re-query. */
  refresh?: boolean;
}

/** Win32 KeyProtectorType enum values (ConvertTo-Json renders enums as ints). */
const PROTECTOR_TYPE_TOKENS: Record<number, string> = {
  0: 'TPM',
  1: 'StartupKey',
  2: 'NumericalPassword',
  3: 'TPMOrPIN',
  4: 'TPMOrStartupKey',
  5: 'TPMAndPIN',
  6: 'TPMAndStartupKey',
  7: 'PIN',
  8: 'Password',
  9: 'RecoveryPassword',
  10: 'Certificate',
  11: 'Elevation',
  12: 'TPMAndCertificate',
  13: 'PublicKey',
  14: 'MnemonicPassword'
};

/** Get-BitLockerVolume VolumeStatus enum values. */
const VOLUME_STATUS_TOKENS: Record<number, string> = {
  0: 'FullyDecrypted',
  1: 'FullyEncrypted',
  2: 'EncryptionInProgress',
  3: 'DecryptionInProgress',
  4: 'EncryptionPaused',
  5: 'DecryptionPaused'
};

/**
 * The status query. Projects ONLY non-secret fields — protector values (the
 * `.RecoveryPassword` property, which holds the 48-digit key) are deliberately
 * never selected here. Property names follow the installed BitLocker module:
 * protector objects expose `KeyProtectorType`, not `ProtectorType`.
 * Exported because the unlock flow re-runs it inside the same elevation.
 */
export const BITLOCKER_STATUS_PS = [
  `$ErrorActionPreference = 'Stop'`,
  `$volumes = @(Get-BitLockerVolume | ForEach-Object {`,
  `  [pscustomobject][ordered]@{`,
  `    MountPoint = [string]$_.MountPoint`,
  `    LockStatus = [int]$_.LockStatus`,
  `    VolumeStatus = [int]$_.VolumeStatus`,
  `    ProtectionStatus = [int]$_.ProtectionStatus`,
  `    VolumeType = ''`,
  `    Protectors = @( $_.KeyProtector | ForEach-Object { [pscustomobject][ordered]@{ type = $_.KeyProtectorType.ToString() } } )`,
  `  }`,
  `})`,
  `ConvertTo-Json -InputObject $volumes -Compress`
].join('\r\n');

/** Strip spaces so "Fully Encrypted" and "FullyEncrypted" become identical tokens. */
function normalizeConversionToken(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return VOLUME_STATUS_TOKENS[parseInt(text, 10)] ?? '';
  return text.replace(/\s+/g, '');
}

function lockStatusOf(value: unknown): boolean {
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /locked/i.test(text) && !/unlocked/i.test(text);
}

function protectionOnOf(value: unknown): boolean {
  if (typeof value === 'number') return value === 1;
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (/off/i.test(text)) return false;
  return /on/i.test(text);
}

function protectorsOf(value: unknown): BitlockerProtector[] {
  if (value === null || value === undefined) return [];
  const rawItems: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value];
  const protectors: BitlockerProtector[] = [];
  const push = (raw: unknown) => {
    if (typeof raw === 'number') {
      protectors.push({ type: PROTECTOR_TYPE_TOKENS[raw] ?? `Type${raw}` });
      return;
    }
    const text = String(raw ?? '').trim();
    if (!text) return;
    if (/^\d+$/.test(text)) {
      protectors.push({ type: PROTECTOR_TYPE_TOKENS[parseInt(text, 10)] ?? `Type${text}` });
      return;
    }
    protectors.push({ type: text });
  };
  for (const item of rawItems) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string' || typeof item === 'number') {
      push(item);
      continue;
    }
    if (typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const rawType =
        rec.type ?? rec.ProtectorType ?? rec.protectorType ?? rec.KeyProtectorType ?? rec.keyProtectorType;
      if (rawType !== null && rawType !== undefined) push(rawType);
    }
  }
  return protectors;
}

/**
 * Parse Get-BitLockerVolume JSON output.
 * Returns null when the text is not parseable, [] when it parses but holds no
 * volumes — callers must distinguish "query failed" from "nothing here".
 */
export function parseBitlockerJson(raw: string): BitlockerVolumeStatus[] | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : null;
  if (!list) return null;
  const volumes: BitlockerVolumeStatus[] = [];
  for (const entry of list as Array<Record<string, unknown> | null | undefined>) {
    if (!entry || typeof entry !== 'object') continue;
    const mount = String(entry.MountPoint ?? entry.mountPoint ?? entry.DriveLetter ?? '');
    const letterMatch = /^([A-Za-z]):/.exec(mount.trim());
    if (!letterMatch) continue;
    volumes.push({
      letter: letterMatch[1].toUpperCase(),
      volumeType: String(entry.VolumeType ?? entry.volumeType ?? '').trim(),
      locked: lockStatusOf(entry.LockStatus ?? entry.lockStatus),
      protectionOn: protectionOnOf(entry.ProtectionStatus ?? entry.protectionStatus),
      conversion: normalizeConversionToken(entry.VolumeStatus ?? entry.volumeStatus ?? entry.ConversionStatus),
      protectors: protectorsOf(entry.Protectors ?? entry.protectors)
    });
  }
  return volumes;
}

/** Protector names under the "Key Protectors:" section of manage-bde output. */
function parseManageBdeProtectors(section: string): BitlockerProtector[] {
  const header = /^\s*Key Protectors:\s*$/im.exec(section);
  if (!header) return [];
  const after = section.slice(header.index + header[0].length);
  const names: string[] = [];
  for (const line of after.split(/\r?\n/)) {
    if (/^Volume\s+[A-Za-z]:/i.test(line)) break;
    if (!line.trim()) {
      if (names.length > 0) break;
      continue;
    }
    if (line.includes(':')) break;
    names.push(line.trim());
  }
  return names.map((type) => ({ type }));
}

/**
 * Parse `manage-bde -status` text (the only BitLocker tool present in WinPE).
 * Splits on "Volume X:" headers; returns null when no volume block was found
 * (tool error output, empty input, or permission noise).
 */
export function parseManageBdeStatus(raw: string): BitlockerVolumeStatus[] | null {
  const text = String(raw ?? '');
  if (!text.trim()) return null;
  const volumes: BitlockerVolumeStatus[] = [];
  const blocks = text.split(/^(?=Volume\s+[A-Za-z]:)/im);
  for (const block of blocks) {
    const header = /^Volume\s+([A-Za-z]):(?:\s*\[([^\]]*)\])?/im.exec(block);
    if (!header) continue;
    const lockMatch = /Lock Status:\s*(Locked|Unlocked)/i.exec(block);
    const protectionMatch = /Protection Status:\s*(Protection\s+On|Protection\s+Off|Protection\s+Unknown|On|Off|Unknown)/i.exec(block);
    const conversionMatch = /Conversion Status:\s*(.+)/i.exec(block);
    volumes.push({
      letter: header[1].toUpperCase(),
      volumeType: (header[2] ?? '').trim(),
      locked: lockMatch ? /^locked$/i.test(lockMatch[1]) : false,
      protectionOn: protectionMatch ? /on$/i.test(protectionMatch[1].trim().split(/\s+/).pop() ?? '') : false,
      conversion: conversionMatch ? normalizeConversionToken(conversionMatch[1]) : '',
      protectors: parseManageBdeProtectors(block)
    });
  }
  return volumes.length > 0 ? volumes : null;
}

/**
 * True when the protector can unlock a volume via a 48-digit recovery
 * password — the only unlock route Phase 1 supports. Handles both the WMI
 * enum spelling ("NumericalPassword", "RecoveryPassword") and the manage-bde
 * display spelling ("Numerical Password").
 */
export function isRecoveryProtectorType(type: string): boolean {
  const normalized = String(type ?? '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return normalized === 'numericalpassword' || normalized === 'recoverypassword';
}

/** True when at least one protector on the volume is a recovery password. */
export function hasRecoveryProtector(volume: BitlockerVolumeStatus): boolean {
  return volume.protectors.some((p) => isRecoveryProtectorType(p.type));
}

/** WinPE marker: X: system drive, or the MiniNT key that exists only there. */
export function isWinPE(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.SystemDrive ?? '').toUpperCase().startsWith('X:')) return true;
  try {
    const reg = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    execFileSync(reg, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\MiniNT'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5_000,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

/** Run the JSON status query without elevation (fast, may be denied). */
function queryJsonStatus(): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      resolvePowershell(),
      ['-NoProfile', '-NonInteractive', '-Command', BITLOCKER_STATUS_PS],
      { encoding: 'utf-8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? '').trim()
    };
  }
}

/** Run `manage-bde -status` directly (WinPE — already admin, no UAC concept). */
export function queryManageBde(): string {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'manage-bde.exe');
  return execFileSync(exe, ['-status'], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

let sessionCache: BitlockerStatusResult | null = null;

/** Drop the cached status (called after an unlock changes lock state). */
export function invalidateBitlockerCache(): void {
  sessionCache = null;
}

/**
 * Install a fresh status result that an elevation already paid for — the
 * unlock flow fetches status in the same elevated script, so the UI can show
 * the now-unlocked state without a second UAC prompt.
 */
export function setBitlockerCache(
  volumes: BitlockerVolumeStatus[],
  source: BitlockerStatusResult['source'] = 'bitlocker-json-elevated'
): void {
  sessionCache = { ok: true, source, volumes };
}

/**
 * Query BitLocker status for every volume.
 *
 * - WinPE: manage-bde directly (always admin).
 * - Windows with elevate: one UAC prompt via the proven elevated-PS wrapper.
 * - Windows without elevate: silent probe; an empty/denied answer is reported
 *   as needsElevation so the UI can offer an explicit elevated retry.
 *
 * Successful results are cached for the session — the UI check button must
 * not re-prompt on every wizard visit; pass refresh to force a re-query.
 */
export async function listBitlockerStatus(options: BitlockerStatusOptions = {}): Promise<BitlockerStatusResult> {
  if (sessionCache && !options.refresh && !options.elevate) {
    return { ...sessionCache, source: 'cache' };
  }

  if (isWinPE()) {
    try {
      const raw = queryManageBde();
      const volumes = parseManageBdeStatus(raw);
      if (!volumes) {
        return { ok: false, source: 'manage-bde', volumes: [], error: 'manage-bde -status returned no volume data.' };
      }
      sessionCache = { ok: true, source: 'manage-bde', volumes };
      return { ...sessionCache };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`WinPE BitLocker status failed: ${error}`);
      return { ok: false, source: 'manage-bde', volumes: [], error };
    }
  }

  if (!options.elevate) {
    const probe = queryJsonStatus();
    const volumes = probe.ok ? parseBitlockerJson(probe.stdout) : null;
    if (volumes && volumes.length > 0) {
      sessionCache = { ok: true, source: 'bitlocker-json', volumes };
      return { ...sessionCache };
    }
    if (volumes) {
      // Parses clean but empty: on Windows this is indistinguishable from the
      // cmdlet silently denying a non-admin caller — elevate to be sure.
      // The denial itself is cached so repeated silent checks (restore
      // preflight, wizard probes) don't respawn PowerShell; refresh/elevate
      // calls bypass the cache and re-probe.
      sessionCache = {
        ok: false,
        source: 'bitlocker-json',
        volumes: [],
        needsElevation: true,
        error: 'BitLocker status could not be read without administrator rights.'
      };
      return { ...sessionCache };
    }
    sessionCache = {
      ok: false,
      source: 'bitlocker-json',
      volumes: [],
      needsElevation: true,
      error: probe.stderr || 'BitLocker status could not be read (administrator rights required).'
    };
    return { ...sessionCache };
  }

  const elevated = await runElevated(BITLOCKER_STATUS_PS);
  const stdout = String(elevated.stdout ?? '').trim();
  if (!stdout) {
    return {
      ok: false,
      source: 'bitlocker-json-elevated',
      volumes: [],
      needsElevation: true,
      error:
        String(elevated.stderr ?? '').trim() ||
        'Administrator approval is required to read BitLocker status.'
    };
  }
  const volumes = parseBitlockerJson(stdout);
  if (!volumes) {
    return {
      ok: false,
      source: 'bitlocker-json-elevated',
      volumes: [],
      error: 'Could not parse the elevated BitLocker status output.'
    };
  }
  sessionCache = { ok: true, source: 'bitlocker-json-elevated', volumes };
  return { ...sessionCache };
}
