import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { locateAdk, peArchForProcess, PeArch } from './adk';

/**
 * WinPE recovery media builder.
 *
 * Creates a bootable OPBS recovery ISO (or USB key) carrying:
 *   - a stock Node.js runtime + the compiled CLI/dist tree,
 *   - the native disk-addon (kept at the relative path native-loader expects),
 *   - winpe-entry.js (headless runCli entry) + restore.cmd / example config,
 *   - a startnet.cmd injected into the WinPE boot.wim that launches restore.cmd.
 *
 * The heavy ADK steps (copype, DISM mount/commit, MakeWinPEMedia) run in a
 * single elevated PowerShell so the whole build needs one UAC confirmation.
 */

export const PE_ARCH_DEFAULT = peArchForProcess();

export interface MediaCreateOptions {
  arch?: PeArch;
  /** iso => produce a .iso file; usb => write to a removable drive letter. */
  format: 'iso' | 'usb';
  /** ISO output path, or USB drive letter (e.g. 'E'). */
  output: string;
  /** Override the ADK kit root when it is not at the default location. */
  adkRoot?: string;
  /** Override the bundled Node.exe (default: the running Node installation). */
  nodeExe?: string;
  /** Compiled main JS tree (defaults to <repo>/dist). */
  distDir?: string;
  /** Compiled native addon (defaults to <repo>/src/native/build/Release). */
  nativeNode?: string;
  /** A restore config (JSON) to pre-seed onto the media as OPBS-restore.json,
   *  so restore.cmd runs it automatically instead of prompting. */
  restoreConfig?: string;
  /** Required for USB output (destroys the target drive contents). */
  yesForUsb?: boolean;
  /** Third-party driver directories to inject into the boot.wim via DISM
   *  (/Add-Driver /Recurse) before the media image is finalized. */
  drivers?: string[];
  /** Stage the payload + build script only; do NOT spawn the elevated ADK
   *  step. Useful in CI or shells that cannot raise UAC: run the returned
   *  `scriptPath` from an already-elevated PowerShell. */
  scriptOnly?: boolean;
}

export interface MediaCreateResult {
  ok: boolean;
  format: 'iso' | 'usb';
  output: string;
  arch: PeArch;
  sizeBytes?: number;
  /** Present when `scriptOnly` was requested: run this from an elevated PowerShell. */
  scriptPath?: string;
  error?: string;
}

/** A file to stage relative to the OPBS payload root. */
export interface PayloadItem {
  from: string;
  /** Relative destination under <stage>/media/OPBS. */
  to: string;
}

/** Resolve a stock Node.exe to bundle. Never returns a path inside the app. */
export function resolveNodeExe(explicit?: string): string | null {
  const seen = (candidate: string): boolean => {
    if (!candidate) return false;
    return /node(\.exe)?$/i.test(path.basename(candidate)) && fs.existsSync(candidate);
  };
  if (explicit) return seen(explicit) ? explicit : null;

  const candidates: string[] = [];
  if (process.env.npm_node_execpath) candidates.push(process.env.npm_node_execpath);
  if (seen(process.execPath)) candidates.unshift(process.execPath);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const out = require('child_process').execFileSync('node', ['-p', 'process.execPath'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const reported = out.trim();
    if (seen(reported)) candidates.unshift(reported);
  } catch {
    /* fall through */
  }

  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (pf) candidates.push(path.join(pf, 'nodejs', 'node.exe'));
  }
  return candidates.find(seen) ?? null;
}

export function resolveDistDir(explicit?: string): string {
  return explicit ?? path.resolve(__dirname, '../../dist');
}

export function resolveNativeNode(explicit?: string): string {
  return explicit ?? path.resolve(__dirname, '../../src/native/build/Release/opbs_native.node');
}

/** Resolve the source folders of the runtime-only npm packages (pure JS). */
export function resolveBundleNodeModules(packages: string[]): Array<{ name: string; dir: string }> {
  return packages.map((pkg) => {
    const pkgName = pkg.split('/')[0];
    try {
      const entry = require.resolve(pkg);
      let dir = path.dirname(entry);
      while (dir !== path.dirname(dir)) {
        const pkgJson = path.join(dir, 'package.json');
        try {
          if (JSON.parse(fs.readFileSync(pkgJson, 'utf-8')).name === pkg) {
            return { name: pkgName, dir };
          }
        } catch {
          /* keep climbing */
        }
        dir = path.dirname(dir);
      }
      return { name: pkgName, dir: '' };
    } catch {
      return { name: pkgName, dir: '' };
    }
  });
}

export function planPayloadCopies(options: {
  nodeExe: string;
  distDir: string;
  nativeNode: string;
  nodeModules: Array<{ name: string; dir: string }>;
}): PayloadItem[] {
  const items: PayloadItem[] = [];
  for (const mod of options.nodeModules) {
    if (mod.dir) {
      items.push({ from: mod.dir, to: `node_modules/${mod.name}` });
    }
  }
  items.push({
    from: options.nativeNode,
    to: path.join('src', 'native', 'build', 'Release', path.basename(options.nativeNode))
  });
  items.push({ from: options.distDir, to: 'dist' });
  items.push({ from: options.nodeExe, to: 'node.exe' });
  return items;
}

/**
 * If a restore config is supplied, stage it as `OPBS-restore.json` in the
 * payload root so `restore.cmd` runs it automatically instead of prompting.
 * Returns null when no config was requested.
 */
export function planRestoreConfigCopy(restoreConfig?: string): PayloadItem | null {
  if (!restoreConfig) return null;
  return { from: restoreConfig, to: 'OPBS-restore.json' };
}

/** Files written into the OPBS payload root from embedded templates. */
export interface PayloadTextFile {
  name: string;
  content: string;
}

export function buildStartnetCmd(): string {
  return [
    '@echo off',
    'title OPBS Recovery',
    'mode con cols=100 lines=40',
    'echo.',
    'echo  Starting OPBS Recovery Media, please wait...',
    'call wpeinit',
    '',
    'set OPBS_ROOT=',
    'for %%D in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do (',
    '  if not defined OPBS_ROOT if exist "%%D:\\OPBS\\node.exe" set OPBS_ROOT=%%D:\\OPBS',
    ')',
    'if defined OPBS_ROOT goto :found',
    'timeout /t 8 /nobreak >nul',
    'for %%D in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do (',
    '  if not defined OPBS_ROOT if exist "%%D:\\OPBS\\node.exe" set OPBS_ROOT=%%D:\\OPBS',
    ')',
    'if not defined OPBS_ROOT goto :notfound',
    ':found',
    'cd /d "%OPBS_ROOT%"',
    'start "%OPBS_ROOT%\\restore.cmd"',
    'exit /b 0',
    ':notfound',
    'echo.',
    'echo  ERROR: OPBS payload not found on this media.',
    'echo  Burn/copy the ISO and boot it again, or mount the added drive.',
    'pause',
    'exit /b 1'
  ].join('\r\n');
}

export function buildRestoreCmd(): string {
  return [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'title OPBS Restore',
    'mode con cols=100 lines=40',
    'cd /d "%~dp0"',
    'echo ============================================================',
    'echo   OPBS - Open Pickle Backup System - Recovery Media',
    'echo ============================================================',
    'echo.',
    'set "CFG="',
    'if exist "%~dp0OPBS-restore.json" set CFG=%~dp0OPBS-restore.json',
    'if defined CFG goto :run',
    'echo  Enter the path to the OPBS restore config (JSON) generated on',
    'echo  the backup machine, for example:',
    'echo.',
    'echo       D:\\backups\\restore.json',
    'echo.',
    'echo  (leave empty to abort)',
    'echo.',
    'set /p CFG=Config path: ',
    'if not defined CFG exit /b 1',
    ':run',
    '"%~dp0node.exe" "%~dp0winpe-entry.js" restore "%CFG%" --elevated',
    'set RC=%ERRORLEVEL%',
    'echo.',
    'if not "%RC%"=="0" (',
    '  echo  Restore finished with error code %RC%.',
    '  pause',
    '  exit /b %RC%',
    ')',
    'echo  Restore completed successfully.',
    'pause',
    'endlocal'
  ].join('\r\n');
}

export function buildExampleRestoreConfig(): string {
  return JSON.stringify(
    {
      imagePath: 'D:\\backups\\system.opbs',
      targetDiskIndex: 0,
      targetPartitions: [0, 1],
      passphrase: '',
      verifyBeforeWrite: true
    },
    null,
    2
  );
}

export function buildReadme(): string {
  return [
    'OPBS Recovery Media',
    '===================',
    '',
    'This media boots into Windows PE and restores an OPBS .opbs backup image',
    'to a selected disk using the headless OPBS CLI.',
    '',
    'How to restore',
    '--------------',
    '1. Boot this media on the target machine.',
    "2. Copy the restore config (create one on the backup machine with",
    "   'new-config' or by hand; see OPBS-restore.example.json) to any",
    '   accessible volume as OPBS-restore.json, or type its path at the prompt.',
    '3. restore.cmd runs:  node.exe winpe-entry.js restore <config> --elevated',
    '',
    'The restore config fields (sourceImagePath / destinationDiskIndex are',
    'accepted as aliases for imagePath / targetDiskIndex):',
    '   imagePath          : the .opbs image to restore',
    '   targetDiskIndex    : target physical disk (list with the disks command)',
    '   targetPartitions   : partition indexes to restore (0 = whole disk)',
    '   passphrase         : passphrase for encrypted images (leave empty if none)',
    '',
    'Dry-run the restore without writing anything (validates the image, the',
    'target disk size and the safety gates):',
    '   node.exe winpe-entry.js restore X:\\path\\restore.json --preflight',
    '',
    'Manual CLI usage (Shift+F10 console):',
    '   cd /d <media-drive>:\\OPBS',
    '   node.exe winpe-entry.js disks',
    '   node.exe winpe-entry.js restore X:\\path\\restore.json --elevated',
    '',
    'OPBS headless CLI embedded on this media.'
  ].join('\r\n');
}

export function payloadTextFiles(): PayloadTextFile[] {
  return [
    { name: 'restore.cmd', content: buildRestoreCmd() },
    { name: 'winpe-entry.js', content: buildWinpeEntry() },
    { name: 'OPBS-restore.example.json', content: buildExampleRestoreConfig() },
    { name: 'README.txt', content: buildReadme() }
  ];
}

function buildWinpeEntry(): string {
  return [
    "'use strict';",
    "const path = require('path');",
    "const { runCli } = require(path.join(__dirname, 'dist', 'cli', 'index.js'));",
    'runCli(process.argv.slice(2))',
    '  .then((code) => process.exit(code))',
    '  .catch((error) => {',
    '    console.error(error instanceof Error ? error.stack : String(error));',
    '    process.exit(1);',
    '  });'
  ].join('\n');
}

function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function base64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * The elevated PowerShell orchestrator. Written to a temp script and launched
 * via `Start-Process -Verb RunAs`. Writes <stage>/result.json on completion.
 */
export function buildElevatedScript(options: {
  arch: PeArch;
  format: 'iso' | 'usb';
  output: string;
  stage: string;
  adkCopype: string;
  adkDandISetEnv: string;
  adkDism: string;
  adkMakeWinPEMedia: string;
  payloadCopies: PayloadItem[];
  payloadTextFiles: PayloadTextFile[];
  startnetCmd: string;
  yesForUsb: boolean;
  drivers?: string[];
}): string {
  const { arch, format, output, stage, payloadCopies, payloadTextFiles, startnetCmd } = options;
  const outputArg = format === 'usb' ? `${output.replace(/:$/, '')}:` : output;
  const lines: string[] = [];
  lines.push('$ErrorActionPreference = "Stop"');
  // Ensure System32 is on PATH so `reg` (needed by DandISetEnv) and `dism`
  // resolve even when this process was spawned from an environment with a
  // restricted PATH (e.g. a dev shell).
  lines.push('$env:Path = "$env:SystemRoot\\System32;$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0;$env:Path"');
  lines.push('function Write-Result($obj) {');
  lines.push(`  $obj | ConvertTo-Json | Set-Content -Path ${psQuote(path.join(stage, 'result.json'))} -Encoding UTF8`);
  lines.push('}');
  // copype + MakeWinPEMedia need the Deployment Tools environment (DandISetEnv
  // sets WinPERoot/OSCDImgRoot and puts oscdimg on PATH), so each runs inside
  // one cmd that sources it first. NOTE: do not pre-create <stage>: copype
  // refuses an existing destination.
  const cmdCall = (inner: string): string =>
    `& $env:ComSpec /d /s /c 'call "${options.adkDandISetEnv}" >NUL && ${inner}'`;
  lines.push(cmdCall(`call "${options.adkCopype}" ${arch} "${stage}"`));
  lines.push(`if ($LASTEXITCODE -ne 0) { Write-Result @{ok=$false;error="copype failed with exit code $LASTEXITCODE"}; exit 0 }`);
  lines.push('');
  // Payload + embedded files into <stage>/media/OPBS
  lines.push(`New-Item -ItemType Directory -Force -Path ${psQuote(path.join(stage, 'media', 'OPBS'))} | Out-Null`);
  for (const item of payloadCopies) {
    const dest = path.resolve(stage, 'media', 'OPBS', item.to);
    lines.push(`New-Item -ItemType Directory -Force -Path ${psQuote(path.dirname(dest))} | Out-Null`);
    lines.push(`Copy-Item -Path ${psQuote(item.from)} -Destination ${psQuote(dest)} -Recurse -Force`);
  }
  for (const file of payloadTextFiles) {
    const dest = path.join(stage, 'media', 'OPBS', file.name);
    lines.push(
      `[IO.File]::WriteAllText(${psQuote(dest)}, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(base64(file.content))})))`
    );
  }
  lines.push('');
  // Inject startnet.cmd into the boot.wim
  const mountDir = path.join(stage, 'mount');
  lines.push(`New-Item -ItemType Directory -Force -Path ${psQuote(mountDir)} | Out-Null`);
  lines.push(`& ${psQuote(options.adkDism)} /Mount-Wim /WimFile:${psQuote(path.join(stage, 'media', 'sources', 'boot.wim'))} /index:1 /MountDir:${psQuote(mountDir)}`);
  lines.push(`if ($LASTEXITCODE -ne 0) { Write-Result @{ok=$false;error="DISM mount failed with exit code $LASTEXITCODE"}; exit 0 }`);
  lines.push(
    `[IO.File]::WriteAllText(${psQuote(path.join(mountDir, 'Windows', 'System32', 'startnet.cmd'))}, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(base64(startnetCmd))})))`
  );
  for (const driver of options.drivers ?? []) {
    lines.push(`if (-not (Test-Path -LiteralPath ${psQuote(driver)})) { Write-Result @{ok=$false;error="Driver directory not found: ${psQuote(driver)}"}; exit 0 }`);
    lines.push(`& ${psQuote(options.adkDism)} /Image:${psQuote(mountDir)} /Add-Driver /Driver:${psQuote(driver)} /Recurse`);
    lines.push(`if ($LASTEXITCODE -ne 0) { Write-Result @{ok=$false;error="DISM /Add-Driver failed (${psQuote(driver)}) with exit code $LASTEXITCODE"}; exit 0 }`);
  }
  lines.push(`& ${psQuote(options.adkDism)} /Unmount-Wim /MountDir:${psQuote(mountDir)} /Commit`);
  lines.push(`if ($LASTEXITCODE -ne 0) { Write-Result @{ok=$false;error="DISM unmount failed with exit code $LASTEXITCODE"}; exit 0 }`);
  lines.push('');
  // Produce the media
  if (format === 'usb' && !options.yesForUsb) {
    lines.push('Write-Result @{ok=$false;error="USB output requires explicit confirmation (--yes)"}; exit 0');
  }
  lines.push(cmdCall(`call "${options.adkMakeWinPEMedia}" /${format === 'iso' ? 'ISO' : 'USB'} "${stage}" "${outputArg}"`));
  lines.push(`if ($LASTEXITCODE -ne 0) { Write-Result @{ok=$false;error="MakeWinPEMedia failed with exit code $LASTEXITCODE"}; exit 0 }`);
  lines.push('Write-Result @{ok=$true;output=' + psQuote(outputArg) + '}');
  lines.push('exit 0');
  return lines.join('\r\n');
}

function runPowershell(script: string): Promise<{ code: number }> {
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
        script
      ]
        .map(psQuote)
        .join(', ')}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $p) { exit 5 }; exit $p.ExitCode`;
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', wrapper], {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
}

/** Create the recovery media. Requires a UAC confirmation for the ADK steps. */
export async function createRecoveryMedia(options: MediaCreateOptions): Promise<MediaCreateResult> {
  const arch = options.arch ?? PE_ARCH_DEFAULT;
  const adk = locateAdk(arch, options.adkRoot);
  if (!adk || !adk.copype || !adk.dism || !adk.makeWinPEMedia) {
    return {
      ok: false,
      format: options.format,
      output: options.output,
      arch,
      error:
        'Windows ADK (Assessment and Deployment Kit) with the Windows Preinstallation Environment ' +
        'component was not found. Install it from Microsoft, then retry (--adk can point at the kit).'
    };
  }

  if (options.format === 'usb' && !options.yesForUsb) {
    return {
      ok: false,
      format: 'usb',
      output: options.output,
      arch,
      error: 'USB output replaces the drive contents; pass --yes to confirm.'
    };
  }

  const nodeExe = resolveNodeExe(options.nodeExe);
  if (!nodeExe) {
    return {
      ok: false,
      format: options.format,
      output: options.output,
      arch,
      error: 'Could not locate a bundled Node.exe (install Node.js or pass --node <path>).'
    };
  }

  const distDir = resolveDistDir(options.distDir);
  const nativeNode = resolveNativeNode(options.nativeNode);
  for (const [label, p] of [
    ['dist', distDir],
    ['native addon', nativeNode]
  ] as const) {
    if (!fs.existsSync(p)) {
      return { ok: false, format: options.format, output: options.output, arch, error: `${label} not found: ${p}` };
    }
  }

  const moduleRoots = resolveBundleNodeModules(['fzstd', 'zstdify']);
  if (moduleRoots.some((m) => !m.dir)) {
    return {
      ok: false,
      format: options.format,
      output: options.output,
      arch,
      error: 'Runtime codec packages (fzstd/zstdify) are not installed in this workspace.'
    };
  }

  const restoreConfigCopy = planRestoreConfigCopy(options.restoreConfig);
  if (restoreConfigCopy && !fs.existsSync(restoreConfigCopy.from)) {
    return {
      ok: false,
      format: options.format,
      output: options.output,
      arch,
      error: `Restore config not found: ${restoreConfigCopy.from}`
    };
  }

  for (const driver of options.drivers ?? []) {
    if (!fs.existsSync(driver)) {
      return {
        ok: false,
        format: options.format,
        output: options.output,
        arch,
        error: `Driver directory not found: ${driver}`
      };
    }
  }

  // `work` holds the build script + result; `stage` is the copype destination
  // and MUST NOT exist beforehand (copype refuses an existing destination).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-winpe-'));
  const stage = path.join(work, 'build');
  const payloadCopies = [
    ...planPayloadCopies({ nodeExe, distDir, nativeNode, nodeModules: moduleRoots }),
    ...(restoreConfigCopy ? [restoreConfigCopy] : [])
  ];
  const script = path.join(work, 'build.ps1');
  fs.writeFileSync(
    script,
    buildElevatedScript({
      arch,
      format: options.format,
      output: options.output,
      stage,
      adkCopype: adk.copype,
      adkDandISetEnv: adk.dandiSetEnv,
      adkDism: adk.dism,
      adkMakeWinPEMedia: adk.makeWinPEMedia,
      payloadCopies,
      payloadTextFiles: payloadTextFiles(),
      startnetCmd: buildStartnetCmd(),
      yesForUsb: options.yesForUsb ?? false,
      drivers: options.drivers ?? []
    }),
    'utf-8'
  );

  // `--script-only`: hand the build over to the caller instead of raising UAC.
  // Return before the `try` below, whose `finally` deletes `work` on success.
  if (options.scriptOnly) {
    return {
      ok: true,
      format: options.format,
      output: options.output,
      arch,
      scriptPath: script
    };
  }

  try {
    const elevated = await runPowershell(script);
    const resultPath = path.join(stage, 'result.json');
    if (!fs.existsSync(resultPath)) {
      return {
        ok: false,
        format: options.format,
        output: options.output,
        arch,
        error:
          `Elevated ADK step did not produce a result (UAC exit code ${elevated.code}; declined or the window ` +
          `closed early). Work kept at ${work} (run ${script} from an elevated PowerShell to retry).`
      };
    }
    const parsed = JSON.parse(
      fs.readFileSync(resultPath, 'utf-8').replace(/^\uFEFF/, '')
    ) as { ok?: boolean; error?: string; output?: string };
    if (!parsed.ok) {
      return {
        ok: false,
        format: options.format,
        output: options.output,
        arch,
        error: `${parsed.error ?? 'Media build failed'} (work kept at ${work} for inspection)`
      };
    }
    let sizeBytes: number | undefined;
    if (options.format === 'iso') {
      const iso = path.resolve(options.output);
      sizeBytes = fs.existsSync(iso) ? fs.statSync(iso).size : undefined;
    }
    return { ok: true, format: options.format, output: options.output, arch, sizeBytes };
  } finally {
    // Keep the staging directory when the build failed (so the elevated script
    // can be re-run manually); clean it up on success.
    if (fs.existsSync(path.join(stage, 'result.json'))) {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

/** A single observed fact from a payload smoke run. */
export interface SmokeCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface PayloadSmokeOptions {
  /** Bundled Node.exe (default: resolved from the running environment). */
  nodeExe?: string;
  distDir?: string;
  nativeNode?: string;
  restoreConfig?: string;
}

export interface PayloadSmokeResult {
  ok: boolean;
  payloadRoot?: string;
  output?: string;
  error?: string;
  checks: SmokeCheck[];
}

/** Check an individual smoke fact, preserving detail text. */
function check(name: string, ok: boolean, detail?: string): SmokeCheck {
  return { check: name, ok, detail };
}

/**
 * Headless payload smoke test for recovery media. Stages the exact payload
 * plan (node.exe, dist, native addon, codecs, embedded text files) into a temp
 * directory and boots the *payload* the same way restore.cmd would — running
 * the bundled Node.exe against winpe-entry.js — with a self-check command that
 * loads the native addon and codecs. This exercises everything the media
 * carries except the actual WinPE boot itself (which needs a real machine).
 */
export function smokeMediaPayload(options: PayloadSmokeOptions = {}): PayloadSmokeResult {
  const checks: SmokeCheck[] = [];
  const nodeExe = resolveNodeExe(options.nodeExe);
  if (!nodeExe) {
    checks.push(check('node.exe', false, 'No stock Node.exe found'));
    return { ok: false, error: 'Could not locate a bundled Node.exe.', checks };
  }
  checks.push(check('node.exe', true, nodeExe));

  const distDir = resolveDistDir(options.distDir);
  const nativeNode = resolveNativeNode(options.nativeNode);
  checks.push(check('dist', fs.existsSync(distDir), distDir));
  checks.push(check('native addon', fs.existsSync(nativeNode), nativeNode));
  if (!fs.existsSync(distDir) || !fs.existsSync(nativeNode)) {
    return { ok: false, error: 'dist or native addon missing in the workspace.', checks };
  }

  const moduleRoots = resolveBundleNodeModules(['fzstd', 'zstdify']);
  for (const mod of moduleRoots) {
    checks.push(check(`codec ${mod.name}`, !!mod.dir, mod.dir || 'not resolvable'));
  }
  if (moduleRoots.some((m) => !m.dir)) {
    return { ok: false, error: 'Runtime codec packages are not installed.', checks };
  }

  const restoreConfigCopy = planRestoreConfigCopy(options.restoreConfig);
  if (restoreConfigCopy && !fs.existsSync(restoreConfigCopy.from)) {
    checks.push(check('restore config', false, restoreConfigCopy.from));
    return { ok: false, error: `Restore config not found: ${restoreConfigCopy.from}`, checks };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-winpe-smoke-'));
  const payloadRoot = path.join(root, 'OPBS');
  let succeeded = false;
  try {
    fs.mkdirSync(path.join(payloadRoot, 'dist'), { recursive: true });
    const copies = [
      ...planPayloadCopies({ nodeExe, distDir, nativeNode, nodeModules: moduleRoots }),
      ...(restoreConfigCopy ? [restoreConfigCopy] : [])
    ];
    for (const item of copies) {
      const dest = path.resolve(payloadRoot, item.to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const stat = fs.statSync(item.from);
      if (stat.isDirectory()) {
        fs.cpSync(item.from, dest, { recursive: true });
      } else {
        fs.copyFileSync(item.from, dest);
      }
    }
    for (const file of payloadTextFiles()) {
      fs.writeFileSync(path.join(payloadRoot, file.name), file.content, 'utf-8');
    }
    checks.push(check('winpe-entry.js', fs.existsSync(path.join(payloadRoot, 'winpe-entry.js')), payloadRoot));
    checks.push(
      check('restore.cmd', fs.existsSync(path.join(payloadRoot, 'restore.cmd')), 'restore.cmd present')
    );

    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync(nodeExe, ['winpe-entry.js', 'smoke-selfcheck'], {
        cwd: payloadRoot,
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 30000
      }).trim();
    } catch (error) {
      const err = error as { status?: number | null; stdout?: string; stderr?: string; message?: string };
      exitCode = err.status ?? 1;
      output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    }
    checks.push(check('payload exit', exitCode === 0, `exit ${exitCode}`));
    let parsed: { ok?: boolean; crc32?: number | null; codecs?: Record<string, boolean> } | null = null;
    try {
      const decoded = JSON.parse(output.split('\n').filter((l) => l.startsWith('{')).pop() ?? 'null') as
        | { ok?: boolean; crc32?: number | null; codecs?: Record<string, boolean> }
        | null;
      parsed = decoded && typeof decoded === 'object' ? decoded : null;
    } catch {
      parsed = null;
    }
    const nativeOk = parsed?.ok === true;
    checks.push(check('native addon loads', nativeOk, output.slice(0, 400) || 'no output'));
    succeeded = exitCode === 0 && nativeOk;
    return {
      ok: succeeded,
      payloadRoot,
      output,
      checks
    };
  } catch (error) {
    checks.push(check('stage', false, error instanceof Error ? error.message : String(error)));
    return { ok: false, payloadRoot, checks };
  } finally {
    if (succeeded) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}