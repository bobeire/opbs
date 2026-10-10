/**
 * Runtime validation for values that reach shell/PowerShell command text.
 *
 * TypeScript types are erased at the IPC boundary: `contextIsolation` and
 * `nodeIntegration: false` harden the renderer, but a compromised renderer
 * can still invoke any handler with any argument shape. Every sink that
 * interpolates a value into a command string must re-check it in main.
 */

/** Parse and validate a physical-disk index (non-negative integer). */
export function toDiskIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid disk index: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Validate a volume argument for chkdsk: a bare drive letter, optional slash (`C:` / `C:\`). */
export function toChkdskVolume(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\?$/.test(value)) {
    throw new Error(`Invalid volume for chkdsk: ${JSON.stringify(value)}`);
  }
  return value;
}
