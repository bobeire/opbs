/**
 * electron-builder `afterAllArtifactBuild` hook: add a plain ZIP of the
 * unpacked app to the release artifacts (promised in issue #7 — the SFX
 * portable exe unpacks to a fresh %TEMP% path on every launch, which trips
 * antivirus prevalence checks; a ZIP extracted once to a stable path does
 * not).
 *
 * electron-builder publishes every path this hook returns.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterAllArtifactBuild(buildResult) {
  const outDir = buildResult.outDir || 'release';
  const unpacked = path.join(outDir, 'win-unpacked');
  if (!fs.existsSync(path.join(unpacked, 'OPBS.exe'))) {
    console.warn(`[after-build] ${unpacked} not found - skipping the portable ZIP`);
    return [];
  }
  const version = require('../package.json').version;
  const zipPath = path.resolve(outDir, `OPBS-Portable-${version}.zip`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  // Compress-Archive puts the CONTENTS of win-unpacked at the ZIP root, so
  // OPBS.exe sits right next to the extracted folder - extract and run.
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  );
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${unpacked.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    ],
    { stdio: 'inherit' }
  );
  console.log(`[after-build] portable ZIP written: ${zipPath}`);
  return [zipPath];
};
