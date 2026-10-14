/**
 * Macrium-image read benchmark — the restore-path cost.
 *
 * Opens every local Macrium sample (.mrimgx / .mrimg), then sequentially
 * reads every block of its largest partition through MacriumPartitionReader.
 * That path decompresses each block (zstd or QuickLZ) and MD5-verifies it
 * against Macrium's own stored digest — exactly what a restore does per
 * block before writing it to disk. No disks are touched; this is a pure
 * read/verify measurement.
 *
 * Usage:  node tools/benchmark-mrimg.js [iterations]
 * Output: one JSON line per (sample, iteration) plus a summary line.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readMacriumImage, openMacriumPartitionReader, closeImageFds } =
  require('../dist/imaging/mrimg');

const ITERATIONS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3;
const CHUNK = 4 * 1024 * 1024;

function discoverSamples() {
  const found = [];
  const dirs = [path.join(__dirname, '..', 'imagefilesamples'), path.join(__dirname, '..')];
  const seen = new Set();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/\.(mrimgx|mrimg)$/i.test(name) || seen.has(name)) continue;
      seen.add(name);
      const p = path.join(dir, name);
      try { if (fs.statSync(p).isFile()) found.push(p); } catch { /* ignore */ }
    }
  }
  return found;
}

function benchSample(imagePath) {
  const parseStart = process.hrtime.bigint();
  const info = readMacriumImage(imagePath);
  const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6;

  // Largest partition with data blocks.
  let partIdx = -1;
  let partSize = 0;
  info.partitions.forEach((p, i) => {
    if (p.blockCount > 0 && p.blockSize > 0) {
      const size = p.geometry?.length || p.blockCount * p.blockSize;
      if (size > partSize) { partSize = size; partIdx = i; }
    }
  });
  if (partIdx < 0) return { imagePath, error: 'no readable partition' };

  const reader = openMacriumPartitionReader(info, partIdx);
  const logical = reader.size;
  const readStart = process.hrtime.bigint();
  let pos = 0;
  while (pos < logical) {
    const want = Math.min(CHUNK, logical - pos);
    const buf = reader.read(pos, want);
    if (!buf || buf.length === 0) throw new Error(`empty read at ${pos}`);
    pos += buf.length;
  }
  const readMs = Number(process.hrtime.bigint() - readStart) / 1e6;

  return {
    imagePath: path.basename(imagePath),
    format: info.format,
    compression: info.compression?.level ?? 'none',
    fileSize: fs.statSync(imagePath).size,
    partition: partIdx,
    partitionFs: info.partitions[partIdx].fsType,
    blockSize: info.partitions[partIdx].blockSize,
    blockCount: info.partitions[partIdx].blockCount,
    logicalBytes: logical,
    parseMs: Math.round(parseMs),
    readMs: Math.round(readMs),
    readMBs: Math.round((logical / 1e6 / (readMs / 1000)) * 10) / 10
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const samples = discoverSamples();
if (samples.length === 0) {
  console.error('No .mrimg/.mrimgx samples found (imagefilesamples/ or repo root).');
  process.exit(1);
}

const cpu = os.cpus()[0];
console.log(JSON.stringify({
  kind: 'machine',
  cpu: cpu.model,
  cores: os.cpus().length,
  ramGB: Math.round(os.totalmem() / 1e9),
  node: process.version,
  platform: process.platform
}));

const allRuns = [];
for (const sample of samples) {
  const runs = [];
  for (let i = 0; i < ITERATIONS; i++) {
    clearMacriumCache();
    let r;
    try {
      r = benchSample(sample);
    } catch (err) {
      r = { imagePath: path.basename(sample), error: String(err.message || err) };
    }
    r.iteration = i + 1;
    console.log(JSON.stringify({ kind: 'run', ...r }));
    if (!r.error) runs.push(r);
    closeImageFds();
  }
  if (runs.length > 0) {
    allRuns.push({
      kind: 'summary',
      imagePath: path.basename(sample),
      format: runs[0].format,
      compression: runs[0].compression,
      fileSize: runs[0].fileSize,
      partitionFs: runs[0].partitionFs,
      logicalBytes: runs[0].logicalBytes,
      medianParseMs: Math.round(median(runs.map((r) => r.parseMs))),
      medianReadMs: Math.round(median(runs.map((r) => r.readMs))),
      medianReadMBs: median(runs.map((r) => r.readMBs)),
      iterations: runs.length
    });
  }
}
for (const s of allRuns) console.log(JSON.stringify(s));

function clearMacriumCache() {
  try { require('../dist/imaging/mrimg').clearMacriumInfoCache(); } catch { /* ignore */ }
}
