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
  // Compress-Archive pulls in the Microsoft.PowerShell.Archive module, which
  // is not always loadable (it failed with "module could not be loaded" on the
  // 0.6.118 and 0.6.119 builds). ZipFile is part of the .NET framework and
  // needs no module. CreateFromDirectory puts the CONTENTS of win-unpacked at
  // the ZIP root, so OPBS.exe sits right next to the extracted folder.
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  );
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::CreateFromDirectory(` +
        `'${unpacked.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}')`
    ],
    { stdio: 'inherit' }
  );
  console.log(`[after-build] portable ZIP written: ${zipPath}`);
  return [zipPath];
};
