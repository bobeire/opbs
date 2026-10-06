'use strict';
/**
 * Prep (or regenerate) the staged test source VHD on this media:
 *   test\src.vhdx = 256 MB dynamic VHDX, GPT, one 200 MB FAT32 partition
 *   labeled OPBSTEST containing marker files.
 *
 * Must run elevated (attaches the VHD, initializes a disk, formats).
 * Usage:  node.exe prep-src.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const vd = require(path.join(HERE, 'dist', 'utils', 'virtual-disk.js'));
const { attachAndDiscoverDisk } = require(path.join(HERE, 'dist', 'helper', 'vhd-attach.js'));

const TEST = path.join(HERE, 'test');
const SRC = path.join(TEST, 'src.vhdx');
const VIRTUAL_SIZE = 268435456; // 256 MB
const PART_SIZE = 209715200; // 200 MB
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(msg) {
  process.stdout.write(msg + '\r\n');
}

async function forceRemove(p) {
  try {
    const info = vd.readVirtualDiskInfo(p);
    if (info && info.isLoaded) vd.detachVirtualDiskFile(p);
  } catch (e) {
    /* not a vhd / not attached */
  }
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      return;
    } catch (e) {
      /* busy - wait and retry */
    }
    await sleep(1000);
  }
  throw new Error('Could not remove ' + p);
}

async function main() {
  fs.mkdirSync(TEST, { recursive: true });
  say('Regenerating ' + SRC);
  await forceRemove(SRC);

  vd.createVirtualDiskFile({ path: SRC, virtualSize: VIRTUAL_SIZE, type: 'dynamic' });
  const disk = await attachAndDiscoverDisk(SRC, { readOnly: false });
  const diskIndex = disk.diskIndex;
  say('Attached as PhysicalDrive' + diskIndex);

  execFileSync(PS, [
    '-NoProfile',
    '-Command',
    `Initialize-Disk -Number ${diskIndex} -PartitionStyle GPT -ErrorAction Stop; ` +
      `$p = New-Partition -DiskNumber ${diskIndex} -Size ${PART_SIZE} -AssignDriveLetter -ErrorAction Stop; ` +
      `Format-Volume -Partition $p -FileSystem FAT32 -NewFileSystemLabel OPBSTEST -Confirm:$false -ErrorAction Stop | Out-Null`
  ]);
  const letter = execFileSync(PS, [
    '-NoProfile',
    '-Command',
    `(Get-Partition -DiskNumber ${diskIndex} | Get-Volume).DriveLetter`
  ]).toString().trim();
  if (!letter) {
    throw new Error('Formatted volume has no drive letter');
  }
  const root = letter + ':\\';
  say('Formatted FAT32 at ' + root);

  fs.writeFileSync(
    path.join(root, 'marker.txt'),
    'OPBS WinPE VHD test source\r\nIf this file survives, backup-from-VHD worked.\r\n'
  );
  fs.writeFileSync(path.join(root, 'random.bin'), crypto.randomBytes(5 * 1024 * 1024));
  for (const f of ['winpe-entry.js', 'restore.cmd', 'vhd-test.js']) {
    const src = path.join(HERE, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(root, f));
  }
  say('Marker files written');

  await sleep(500);
  vd.detachVirtualDiskFile(SRC);
  say('Detached. src.vhdx ready at ' + SRC);
}

main().catch((e) => {
  say('PREP FAILED: ' + (e && e.message ? e.message : String(e)));
  try {
    vd.detachVirtualDiskFile(SRC);
  } catch (ignore) {
    /* already detached */
  }
  process.exit(1);
});
