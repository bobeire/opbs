import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { peArchForProcess, PeArch } from './adk';
import { psQuote, runElevatedPowerShell } from './elevated';
import { logger } from './logger';

/**
 * Silent WinFsp runtime installer.
 *
 * Resolves the latest `.msi` from the WinFsp GitHub releases (signed kernel
 * driver + userspace DLL), downloads it, then installs it quietly via
 * `msiexec /i ... /qn /norestart` behind a single UAC confirmation.
 *
 * Exit codes: MSI returns 0 on success and 3010 (ERROR_SUCCESS_REBOOT_REQUIRED)
 * when a reboot is recommended; both count as success here.
 */

export const WIN_FSP_LATEST_URL = 'https://api.github.com/repos/winfsp/winfsp/releases/latest';

export interface WinfspInstallOptions {
  /** Pre-downloaded WinFsp MSI path; skips the release lookup + download. */
  msiPath?: string;
  arch?: PeArch;
}

export interface WinfspInstallResult {
  ok: boolean;
  code?: number;
  msi?: string;
  error?: string;
}

/**
 * Pick the MSI asset for `arch` from a release's asset names. Prefers the
 * arch-specific (`-x64.msi` / `-arm64.msi`) asset, falling back to a
 * platform-neutral `.msi`.
 */
export function chooseWinFspMsi(names: string[], arch: PeArch = 'amd64'): string | null {
  const token = arch === 'arm64' ? 'arm64' : 'x64';
  const msis = names
    .filter((n) => /\.msi$/i.test(n))
    // Prefer the arch-specific asset when present (helps avoid accidentally
    // selecting a combined/other-arch MSI), then fall back to the first.
    .sort((a, b) => {
      const aHit = /-x64\.msi$/i.test(a) || /-arm64\.msi$/i.test(a) ? 1 : 0;
      const bHit = /-x64\.msi$/i.test(b) || /-arm64\.msi$/i.test(b) ? 1 : 0;
      return bHit - aHit;
    });
  return msis.find((n) => new RegExp(`-${token}\\.msi$`, 'i').test(n)) ?? msis[0] ?? null;
}

/**
 * Resolve the browser download URL of the latest WinFsp MSI for `arch` via the
 * GitHub releases API (unauthenticated; 60 requests/hour is plenty).
 */
export async function resolveWinFspMsiUrl(arch: PeArch = peArchForProcess()): Promise<string> {
  const res = await fetch(WIN_FSP_LATEST_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'opbs' }
  });
  if (!res.ok) {
    throw new Error(`WinFsp release lookup failed (HTTP ${res.status}). Install the runtime from https://winfsp.dev`);
  }
  const release = (await res.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
  const assets = release.assets ?? [];
  const name = chooseWinFspMsi(assets.map((a) => a.name), arch);
  const asset = name ? assets.find((a) => a.name === name) : undefined;
  if (!asset) {
    throw new Error('No .msi asset found on the latest WinFsp release. Install the runtime from https://winfsp.dev');
  }
  return asset.browser_download_url;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`WinFsp download failed (HTTP ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error('WinFsp download returned an empty file');
  }
  fs.writeFileSync(dest, buf);
}

/**
 * Build the elevated PowerShell payload that runs the WinFsp MSI silently.
 * Pure so unit tests cover quoting + flags without elevation.
 */
export function buildWinFspInstallScript(msiPath: string): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$msi = ${psQuote(msiPath)}`,
    `$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart') -Wait -PassThru`,
    'exit $p.ExitCode'
  ].join('\r\n');
}

export async function installWinfsp(options: WinfspInstallOptions = {}): Promise<WinfspInstallResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-winfsp-'));
  try {
    let msiPath = options.msiPath;
    if (!msiPath) {
      const url = await resolveWinFspMsiUrl(options.arch);
      msiPath = path.join(dir, 'WinFsp.msi');
      logger.info(`Downloading WinFsp MSI: ${url}`);
      await downloadToFile(url, msiPath);
    }
    if (!fs.existsSync(msiPath) || fs.statSync(msiPath).size < 100000) {
      return { ok: false, error: 'WinFsp MSI was not downloaded correctly (missing or unexpectedly small file).' };
    }

    const script = path.join(dir, 'install.ps1');
    fs.writeFileSync(script, buildWinFspInstallScript(msiPath), 'utf-8');

    const code = await runElevatedPowerShell(script);
    if (code === 0 || code === 3010) {
      logger.info(`WinFsp installed via msiexec (exit ${code}).`);
      return { ok: true, code, msi: msiPath };
    }
    logger.error(`WinFsp installation failed with msiexec exit code ${code}.`);
    return {
      ok: false,
      code,
      error:
        code === 5
          ? 'UAC elevation was not confirmed; the install was skipped.'
          : `WinFsp installer exited with code ${code}. Install the runtime manually from https://winfsp.dev`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`WinFsp installation failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}