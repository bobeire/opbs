// Direct smoke test of the VSS fix: does createSnapshotSet work?
//
// Runs elevated (VSS requesters must), so it writes its result to a file as
// well as the console — there is no console to read when launched with
// -Verb RunAs.
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const n = require('../src/native/build/Release/opbs_native.node');

const logPath = 'C:\\Users\\rober\\Documents\\opencode\\opbs\\vss-smoke-result.txt';
const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};

const t0 = Date.now();
try {
  const snaps = n.createSnapshotSet(['C:\\']);
  say(`createSnapshotSet OK in ${Date.now() - t0}ms: ${JSON.stringify(snaps)}`);
  const bytes = n.readBlocks(snaps[0].devicePath, 0n, 512n);
  say(`probe read OK: ${bytes.length} bytes, OEM = ${JSON.stringify(bytes.toString('ascii', 3, 11))}`);
  n.deleteSnapshot(snaps[0].id);
  say(`deleted ${snaps[0].id}`);
  fs.writeFileSync(logPath, `PASS\n${lines.join('\n')}\n`);
  process.exit(0);
} catch (e) {
  say(`FAILED after ${Date.now() - t0}ms: ${e && e.message ? e.message : e}`);
  fs.writeFileSync(logPath, `FAIL\n${lines.join('\n')}\n`);
  process.exit(1);
}
