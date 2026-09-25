import { execFileSync } from 'child_process';
import { resolvePowershell } from './elevated';
import { logger } from './logger';

/**
 * USB target picker for the recovery-media wizard.
 *
 * Enumerates every lettered volume with the info a noob needs to recognize
 * the right stick (label, model, size, bus, removable flag), so the UI can
 * offer a dropdown instead of a free-typed drive letter.
 */

export interface MediaDriveInfo {
  letter: string;
  volumeLabel: string;
  fs: string;
  sizeBytes: number;
  /** Get-Volume DriveType: 'Removable' | 'Fixed' | 'CDRom' | 'Network' | ... */
  driveType: string;
  /** Get-Disk BusType: 'USB' | 'SATA' | 'NVMe' | ... */
  busType: string;
  model: string;
  removable: boolean;
  usb: boolean;
  isSystem: boolean;
}

export interface MediaDriveOption extends MediaDriveInfo {
  /** Pre-formatted picker text, e.g. `E: — Cruzer Blade (7.7 GB, USB, removable)`. */
  text: string;
}

export interface MediaDriveGroups {
  primary: MediaDriveOption[];
  others: MediaDriveOption[];
  error?: string;
}

const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sys = ((Get-CimInstance Win32_OperatingSystem).SystemDrive) -replace ':',''
$vols = @()
foreach ($v in @(Get-Volume | Where-Object { $_.DriveLetter })) {
  $letter = [string]$v.DriveLetter
  $part = $null
  try { $part = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue } catch {}
  $disk = $null
  if ($part) {
    try { $disk = $part | Get-Disk -ErrorAction SilentlyContinue } catch {}
  }
  $bus = ''
  $model = ''
  if ($disk) {
    $bus = [string]$disk.BusType
    $model = [string]$disk.FriendlyName
  }
  $vols += [pscustomobject][ordered]@{
    letter = $letter
    volumeLabel = [string]$v.FileSystemLabel
    fs = [string]$v.FileSystem
    sizeBytes = [int64]$v.Size
    driveType = [string]$v.DriveType
    busType = $bus
    model = $model
    isSystem = ($letter -ieq $sys)
  }
}
ConvertTo-Json -InputObject $vols -Compress
`;

/** Parse the PowerShell JSON output into drive records (defensively). */
export function parseMediaDrivesJson(raw: string): MediaDriveInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? '').trim());
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];
  const drives: MediaDriveInfo[] = [];
  for (const entry of list as Array<Record<string, unknown> | null | undefined>) {
    if (!entry || typeof entry !== 'object') continue;
    const letter = String(entry.letter ?? '').toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    const driveType = String(entry.driveType ?? '');
    const busType = String(entry.busType ?? '');
    drives.push({
      letter,
      volumeLabel: String(entry.volumeLabel ?? ''),
      fs: String(entry.fs ?? ''),
      sizeBytes: Number(entry.sizeBytes) || 0,
      driveType,
      busType,
      model: String(entry.model ?? ''),
      removable: driveType === 'Removable',
      usb: busType.toUpperCase() === 'USB',
      isSystem: entry.isSystem === true
    });
  }
  return drives;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/** Picker text for one drive: letter, best human name, size, and bus traits. */
export function formatMediaDriveOption(d: MediaDriveInfo): string {
  const name = d.volumeLabel || d.model || 'Local disk';
  const traits = [d.busType || 'unknown bus'];
  if (d.removable) traits.push('removable');
  else if (!d.usb) traits.push('INTERNAL');
  return `${d.letter}: — ${name} (${formatSize(d.sizeBytes)}, ${traits.join(', ')})`;
}

/**
 * Drives that must never be offered as a format target (and are refused
 * server-side too): the Windows system drive, the drive OPBS itself runs
 * from, and the drive holding the app data.
 */
export function protectedDriveLetters(
  sources?: { systemDrive?: string | null; execPath?: string | null; appData?: string | null }
): string[] {
  const s = sources ?? {
    systemDrive: process.env.SystemDrive,
    execPath: process.execPath,
    appData: process.env.APPDATA
  };
  const letters = new Set<string>();
  for (const value of [s.systemDrive, s.execPath, s.appData]) {
    const match = /^([A-Za-z]):/.exec(String(value ?? ''));
    if (match) letters.add(match[1].toUpperCase());
  }
  return [...letters];
}

/**
 * Split eligible targets into safe groups: USB/removable first, other
 * non-system fixed disks in a clearly-marked secondary group. System drives,
 * optical and network volumes are dropped entirely.
 */
export function groupMediaDrives(drives: MediaDriveInfo[], protectedLetters: string[]): MediaDriveGroups {
  const blocked = new Set(protectedLetters.map((l) => l.toUpperCase()));
  const eligible = drives.filter(
    (d) =>
      !d.isSystem &&
      !blocked.has(d.letter) &&
      (d.driveType === 'Removable' || d.driveType === 'Fixed')
  );
  const withText = (d: MediaDriveInfo): MediaDriveOption => ({ ...d, text: formatMediaDriveOption(d) });
  const byLetter = (a: MediaDriveOption, b: MediaDriveOption) => a.letter.localeCompare(b.letter);
  const primary = eligible.filter((d) => d.usb || d.removable).map(withText).sort(byLetter);
  const others = eligible.filter((d) => !d.usb && !d.removable).map(withText).sort(byLetter);
  return { primary, others };
}

/**
 * Server-side safety net for USB creation: refuse a target letter that holds
 * Windows or OPBS itself, regardless of what the UI sent. Returns an error
 * message, or null when the target is acceptable.
 */
export function usbTargetGuard(output: string, protectedLetters: string[]): string | null {
  const match = /^([A-Za-z]):?(?:[\\/].*)?$/.exec(String(output ?? '').trim());
  if (!match) {
    return `Invalid USB target: "${output}" (expected a drive letter).`;
  }
  const letter = match[1].toUpperCase();
  if (protectedLetters.includes(letter)) {
    return (
      `Refusing to write recovery media to drive ${letter}: — that drive holds Windows or ` +
      `OPBS itself. Pick a different USB drive.`
    );
  }
  return null;
}

/** Enumerate picker candidates (non-elevated, one PowerShell call). */
export function listMediaDrives(): MediaDriveGroups {
  try {
    const raw = execFileSync(resolvePowershell(), ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 20_000
    });
    return groupMediaDrives(parseMediaDrivesJson(raw), protectedDriveLetters());
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(`Drive enumeration failed: ${error}`);
    return { primary: [], others: [], error: `Could not list drives: ${error}` };
  }
}
