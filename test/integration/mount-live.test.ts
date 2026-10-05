import { test, expect } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildNtfsVolumeData } from '../helpers/ntfs-fixture';
import { writeImageFromBytes } from '../helpers/opbs-image';
import {
  activeMountCount,
  heapCheckNow,
  mountImage,
  unmountImage,
  winfspAvailable
} from '../../src/main/imaging/mount-manager';

/**
 * Live smoke test for the WinFsp runtime: mounts a real `.opbs` NTFS
 * partition as a drive letter and serves it to a *separate process* (the
 * bridge callbacks arrive on this process's main thread via a
 * ThreadSafeFunction, so any synchronous file system access from here would
 * deadlock), then unmounts and verifies the letter is gone.
 *
 * The probe child uses `opendirSync` rather than `readdirSync`: libuv's
 * `readdirSync`/`statSync` reject WinFsp drive roots with ENOENT (observed
 * identically on the stock memfs sample), while opendir, reads, and
 * PowerShell all work.
 */

interface MountProbe {
  names: string[];
  hello: string | null;
  helloErr?: string;
  bigLen: number | null;
  bigErr?: string;
  statRoot?: boolean;
  statRootErr?: string;
  statHello?: number;
  statHelloErr?: string;
  cmdDir?: string;
  cmdErr?: string;
}

const runChild = (
  cmd: string,
  args: string[],
  timeout: number
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${stderr}\n${stdout}`));
      else resolve(String(stdout));
    });
  });

async function probeMount(mountPoint: string, workDir: string): Promise<MountProbe> {
  const root = mountPoint.endsWith('\\') ? mountPoint : `${mountPoint}\\`;
  const probeScript = path.join(workDir, 'probe.js');
  fs.writeFileSync(
    probeScript,
    `const fs = require('fs');
const cp = require('child_process');
const root = ${JSON.stringify(root)};
const ops = (process.env.PROBE_OPS || 'opendir,hello,big,statroot,stathello,cmddir').split(',');
const out = { names: [], hello: null, bigLen: null };
if (ops.includes('opendir')) try {
  const d = fs.opendirSync(root);
  let e;
  while ((e = d.readSync())) out.names.push(e.name);
  d.closeSync();
} catch (e) { out.namesErr = e.code; }
if (ops.includes('hello')) try { out.hello = fs.readFileSync(root + 'hello.txt', 'utf8'); } catch (e) { out.helloErr = e.code; }
if (ops.includes('big')) try { out.bigLen = fs.readFileSync(root + 'docs\\\\big.bin').length; } catch (e) { out.bigErr = e.code; }
if (ops.includes('statroot')) try { out.statRoot = fs.statSync(root).isDirectory(); } catch (e) { out.statRootErr = e.code; }
if (ops.includes('stathello')) try { out.statHello = fs.statSync(root + 'hello.txt').size; } catch (e) { out.statHelloErr = e.code; }
if (ops.includes('cmddir')) try {
  out.cmdDir = cp.execFileSync('C:\\\\Windows\\\\System32\\\\cmd.exe', ['/c', 'dir', root],
    { windowsHide: true, encoding: 'utf8' }).split(/\\r?\\n/).filter(Boolean).slice(0, 12).join(' | ');
} catch (e) { out.cmdErr = String(e.message).slice(0, 300); }
process.stdout.write(JSON.stringify(out));
`
  );
  const stdout = await runChild(process.execPath, [probeScript], 30000);
  return JSON.parse(stdout) as MountProbe;
}

test.skipIf(!winfspAvailable())(
  'mounts an .opbs NTFS partition as a live read-only WinFsp drive',
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-mount-live-'));
    const imagePath = path.join(dir, 'ntfs.opbs');
    writeImageFromBytes(imagePath, buildNtfsVolumeData(), 4096);

    const before = activeMountCount();
    let mounted: ReturnType<typeof mountImage> | null = null;
    try {
      mounted = mountImage({ imagePath, partitionIndex: 0, label: 'OPBS Mount Smoke' });
      expect(mounted.mountPoint).toMatch(/^[A-Za-z]:/);
      expect(activeMountCount()).toBe(before + 1);
      heapCheckNow();

      const probe = await probeMount(mounted.mountPoint, dir);
      console.log('PROBE', JSON.stringify(probe));
      heapCheckNow();
      // Diagnostic: let the kernel drain trailing Close work before unmounting
      // (OPBS_SETTLE_MS=0 keeps the normal immediate-unmount path).
      const settle = Number(process.env.OPBS_SETTLE_MS ?? 0);
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));

      // Root listing (system files are intentionally visible): fixture root
      // is MFT record 5 with $MFT, $MFTMirr, hello.txt, docs.
      expect(probe.names).toEqual(
        expect.arrayContaining(['hello.txt', 'docs', '$MFT', '$MFTMirr'])
      );
      expect(probe.hello).toBe('Hello, OPBS world!');
      expect(probe.bigLen).toBe(2 * 4096);
      expect(probe.statRootErr ?? probe.statRoot).toBe(true);
      expect(probe.statHelloErr ?? probe.statHello).toBe(18);
      // cmd.exe `dir` exercises the Win32 enumeration path end to end.
      expect(probe.cmdDir ?? probe.cmdErr ?? 'no cmd result').toContain('hello.txt');

      expect(unmountImage(mounted.id)).toBe(true);
      heapCheckNow();
      expect(activeMountCount()).toBe(before);
      const root = mounted.mountPoint.endsWith('\\')
        ? mounted.mountPoint
        : `${mounted.mountPoint}\\`;
      expect(fs.existsSync(root)).toBe(false);
      mounted = null;
    } finally {
      if (mounted) unmountImage(mounted.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  60000
);
