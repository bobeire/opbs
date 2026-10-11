/**
 * Lazy accessor for the `electron` module.
 *
 * `electron` must never be imported at module load in the CLI/payload graph:
 * the WinPE media runs plain `node.exe` where the package is absent (and in
 * dev installs `require('electron')` resolves to a path string, not a
 * module). Everything that needs Electron at runtime funnels through this
 * accessor, which also gives tests a seam — `vi.mock('electron')` does not
 * intercept raw `require` calls.
 */
export function getElectron(): typeof import('electron') | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron') as unknown;
    return mod && typeof mod === 'object' ? (mod as typeof import('electron')) : undefined;
  } catch {
    return undefined;
  }
}
