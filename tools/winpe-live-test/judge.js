'use strict';
/**
 * Judge the VHD live-test artifacts: back up test\restored.vhdx (read-only
 * attach) into test\img-judge, then byte-compare every partition against
 * the image taken from test\src.vhdx.
 *
 * Run elevated (VHD attach requires admin), e.g. from an admin console:
 *   node.exe judge.js
 * Results: console + test\judge-log.txt. Exit code 0 = byte-exact.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const TEST = path.join(HERE, 'test');
const IMG_SRC = path.join(TEST, 'img-winpe');
const IMG_JUDGE = path.join(TEST, 'img-judge');
const OUT_VHD = path.join(TEST, 'restored.vhdx');
const LOG = path.join(TEST, 'judge-log.txt');
const ENTRY = path.join(HERE, 'winpe-entry.js');

let failures = 0;

function log(line) {
  process.stdout.write(line + '\r\n');
  try {
    fs.appendFileSync(LOG, line + '\r\n');
  } catch (e) {
    /* log must never break judging */
  }
}

function check(name, ok, detail) {
  log((ok ? 'PASS: ' : 'FAIL: ') + name + (!ok && detail ? ' - ' + detail : ''));
  if (!ok) failures++;
}

function newestOpbs(dir) {
  try {
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.opbs'))
      .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    return names.length ? path.join(dir, names[names.length - 1].n) : null;
  } catch (e) {
    return null;
  }
}

function run(args) {
  log('> node winpe-entry.js ' + args.join(' '));
  const r = spawnSync(process.execPath, [ENTRY].concat(args), {
    encoding: 'utf8',
    cwd: HERE,
    timeout: 600000
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  out.split(/\r?\n/).forEach((line) => {
    if (line.trim()) log('    ' + line);
  });
  log('    exit=' + r.status);
  return { code: r.status, out: out };
}

function comparePartition(imgA, imgB, pIndex, metaA, metaB) {
  const browse = require(path.join(HERE, 'dist', 'imaging', 'image-browse.js'));
  const A = browse.partitionReaderForChain([imgA], pIndex);
  const B = browse.partitionReaderForChain([imgB], pIndex);
  if (A.partition.offset !== B.partition.offset || A.partition.size !== B.partition.size) {
    return 'meta mismatch: ' + JSON.stringify(A.partition) + ' vs ' + JSON.stringify(B.partition);
  }
  const CHUNK = 8 * 1024 * 1024;
  const size = Number(A.partition.size);
  let off = 0;
  while (off < size) {
    const want = Math.min(CHUNK, size - off);
    const la = A.reader.read(off, want);
    const lb = B.reader.read(off, want);
    if (la.length !== lb.length || !la.equals(lb)) {
      let i = 0;
      while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
      return 'byte diff at partition offset ' + (off + i) + ' (partition ' + pIndex + ', size ' + size + ')';
    }
    off += la.length;
  }
  return null;
}

function main() {
  fs.writeFileSync(LOG, '');
  log('=== OPBS VHD test judge (restored.vhdx vs src image) ===');
  log('date: ' + new Date().toISOString() + '   node: ' + process.version + '   media: ' + HERE);

  check('restored.vhdx exists', fs.existsSync(OUT_VHD), OUT_VHD + ' missing');
  const imgA = newestOpbs(IMG_SRC);
  check('source image exists', imgA !== null, 'none in ' + IMG_SRC);
  if (!imgA || !fs.existsSync(OUT_VHD)) {
    log(failures + ' FAILURES');
    return failures ? 1 : 0;
  }

  try {
    fs.rmSync(IMG_JUDGE, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  fs.mkdirSync(IMG_JUDGE, { recursive: true });

  const cfg = path.join(TEST, 'vhd-judge.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify(
      {
        sourceDiskIndex: 0,
        sourcePartitions: [],
        destinationPath: IMG_JUDGE,
        compressionLevel: 1,
        verificationEnabled: true,
        usedBlocksOnly: false
      },
      null,
      2
    )
  );
  const b = run(['backup', cfg, '--source-vhd', OUT_VHD, '--elevated']);
  check('backup restored.vhdx reported OK', b.code === 0 && b.out.indexOf('Job OK') >= 0, 'exit=' + b.code);

  const imgB = newestOpbs(IMG_JUDGE);
  check('judge image written', imgB !== null, 'none in ' + IMG_JUDGE);
  if (!imgB) {
    log(failures + ' FAILURES');
    return 1;
  }

  const fmt = require(path.join(HERE, 'dist', 'imaging', 'image-format.js'));
  const metaA = fmt.readImageInfo(imgA);
  const metaB = fmt.readImageInfo(imgB);
  const idxA = (metaA.partitions || []).map((p) => p.partitionIndex);
  const idxB = (metaB.partitions || []).map((p) => p.partitionIndex);
  check(
    'partition sets match',
    JSON.stringify(idxA) === JSON.stringify(idxB),
    JSON.stringify(idxA) + ' vs ' + JSON.stringify(idxB)
  );

  for (const p of metaA.partitions || []) {
    if (idxB.indexOf(p.partitionIndex) < 0) continue;
    let err = null;
    try {
      err = comparePartition(imgA, imgB, p.partitionIndex, metaA, metaB);
    } catch (e) {
      err = String((e && e.message) || e);
    }
    check(
      'partition ' + p.partitionIndex + ' byte-exact (' + p.size + ' bytes)',
      err === null,
      err || undefined
    );
  }

  log(failures ? failures + ' FAILURES' : 'JUDGE ALL PASS');
  return failures ? 1 : 0;
}

process.exit(main());
