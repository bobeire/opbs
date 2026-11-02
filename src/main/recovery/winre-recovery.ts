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
import { logger, logDirectory } from '../utils/logger';
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
/** The recovery run's log, copied onto the restored volume by restore.cmd. */
export const RECOVERY_LOG_FILENAME = 'OPBS-restore.log';

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

/**
 * A staged image reference that survives the recovery environment's drive
 * letters: Windows' `E:\images\x.opbs` is frequently `F:\images\x.opbs` (or a
 * different volume entirely) after booting WinRE/WinPE. The path from the
 * volume root plus the file size identify the file no matter which letter the
 * volume ends up with.
 */
export interface StagedImageFallback {
  /** Path from the volume root, e.g. `images\x.opbs` (no drive letter). */
  relativePath: string;
  sizeBytes: number;
}

/**
 * Resolve the image for a staged restore when the recorded drive-letter path
 * no longer exists (the recovery environment re-letters volumes). Tries every
 * lettered volume for the recorded relative path and requires the size to
 * match, so a same-named file elsewhere cannot be picked up by accident.
 *
 * Returns the resolved path, or null when nothing matches — the caller then
 * reports the original missing-path error.
 */
export function resolveStagedImagePath(
  imagePath: string,
  fallback: StagedImageFallback | undefined,
  exists: (candidate: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  sizeOf: (candidate: string) => number = (p) => fs.statSync(p).size
): string | null {
  if (!fallback || !fallback.relativePath) return null;
  const rel = String(fallback.relativePath).replace(/^[\\/]+/, '').replace(/\//g, '\\');
  if (!rel) return null;
  if (fs.existsSync(imagePath)) return imagePath;

  // The recorded volume, whatever letter it has now: try every letter first
  // (cheap — a handful of stat calls), and accept only an exact size match.
  const matches: string[] = [];
  for (let i = 0; i < 26; i++) {
    const candidate = `${String.fromCharCode(65 + i)}:\\${rel}`;
    if (!exists(candidate)) continue;
    try {
      if (typeof fallback.sizeBytes === 'number' && sizeOf(candidate) !== fallback.sizeBytes) continue;
    } catch {
      continue;
    }
    matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
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
  /** Warnings reported by the restore that ran in the recovery environment. */
  warnings?: string[];
  /** Failure reason, when the restore reported one. */
  error?: string;
  bytesWritten?: number;
  /** Where the recovery run's own log was preserved on this machine. */
  logPath?: string;
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
    // The result marker belongs on the volume the staged payload was found on
    // (the freshly restored system volume), not on the RAM copy it runs from.
    'for %%I in ("%STAGED%\\..\\..") do set "VOLROOT=%%~fI"',
    'if "%VOLROOT:~-1%"=="\\" set "VOLROOT=%VOLROOT:~0,-1%"',
    'echo.',
    'echo The restore will start automatically in 10 seconds.',
    'echo Press any key within 10 seconds to cancel and open a command prompt instead.',
    'X:\\OPBS\\node.exe X:\\OPBS\\cancel-window.js',
    'if errorlevel 1 goto :cancelled',
    'call "X:\\OPBS\\restore.cmd"',
    'if errorlevel 1 goto :failed',
    'echo.',
    'echo Restore completed.',
    'if exist "%VOLROOT%\\OPBS-restore-result.json" echo Full result, warnings included: %VOLROOT%\\OPBS-restore-result.json',
    'echo.',
    // Do not reboot over the output. The restore's warnings scroll past in a
    // fraction of a second and the screen used to close with them, so the only
    // way to read them was to run the whole restore again (field report
    // 2026-11-01). Hold, then reboot; any key stays in this window.
    'echo Rebooting back into Windows in 30 seconds.',
    'echo Press any key to stay in this window and read the output instead.',
    'X:\\OPBS\\node.exe X:\\OPBS\\cancel-window.js 30',
    'if errorlevel 1 goto :stay',
    'wpeutil reboot',
    'goto :eof',
    ':stay',
    'echo.',
    'echo Staying in this window. Reboot when ready with: wpeutil reboot',
    'cmd /k',
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
    // startnet.cmd computes this; recompute for a direct run of restore.cmd.
    'if not defined VOLROOT if defined OPBS_STAGED for %%I in ("%OPBS_STAGED%\\..\\..") do set "VOLROOT=%%~fI"',
    'if defined VOLROOT if "%VOLROOT:~-1%"=="\\" set "VOLROOT=%VOLROOT:~0,-1%"',
    'if not defined VOLROOT set "VOLROOT=%SystemDrive%"',
    // Node logs to OPBS_LOG_DIR. In the recovery environment that folder is
    // on the RAM disk, so the log has to be copied onto the restored volume
    // afterwards - writing it there during the restore would be writing into
    // the area being overwritten (field report 2026-11-02: "the logs don't say
    // much", and the recovery run's log was gone by the time anyone looked).
    'set "OPBS_LOG_DIR=%~dp0logs"',
    'mkdir "%OPBS_LOG_DIR%" >nul 2>&1',
    'echo Running the staged restore from OPBS-restore.json ...',
    'echo.',
    // --result writes the job outcome (warnings included) as JSON on the
    // restored volume. stdout is not durable here: the console scrolls and the
    // machine reboots seconds later, so warnings that only exist on screen are
    // lost (field report 2026-11-01).
    'node.exe winpe-entry.js restore "OPBS-restore.json" --elevated --acknowledge-same-disk --result "%VOLROOT%\\OPBS-restore-result.json"',
    'set "RC=%ERRORLEVEL%"',
    'if defined OPBS_LOG_DIR for %%F in ("%OPBS_LOG_DIR%\\*.log") do copy /y "%%~fF" "%VOLROOT%\\OPBS-restore.log" >nul',
    'if exist "%VOLROOT%\\OPBS-restore-result.json" exit /b %RC%',
    // Fallback marker if the CLI died before it could write its own result.
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
  // The recovery environment re-letters volumes: record where the image lives
  // on ITS volume (path + size) so the restore can find it again whichever
  // letter the volume ends up with.
  let fallback: StagedImageFallback | undefined;
  try {
    const root = path.parse(config.imagePath).root;
    const relativePath = path.relative(root, config.imagePath);
    const sizeBytes = fs.statSync(config.imagePath).size;
    if (relativePath && !relativePath.startsWith('..')) {
      fallback = { relativePath, sizeBytes };
    }
  } catch {
    /* image missing/unreadable at stage time — the restore reports it */
  }
  return [
    { name: 'winpe-entry.js', content: buildWinpeEntry() },
    { name: 'restore.cmd', content: buildRecoveryRestoreCmd() },
    { name: 'cancel-window.js', content: buildCancelWindowJs() },
    {
      name: 'OPBS-restore.json',
      content: JSON.stringify(
        {
          imagePath: config.imagePath,
          ...(fallback ? { imagePathFallback: fallback } : {}),
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
  // Auto flow: cmd /c startnet.cmd. If a given winpeshl.exe declined to
  // split arguments, cmd.exe alone opens an interactive console - a safe
  // fallback (type startnet), never a silent failure.
  return ['[LaunchApp]', 'AppPath=X:\\Windows\\System32\\cmd.exe /c X:\\Windows\\System32\\startnet.cmd', ''].join(
    '\r\n'
  );
}

/**
 * 10-second cancel window, run from the recovery console. Exits 0 when the
 * timer expires (proceed with the restore), 1 when the user presses a key
 * (cancel). choice.exe and timeout.com are not present in every recovery
 * image (winre.wim lacks choice) - node always is, it travels with us.
 */
export function buildCancelWindowJs(): string {
  return [
    "'use strict';",
    "const rl = require('readline');",
    "rl.emitKeypressEvents(process.stdin);",
    "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    // Seconds as argv[2] (default 10). The same window serves two jobs: the
    // pre-restore cancel prompt, and the post-restore hold that keeps the
    // warnings on screen instead of rebooting over them (field report
    // 2026-11-01). choice.exe is absent from winre.wim, node travels with us.
    "const seconds = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;",
    "const timer = setTimeout(() => process.exit(0), seconds * 1000);",
    "process.stdin.on('keypress', () => { clearTimeout(timer); process.exit(1); });",
    ''
  ].join('\n');
}

/**
 * PowerShell transcript lines for an elevated session.
 *
 * The outer wrapper cannot combine `Start-Process -Verb RunAs` with
 * `-RedirectStandard*` (AmbiguousParameterSet), so an elevated script has to
 * record its own output. Without these lines the window's output vanishes
 * with the window and the app's log says almost nothing about what the
 * elevated step actually did (field report 2026-11-02: "the logs don't say
 * much — capture the output in the PowerShell window").
 */
function transcriptStart(logPath: string): string {
  return `Start-Transcript -Path ${psSingle(logPath)} -Append -ErrorAction SilentlyContinue | Out-Null`;
}

const transcriptStop = `Stop-Transcript -ErrorAction SilentlyContinue | Out-Null`;

/**
 * Keep a log past its source location's lifetime and report where it went.
 * "Kept in a temp folder" or "on the volume root" is not a place anyone will
 * look — the app's log directory is.
 */
export function preserveLog(source: string, label: string): string | null {
  try {
    if (!fs.existsSync(source)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(logDirectory(), `${label}-${stamp}.log`);
    fs.mkdirSync(logDirectory(), { recursive: true });
    fs.copyFileSync(source, dest);
    return dest;
  } catch {
    return null;
  }
}

/** Where an elevated script writes its transcript (inside the kept work dir). */
export function elevatedLogPath(work: string): string {
  return path.join(work, 'elevated.log');
}

/**
 * Keep the elevated transcript past the work dir's lifetime and report where
 * it went. The temp folder is deleted on success and kept on failure, but
 * "kept in a temp folder" is not a place a user will find — the app's log
 * directory is.
 */
export function preserveElevatedLog(work: string, label: string): string | null {
  return preserveLog(elevatedLogPath(work), label);
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
    // Record the whole elevated session: the wrapper cannot capture it from
    // outside (see transcriptStart), and a step that fails in the dark is a
    // step nobody can debug.
    transcriptStart(elevatedLogPath(p.work)),
    `$work = ${psSingle(p.work)}`,
    `$progressFile = ${psSingle(p.progressFile)}`,
    `$resultFile = ${psSingle(p.resultFile)}`,
    `$stageRoot = Join-Path $env:SystemDrive ${psSingle(RECOVERY_STAGE_DIRNAME)}`,
    `$entryGuid = $null`,
    `$ramdiskGuid = $null`,
    `$bitLockerSuspended = $false`,
    `$winreSource = $null`,
    `function Write-Step([string]$m) {`,
    `  for ($i = 0; $i -lt 5; $i++) {`,
    `    try { Add-Content -Path $progressFile -Value $m; return } catch { Start-Sleep -Milliseconds 200 }`,
    `  }`,
    `}`,
    `function Write-Result([bool]$ok, [string]$error) {`,
    `  $r = @{ ok = $ok; entryGuid = $entryGuid; ramdiskGuid = $ramdiskGuid; bitLockerSuspended = $bitLockerSuspended; winreSource = $winreSource }`,
    `  if ($error) { $r.error = $error }`,
    `  $json = $r | ConvertTo-Json`,
    `  for ($i = 0; $i -lt 5; $i++) {`,
    `    try { Set-Content -Path $resultFile -Value $json -Encoding UTF8; return } catch { Start-Sleep -Milliseconds 200 }`,
    `  }`,
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
    `  & dism /English /Mount-Wim /WimFile:"$wimTarget" /Index:1 /MountDir:"$mount"`,
    `  if ($LASTEXITCODE -ne 0) { throw "dism /Mount-Wim failed with exit code $LASTEXITCODE" }`,
    `  try {`,
    `    [System.IO.File]::WriteAllText((Join-Path $mount 'Windows\\System32\\startnet.cmd'), [System.Text.Encoding]::ASCII.GetString([System.Convert]::FromBase64String('${p.startnetB64}')))`,
    `    [System.IO.File]::WriteAllText((Join-Path $mount 'Windows\\System32\\winpeshl.ini'), [System.Text.Encoding]::ASCII.GetString([System.Convert]::FromBase64String('${p.winpeshlB64}')))`,
    `    & dism /English /Unmount-Wim /MountDir:"$mount" /Commit`,
    `    if ($LASTEXITCODE -ne 0) { throw "dism /Unmount-Wim /Commit failed with exit code $LASTEXITCODE" }`,
    `  } catch {`,
    `    & dism /English /Unmount-Wim /MountDir:"$mount" /Discard`,
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
    `  & bcdedit /set $ramdiskGuid ramdisksdidevice "partition=$sys"`,
    `  & bcdedit /set $ramdiskGuid ramdisksdipath '\\Recovery\\OPBS\\boot.sdi'`,
    `  $entryOut = (& bcdedit /create /d 'OPBS Recovery' /application osloader | Out-String)`,
    `  if ($entryOut -match '\\{[0-9a-fA-F-]+\\}') { $entryGuid = $matches[0] } else { throw "bcdedit /create /application osloader failed: $entryOut" }`,
    `  $wimDev = '[' + $sys + ']\\Recovery\\OPBS\\winre.wim'`,
    `  & bcdedit /set $entryGuid device "ramdisk=$wimDev,$ramdiskGuid"`,
    `  & bcdedit /set $entryGuid osdevice "ramdisk=$wimDev,$ramdiskGuid"`,
    `  # The loader path comes from {current}: PEFirmwareType only exists in`,
    `  # WinPE's registry, so probing it from Windows silently picks the BIOS`,
    `  # loader (winload.exe) on UEFI machines - a black screen right after the`,
    `  # 'Loading files' phase. {current} is the proven ground truth.`,
    `  $loader = $null`,
    `  $enumCur = (& bcdedit /enum '{current}' | Out-String)`,
    `  if ($enumCur -match '(?m)^\\s*path\\s+(\\S+)\\s*$') { $loader = $matches[1] }`,
    `  if (-not $loader) { $loader = '\\windows\\system32\\winload.efi' }`,
    `  & bcdedit /set $entryGuid path $loader`,
    `  & bcdedit /set $entryGuid systemroot '\\windows'`,
    `  & bcdedit /set $entryGuid inherit '{bootloadersettings}'`,
    `  & bcdedit /set $entryGuid nx OptIn`,
    `  & bcdedit /set $entryGuid bootmenupolicy Standard`,
    `  & bcdedit /set $entryGuid detecthal Yes`,
    `  & bcdedit /set $entryGuid winpe Yes`,
    `  & bcdedit /bootsequence $entryGuid`,
    ``,
    `  Write-Step 'Checking BitLocker...'`,
    `  $bl = (& manage-bde -status $env:SystemDrive 2>$null | Out-String)`,
    `  if ($bl -match 'Protection Status:\\s*Protection On') {`,
    `    Write-Step 'Suspending BitLocker protection for one boot...'`,
    `    & manage-bde -protectors -disable $env:SystemDrive -RebootCount 1`,
    `    if ($LASTEXITCODE -ne 0) { throw "manage-bde -protectors -disable failed with exit code $LASTEXITCODE - suspend BitLocker manually, then retry." }`,
    `    $bitLockerSuspended = $true`,
    `  }`,
    ``,
    `  Write-Step 'Staging complete.'`,
    `  Write-Result $true $null`,
    `} catch {`,
    `  Write-Result $false ($_.Exception.Message)`,
    `}`,
    transcriptStop
  ].join('\n');
}

/** Remove a staged recovery restore: boot entry, ramdisk object and folder. */
export function buildCleanupScript(p: { progressFile: string; resultFile: string; entryGuid: string; ramdiskGuid: string }): string {
  return [
    `$ErrorActionPreference = 'Continue'`,
    // Same reason as the staging script: capture what this elevated session
    // does, so a failure is readable afterwards.
    transcriptStart(elevatedLogPath(path.dirname(p.progressFile))),
    `$progressFile = ${psSingle(p.progressFile)}`,
    `$resultFile = ${psSingle(p.resultFile)}`,
    `$stageRoot = Join-Path $env:SystemDrive ${psSingle(RECOVERY_STAGE_DIRNAME)}`,
    `function Write-Step([string]$m) {`,
    `  for ($i = 0; $i -lt 5; $i++) {`,
    `    try { Add-Content -Path $progressFile -Value $m; return } catch { Start-Sleep -Milliseconds 200 }`,
    `  }`,
    `}`,
    `try {`,
    `  Write-Step 'Removing the OPBS Recovery boot entry...'`,
    `  & bcdedit /deletevalue {bootmgr} bootsequence`,
    `  & bcdedit /delete ${psSingle(p.entryGuid)}`,
    `  # Never touch the canonical {ramdiskoptions} (shared with Windows RE).`,
    `  if (${psSingle(p.ramdiskGuid)} -ne '{ae5534e0-a924-466c-b836-758539a3ee3a}') {`,
    `    & bcdedit /delete ${psSingle(p.ramdiskGuid)}`,
    `  }`,
    `  Write-Step 'Removing the staged recovery files...'`,
    `  if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }`,
    `  Write-Step 'Cleanup complete.'`,
    `  (@{ ok = $true; cleaned = $true } | ConvertTo-Json) | Set-Content -Path $resultFile -Encoding UTF8`,
    `} catch {`,
    `  (@{ ok = $false; cleaned = $false; error = $_.Exception.Message } | ConvertTo-Json) | Set-Content -Path $resultFile -Encoding UTF8`,
    `}`,
    transcriptStop
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
/**
 * Turn an elevated step's output into something a person can act on: the tail
 * of the transcript plus where the whole thing was kept. "It failed" with no
 * output is exactly the report nobody can act on (field report 2026-11-02:
 * "the logs don't say much").
 */
function transcriptDetail(work: string, label: string): string {
  const kept = preserveElevatedLog(work, label);
  const tail = readLogTail(elevatedLogPath(work), 1500);
  const parts: string[] = [];
  if (tail) parts.push(`PowerShell output:\n${tail}`);
  if (kept) parts.push(`Full transcript: ${kept}`);
  return parts.length > 0 ? ` ${parts.join('. ')}` : '';
}

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
      const detail = transcriptDetail(work, 'recovery-stage');
      logger.error(`Recovery staging failed: ${error}${detail}`);
      return { ok: false, error: `${error ?? 'Recovery staging failed.'}${detail}` };
    }
    if (!parsed.ok) {
      const detail = transcriptDetail(work, 'recovery-stage');
      const message = `${String(parsed.error ?? 'Recovery staging failed.')} (work kept at ${work} for inspection)${detail}`;
      logger.error(`Recovery staging failed: ${message}`);
      return { ok: false, error: message };
    }
    // Keep the transcript on success too: it is the only record of what the
    // elevated steps actually said, and a staging run is rare enough that one
    // small log per run costs nothing.
    const keptLog = preserveElevatedLog(work, 'recovery-stage');
    if (keptLog) logger.info(`Recovery staging transcript: ${keptLog}`);

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
    // Keep the transcript before the work dir goes: it is the only record of
    // what the elevated step said, on success as well as on failure.
    const detail = transcriptDetail(work, 'recovery-cleanup');
    if (!parsed) return { ok: false, error: `${error ?? 'Cleanup failed.'}${detail}` };
    fs.rmSync(work, { recursive: true, force: true });
    return parsed.ok ? { ok: true, cleaned: true } : { ok: false, error: `${String(parsed.error ?? 'Cleanup failed.')}${detail}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Windows-side status: is a restore staged, and did the last PE restore leave
 * a result marker? The marker is consumed (deleted) on read.
 */
export function readRecoveryStatus(): RecoveryStatusResult {
  const root = process.env.SystemDrive ?? 'C:';
  const stageRoot = path.join(root, RECOVERY_STAGE_DIRNAME);
  const staged = fs.existsSync(stageRoot);
  const resultPath = path.join(root, RECOVERY_RESULT_FILENAME);

  // The recovery run's own log is copied onto the restored volume by
  // restore.cmd, because the folder it is written to lives on the RAM disk
  // and dies with it. Preserve it into the app's log directory first: the
  // volume root is where stray files get cleaned up, and this log is the only
  // record of what the run actually did (field report 2026-11-02).
  let preservedLog: string | null = null;
  try {
    preservedLog = preserveLog(path.join(root, RECOVERY_LOG_FILENAME), 'recovery-restore');
    if (preservedLog) {
      fs.rmSync(path.join(root, RECOVERY_LOG_FILENAME), { force: true });
      logger.info(`Recovery run log preserved at ${preservedLog}`);
    }
  } catch {
    /* unpreservable — the run's log stays where it is */
  }

  let pendingResult: RecoveryPendingResult | null = null;
  try {
    if (fs.existsSync(resultPath)) {
      const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as {
        ok?: boolean;
        exitCode?: number;
        finishedAt?: string;
        warnings?: unknown;
        error?: unknown;
        bytesWritten?: number;
      };
      // Warnings are the point of this file: the recovery console scrolls and
      // reboots, so this is the only place they survive. Bound them so a
      // pathological run cannot turn the startup toast into a wall of text.
      const warnings = Array.isArray(raw.warnings)
        ? raw.warnings
            .filter((w): w is string => typeof w === 'string')
            .slice(0, 20)
            .map((w) => w.slice(0, 500))
        : [];
      pendingResult = {
        ok: !!raw.ok,
        ...(typeof raw.exitCode === 'number' ? { exitCode: raw.exitCode } : {}),
        ...(raw.finishedAt ? { finishedAt: String(raw.finishedAt) } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(typeof raw.error === 'string' && raw.error ? { error: raw.error.slice(0, 500) } : {}),
        ...(typeof raw.bytesWritten === 'number' ? { bytesWritten: raw.bytesWritten } : {}),
        ...(preservedLog ? { logPath: preservedLog } : {})
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
