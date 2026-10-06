'use strict';
/**
 * OPBS WinPE VHD live test.
 *
 * Steps:
 *   0. network probe (NIC driver / DHCP check - informational, or hard with
 *      --require-net)
 *   1. backup --source-vhd   (0.6.44 feature: attach a VHD read-only, back it up)
 *   2. restore into a fresh VHD (0.6.45 feature: fresh GPT + early rescan)
 *
 * Against scratch VHDX files staged on this media (never a physical disk).
 *
 * All paths derive from this script's location, so the stick works in any
 * drive letter on any x64 machine. Results: console + test\winpe-test-log.txt.
 * Artifacts (test\img-winpe, test\restored.vhdx) are byte-compared after the
 * stick is brought back to the dev machine.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const TEST = path.join(HERE, 'test');
const IMG = path.join(TEST, 'img-winpe');
const SRC_VHD = path.join(TEST, 'src.vhdx');
const OUT_VHD = path.join(TEST, 'restored.vhdx');
const LOG = path.join(TEST, 'winpe-test-log.txt');
const ENTRY = path.join(HERE, 'winpe-entry.js');

let failures = 0;

function log(line) {
  process.stdout.write(line + '\r\n');
  try {
    fs.appendFileSync(LOG, line + '\r\n');
  } catch (e) {
    /* log must never break the test */
  }
}

function check(name, ok, detail) {
  log((ok ? 'PASS: ' : 'FAIL: ') + name + (!ok && detail ? ' - ' + detail : ''));
  if (!ok) failures++;
}

/**
 * Network probe: list non-internal IPv4 addresses, then try a TCP connect to
 * 1.1.1.1:53 (5 s timeout). The probe runs in a child process so this
 * synchronous harness can wait for it without restructuring. Reported as
 * PASS/WARN; a WARN only becomes a failure with --require-net, because a
 * NIC-less or DHCP-less WinPE boot is still a valid restore environment.
 */
const NET_PROBE_SRC = [
  "const os=require('os'),net=require('net');",
  'const ipv4=[];',
  'const ifs=os.networkInterfaces();',
  "for (const n of Object.keys(ifs)) { for (const i of ifs[n]||[]) { if ((i.family==='IPv4'||i.family===4) && !i.internal) ipv4.push(n+'='+i.address); } }",
  'const done=(tcp)=>process.stdout.write(JSON.stringify({ipv4:ipv4,tcp:tcp}));',
  'if (!ipv4.length) { done(null); } else {',
  "  const s=net.connect({host:'1.1.1.1',port:53});",
  '  s.setTimeout(5000);',
  "  s.on('connect',()=>{ done(true); s.destroy(); });",
  "  s.on('timeout',()=>{ done(false); s.destroy(); });",
  "  s.on('error',()=>{ done(false); });",
  '}'
].join('');

function probeNetwork(requireNet) {
  let info = null;
  try {
    const r = spawnSync(process.execPath, ['-e', NET_PROBE_SRC], {
      env: Object.assign({}, process.env, { OPENSSL_CONF: '' }),
      encoding: 'utf8',
      timeout: 20000
    });
    info = JSON.parse(String(r.stdout || '').trim() || 'null');
  } catch (e) {
    info = null;
  }
  const ipv4 = (info && info.ipv4) || [];
  const tcp = info ? info.tcp : null;
  const ok = ipv4.length > 0 && tcp === true;
  log('net: ipv4=' + (ipv4.join(', ') || 'none') + ' tcp=' + tcp);
  if (ok) {
    log('PASS: network probe (IPv4 + TCP reachable)');
  } else if (requireNet) {
    check('network probe (IPv4 + TCP reachable)', false, 'ipv4=' + ipv4.length + ' tcp=' + tcp);
  } else {
    log('WARN: network probe (no IPv4 or TCP unreachable - NIC driver or DHCP unavailable)');
  }
}

function run(args) {
  log('> node winpe-entry.js ' + args.join(' '));
  const r = spawnSync(process.execPath, [ENTRY].concat(args), {
    cwd: HERE,
    env: Object.assign({}, process.env, { OPENSSL_CONF: '' }),
    encoding: 'utf8',
    timeout: 15 * 60 * 1000
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  out.split(/\r?\n/).forEach((l) => {
    if (l.trim()) log('    ' + l);
  });
  log('    exit=' + r.status);
  return { code: r.status, out: out };
}

function newestOpbs(dir) {
  let best = null;
  let bestTime = 0;
  const entries = fs.readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    if (!/\.opbs$/i.test(f)) continue;
    const p = path.join(dir, f);
    const t = fs.statSync(p).mtimeMs;
    if (t > bestTime) {
      bestTime = t;
      best = p;
    }
  }
  return best;
}

function main() {
  try {
    fs.mkdirSync(IMG, { recursive: true });
  } catch (e) {
    /* exists */
  }
  const stale = fs.readdirSync(IMG);
  for (let i = 0; i < stale.length; i++) {
    try {
      fs.rmSync(path.join(IMG, stale[i]), { force: true });
    } catch (e) {
      /* keep going */
    }
  }
  try {
    fs.rmSync(OUT_VHD, { force: true });
  } catch (e) {
    /* may not exist */
  }
  try {
    fs.rmSync(LOG, { force: true });
  } catch (e) {
    /* may not exist */
  }

  log('=== OPBS WinPE VHD live test ===');
  log('date: ' + new Date().toISOString());
  log('node: ' + process.version + '   media: ' + HERE);

  check('src.vhdx staged on media', fs.existsSync(SRC_VHD), SRC_VHD + ' missing');
  if (failures > 0) return finish();
  if (!fs.existsSync(ENTRY)) {
    check('winpe-entry.js present', false, ENTRY + ' missing');
    return finish();
  }

  const disks = run(['disks']);
  check('disks command runs', disks.code === 0);

  probeNetwork(process.argv.indexOf('--require-net') >= 0);

  const backupCfg = path.join(TEST, 'vhd-backup.json');
  fs.writeFileSync(
    backupCfg,
    JSON.stringify(
      {
        sourceDiskIndex: 0,
        sourcePartitions: [],
        destinationPath: IMG,
        compressionLevel: 1,
        verificationEnabled: true,
        usedBlocksOnly: false
      },
      null,
      2
    )
  );
  const b = run(['backup', backupCfg, '--source-vhd', SRC_VHD, '--elevated']);
  check('backup --source-vhd reported OK', b.code === 0 && b.out.indexOf('Job OK') >= 0, 'exit=' + b.code);
  const img = newestOpbs(IMG);
  check('backup wrote an .opbs image', img !== null, 'none in ' + IMG);
  if (img) log('image: ' + img);

  // Image sanity: every captured partition must be non-empty with written
  // blocks. Catches silent partial/zero images (index not finalized, wrong
  // partition captured) even when the CLI itself reported success.
  let imageMeta = null;
  if (img) {
    try {
      const fmt = require(path.join(HERE, 'dist', 'imaging', 'image-format.js'));
      imageMeta = fmt.readImageInfo(img);
      const parts = imageMeta.partitions || [];
      const bad = parts.filter((p) => !(p.size > 0) || !(p.blockCount > 0));
      check(
        'image has non-empty partitions',
        parts.length > 0 && bad.length === 0,
        parts.length + ' partition(s), bad=' + JSON.stringify(bad)
      );
      log('image meta: partitions=' + JSON.stringify(parts));
    } catch (e) {
      check('image has non-empty partitions', false, String((e && e.message) || e));
    }
  }

  if (img && imageMeta) {
    const restoreCfg = path.join(TEST, 'vhd-restore.json');
    fs.writeFileSync(
      restoreCfg,
      JSON.stringify(
        {
          imagePath: img,
          targetPartitions: (imageMeta.partitions || []).map((p) => p.partitionIndex),
          targetVirtualDisk: { path: OUT_VHD, type: 'dynamic', virtualSize: 268435456 }
        },
        null,
        2
      )
    );
    const r = run(['restore', restoreCfg, '--elevated']);
    check('restore into fresh VHD reported OK', r.code === 0 && r.out.indexOf('Job OK') >= 0, 'exit=' + r.code);
    check('restored.vhdx exists', fs.existsSync(OUT_VHD), OUT_VHD + ' missing');
  } else {
    check('restore step ran', false, 'skipped because no usable image was produced');
  }

  finish();
}

function finish() {
  log('');
  log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  log('Artifacts for judging: test\\img-winpe, test\\restored.vhdx, test\\winpe-test-log.txt');
  process.exit(failures === 0 ? 0 : 1);
}

main();
