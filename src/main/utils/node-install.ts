import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { psQuote, resolvePowershell } from './elevated';
import { logger } from './logger';

/**
 * Silent, per-user Node.js runtime install for the recovery-media builder.
 *
 * The WinPE payload boots and runs `node.exe winpe-entry.js ...`, so machines
 * without a system Node.js install show "tools not available" with no way
 * forward. Instead of an MSI (UAC prompt, machine-wide changes), download the
 * official portable zip and extract it into the app's user-data directory —
 * fully silent, no admin rights, nothing registered system-wide.
 */

/** Pinned Node.js LTS used for the portable runtime (keep in sync with tests). */
export const NODE_RUNTIME_VERSION = 'v24.21.0';

export type NodeZipArch = 'x64' | 'arm64';

export function nodeZipArch(arch: string): NodeZipArch {
  return arch === 'arm64' ? 'arm64' : 'x64';
}

/** Official portable Windows zip for the pinned version. */
export function nodeZipUrl(arch: string): string {
  const zipArch = nodeZipArch(arch);
  return `https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/node-${NODE_RUNTIME_VERSION}-win-${zipArch}.zip`;
}

/**
 * Directory holding the portable runtime (node.exe lives directly inside).
 * Mirrors `logger.getUserDataDir()`'s electron-guarded pattern so the CLI
 * (no Electron) resolves to the same %APPDATA%\opbs location as the GUI.
 */
export function nodeRuntimeDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath(name: string): string } } | string;
    if (typeof electron === 'object' && electron.app && typeof electron.app.getPath === 'function') {
      return path.join(electron.app.getPath('userData'), 'node-runtime');
    }
  } catch {
    // Not running inside Electron.
  }
  const appData = process.env.APPDATA ?? os.homedir();
  return path.join(appData, 'opbs', 'node-runtime');
}

export function installedNodeExe(): string {
  return path.join(nodeRuntimeDir(), 'node.exe');
}

export interface NodeInstallOptions {
  /** Install target directory (default: nodeRuntimeDir()). */
  installDir?: string;
  /** Host architecture — picks win-x64 vs win-arm64 (default: process.arch). */
  arch?: string;
  /** Pre-downloaded zip; skips the download (mirrors AdkInstallOptions). */
  zipFile?: string;
  /** Skip the final `node -v` smoke check (tests only). */
  verify?: boolean;
}

export interface NodeInstallResult {
  ok: boolean;
  nodeExe: string | null;
  version?: string;
  error?: string;
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

/** Extract a zip with .NET's ZipFile (same module, far faster than Expand-Archive). */
function extractZip(zip: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zip)}, ${psQuote(destDir)})`;
  execFileSync(resolvePowershell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore'
  });
}

/** Depth-first search for node.exe under `root` (zip layouts vary by version). */
export function findNodeExe(root: string, maxDepth = 3): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /^node(\.exe)?$/i.test(entry.name)) {
        return full;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root, 0);
}

/**
 * Download the portable Node.js zip (unless provided), extract it into
 * `installDir` (wiping any previous copy), and verify the result by running
 * `node -v`. Returns the final node.exe path so callers can re-check media.
 */
export async function installNodeRuntime(options: NodeInstallOptions = {}): Promise<NodeInstallResult> {
  const installDir = options.installDir ?? nodeRuntimeDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-node-'));
  try {
    const zip = options.zipFile ?? path.join(dir, 'node.zip');
    if (!options.zipFile) {
      const url = nodeZipUrl(options.arch ?? process.arch);
      logger.info(`Downloading portable Node.js runtime: ${url}`);
      await downloadToFile(url, zip);
      if (!fs.existsSync(zip) || fs.statSync(zip).size < 1_000_000) {
        return {
          ok: false,
          nodeExe: null,
          error: 'The Node.js archive was not downloaded correctly (missing or unexpectedly small file).'
        };
      }
    }

    const extracted = path.join(dir, 'extracted');
    extractZip(zip, extracted);

    const found = findNodeExe(extracted);
    if (!found) {
      return { ok: false, nodeExe: null, error: 'The Node.js archive did not contain a node.exe.' };
    }

    // Flatten: copy the folder that holds node.exe (the zip's top directory)
    // so the final layout is <installDir>/node.exe.
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    fs.cpSync(path.dirname(found), installDir, { recursive: true });

    const nodeExe = path.join(installDir, 'node.exe');
    if (!fs.existsSync(nodeExe)) {
      return { ok: false, nodeExe: null, error: 'node.exe is missing after extraction.' };
    }

    let version: string | undefined;
    if (options.verify !== false) {
      const out = execFileSync(nodeExe, ['-v'], { encoding: 'utf8', windowsHide: true }).trim();
      if (!/^v\d+\./.test(out)) {
        return { ok: false, nodeExe: null, error: `Extracted node.exe did not report a version (got "${out}").` };
      }
      version = out;
    }

    logger.info(`Portable Node.js runtime installed at ${nodeExe}${version ? ` (${version})` : ''}`);
    return { ok: true, nodeExe, version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Portable Node.js install failed: ${message}`);
    return { ok: false, nodeExe: null, error: message };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
