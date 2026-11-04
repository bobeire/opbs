// Diagnostic: how CAN we read a VSS shadow copy device?
//
// Two hypotheses about why ReadFile returned "the device is not ready" were
// wrong (FILE_FLAG_SEQUENTIAL_SCAN, then FILE_FLAG_BACKUP_SEMANTICS). Instead
// of a third guess, this tries every plausible open/read variant in one
// elevated run and reports which — if any — works.
//
// It also records which VSS provider owns the snapshot. A third-party provider
// can hand back a device object that exists but cannot be read by us, which
// looks exactly like a filesystem that is "not ready".
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';

const require = createRequire(import.meta.url);
const n = require('../src/native/build/Release/opbs_native.node');

// Results live next to the repository, wherever it is checked out, so the file
// lands somewhere predictable even when started with -Verb RunAs.
const logPath = new URL('../vss-probe-result.txt', import.meta.url);
const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};

// Run elevated; there is no console to read when started with -Verb RunAs, so
// every result goes to the file.
process.on('uncaughtException', (e) => {
  say(`UNCAUGHT: ${e && e.stack ? e.stack : e}`);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  process.exit(1);
});

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    return `FAILED: ${e && e.message ? e.message : e}`;
  }
};

const elevated = (() => {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
})();
say(`elevated: ${elevated}`);
say(`node: ${process.version} (${process.arch})`);

const sys32 = 'C:\\Windows\\System32\\';
say('--- vssadmin list providers ---');
say(run(sys32 + 'vssadmin.exe', ['list', 'providers']).trim());
say('--- vssadmin list shadowstorage /for=C: ---');
say(run(sys32 + 'vssadmin.exe', ['list', 'shadowstorage', '/for=C:']).trim());

let devicePath = '';
let snapshotId = '';
try {
  const t0 = Date.now();
  const snaps = n.createSnapshotSet(['C:\\']);
  devicePath = snaps[0].devicePath;
  snapshotId = snaps[0].id;
  say(`snapshot created in ${Date.now() - t0}ms: id=${devicePath}`);
} catch (e) {
  say(`createSnapshotSet FAILED: ${e.message || e}`);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  process.exit(1);
}

say('--- vssadmin list shadows /for=C: ---');
say(run(sys32 + 'vssadmin.exe', ['list', 'shadows', '/for=C:']).trim());

say('--- WMI Win32_ShadowCopy ---');
const wmiScript = [
  '$ErrorActionPreference = "Stop"',
  'Get-CimInstance -ClassName Win32_ShadowCopy | Select-Object ID,VolumeName,ProviderID,InstallDate | Format-List'
].join('; ');
say(
  run(sys32 + 'WindowsPowerShell\\v1.0\\powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    wmiScript
  ]).trim()
);

const readNative = (label) => {
  try {
    const buf = n.readBlocks(devicePath, 0n, 512n);
    say(`${label}: OK — ${buf.length} bytes, OEM = ${JSON.stringify(buf.toString('ascii', 3, 11))}`);
    return true;
  } catch (e) {
    say(`${label}: FAIL — ${e.message || e}`);
    return false;
  }
};

readNative('native readBlocks (immediately)');

// A snapshot that needs a moment to become readable would explain the failure
// and would be fixed by waiting; one that never becomes readable would not.
say('waiting 3000ms, then reading again…');
await new Promise((r) => setTimeout(r, 3000));
readNative('native readBlocks (after 3s)');

// The native reader is the suspect, so test the same read through Node, which
// uses its own open flags. If Node works, the bug is ours; if Node fails the
// same way, the device really is not readable by this process.
const nodeRead = (label, openPath) => {
  try {
    const fd = fs.openSync(openPath, 'r');
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, 512, 0);
    say(`${label}: OK — ${read} bytes, OEM = ${JSON.stringify(buf.toString('ascii', 3, 11))}`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    say(`${label}: FAIL — ${e.code || ''} ${e.message}`);
    return false;
  }
};
nodeRead('node fs open device', devicePath);
nodeRead('node fs open device + trailing \\', `${devicePath}\\`);

// Is the snapshot browsable as a filesystem at all? This is the documented
// way to use a shadow copy device object: as a directory root.
for (const p of [`${devicePath}\\`, `${devicePath}\\Windows`, `${devicePath}\\Windows\\System32`]) {
  try {
    const st = fs.statSync(p);
    say(`stat ${p}: OK (${st.isDirectory() ? 'dir' : 'file'})`);
  } catch (e) {
    say(`stat ${p}: FAIL — ${e.code || ''} ${e.message}`);
  }
}

// And can we read a known file through the snapshot? If this works while the
// raw read fails, the image should read files rather than blocks from the
// device root — a different shape of fix.
try {
  const fd = fs.openSync(`${devicePath}\\Windows\\System32\\drivers\\etc\\hosts`, 'r');
  const buf = Buffer.alloc(64);
  const read = fs.readSync(fd, buf, 0, 64, 0);
  say(`read hosts through snapshot: OK — ${read} bytes`);
  fs.closeSync(fd);
} catch (e) {
  say(`read hosts through snapshot: FAIL — ${e.code || ''} ${e.message}`);
}

try {
  n.deleteSnapshot(snapshotId);
  say(`deleted ${snapshotId}`);
} catch (e) {
  say(`deleteSnapshot FAILED: ${e.message || e}`);
}

fs.writeFileSync(logPath, lines.join('\n') + '\n');
console.log('done');
