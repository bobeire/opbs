'use strict';
/**
 * OPBS "restore after reboot into WinRE" live test - Windows side.
 *
 * Full round-trip of the recovery-after-reboot feature, always against a
 * scratch VHDX (never a physical disk):
 *
 *   prep   : ensure test\src.vhdx (prep-src.js source VHD) and back it up to
 *            test\recovery-image.opbs with `backup --source-vhd`
 *   stage  : write test\recovery-config.json and run `recovery stage`, then
 *            assert the staged payload + one-shot "OPBS Recovery" BCD entry
 *   (reboot - the machine boots OPBS Recovery once, restores automatically
 *    after a 10-second cancel window and returns to Windows on its own)
 *   after  : `recovery status` (pending result, consumed on read), scratch
 *            VHDX restored, one-shot entry consumed, then `recovery cleanup`
 *   cancel : `recovery cleanup` only - abort without rebooting
 *
 * SAFETY: no step writes to a physical disk. Everything lives in test\ and
 * in %SystemDrive%\Recovery\OPBS (the staged payload). The one-shot boot
 * entry is removed again by the after/cancel phases.
 *
 * NOTE: test\restored.vhdx is created/restored by the WinRE phase and its
 * path must live on the system drive - the PE environment usually keeps
 * that drive letter, so the absolute path staged in OPBS-restore.json still
 * resolves there. The same holds for test\recovery-image.opbs (the image is
 * read back by the PE restore from that absolute path).
 *
 * The OPBS CLI runs from the repo build (dist/cli/index.js resolved against
 * the repo root two levels up - it exports runCli, see winpe-entry.js for the
 * same shim pattern). Pass --cli <path> to run another build's
 * dist/cli/index.js instead (e.g. an installed OPBS).
 *
 * Results: console + test\recovery-test-log.txt. Every phase ends with
 * "ALL PASS" or "FAILED: n". The after phase consumes the result marker
 * (%SystemDrive%\OPBS-restore-result.json), so a second after run reports
 * "no pending result" - run prep+stage again for another round-trip.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
// Artifacts live on the SYSTEM DRIVE no matter which drive the repo sits on:
// the WinRE phase must open the same paths from PE, and PE reliably keeps
// only the system drive's letter. (A repo on D: used to fail the gate.)
const SYSTEM_DRIVE = process.env.SystemDrive || 'C:';
const TEST = path.join(SYSTEM_DRIVE, 'opbs-recovery-test');
const SRC_VHD = path.join(TEST, 'src.vhdx');
const IMAGE = path.join(TEST, 'recovery-image.opbs');
const OUT_VHD = path.join(TEST, 'restored.vhdx');
const CFG = path.join(TEST, 'recovery-config.json');
const LOG = path.join(TEST, 'recovery-test-log.txt');
const STAGE_DIR = path.join(SYSTEM_DRIVE, 'Recovery', 'OPBS');
const RESULT_MARKER = path.join(SYSTEM_DRIVE, 'OPBS-restore-result.json');
const ENTRY_DESCRIPTION = 'OPBS Recovery';
// prep-src.js creates a 256 MB VHDX; used only if the native reader is
// unavailable.
const DEFAULT_VIRTUAL_SIZE = 268435456;

const BACKUP_TIMEOUT_MS = 15 * 60 * 1000;
const STAGE_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 30 * 60 * 1000;
const STATUS_TIMEOUT_MS = 2 * 60 * 1000;
const PREP_TIMEOUT_MS = 10 * 60 * 1000;

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

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (e) {
    return null;
  }
}

/** Extract the first JSON object from mixed CLI output (--json replies). */
function extractJson(out) {
  const s = String(out || '').indexOf('{');
  const e = String(out || '').lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(String(out).slice(s, e + 1));
  } catch (err) {
    return null;
  }
}

/**
 * Run the OPBS CLI (dist/cli/index.js exports runCli; running the file
 * directly is a no-op) through the same shim winpe-entry.js is built from.
 */
const CLI_RUNNER_SRC = [
  "'use strict';",
  "const cli = require(process.argv[1]);",
  'Promise.resolve(cli.runCli(process.argv.slice(2)))',
  '  .then((code) => {',
  '    process.exitCode = code;',
  '    setTimeout(() => process.exit(code), 3000).unref();',
  '  })',
  '  .catch((error) => {',
  '    console.error(error instanceof Error ? error.stack : String(error));',
  '    process.exit(1);',
  '  });'
].join('\n');

let CLI = path.join(REPO, 'dist', 'cli', 'index.js');
// dist root of whatever build we run (…\dist\cli\index.js -> …\dist); filled
// in by main() so --cli also picks up that build's image-format/virtual-disk.
let DIST = path.join(REPO, 'dist');

function runOpbs(args, timeoutMs) {
  log('> ' + CLI + ' ' + args.join(' '));
  const r = spawnSync(process.execPath, ['-e', CLI_RUNNER_SRC, CLI].concat(args), {
    cwd: HERE,
    env: Object.assign({}, process.env, { OPENSSL_CONF: '' }),
    encoding: 'utf8',
    timeout: timeoutMs || BACKUP_TIMEOUT_MS
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  out.split(/\r?\n/).forEach((l) => {
    if (l.trim()) log('    ' + l);
  });
  log('    exit=' + r.status);
  return { code: r.status, out: out };
}

function bcd(args) {
  log('> bcdedit ' + args.join(' '));
  const r = spawnSync('bcdedit', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  out.split(/\r?\n/).forEach((l) => {
    if (l.trim()) log('    ' + l);
  });
  return out;
}

function bcdEnum() {
  return bcd(['/enum']);
}

function bcdBootmgr() {
  return bcd(['/enum', '{bootmgr}']);
}

function isElevated() {
  const r = spawnSync('net', ['session'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  return r.status === 0;
}

function onSystemDrive(p) {
  return path.resolve(p).toLowerCase().indexOf((SYSTEM_DRIVE + '\\').toLowerCase()) === 0;
}

/** Delete a possibly-attached VHDX (detach first when needed). */
function forceRemove(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch (e) {
    /* busy - try detach below */
  }
  if (fs.existsSync(p)) {
    try {
      const vd = require(path.join(DIST, 'utils', 'virtual-disk.js'));
      const info = vd.readVirtualDiskInfo(p);
      if (info && info.isLoaded) vd.detachVirtualDiskFile(p);
    } catch (e) {
      /* not attached / no native helper */
    }
    try {
      fs.rmSync(p, { force: true });
    } catch (e) {
      /* still busy */
    }
  }
  return !fs.existsSync(p);
}

/** Shared read-only image metadata (same discovery as vhd-test.js). */
function readImageMeta(imagePath) {
  const fmt = require(path.join(DIST, 'imaging', 'image-format.js'));
  return fmt.readImageInfo(imagePath);
}

/**
 * prep: ensure test\src.vhdx exists (reusing prep-src.js when it does not -
 * vhd-test.js requires the very same file to be staged), then back it up to
 * test\recovery-image.opbs. Everything stays inside test\.
 */
function ensureSrcVhd() {
  const valid = () => fs.existsSync(SRC_VHD) && fs.statSync(SRC_VHD).size > 4 * 1024 * 1024;
  if (valid()) {
    check('src.vhdx staged in ' + TEST, true);
    return;
  }
  if (fs.existsSync(SRC_VHD)) {
    // A partial file from a failed run must not pass the check next time.
    log('removing a stale/partial src.vhdx before regenerating');
    fs.rmSync(SRC_VHD, { force: true });
  }
  log('src.vhdx missing - generating it with prep-src.js ...');
  const r = spawnSync(process.execPath, [path.join(HERE, 'prep-src.js'), TEST], {
    cwd: HERE,
    env: Object.assign({}, process.env, { OPENSSL_CONF: '' }),
    encoding: 'utf8',
    timeout: PREP_TIMEOUT_MS
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  out.split(/\r?\n/).forEach((l) => {
    if (l.trim()) log('    ' + l);
  });
  log('    exit=' + r.status);
  check(
    'src.vhdx staged in ' + TEST,
    r.status === 0 && valid(),
    'prep-src.js could not create it (see its output above) - it needs an admin console, or copy a prepared src.vhdx into ' + TEST
  );
}

function phasePrep() {
  ensureSrcVhd();
  if (failures > 0) return;

  // Deterministic image name - drop any stale copy first (safe to re-run).
  try {
    fs.rmSync(IMAGE, { force: true });
  } catch (e) {
    /* may not exist */
  }
  const backupCfg = path.join(TEST, 'recovery-backup.json');
  fs.writeFileSync(
    backupCfg,
    JSON.stringify(
      {
        sourceDiskIndex: 0,
        sourcePartitions: [],
        destinationPath: TEST,
        imageName: 'recovery-image',
        compressionLevel: 1,
        verificationEnabled: true,
        usedBlocksOnly: false
      },
      null,
      2
    )
  );
  // Same invocation style as vhd-test.js's backup step.
  const b = runOpbs(['backup', backupCfg, '--source-vhd', SRC_VHD, '--elevated'], BACKUP_TIMEOUT_MS);
  check('backup --source-vhd reported Job OK', b.code === 0 && b.out.indexOf('Job OK') >= 0, 'exit=' + b.code);
  const st = safeStat(IMAGE);
  check('recovery-image.opbs written', st !== null && st.size > 1024 * 1024, IMAGE + ' missing or tiny');

  // Image sanity (as in vhd-test.js): catch silent partial/zero images.
  try {
    const meta = readImageMeta(IMAGE);
    const parts = meta.partitions || [];
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

/**
 * stage: write test\recovery-config.json (exactly one target: this test uses
 * targetVirtualDisk, never targetDiskIndex - nothing physical is touched),
 * run `recovery stage`, then assert the staged payload and BCD entry.
 */
function phaseStage() {

  // Idempotent re-run: a previous (unbooted) staging must go first, or its
  // one-shot BCD entry would leak.
  if (fs.existsSync(STAGE_DIR) || bcdEnum().indexOf(ENTRY_DESCRIPTION) >= 0) {
    log('previous staging found - cleaning it up before re-staging');
    const c = runOpbs(['recovery', 'cleanup'], CLEANUP_TIMEOUT_MS);
    check('previous staging removed', c.code === 0 && !fs.existsSync(STAGE_DIR), 'exit=' + c.code);
  }

  // The WinRE phase creates test\restored.vhdx - drop any stale copy first.
  const removed = forceRemove(OUT_VHD);
  check('stale restored.vhdx removed', removed, OUT_VHD + ' is locked - detach the VHDX and retry');
  if (!removed) return;

  let partIdx = [];
  try {
    // The CLI has no image-info command - discover partitions the same way
    // vhd-test.js/judge.js do (readImageInfo on the .opbs image).
    partIdx = (readImageMeta(IMAGE).partitions || []).map((p) => p.partitionIndex);
    check('image partitions discovered', partIdx.length > 0, 'none in ' + IMAGE);
    log('image partitions: ' + JSON.stringify(partIdx));
  } catch (e) {
    check('image partitions discovered', false, String((e && e.message) || e));
  }
  if (partIdx.length === 0) return;

  let virtualSize = DEFAULT_VIRTUAL_SIZE;
  try {
    const vd = require(path.join(DIST, 'utils', 'virtual-disk.js'));
    const info = vd.readVirtualDiskInfo(SRC_VHD);
    if (info && info.virtualSize > 0) virtualSize = info.virtualSize;
  } catch (e) {
    log('WARN: could not read src.vhdx virtual size - using ' + DEFAULT_VIRTUAL_SIZE);
  }
  log('target virtualSize: ' + virtualSize);

  fs.writeFileSync(
    CFG,
    JSON.stringify(
      {
        imagePath: IMAGE,
        targetVirtualDisk: { path: OUT_VHD, virtualSize: virtualSize, type: 'dynamic' },
        targetPartitions: partIdx,
        verifyBeforeWrite: true
      },
      null,
      2
    )
  );
  log('config: ' + CFG);

  const s = runOpbs(['recovery', 'stage', CFG], STAGE_TIMEOUT_MS);
  check('recovery stage reported OK', s.code === 0 && s.out.indexOf('Recovery restore staged') >= 0, 'exit=' + s.code);

  check('staged folder exists at ' + STAGE_DIR, fs.existsSync(STAGE_DIR), STAGE_DIR + ' missing');
  const REQUIRED = [
    'winre.wim',
    'media\\OPBS\\node.exe',
    'media\\OPBS\\OPBS-restore.json',
    'media\\OPBS\\restore.cmd',
    'media\\OPBS\\winpe-entry.js',
    'stage.json'
  ];
  REQUIRED.forEach((rel) => {
    check('staged file present: ' + rel, fs.existsSync(path.join(STAGE_DIR, rel)), path.join(STAGE_DIR, rel) + ' missing');
  });

  const enumOut = bcdEnum();
  check('bcdedit /enum lists an "' + ENTRY_DESCRIPTION + '" entry', enumOut.indexOf(ENTRY_DESCRIPTION) >= 0, 'no such entry');

  let entryGuid = null;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(STAGE_DIR, 'stage.json'), 'utf-8'));
    entryGuid = typeof marker.entryGuid === 'string' ? marker.entryGuid : null;
  } catch (e) {
    /* checked below */
  }
  check('stage.json holds the entry GUID', entryGuid !== null, 'stage.json missing or has no entryGuid');

  const bootOut = bcdBootmgr();
  const seq = /bootsequence[^\r\n]*/i.exec(bootOut);
  check(
    'bootsequence references the ' + ENTRY_DESCRIPTION + ' entry',
    seq !== null && entryGuid !== null && seq[0].toLowerCase().indexOf(String(entryGuid).toLowerCase()) >= 0,
    seq === null
      ? 'no bootsequence line in bcdedit /enum {bootmgr}'
      : entryGuid
        ? 'bootsequence is "' + seq[0].trim() + '" (expected ' + entryGuid + ')'
        : 'entry GUID unknown'
  );

  let stagedCfg = null;
  try {
    stagedCfg = JSON.parse(fs.readFileSync(path.join(STAGE_DIR, 'media', 'OPBS', 'OPBS-restore.json'), 'utf-8'));
  } catch (e) {
    /* checked below */
  }
  check(
    'staged OPBS-restore.json contains targetVirtualDisk',
    stagedCfg !== null && !!stagedCfg.targetVirtualDisk && typeof stagedCfg.targetVirtualDisk.path === 'string',
    'missing'
  );
  check(
    'staged target is test\\restored.vhdx',
    stagedCfg !== null &&
      !!stagedCfg.targetVirtualDisk &&
      path.resolve(stagedCfg.targetVirtualDisk.path) === path.resolve(OUT_VHD),
    stagedCfg && stagedCfg.targetVirtualDisk ? String(stagedCfg.targetVirtualDisk.path) : 'no targetVirtualDisk'
  );

  log('');
  log('NEXT STEPS:');
  log('  1. Restart the machine now (Start menu -> Restart, or: shutdown /r /t 0).');
  log('  2. It boots "' + ENTRY_DESCRIPTION + '" instead of Windows (one-shot).');
  log('     A 10-second cancel window appears - do NOT cancel; the restore runs');
  log('     automatically into ' + OUT_VHD);
  log('  3. When the restore finishes, the machine reboots back into Windows by');
  log('     itself. Log in, then run:  recovery-test.cmd after');
  log('');
  log('To abort BEFORE restarting (nothing has been restored yet):');
  log('  recovery-test.cmd cancel');
}

/**
 * after: the machine has been through the OPBS Recovery boot. Read (and
 * thereby consume) the result marker, verify the scratch VHDX and the
 * consumed one-shot entry, then clean everything up.
 */
function phaseAfter() {

  const st = runOpbs(['recovery', 'status', '--json'], STATUS_TIMEOUT_MS);
  const status = extractJson(st.out);
  check('recovery status --json ran', st.code === 0 && status !== null, 'exit=' + st.code);
  if (!status || !status.pendingResult) {
    check('pending recovery result present', false, 'none found - did the OPBS Recovery boot run the restore?');
  } else {
    check('pending recovery result present', true);
    log('result marker consumed by this status read: ' + RESULT_MARKER);
    check(
      'recovery restore reported ok',
      status.pendingResult.ok === true,
      status.pendingResult.ok
        ? undefined
        : 'failed with exit code ' +
            (status.pendingResult.exitCode != null ? status.pendingResult.exitCode : '?') +
            (status.pendingResult.finishedAt ? ' at ' + status.pendingResult.finishedAt : '')
    );
  }

  const st2 = safeStat(OUT_VHD);
  check('restored.vhdx exists', st2 !== null, OUT_VHD + ' missing');
  if (st2 !== null) {
    check('restored.vhdx is non-trivial (> 1 MB)', st2.size > 1024 * 1024, st2.size + ' bytes');
  }

  // One-shot means one-shot: the boot manager consumed the bootsequence.
  const bootOut = bcdBootmgr();
  check('bootsequence consumed (one-shot)', /bootsequence/i.test(bootOut) === false, 'bootsequence line still present');

  const c = runOpbs(['recovery', 'cleanup'], CLEANUP_TIMEOUT_MS);
  check('recovery cleanup reported OK', c.code === 0, 'exit=' + c.code);
  check('staged folder removed', !fs.existsSync(STAGE_DIR), STAGE_DIR + ' still present');
  const enumOut = bcdEnum();
  check('"' + ENTRY_DESCRIPTION + '" boot entry removed', enumOut.indexOf(ENTRY_DESCRIPTION) < 0, 'entry still listed');
}

/** cancel: abort the test before rebooting - remove entry + staged files. */
function phaseCancel() {
  const c = runOpbs(['recovery', 'cleanup'], CLEANUP_TIMEOUT_MS);
  check('recovery cleanup reported OK', c.code === 0, 'exit=' + c.code);
  check('staged folder removed', !fs.existsSync(STAGE_DIR), STAGE_DIR + ' still present');
  const enumOut = bcdEnum();
  check('"' + ENTRY_DESCRIPTION + '" boot entry removed', enumOut.indexOf(ENTRY_DESCRIPTION) < 0, 'entry still listed');
  const bootOut = bcdBootmgr();
  check('bootsequence cleared', /bootsequence/i.test(bootOut) === false, 'bootsequence line still present');
  log('staged restore cancelled - nothing was restored; test\\restored.vhdx is expected to be absent.');
}

function parseArgs(argv) {
  let cli = null;
  let phase = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cli') {
      cli = argv[++i] || null;
    } else if (a.indexOf('--') === 0) {
      /* ignore unknown flags */
    } else if (!phase) {
      phase = a;
    }
  }
  return { cli: cli, phase: phase };
}

function finish() {
  log('');
  log(failures === 0 ? 'ALL PASS' : 'FAILED: ' + failures);
  log('Log: ' + LOG);
  process.exit(failures === 0 ? 0 : 1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase;
  if (args.cli) CLI = path.resolve(args.cli);
  const distGuess = path.dirname(path.dirname(CLI));
  DIST = fs.existsSync(path.join(distGuess, 'imaging', 'image-format.js')) ? distGuess : path.join(REPO, 'dist');

  if (!phase || ['prep', 'stage', 'after', 'cancel'].indexOf(phase) < 0) {
    process.stdout.write('usage: recovery-test.js <prep|stage|after|cancel> [--cli <path-to-dist-cli-index.js>]\r\n');
    process.exit(1);
  }

  try {
    fs.mkdirSync(TEST, { recursive: true });
  } catch (e) {
    /* exists */
  }
  if (phase === 'prep') {
    // A fresh prep starts a fresh log; later phases append to it.
    try {
      fs.rmSync(LOG, { force: true });
    } catch (e) {
      /* may not exist */
    }
  }

  log('');
  log('=== OPBS recovery-after-reboot live test - phase ' + phase + ' ===');
  log('date: ' + new Date().toISOString());
  log('node: ' + process.version + '   dir: ' + HERE);
  log('cli:  ' + CLI);
  log('staged payload: ' + STAGE_DIR + '   result marker: ' + RESULT_MARKER);

  check('OPBS CLI present', fs.existsSync(CLI), CLI + ' missing - build the repo (npm run build) or pass --cli <path>');
  if (failures > 0) return finish();
  check('artifacts on the system drive (PE keeps that letter)', onSystemDrive(TEST), TEST + ' is not under ' + SYSTEM_DRIVE);
  if (failures > 0) return finish();
  // VHD attach and bcdedit both need it - fail fast instead of cryptic 1314s.
  check(
    'running as an administrator',
    isElevated(),
    'right-click the console (or the .cmd) and choose "Run as administrator"'
  );
  if (failures > 0) return finish();

  if (phase === 'prep') phasePrep();
  else if (phase === 'stage') phaseStage();
  else if (phase === 'after') phaseAfter();
  else phaseCancel();

  finish();
}

main();
