/**
 * "Restore after reboot into recovery" — stage a restore that must run
 * outside the live Windows session (system/boot volumes), boot into a
 * WinRE-based recovery environment once, run the restore there, and come
 * back to Windows with a result marker.
 *
 * How it works (SIW2's winre.wim pattern — see elevenforum thread 46521):
 *  1. The machine's own `winre.wim` is COPIED (never modified in place) to
 *     `%SystemDrive%\Recovery\OPBS\winre.wim` — no ADK required, and the
 *     image carries this machine's storage/BitLocker drivers.
 *  2. The OPBS payload (node.exe, dist, native addon, codecs) plus a staged
 *     `OPBS-restore.json` and launcher scripts land in
 *     `%SystemDrive%\Recovery\OPBS\media\OPBS\`.
 *  3. A `startnet.cmd` is injected into the COPIED wim. It copies the
 *     payload to the X: ramdisk before anything is written, so the restore
 *     can overwrite the very volume the payload came from.
 *  4. A one-shot boot entry ("OPBS Recovery") is added to the system BCD
 *     using a dedicated ramdisk device object — the shared {ramdiskoptions}
 *     used by Windows Recovery Environment is left untouched, so WinRE
 *     keeps working exactly as before. `bcdedit /bootsequence` boots it
 *     once; the normal boot menu is never modified.
 *  5. In the recovery environment the restore runs automatically (after a
 *     10-second cancel window), writes `%SystemDrive%\OPBS-restore-result.json`
 *     on the freshly restored volume, and reboots back to Windows.
 *
 * Everything here is elevated (DISM mount, BCD edits, BitLocker) and runs
 * through one generated PowerShell script with the same progress/result
 * handshake as the recovery-media build (winpe-media.ts).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { runElevatedPowerShell } from '../utils/elevated';
import { logger } from '../utils/logger';
import {
  PayloadItem,
  planPayloadCopies,
  stagePayloadFiles,
  readLogTail,
  elevatedNoResultError,
  resolveNodeExe,
  resolveDistDir,
  resolveNativeNode,
  resolveBundleNodeModules,
  buildWinpeEntry
} from '../utils/winpe-media';

/** Staging root, relative to the system drive. */
export const RECOVERY_STAGE_DIRNAME = path.join('Recovery', 'OPBS');
/** Result marker written at the system-drive root after the PE restore. */
export const RECOVERY_RESULT_FILENAME = 'OPBS-restore-result.json';

const STAGE_TIMEOUT_MS = 30 * 60 * 1000;
const CLOSE_GRACE_MS = 15_000;
const PE_PAYLOAD_SCAN = 'Recovery\\OPBS\\media\\OPBS\\node.exe';

/** The restore config staged as OPBS-restore.json (CLI restore schema). */
export interface RecoveryStageConfig {
  imagePath: string;
  /** Target physical disk (mutually exclusive with targetVirtualDisk). */
  targetDiskIndex?: number;
  /** Restore into a virtual disk instead — used by the live-test harness. */
  targetVirtualDisk?: { path: string; virtualSize: number; type: 'dynamic' | 'fixed' };
  targetPartitions: number[];
  passphrase?: string;
  verifyBeforeWrite?: boolean;
  clearFreeSpace?: boolean;
  acknowledgeSameDisk?: boolean;
}

export interface RecoveryStageResult {
  ok: boolean;
  /** %SystemDrive%\Recovery\OPBS */
  stagedPath?: string;
  /** The one-shot "OPBS Recovery" BCD entry. */
  entryGuid?: string;
  /** The dedicated ramdisk device object (not {ramdiskoptions}). */
  ramdiskGuid?: string;
  bitLockerSuspended?: boolean;
  winreSource?: string;
  error?: string;
}

export interface RecoveryCleanupResult {
  ok: boolean;
  cleaned?: boolean;
  error?: string;
}

export interface RecoveryPendingResult {
  ok: boolean;
  exitCode?: number;
  finishedAt?: string;
}

export interface RecoveryStatusResult {
  staged: boolean;
  stagedPath?: string;
  /** Result of the last PE restore, consumed (deleted) on read. */
  pendingResult?: RecoveryPendingResult | null;
}

/** Extract the GUID bcdedit prints on /create or /copy ("The entry {…} was …"). */
export function parseBcdCreateGuid(output: string): string | null {
  const m = /\{([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}/.exec(output ?? '');
  return m ? `{${m[1]}}` : null;
}

/** Extract the "Windows RE location: …" line from `reagentc /info`. */
export function parseReagentcWinreDir(text: string): string | null {
  const m = /Windows RE location:\s*(.+)/.exec(text ?? '');
  return m ? m[1].trim() : null;
}

function psSingle(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * startnet.cmd injected into the copied winre.wim. Differences from the USB
 * media variant: the payload lives at \Recovery\OPBS\media\OPBS on some
 * volume, is copied to the X: ramdisk FIRST (the restore may overwrite the
 * source volume), an automatic restore can be cancelled within 10 seconds,
 * and success reboots back to Windows.
 */
export function buildRecoveryStartnetCmd(): string {
  return [
    '@echo off',
    'title OPBS Recovery',
    // Banner BEFORE everything else (incl. wpeinit): a hang must show what
    // is running instead of a silent black console. No `mode con` - the
    // mode switch is a blank-output suspect on some displays.
    'echo.',
    'echo ============================================',
    'echo   OPBS Recovery - restore after reboot',
    'echo ============================================',
    'echo.',
    // node.exe fatals at startup when OPENSSL_CONF points at an unreadable
    // path — neutralize it for every node.exe spawned from this console.
    'set "OPENSSL_CONF="',
    'echo Initializing devices (wpeinit - can take a minute)...',
    'call wpeinit',
    'echo.',
    'set STAGED=',
    'for %%D in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do (',
    `  if not defined STAGED if exist "%%D:\\${PE_PAYLOAD_SCAN}" set STAGED=%%D:\\Recovery\\OPBS`,
    ')',
    'if not defined STAGED goto :notfound',
    'echo Found the staged restore on %STAGED% - copying to RAM...',
    'xcopy "%STAGED%\\media\\OPBS" "X:\\OPBS\\" /E /I /Q /Y >nul',
    'if not exist "X:\\OPBS\\node.exe" goto :notfound',
    'set "OPBS_STAGED=%STAGED%"',
    'echo.',
    'echo The restore will start automatically in 10 seconds.',
    'choice /c YN /T 10 /D Y /N /M "Continue with the restore? [Y/N]: "',
    'if errorlevel 2 goto :cancelled',
    'call "X:\\OPBS\\restore.cmd"',
    'if errorlevel 1 goto :failed',
    'echo.',
    'echo Restore completed. Rebooting back into Windows...',
    'wpeutil reboot',
    'goto :eof',
    ':cancelled',
    'echo.',
    'echo Cancelled - no restore has been run.',
    'echo The staged restore is kept; OPBS can cancel it from the Restore page.',
    'echo Manual use: X:\\OPBS\\node.exe X:\\OPBS\\winpe-entry.js wizard',
    'cmd /k',
    'goto :eof',
    ':failed',
    'echo.',
    'echo *** THE RESTORE FAILED - see the output above. ***',
    'echo The machine has NOT been rebooted. Retry manually with:',
    'echo   X:\\OPBS\\node.exe X:\\OPBS\\winpe-entry.js wizard',
    'cmd /k',
    'goto :eof',
    ':notfound',
    'echo.',
    'echo ERROR: staged OPBS restore payload not found on any volume.',
    'cmd /k'
  ].join('\r\n');
}

/**
 * restore.cmd in the payload root: run the staged restore config through the
 * CLI, then write the result marker at the source volume's root (the freshly
 * restored system volume) so Windows-side OPBS can report the outcome.
 */
export function buildRecoveryRestoreCmd(): string {
  return [
    '@echo off',
    'setlocal',
    'title OPBS Restore',
    'cd /d "%~dp0"',
    'if not exist "%~dp0OPBS-restore.json" goto :wizard',
    'echo Running the staged restore from OPBS-restore.json ...',
    'echo.',
    'node.exe winpe-entry.js restore "OPBS-restore.json" --elevated --acknowledge-same-disk',
    'set "RC=%ERRORLEVEL%"',
    'if defined OPBS_STAGED for %%I in ("%OPBS_STAGED%\\..\\..") do set "VOLROOT=%%~fI"',
    'if not defined VOLROOT set "VOLROOT=%SystemDrive%\\."',
    'if "%RC%"=="0" (',
    '  >"%VOLROOT%\\OPBS-restore-result.json" echo {"ok":true,"finishedAt":"%DATE% %TIME%"}',
    '  exit /b 0',
    ')',
    '>"%VOLROOT%\\OPBS-restore-result.json" echo {"ok":false,"exitCode":%RC%,"finishedAt":"%DATE% %TIME%"}',
    'exit /b 1',
    ':wizard',
    'echo No OPBS-restore.json found - starting the interactive restore wizard.',
    'node.exe winpe-entry.js wizard'
  ].join('\r\n');
}

/** Text files placed in the payload root alongside the node runtime. */
export function recoveryPayloadTextFiles(config: RecoveryStageConfig): Array<{ name: string; content: string }> {
  return [
    { name: 'winpe-entry.js', content: buildWinpeEntry() },
    { name: 'restore.cmd', content: buildRecoveryRestoreCmd() },
    {
      name: 'OPBS-restore.json',
      content: JSON.stringify(
        {
          imagePath: config.imagePath,
          ...(config.targetVirtualDisk
            ? { targetVirtualDisk: config.targetVirtualDisk }
            : { targetDiskIndex: config.targetDiskIndex }),
          targetPartitions: config.targetPartitions,
          ...(config.passphrase ? { passphrase: config.passphrase } : {}),
          verifyBeforeWrite: config.verifyBeforeWrite !== false,
          clearFreeSpace: config.clearFreeSpace !== false
        },
        null,
        2
      )
    }
  ];
}

/**
 * winpeshl.ini injected into the copied winre.wim. WinRE boots through
 * winpeshl.exe, which runs winpeshl.ini INSTEAD of startnet.cmd - the stock
 * ini launches recenv.exe (the recovery UI), so the payload must be wired
 * here (SIW2's original recipe: "the program and winpeshl.ini shoved in").
 */
export function buildWinpeshlIni(): string {
  // Exactly the syntax this winpeshl.exe demonstrably parses - the stock
  // file is "[LaunchApp]" + "AppPath=<command line>". The documented
  // "[LaunchApps]" multi-app form is a different parser path and black-
  // screens when unhandled (winpeshl exits, nothing runs).
  //
  // Bisect mode: an INTERACTIVE console. If it appears, the whole boot
  // chain below winpeshl is healthy and `startnet` can be run by hand to
  // watch the flow live; if even this is black, the fault is at/below
  // winpeshl itself.
  return ['[LaunchApp]', 'AppPath=X:\\Windows\\System32\\cmd.exe', ''].join('\r\n');
}

export interface StageScriptParams {
  work: string;
  progressFile: string;
  resultFile: string;
  /** Already-staged payload files (real paths, copied into media/OPBS). */
  payload: PayloadItem[];
  /** Text files written into media/OPBS from base64. */
  textFiles: Array<{ name: string; b64: string }>;
  startnetB64: string;
  winpeshlB64: string;
}

/**
 * The elevated staging script. Steps: stage folder → copy winre.wim (found
 * via reagentc, with fallbacks) → copy payload → DISM-mount the copy and
 * inject startnet.cmd → create a dedicated ramdisk device object + one-shot
 * boot entry → suspend BitLocker protectors for one boot → result.json.
 */
export function buildStageScript(p: StageScriptParams): string {
  const copyLines = p.payload
    .map(
      (item) =>
        `  $dest = Join-Path $stageRoot (Join-Path 'media\\OPBS' ${psSingle(item.to)})\n` +
        `  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dest)) | Out-Null\n` +
        `  Copy-Item -Recurse -Force ${psSingle(item.from)} $dest`
    )
    .join('\n');
  const textLines = p.textFiles
    .map(
      (f) =>
        `  [System.IO.File]::WriteAllBytes((Join-Path $stageRoot (Join-Path 'media\\OPBS' ${psSingle(f.name)})), [System.Convert]::FromBase64String('${f.b64}'))`
    )
    .join('\n');
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$work = ${psSingle(p.work)}`,
    `$progressFile = ${psSingle(p.progressFile)}`,
    `$resultFile = ${psSingle(p.resultFile)}`,
    `$stageRoot = Join-Path $env:SystemDrive ${psSingle(RECOVERY_STAGE_DIRNAME)}`,
    `$entryGuid = $null`,
    `$ramdiskGuid = $null`,
    `$bitLockerSuspended = $false`,
    `$winreSource = $null`,
    `function Write-Step([string]$m) { Add-Content -Path $progressFile -Value $m }`,
    `function Write-Result([bool]$ok, [string]$error) {`,
    `  $r = @{ ok = $ok; entryGuid = $entryGuid; ramdiskGuid = $ramdiskGuid; bitLockerSuspended = $bitLockerSuspended; winreSource = $winreSource }`,
    `  if ($error) { $r.error = $error }`,
    `  ($r | ConvertTo-Json) | Set-Content -Path $resultFile -Encoding UTF8`,
    `}`,
    `try {`,
    `  Write-Step 'Preparing the staging folder...'`,
    `  if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }`,
    `  New-Item -ItemType Directory -Path (Join-Path $stageRoot 'media\\OPBS') -Force | Out-Null`,
    ``,
    `  Write-Step 'Locating winre.wim (Windows Recovery Environment)...'`,
    `  $wim = $null`,
    `  $candidates = @()`,
    `  $reInfo = (& (Join-Path $env:SystemRoot 'System32\\reagentc.exe') /info 2>$null | Out-String)`,
    `  foreach ($line in ($reInfo -split '\\r?\\n')) {`,
    `    if ($line -match '^\\s*Windows RE location:\\s*(.+?)\\s*$') {`,
    `      $dir = $matches[1]`,
    `      $candidates += (Join-Path $dir 'winre.wim')`,
    `      # reagentc prints \\\\?\\GLOBALROOT\\... device paths that the PowerShell`,
    `      # filesystem provider (Test-Path/Copy-Item) cannot open - the Win32`,
    `      # form is \\\\.\\GLOBALROOT\\... which the .NET file APIs handle fine.`,
    `      if ($dir.StartsWith('\\\\?\\')) { $candidates += (Join-Path ('\\\\.\\' + $dir.Substring(4)) 'winre.wim') }`,
    `      if ($dir.StartsWith('\\\\.\\')) { $candidates += (Join-Path ('\\\\?\\' + $dir.Substring(4)) 'winre.wim') }`,
    `    }`,
    `  }`,
    `  $candidates += (Join-Path $env:SystemRoot 'System32\\Recovery\\winre.wim')`,
    `  $candidates += (Join-Path $env:SystemDrive 'Recovery\\WindowsRE\\winre.wim')`,
    `  foreach ($c in $candidates) {`,
    `    if ([System.IO.File]::Exists($c)) { $wim = $c; break }`,
    `  }`,
    `  if (-not $wim) { throw 'winre.wim was not found - the Windows Recovery Environment looks disabled (see: reagentc /info).' }`,
    `  $winreSource = $wim`,
    `  # The boot manager builds the RAM disk from an SDI file (boot.sdi) BEFORE`,
    `  # mounting the WIM - pointing ramdisksdipath at the WIM yields 0xc000007b`,
    `  # ("a required device isn't connected"). WinRE keeps boot.sdi beside its`,
    `  # winre.wim; copy both so the staged entry is self-contained.`,
    `  $sdi = $null`,
    `  foreach ($c in @((Join-Path ([System.IO.Path]::GetDirectoryName($wim)) 'boot.sdi'), (Join-Path $env:SystemDrive 'Boot\\boot.sdi'))) {`,
    `    if ([System.IO.File]::Exists($c)) { $sdi = $c; break }`,
    `  }`,
    `  if (-not $sdi) { throw 'boot.sdi was not found beside winre.wim (nor in the system drive''s Boot folder) - the boot manager needs it to set up the recovery RAM disk.' }`,
    `  Write-Step "Copying winre.wim from $wim ..."`,
    `  [System.IO.File]::Copy($wim, (Join-Path $stageRoot 'winre.wim'), $true)`,
    `  Write-Step "Copying boot.sdi from $sdi ..."`,
    `  [System.IO.File]::Copy($sdi, (Join-Path $stageRoot 'boot.sdi'), $true)`,
    ``,
    `  Write-Step 'Staging the OPBS payload...'`,
    copyLines,
    textLines,
    ``,
    `  Write-Step 'Injecting the OPBS launcher into the recovery image...'`,
    `  $wimTarget = Join-Path $stageRoot 'winre.wim'`,
    `  $mount = Join-Path $env:TEMP ('opbs-wim-' + [guid]::NewGuid().ToString('N'))`,
    `  New-Item -ItemType Directory -Path $mount | Out-Null`,
    `  & dism /English /Mount-Wim /WimFile:"$wimTarget" /Index:1 /MountDir:"$mount" | Out-Null`,
    `  if ($LASTEXITCODE -ne 0) { throw "dism /Mount-Wim failed with exit code $LASTEXITCODE" }`,
    `  try {`,
    `    [System.IO.File]::WriteAllText((Join-Path $mount 'Windows\\System32\\startnet.cmd'), [System.Text.Encoding]::ASCII.GetString([System.Convert]::FromBase64String('${p.startnetB64}')))`,
    `    [System.IO.File]::WriteAllText((Join-Path $mount 'Windows\\System32\\winpeshl.ini'), [System.Text.Encoding]::ASCII.GetString([System.Convert]::FromBase64String('${p.winpeshlB64}')))`,
    `    & dism /English /Unmount-Wim /MountDir:"$mount" /Commit | Out-Null`,
    `    if ($LASTEXITCODE -ne 0) { throw "dism /Unmount-Wim /Commit failed with exit code $LASTEXITCODE" }`,
    `  } catch {`,
    `    & dism /English /Unmount-Wim /MountDir:"$mount" /Discard | Out-Null`,
    `    throw`,
    `  }`,
    `  Remove-Item -Recurse -Force $mount`,
    ``,
    `  Write-Step 'Creating the one-shot recovery boot entry...'`,
    `  # A DEDICATED ramdisk device object (SIW2's multi-WIM pattern). The`,
    `  # well-known {ramdiskoptions} is shared with Windows Recovery`,
    `  # Environment - it is never touched here, so WinRE keeps booting.`,
    `  $ramOut = (& bcdedit /create /d 'OPBS ramdisk options' /device | Out-String)`,
    `  if ($ramOut -match '\\{[0-9a-fA-F-]+\\}') { $ramdiskGuid = $matches[0] } else { throw "bcdedit /create /device failed: $ramOut" }`,
    `  $sys = $env:SystemDrive.TrimEnd('\\')`,
    `  & bcdedit /set $ramdiskGuid ramdisksdidevice "partition=$sys" | Out-Null`,
    `  & bcdedit /set $ramdiskGuid ramdisksdipath '\\Recovery\\OPBS\\boot.sdi' | Out-Null`,
    `  $entryOut = (& bcdedit /create /d 'OPBS Recovery' /application osloader | Out-String)`,
    `  if ($entryOut -match '\\{[0-9a-fA-F-]+\\}') { $entryGuid = $matches[0] } else { throw "bcdedit /create /application osloader failed: $entryOut" }`,
    `  $wimDev = '[' + $sys + ']\\Recovery\\OPBS\\winre.wim'`,
    `  & bcdedit /set $entryGuid device "ramdisk=$wimDev,$ramdiskGuid" | Out-Null`,
    `  & bcdedit /set $entryGuid osdevice "ramdisk=$wimDev,$ramdiskGuid" | Out-Null`,
    `  $fw = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name PEFirmwareType -ErrorAction SilentlyContinue).PEFirmwareType`,
    `  if ($fw -eq 2) { & bcdedit /set $entryGuid path '\\windows\\system32\\winload.efi' | Out-Null }`,
    `  else { & bcdedit /set $entryGuid path '\\windows\\system32\\winload.exe' | Out-Null }`,
    `  & bcdedit /set $entryGuid systemroot '\\windows' | Out-Null`,
    `  & bcdedit /set $entryGuid inherit '{bootloadersettings}' | Out-Null`,
    `  & bcdedit /set $entryGuid nx OptIn | Out-Null`,
    `  & bcdedit /set $entryGuid bootmenupolicy Standard | Out-Null`,
    `  # Windows 11 24H2+ memory-integrity settings - present on every working`,
    `  # Win11 boot entry ({current}, WinRE) and a black-screen suspect when`,
    `  # missing on HVCI machines.`,
    `  & bcdedit /set $entryGuid isolatedcontext Yes | Out-Null`,
    `  & bcdedit /set $entryGuid allowedinmemorysettings 0x15000075 | Out-Null`,
    `  & bcdedit /set $entryGuid detecthal Yes | Out-Null`,
    `  & bcdedit /set $entryGuid winpe Yes | Out-Null`,
    `  & bcdedit /bootsequence $entryGuid | Out-Null`,
    ``,
    `  Write-Step 'Checking BitLocker...'`,
    `  $bl = (& manage-bde -status $env:SystemDrive 2>$null | Out-String)`,
    `  if ($bl -match 'Protection Status:\\s*Protection On') {`,
    `    Write-Step 'Suspending BitLocker protection for one boot...'`,
    `    & manage-bde -protectors -disable $env:SystemDrive -RebootCount 1 | Out-Null`,
    `    if ($LASTEXITCODE -ne 0) { throw "manage-bde -protectors -disable failed with exit code $LASTEXITCODE - suspend BitLocker manually, then retry." }`,
    `    $bitLockerSuspended = $true`,
    `  }`,
    ``,
    `  Write-Step 'Staging complete.'`,
    `  Write-Result $true $null`,
    `} catch {`,
    `  Write-Result $false ($_.Exception.Message)`,
    `}`
  ].join('\n');
}

/** Remove a staged recovery restore: boot entry, ramdisk object and folder. */
export function buildCleanupScript(p: { progressFile: string; resultFile: string; entryGuid: string; ramdiskGuid: string }): string {
  return [
    `$ErrorActionPreference = 'Continue'`,
    `$progressFile = ${psSingle(p.progressFile)}`,
    `$resultFile = ${psSingle(p.resultFile)}`,
    `$stageRoot = Join-Path $env:SystemDrive ${psSingle(RECOVERY_STAGE_DIRNAME)}`,
    `function Write-Step([string]$m) { Add-Content -Path $progressFile -Value $m }`,
    `try {`,
    `  Write-Step 'Removing the OPBS Recovery boot entry...'`,
    `  & bcdedit /deletevalue {bootmgr} bootsequence | Out-Null`,
    `  & bcdedit /delete ${psSingle(p.entryGuid)} | Out-Null`,
    `  # Never touch the canonical {ramdiskoptions} (shared with Windows RE).`,
    `  if (${psSingle(p.ramdiskGuid)} -ne '{ae5534e0-a924-466c-b836-758539a3ee3a}') {`,
    `    & bcdedit /delete ${psSingle(p.ramdiskGuid)} | Out-Null`,
    `  }`,
    `  Write-Step 'Removing the staged recovery files...'`,
    `  if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }`,
    `  Write-Step 'Cleanup complete.'`,
    `  (@{ ok = $true; cleaned = $true } | ConvertTo-Json) | Set-Content -Path $resultFile -Encoding UTF8`,
    `} catch {`,
    `  (@{ ok = $false; cleaned = $false; error = $_.Exception.Message } | ConvertTo-Json) | Set-Content -Path $resultFile -Encoding UTF8`,
    `}`
  ].join('\n');
}

/** Marker left in the staging folder so cleanup knows what to delete. */
interface RecoveryStageMarker {
  entryGuid: string;
  ramdiskGuid: string;
  stagedAt: string;
}

function stageMarkerPath(): string {
  return path.join(process.env.SystemDrive ?? 'C:', RECOVERY_STAGE_DIRNAME, 'stage.json');
}

function readStageMarker(): RecoveryStageMarker | null {
  try {
    return JSON.parse(fs.readFileSync(stageMarkerPath(), 'utf-8')) as RecoveryStageMarker;
  } catch {
    return null;
  }
}

/**
 * Run a generated elevated script with the winpe-media result/progress
 * handshake (result.json is authoritative; the wrapper's close is not).
 */
async function runRecoveryScript(
  work: string,
  scriptPath: string,
  resultFile: string,
  progressFile: string,
  onProgress?: (msg: string) => void
): Promise<{ parsed: Record<string, unknown> | null; exitCode: number | undefined; error?: string }> {
  let seen = 0;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(progressFile)) return;
      const all = fs.readFileSync(progressFile, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
      if (all.length > seen) {
        seen = all.length;
        try {
          onProgress?.(all[all.length - 1]);
        } catch {
          /* renderer may be gone */
        }
      }
    } catch {
      /* partial write */
    }
  }, 700);
  const startedAt = Date.now();
  let exitCode: number | undefined;
  let closeError: unknown;
  let closeAtMs = 0;
  const closing = runElevatedPowerShell(scriptPath)
    .then((code) => {
      exitCode = code;
      closeAtMs = Date.now();
    })
    .catch((err: unknown) => {
      closeError = err;
      closeAtMs = Date.now();
    });
  for (;;) {
    if (fs.existsSync(resultFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
        clearInterval(timer);
        await closing;
        return { parsed, exitCode };
      } catch {
        /* still being written */
      }
    }
    if (closeError) break;
    if (exitCode === 5) break;
    if (exitCode !== undefined && Date.now() - closeAtMs > CLOSE_GRACE_MS) break;
    if (Date.now() - startedAt > STAGE_TIMEOUT_MS) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  clearInterval(timer);
  await closing;
  const logTail = readLogTail(path.join(work, 'progress.txt'));
  return {
    parsed: null,
    exitCode,
    error: closeError
      ? String(closeError instanceof Error ? closeError.message : closeError)
      : elevatedNoResultError(exitCode ?? -1, work, scriptPath, logTail)
  };
}

/**
 * Stage "restore after reboot into recovery". Requires one UAC confirmation
 * (DISM, BCD and BitLocker changes are machine-level).
 */
export async function stageRecoveryRestore(
  config: RecoveryStageConfig,
  opts?: { onProgress?: (msg: string) => void }
): Promise<RecoveryStageResult> {
  try {
    if (!config || typeof config.imagePath !== 'string' || !config.imagePath.trim()) {
      return { ok: false, error: 'No image selected.' };
    }
    const hasVhd = !!config.targetVirtualDisk && typeof config.targetVirtualDisk.path === 'string';
    const hasDisk = Number.isInteger(config.targetDiskIndex) && (config.targetDiskIndex ?? -1) >= 0;
    if (hasVhd === hasDisk) {
      return { ok: false, error: 'Set exactly one restore target: a target disk or a target virtual disk.' };
    }
    if (!Array.isArray(config.targetPartitions) || config.targetPartitions.length === 0) {
      return { ok: false, error: 'No partitions selected.' };
    }

    const nodeExe = resolveNodeExe();
    if (!nodeExe) {
      return {
        ok: false,
        error:
          'No Node.js runtime was found for the recovery environment. Install the portable ' +
          'Node.js runtime from the Recovery Media page (or install Node.js), then retry.'
      };
    }
    const payloadCopies = planPayloadCopies({
      nodeExe,
      distDir: resolveDistDir(),
      nativeNode: resolveNativeNode(),
      nodeModules: resolveBundleNodeModules(['fzstd', 'zstdify'])
    });

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-recovery-'));
    const progressFile = path.join(work, 'progress.txt');
    const resultFile = path.join(work, 'result.json');
    const scriptPath = path.join(work, 'stage.ps1');

    // Stage payload as real files first: the elevated PowerShell (.NET) cannot
    // read inside app.asar (same constraint as the media build).
    const stagedCopies = stagePayloadFiles(payloadCopies, work);
    const textFiles = recoveryPayloadTextFiles(config).map((f) => ({ name: f.name, b64: b64(f.content) }));
    fs.writeFileSync(
      scriptPath,
      buildStageScript({
        work,
        progressFile,
        resultFile,
        payload: stagedCopies,
        textFiles,
        startnetB64: b64(buildRecoveryStartnetCmd()),
        winpeshlB64: b64(buildWinpeshlIni())
      }),
      'utf-8'
    );

    opts?.onProgress?.('Starting the elevated staging (DISM/BCD)...');
    const { parsed, error } = await runRecoveryScript(work, scriptPath, resultFile, progressFile, opts?.onProgress);
    if (!parsed) {
      logger.error(`Recovery staging failed: ${error}`);
      return { ok: false, error: error ?? 'Recovery staging failed.' };
    }
    if (!parsed.ok) {
      const message = `${String(parsed.error ?? 'Recovery staging failed.')} (work kept at ${work} for inspection)`;
      logger.error(`Recovery staging failed: ${message}`);
      return { ok: false, error: message };
    }

    const result: RecoveryStageResult = {
      ok: true,
      stagedPath: path.join(process.env.SystemDrive ?? 'C:', RECOVERY_STAGE_DIRNAME),
      entryGuid: (parsed.entryGuid as string) ?? undefined,
      ramdiskGuid: (parsed.ramdiskGuid as string) ?? undefined,
      bitLockerSuspended: !!parsed.bitLockerSuspended,
      winreSource: (parsed.winreSource as string) ?? undefined
    };
    // Marker for cleanup (staging may happen again before a reboot).
    if (result.entryGuid && result.ramdiskGuid) {
      try {
        fs.writeFileSync(
          stageMarkerPath(),
          JSON.stringify(
            { entryGuid: result.entryGuid, ramdiskGuid: result.ramdiskGuid, stagedAt: new Date().toISOString() } satisfies RecoveryStageMarker,
            null,
            2
          ),
          'utf-8'
        );
      } catch {
        /* marker is a convenience; cleanup can still run via the CLI */
      }
    }
    fs.rmSync(work, { recursive: true, force: true });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Recovery staging failed: ${message}`);
    return { ok: false, error: message };
  }
}

/** Cancel a staged restore: delete the boot entry, ramdisk object and files. */
export async function cleanupRecovery(opts?: { onProgress?: (msg: string) => void }): Promise<RecoveryCleanupResult> {
  try {
    const marker = readStageMarker();
    if (!marker) {
      // No marker — still try to remove an orphaned folder.
      const stageRoot = path.join(process.env.SystemDrive ?? 'C:', RECOVERY_STAGE_DIRNAME);
      if (!fs.existsSync(stageRoot)) return { ok: true, cleaned: false };
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-recovery-clean-'));
    const progressFile = path.join(work, 'progress.txt');
    const resultFile = path.join(work, 'result.json');
    const scriptPath = path.join(work, 'cleanup.ps1');
    fs.writeFileSync(
      scriptPath,
      buildCleanupScript({
        progressFile,
        resultFile,
        entryGuid: marker?.entryGuid ?? '{00000000-0000-0000-0000-000000000000}',
        ramdiskGuid: marker?.ramdiskGuid ?? '{00000000-0000-0000-0000-000000000000}'
      }),
      'utf-8'
    );
    opts?.onProgress?.('Removing the staged restore (UAC)...');
    const { parsed, error } = await runRecoveryScript(work, scriptPath, resultFile, progressFile, opts?.onProgress);
    if (!parsed) return { ok: false, error: error ?? 'Cleanup failed.' };
    fs.rmSync(work, { recursive: true, force: true });
    return parsed.ok ? { ok: true, cleaned: true } : { ok: false, error: String(parsed.error ?? 'Cleanup failed.') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Windows-side status: is a restore staged, and did the last PE restore leave
 * a result marker? The marker is consumed (deleted) on read.
 */
export function readRecoveryStatus(): RecoveryStatusResult {
  const stageRoot = path.join(process.env.SystemDrive ?? 'C:', RECOVERY_STAGE_DIRNAME);
  const staged = fs.existsSync(stageRoot);
  const resultPath = path.join(process.env.SystemDrive ?? 'C:', RECOVERY_RESULT_FILENAME);
  let pendingResult: RecoveryPendingResult | null = null;
  try {
    if (fs.existsSync(resultPath)) {
      const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as RecoveryPendingResult;
      pendingResult = {
        ok: !!raw.ok,
        ...(typeof raw.exitCode === 'number' ? { exitCode: raw.exitCode } : {}),
        ...(raw.finishedAt ? { finishedAt: raw.finishedAt } : {})
      };
      fs.rmSync(resultPath, { force: true });
    }
  } catch {
    /* unreadable marker — treat as absent */
  }
  return { staged, stagedPath: staged ? stageRoot : undefined, pendingResult };
}

/** Reboot into the staged recovery environment (one-shot boot entry). */
export function rebootToRecovery(): { ok: boolean; error?: string } {
  try {
    spawn('shutdown', ['/r', '/t', '5'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
