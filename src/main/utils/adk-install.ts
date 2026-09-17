import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { locateAdk, peArchForProcess } from './adk';
import { psQuote, runElevatedPowerShell } from './elevated';
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
  /** Directory containing the ADK installer logs (present on failure). */
  logDir?: string;
}

export interface AdkInstallScriptPlan {
  adkSetup: string;
  adkWinPe: string;
  installPath?: string;
  resultPath: string;
  /** Optional log file for the ADK (Deployment Tools) step. */
  adkSetupLog?: string;
  /** Optional log file for the WinPE add-on step. */
  adkWinPeLog?: string;
}

/**
 * Build the elevated PowerShell payload that runs both ADK bootstraps silently
 * and records each step's exit code (and an overall status) to `resultPath`.
 * Pure so the unit tests exercise quoting + flags without elevation.
 *
 * Note: the per-step argument parameter is deliberately NOT named `$Args` —
 * `$Args` is a reserved automatic variable in PowerShell, so a parameter with
 * that name never receives its argument and the installers would be launched
 * with an empty command line.
 */
export function buildAdkInstallScript(plan: AdkInstallScriptPlan): string {
  const installArg =
    plan.installPath && plan.installPath.trim() !== ''
      ? ` @('/features','OptionId.DeploymentTools','/quiet','/norestart','/ceip','off','/installpath',${psQuote(plan.installPath.trim())})`
      : ` @('/features','OptionId.DeploymentTools','/quiet','/norestart','/ceip','off')`;
  const setupLogArg = plan.adkSetupLog ? ` '/log',${psQuote(plan.adkSetupLog)}` : '';
  const winPeLogArg = plan.adkWinPeLog ? ` '/log',${psQuote(plan.adkWinPeLog)}` : '';
  return [
    "$ErrorActionPreference = 'Continue'",
    `$resultPath = ${psQuote(plan.resultPath)}`,
    '$steps = @()',
    'function Run-AdkStep {',
    '  param([string]$Name, [string]$Exe, [string[]]$CmdArgs)',
    '  if ($null -eq $CmdArgs) { $CmdArgs = @() }',
    '  $p = Start-Process -FilePath $Exe -ArgumentList $CmdArgs -Wait -PassThru',
    '  $code = $p.ExitCode',
    '  if ($null -eq $code) { $code = -1 }',
    '  $script:steps += [pscustomobject]@{ name = $Name; exitCode = $code }',
    '  return $code',
    '}',
    `$code1 = Run-AdkStep 'ADK (Deployment Tools)' ${psQuote(plan.adkSetup)}${installArg}${setupLogArg}`,
    `$code2 = Run-AdkStep 'WinPE add-on (Windows Preinstallation Environment)' ${psQuote(plan.adkWinPe)} @('/features','OptionId.WindowsPreinstallationEnvironment','/quiet','/norestart','/ceip','off')${winPeLogArg}`,
    '$overall = 0',
    'if ($code1 -ne 0 -or $code2 -ne 0) { $overall = 1 }',
    '[IO.File]::WriteAllText($resultPath, ($steps | ConvertTo-Json -Compress))',
    'exit $overall'
  ].join('\r\n');
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
  const adkSetupLog = path.join(dir, 'adksetup.log');
  const adkWinPeLog = path.join(dir, 'adkwinpesetup.log');
  let failure = false;
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
    fs.writeFileSync(
      script,
      buildAdkInstallScript({ adkSetup, adkWinPe, installPath: options.installPath, resultPath, adkSetupLog, adkWinPeLog }),
      'utf-8'
    );

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
    const failedStep = steps.find((s) => s.exitCode !== 0);
    const failureText = adk ? 'installer reported a failure' : 'ADK still not detected after install';
    const stepDetail = failedStep
      ? ` (${failedStep.name}, exit code ${failedStep.exitCode})`
      : steps.length > 0
        ? ` (steps: ${steps.map((s) => `${s.name}=${s.exitCode}`).join(', ')})`
        : '';
    logger.error(`Windows ADK install failed: ${failureText}${stepDetail}. code=${code}`);
    failure = true;
    return {
      ok: false,
      adkRoot: adk?.root ?? null,
      steps,
      logDir: dir,
      error: `${failureText}${stepDetail}. Detailed logs: ${dir}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Windows ADK install failed: ${message}`);
    return { ok: false, adkRoot: null, steps: [], logDir: dir, error: message };
  } finally {
    if (!failure) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}