import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NODE_RUNTIME_VERSION,
  nodeZipUrl,
  nodeZipArch,
  nodeRuntimeDir,
  installedNodeExe,
  findNodeExe,
  installNodeRuntime
} from '../../src/main/utils/node-install';
import { resolveNodeExe } from '../../src/main/utils/winpe-media';
import { psQuote, resolvePowershell } from '../../src/main/utils/elevated';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Store-mode zip via .NET (NoCompression) — a 90 MB node.exe in seconds, not minutes. */
function makeZip(stagingParent: string, zip: string): void {
  execFileSync(
    resolvePowershell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stagingParent)}, ${psQuote(zip)}, [System.IO.Compression.CompressionLevel]::NoCompression, $false)`
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
}

/** Shared real archive: a node-x/node.exe copy of the running Node (store mode). */
let realZip = '';

beforeAll(() => {
  const work = tmp();
  const stagingParent = path.join(work, 'staging');
  const nested = path.join(stagingParent, `node-${NODE_RUNTIME_VERSION}-win-x64`);
  fs.mkdirSync(nested, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(nested, 'node.exe'));
  realZip = path.join(work, 'node.zip');
  makeZip(stagingParent, realZip);
}, 60_000);

afterEach(() => {
  for (const dir of tmpDirs.splice(1)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('node-install', () => {
  it('pins the official portable zip URLs per architecture', () => {
    expect(NODE_RUNTIME_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(nodeZipArch('arm64')).toBe('arm64');
    expect(nodeZipArch('x64')).toBe('x64');
    expect(nodeZipArch('ia32')).toBe('x64'); // anything non-arm falls back to x64
    expect(nodeZipUrl('x64')).toBe(
      `https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/node-${NODE_RUNTIME_VERSION}-win-x64.zip`
    );
    expect(nodeZipUrl('arm64')).toBe(
      `https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/node-${NODE_RUNTIME_VERSION}-win-arm64.zip`
    );
  });

  it('resolves the runtime directory under the app data folder', () => {
    const dir = nodeRuntimeDir();
    expect(path.basename(dir)).toBe('node-runtime');
    expect(dir.toLowerCase()).toContain('opbs');
    expect(installedNodeExe()).toBe(path.join(dir, 'node.exe'));
  });

  it('findNodeExe locates node.exe inside the zip layout', () => {
    const root = tmp();
    const nested = path.join(root, `node-${NODE_RUNTIME_VERSION}-win-x64`);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'node.exe'), 'fake');
    expect(findNodeExe(root)).toBe(path.join(nested, 'node.exe'));
    expect(findNodeExe(tmp())).toBeNull();
  });

  it('resolveNodeExe prefers the injected runtime dir, then falls back', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'node.exe'), 'fake');
    expect(resolveNodeExe(undefined, dir)).toBe(path.join(dir, 'node.exe'));
    // A runtime dir without node.exe falls back to the same candidates as the default.
    expect(resolveNodeExe(undefined, path.join(dir, 'missing'))).toBe(resolveNodeExe());
    // An explicit path always wins.
    expect(resolveNodeExe(process.execPath, dir)).toBe(process.execPath);
  });

  it('installs from a real archive: flattens node.exe and verifies it runs', async () => {
    const work = tmp();
    const installDir = path.join(work, 'install');
    const result = await installNodeRuntime({ zipFile: realZip, installDir });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.nodeExe).toBe(path.join(installDir, 'node.exe'));
    expect(fs.existsSync(result.nodeExe!)).toBe(true);
    expect(result.version).toBe(process.version);
  }, 60_000);

  it('wipes a previous install before extracting (stale files never survive)', async () => {
    const work = tmp();
    const installDir = path.join(work, 'install');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, 'stale.txt'), 'old');

    const result = await installNodeRuntime({ zipFile: realZip, installDir });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(installDir, 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(installDir, 'node.exe'))).toBe(true);
  }, 60_000);

  it('fails the verification when node.exe is not a real executable', async () => {
    const work = tmp();
    const stagingParent = path.join(work, 'staging');
    fs.mkdirSync(path.join(stagingParent, 'node-bad'), { recursive: true });
    fs.writeFileSync(path.join(stagingParent, 'node-bad', 'node.exe'), 'not an executable');
    const zip = path.join(work, 'bad.zip');
    makeZip(stagingParent, zip);

    const result = await installNodeRuntime({ zipFile: zip, installDir: path.join(work, 'install') });
    expect(result.ok).toBe(false);
    expect(result.nodeExe).toBeNull();
    expect(result.error).toBeTruthy();
  }, 60_000);

  it('fails cleanly on a missing archive', async () => {
    const work = tmp();
    const result = await installNodeRuntime({
      zipFile: path.join(work, 'nope.zip'),
      installDir: path.join(work, 'install')
    });
    expect(result.ok).toBe(false);
    expect(result.nodeExe).toBeNull();
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(path.join(work, 'install'))).toBe(false);
  });

  it('fails cleanly on a corrupt archive', async () => {
    const work = tmp();
    const zip = path.join(work, 'corrupt.zip');
    fs.writeFileSync(zip, Buffer.alloc(2 * 1024 * 1024, 7));
    const result = await installNodeRuntime({ zipFile: zip, installDir: path.join(work, 'install') });
    expect(result.ok).toBe(false);
    expect(result.nodeExe).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
