import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildStartnetCmd,
  buildRestoreCmd,
  buildExampleRestoreConfig,
  buildReadme,
  payloadTextFiles,
  resolveNodeExe,
  resolveBundleNodeModules,
  planPayloadCopies,
  planRestoreConfigCopy,
  buildElevatedScript,
  smokeMediaPayload,
  stagePayloadFiles,
  copyPath,
  readLogTail,
  elevatedNoResultError,
  PE_ARCH_DEFAULT
} from '../../src/main/utils/winpe-media';
import * as os from 'os';

describe('winpe-media', () => {
  const ARCH = PE_ARCH_DEFAULT;

  describe('resolveNodeExe', () => {
    it('returns null when the explicit path is not a node exe', () => {
      expect(resolveNodeExe('C:/nonexistent/foo.exe')).toBeNull();
    });
    it('resolves a real node executable from the environment', () => {
      const found = resolveNodeExe();
      expect(found).toBeTruthy();
      expect(path.basename(found!)).toBe('node.exe');
    });
  });

  describe('stagePayloadFiles', () => {
    it('copies payload sources to real flat files the elevated script can read', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-stage-'));
      try {
        const srcDir = path.join(tmp, 'fake-asar', 'node_modules', 'fzstd');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'index.js'), 'codec');
        const srcFile = path.join(tmp, 'fake-asar', 'node.exe');
        fs.writeFileSync(srcFile, 'exe');

        const payloadDir = path.join(tmp, 'payload');
        const staged = stagePayloadFiles(
          [
            { from: srcDir, to: 'node_modules/fzstd' },
            { from: srcFile, to: 'node.exe' }
          ],
          payloadDir
        );

        expect(staged).toHaveLength(2);
        for (const item of staged) {
          expect(item.from.startsWith(payloadDir)).toBe(true);
          expect(path.basename(item.from).startsWith('0-') || path.basename(item.from).startsWith('1-')).toBe(true);
          expect(fs.existsSync(item.from)).toBe(true);
        }
        // Destinations are preserved for the script; content survives the copy.
        expect(staged[0].to).toBe('node_modules/fzstd');
        expect(fs.readFileSync(path.join(staged[0].from, 'index.js'), 'utf8')).toBe('codec');
        expect(fs.readFileSync(staged[1].from, 'utf8')).toBe('exe');
        // The originals are untouched.
        expect(fs.existsSync(srcDir)).toBe(true);
        expect(fs.existsSync(srcFile)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('keeps sources distinct when basenames collide', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-stage-'));
      try {
        const a = path.join(tmp, 'a', 'dist');
        const b = path.join(tmp, 'b', 'dist');
        fs.mkdirSync(a, { recursive: true });
        fs.mkdirSync(b, { recursive: true });
        fs.writeFileSync(path.join(a, 'x'), 'a');
        fs.writeFileSync(path.join(b, 'x'), 'b');

        const staged = stagePayloadFiles(
          [
            { from: a, to: 'dist' },
            { from: b, to: 'dist2' }
          ],
          path.join(tmp, 'payload')
        );
        expect(staged[0].from).not.toBe(staged[1].from);
        expect(fs.readFileSync(path.join(staged[0].from, 'x'), 'utf8')).toBe('a');
        expect(fs.readFileSync(path.join(staged[1].from, 'x'), 'utf8')).toBe('b');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('copyPath', () => {
    it('copies a nested directory tree', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-copypath-'));
      try {
        const src = path.join(tmp, 'src', 'dist');
        fs.mkdirSync(path.join(src, 'cli'), { recursive: true });
        fs.writeFileSync(path.join(src, 'cli', 'index.js'), 'cli');
        fs.writeFileSync(path.join(src, 'root.js'), 'root');
        const dest = path.join(tmp, 'dest');
        copyPath(src, dest);
        expect(fs.readFileSync(path.join(dest, 'cli', 'index.js'), 'utf8')).toBe('cli');
        expect(fs.readFileSync(path.join(dest, 'root.js'), 'utf8')).toBe('root');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('copies a single file, creating the destination directory', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-copypath-'));
      try {
        const src = path.join(tmp, 'opbs_native.node');
        fs.writeFileSync(src, 'binary');
        const dest = path.join(tmp, 'out', 'deep', 'opbs_native.node');
        copyPath(src, dest);
        expect(fs.readFileSync(dest, 'utf8')).toBe('binary');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('readLogTail', () => {
    it('returns the last bytes of a file', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-log-'));
      try {
        const file = path.join(tmp, 'x.log');
        fs.writeFileSync(file, 'line1\nline2\nline3\n');
        const tail = readLogTail(file, 7);
        expect(tail).toBe('line3'); // trailing whitespace is trimmed for messages
        expect(readLogTail(path.join(tmp, 'missing.log'))).toBeNull();
        const empty = path.join(tmp, 'empty.log');
        fs.writeFileSync(empty, '');
        expect(readLogTail(empty)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('elevatedNoResultError', () => {
    it('attributes exit code 5 to the UAC prompt itself', () => {
      const msg = elevatedNoResultError(5, 'C:/work', 'C:/work/build.ps1', null);
      expect(msg).toContain('exit code 5');
      expect(msg).toContain('declined or never appeared');
      expect(msg).toContain('C:/work');
      expect(msg).toContain('C:/work/build.ps1');
      expect(msg).not.toContain('script output');
    });

    it('attributes other exits to the script and embeds captured output', () => {
      const msg = elevatedNoResultError(1, 'C:/work', 'C:/work/build.ps1', 'ItemNotFoundException: bad path');
      expect(msg).toContain('exit code 1');
      expect(msg).toContain('failed before writing result.json');
      expect(msg).toContain('ItemNotFoundException: bad path');
    });

    it('omits the output section when no log was captured', () => {
      const msg = elevatedNoResultError(1, 'C:/work', 'C:/work/build.ps1', null);
      expect(msg).not.toContain('script output');
      expect(msg).toContain('Work kept at C:/work');
    });

    it('trims long output to its final 600 chars so the error stays readable', () => {
      const long = 'a'.repeat(1000) + 'TAIL-MARKER';
      const msg = elevatedNoResultError(1, 'C:/work', 'C:/work/build.ps1', long);
      expect(msg).toContain('TAIL-MARKER');
      expect(msg).toContain('…');
      expect(msg).not.toContain('a'.repeat(601));
    });
  });

  describe('resolveBundleNodeModules', () => {
    it('resolves the installed codec packages', () => {
      const mods = resolveBundleNodeModules(['fzstd', 'zstdify']);
      expect(mods.every((m) => m.dir.length > 0)).toBe(true);
      for (const m of mods) {
        expect(path.basename(m.dir)).toBe(m.name);
        expect(m.dir).toContain('node_modules');
      }
    });
    it('returns an empty dir for an unknown package', () => {
      const mods = resolveBundleNodeModules(['definitely-not-a-package-xyz']);
      expect(mods[0].dir).toBe('');
    });
  });

  describe('planPayloadCopies', () => {    it('lays out node.exe, dist, native addon and codecs under OPBS', () => {
      const distDir = path.resolve('src', 'main');
      const nativeNode = path.resolve('src', 'native', 'build', 'Release', 'opbs_native.node');
      const items = planPayloadCopies({
        nodeExe: 'C:/node/node.exe',
        distDir,
        nativeNode,
        nodeModules: [
          { name: 'fzstd', dir: 'C:/app/node_modules/fzstd' },
          { name: 'zstdify', dir: 'C:/app/node_modules/zstdify' }
        ]
      });
      const tos = items.map((i) => i.to);
      expect(tos).toContain('node.exe');
      expect(tos).toContain('dist');
      expect(tos).toContain('node_modules/fzstd');
      expect(tos).toContain('node_modules/zstdify');
      expect(tos).toContain(path.join('src', 'native', 'build', 'Release', 'opbs_native.node'));
    });
  });

  describe('planRestoreConfigCopy', () => {
    it('returns null when no config is requested', () => {
      expect(planRestoreConfigCopy()).toBeNull();
      expect(planRestoreConfigCopy('')).toBeNull();
    });

    it('stages a supplied config as OPBS-restore.json in the payload root', () => {
      const item = planRestoreConfigCopy('C:/restore.json')!;
      expect(item).toEqual({ from: 'C:/restore.json', to: 'OPBS-restore.json' });
    });
  });

  describe('templates', () => {
    it('startnet.cmd finds the OPBS payload and launches restore.cmd', () => {
      const s = buildStartnetCmd();
      expect(s).toContain('call wpeinit');
      expect(s).toContain('OPBS\\node.exe');
      expect(s).toContain('restore.cmd');
      expect(s.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // strictly CRLF
    });

    it('restore.cmd invokes the embedded CLI on a config', () => {
      const s = buildRestoreCmd();
      expect(s).toContain('winpe-entry.js');
      expect(s).toContain('restore');
      expect(s).toContain('--elevated');
      expect(s).toContain('OPBS-restore.json');
    });

    it('example restore config uses canonical CLI keys', () => {
      const cfg = buildExampleRestoreConfig();
      expect(cfg).toContain('imagePath');
      expect(cfg).toContain('targetDiskIndex');
      expect(cfg).toContain('targetPartitions');
      expect(cfg).toContain('verifyBeforeWrite');
    });

    it('README documents the restore workflow and preflight', () => {
      expect(buildReadme()).toContain('winpe-entry.js');
      expect(buildReadme()).toContain('--preflight');
      expect(buildReadme()).toContain('sourceImagePath / destinationDiskIndex');
    });

    it('payloadTextFiles emits all embedded files once', () => {
      const names = payloadTextFiles().map((f) => f.name);
      expect(names).toContain('restore.cmd');
      expect(names).toContain('winpe-entry.js');
      expect(names).toContain('OPBS-restore.example.json');
      expect(names).toContain('README.txt');
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('buildElevatedScript', () => {
    const base = {
      arch: ARCH,
      format: 'iso' as const,
      output: 'C:/out/opbs.iso',
      stage: 'C:/stage',
      adkCopype: 'C:/adk/copype.cmd',
      adkDandISetEnv: 'C:/adk/Deployment Tools/DandISetEnv.bat',
      adkDism: 'C:/adk/dism.exe',
      adkMakeWinPEMedia: 'C:/adk/MakeWinPEMedia.cmd',
      payloadCopies: [{ from: 'C:/x/node.exe', to: 'node.exe' }],
      payloadTextFiles: [{ name: 'restore.cmd', content: 'echo hi' }],
      startnetCmd: 'call wpeinit',
      yesForUsb: false
    };

    it('runs copype, DISM mount/commit, and MakeWinPEMedia in order', () => {
      const s = buildElevatedScript(base);
      const copypeIdx = s.indexOf('copype.cmd');
      const mountIdx = s.indexOf('/Mount-Wim');
      const writeIdx = s.indexOf('startnet.cmd');
      const unmountIdx = s.indexOf('/Unmount-Wim');
      const isoIdx = s.indexOf('/ISO');
      expect(copypeIdx).toBeGreaterThan(-1);
      expect(mountIdx).toBeGreaterThan(copypeIdx);
      expect(writeIdx).toBeGreaterThan(mountIdx);
      expect(unmountIdx).toBeGreaterThan(writeIdx);
      expect(isoIdx).toBeGreaterThan(unmountIdx);
    });

    it('sources the Deployment Tools environment before copype and MakeWinPEMedia', () => {
      const s = buildElevatedScript(base);
      const calls = s.split('\r\n').filter((l) => l.includes('DandISetEnv.bat'));
      expect(calls.length).toBe(2);
      for (const call of calls) {
        expect(call).toMatch(/ComSpec \/d \/s \/c/);
      }
      expect(calls[0]).toContain('copype.cmd');
      expect(calls[1]).toContain('MakeWinPEMedia.cmd');
    });

    it('writes payload text files as base64 into <stage>/media/OPBS', () => {
      const s = buildElevatedScript(base);
      expect(s).toContain('media\\OPBS\\restore.cmd');
      expect(s).toContain('[Convert]::FromBase64String');
    });

    it('transcripts its output into elevated.log next to the script', () => {
      const s = buildElevatedScript(base);
      // The wrapper cannot use -RedirectStandard* with -Verb RunAs
      // (AmbiguousParameterSet), so the script must capture its own output.
      expect(s).toContain(`Start-Transcript -Path (Join-Path $PSScriptRoot 'elevated.log')`);
      expect(s).toContain('-ErrorAction SilentlyContinue | Out-Null');
      // Transcript starts before the first operation that can fail.
      expect(s.indexOf('Start-Transcript')).toBeLessThan(s.indexOf('copype.cmd'));
      // And is stopped on the success path just before the final exit.
      expect(s).toContain('Stop-Transcript -ErrorAction SilentlyContinue | Out-Null\r\nexit 0');
    });

    it('uses /USB and guards without confirmation', () => {
      const s = buildElevatedScript({ ...base, format: 'usb', output: 'E:', yesForUsb: false });
      expect(s).toContain('/USB');
      expect(s).toContain('explicit confirmation');
    });

    it('errors out of USB step before writing when not confirmed', () => {
      const s = buildElevatedScript({ ...base, format: 'usb', output: 'E:', yesForUsb: false });
      expect(s.indexOf('Write-Result @{ok=$false;error="USB output requires explicit confirmation')).toBeLessThan(
        s.indexOf('MakeWinPEMedia.cmd')
      );
    });

    it('injects third-party drivers into the mounted WIM before committing', () => {
      const s = buildElevatedScript({ ...base, drivers: ['C:/drivers/net', 'C:/drivers/storage'] });
      const startnetIdx = s.indexOf('startnet.cmd');
      const addDriverIdx = s.indexOf('/Add-Driver');
      const unmountIdx = s.indexOf('/Unmount-Wim');
      expect(addDriverIdx).toBeGreaterThan(startnetIdx);
      expect(unmountIdx).toBeGreaterThan(addDriverIdx);
      expect(s.indexOf("C:/drivers/net")).toBeGreaterThan(-1);
      expect(s.indexOf("C:/drivers/storage")).toBeGreaterThan(-1);
      // A missing driver dir aborts before DISM is touched.
      expect(s).toContain('Driver directory not found');
      // Without drivers, no Add-Driver step is emitted.
      expect(buildElevatedScript(base)).not.toContain('/Add-Driver');
    });

    it('adds WinPE-SecureStartup into the mounted WIM before committing', () => {
      const cab = 'C:/adk/WinPE_OCs/WinPE-SecureStartup.cab';
      const s = buildElevatedScript({ ...base, adkSecureStartupCab: cab });
      const addPackageIdx = s.indexOf('/Add-Package');
      const unmountIdx = s.indexOf('/Unmount-Wim');
      expect(addPackageIdx).toBeGreaterThan(-1);
      expect(s).toContain(`PackagePath:'${cab}'`);
      expect(s).toContain('WinPE-SecureStartup (BitLocker support) failed');
      expect(unmountIdx).toBeGreaterThan(addPackageIdx);
      expect(buildElevatedScript(base)).not.toContain('/Add-Package');
    });
  });

  describe('smokeMediaPayload', () => {
    const distDir = path.resolve(__dirname, '../../dist');
    const nativeNode = path.resolve(__dirname, '../../src/native/build/Release/opbs_native.node');
    let addonLoads = false;
    try { require(nativeNode); addonLoads = true; } catch { /* needs Electron runtime */ }
    const available = fs.existsSync(distDir) && fs.existsSync(nativeNode) && addonLoads;
    const opts = () => ({ distDir, nativeNode });

    it('rejects a missing native addon without touching the payload root', () => {
      const result = smokeMediaPayload({ ...opts(), nativeNode: 'C:/definitely/missing/opbs_native.node' });
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.check === 'native addon')!.ok).toBe(false);
    });

    it.skipIf(!available)(
      'boots the staged payload (real node.exe + winpe-entry.js + native addon) successfully',
      () => {
        const result = smokeMediaPayload(opts());
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.log(result.checks.map((c) => `${c.check}: ${c.ok ? 'ok' : c.detail}`).join('\n'));
        }
        expect(result.checks.find((c) => c.check === 'node.exe')!.ok).toBe(true);
        expect(result.checks.find((c) => c.check === 'native addon loads')!.ok).toBe(true);
        expect(result.checks.find((c) => c.check === 'codec fzstd')!.ok).toBe(true);
        expect(result.checks.find((c) => c.check === 'codec zstdify')!.ok).toBe(true);
        expect(result.ok).toBe(true);
      }
    );

    it.skipIf(!available)('stages the payload root and cleans it up on success', () => {
      const result = smokeMediaPayload(opts());
      expect(result.ok).toBe(true);
      // payloadRoot points at the now-removed temp dir (cleaned up on success).
      expect(result.payloadRoot).toBeTruthy();
      expect(fs.existsSync(result.payloadRoot!)).toBe(false);
    });
  });
});
