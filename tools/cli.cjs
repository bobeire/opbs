'use strict';
/**
 * Run the repo's CLI without packaging the app:
 *
 *   node tools\cli.cjs media create --usb D --yes --dual-partition
 *   node tools\cli.cjs mrimg info image.mrimgx
 *
 * Same entry the WinPE payload uses (`winpe-entry.js`), pointed at this
 * checkout's `dist`, so it exercises the code under development rather than
 * an installed/packaged OPBS.exe.
 */
const path = require('path');
const { runCli } = require(path.join(__dirname, '..', 'dist', 'cli', 'index.js'));

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3000).unref();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
