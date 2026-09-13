import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { locateAdk, peArchForProcess } from './adk';
import { logger } from './logger';

/**
 * Silent Windows ADK installer.
 *
 * Downloads the ADK bootstrap (`adksetup.exe`) and the WinPE add-on bootstrap
 * (`adkwinpesetup.exe`), then runs both in a single elevated PowerShell with
 * `/quiet` so the operator only sees one UAC confirmation. All ADK UI is
 * suppressed; license terms are accepted by the silent `installpath`/`features`
 * combination (Microsoft documented behavior).
 */

/** Windows ADK for Windows 11 bootstrap (Deployment Tools, DISM, ...). */
export const ADK_SETUP_URL = 'https://go.microsoft.com/fwlink/?linkid=2289980';
/** Windows PE add-on bootstrap (copype, MakeWinPEMedia, ...). */
export const ADK_WINPE_URL = 'https://go.microsoft.com/fwlink/?linkid=2289981';

export interface AdkInstallOptions {
  /** Pre-downloaded adksetup.exe; skips the download when provided. */
  adkSetup?: string;
  /** Pre-downloaded adkwinpesetup.exe; skips the download when provided. */
  adkWinPe?: string;
  /** Optional ADK install path (/installpath). */
  installPath?: string;
}

export interface AdkInstallStep {
  name: string;
  exitCode: number;
}

export interface AdkInstallResult {
  ok: boolean;
  adkRoot: string | null;
  steps: AdkInstallStep[];
  error?: string;
}

export interface AdkInstallScriptPlan {
  adkSetup: string;
  adkWinPe: string;
  installPath?: string;
  resultPath: string;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the elevated PowerShell payload that runs both ADK bootstraps silently
 * and records each step's exit code (and an overall status) to `resultPath`.
 * Pure so the unit tests exercise quoting + flags without elevation.
 */
export function buildAdkInstallScript(plan: AdkInstallScriptPlan): string {
  const installArg =
    plan.installPath && plan.installPath.trim() !== ''
      ? ` @('/features','OptionId.DeploymentTools','/quiet','/norestart','/ceip','off','/installpath',${psQuote(plan.installPath.trim())})`
      : ` @('/features','OptionId.DeploymentTools','/quiet','/norestart','/ceip','off')`;
  return [
    "$ErrorActionPreference = 'Continue'",
    `$resultPath = ${psQuote(plan.resultPath)}`,
    '$steps = @()',
    'function Run-AdkStep {',
    '  param([string]$Name, [string]$Exe, [string[]]$Args)',
    '  $p = Start-Process -FilePath $Exe -ArgumentList $Args -Wait -PassThru',
    '  $script:steps += [pscustomobject]@{ name = $Name; exitCode = $p.ExitCode }',
    '  return $p.ExitCode',
    '}',
    `$code1 = Run-AdkStep 'ADK (Deployment Tools)' ${psQuote(plan.adkSetup)}${installArg}`,
    `$code2 = Run-AdkStep 'WinPE add-on (Windows Preinstallation Environment)' ${psQuote(plan.adkWinPe)} @('/features','OptionId.WindowsPreinstallationEnvironment','/quiet','/norestart','/ceip','off')`,
    '$overall = 0',
    'if ($code1 -ne 0 -or $code2 -ne 0) { $overall = 1 }',
    '[IO.File]::WriteAllText($resultPath, $steps | ConvertTo-Json -Compress)',
    'exit $overall'
  ].join('\r\n');
}

function runElevatedPowerShell(scriptPath: string): Promise<number> {
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

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error(`Downloaded empty file from ${url}`);
  }
  fs.writeFileSync(dest, buf);
}

/**
 * Download the ADK bootstraps (unless overridden), run both installers silently
 * behind one UAC confirmation, then re-locate the kit to confirm the WinPE
 * component is now present.
 */
export async function installAdkExe(options: AdkInstallOptions = {}): Promise<AdkInstallResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-adk-'));
  const resultPath = path.join(dir, 'result.json');
  try {
    const adkSetup = options.adkSetup ?? path.join(dir, 'adksetup.exe');
    const adkWinPe = options.adkWinPe ?? path.join(dir, 'adkwinpesetup.exe');
    if (!options.adkSetup) {
      logger.info(`Downloading Windows ADK bootstrap: ${ADK_SETUP_URL}`);
      await downloadToFile(ADK_SETUP_URL, adkSetup);
    }
    if (!options.adkWinPe) {
      logger.info(`Downloading Windows PE add-on bootstrap: ${ADK_WINPE_URL}`);
      await downloadToFile(ADK_WINPE_URL, adkWinPe);
    }
    for (const [label, p] of [
      ['adksetup.exe', adkSetup],
      ['adkwinpesetup.exe', adkWinPe]
    ] as const) {
      if (!fs.existsSync(p) || fs.statSync(p).size < 100000) {
        return {
          ok: false,
          adkRoot: null,
          steps: [],
          error: `${label} was not downloaded correctly (missing or unexpectedly small file).`
        };
      }
    }

    const script = path.join(dir, 'install.ps1');
    fs.writeFileSync(script, buildAdkInstallScript({ adkSetup, adkWinPe, installPath: options.installPath, resultPath }), 'utf-8');

    const code = await runElevatedPowerShell(script);
    let steps: AdkInstallStep[] = [];
    if (fs.existsSync(resultPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Array<{ name: string; exitCode: number }>;
        steps = raw.map((s) => ({ name: s.name, exitCode: s.exitCode }));
      } catch {
        logger.warn('ADK installer result.json was unreadable; falling back to overall exit code.');
      }
    }

    const adk = locateAdk(peArchForProcess());
    if (code === 0 && adk) {
      logger.info(`Windows ADK installed at ${adk.root}`);
      return { ok: true, adkRoot: adk.root, steps };
    }
    const failure = adk ? `installer reported a failure` : 'ADK still not detected after install';
    const detail = steps.find((s) => s.exitCode !== 0)?.name ?? '';
    logger.error(`Windows ADK install failed: ${failure}`);
    return {
      ok: false,
      adkRoot: adk?.root ?? null,
      steps,
      error: `${failure}${detail ? ` (${detail})` : ''}. Run the ADK installer manually and retry.`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Windows ADK install failed: ${message}`);
    return { ok: false, adkRoot: null, steps: [], error: message };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}