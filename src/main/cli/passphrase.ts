import * as fs from 'fs';
import { flagValue } from './flags';

export type PassphraseSource = 'file' | 'env' | 'flag' | 'none';

let warnedLegacyFlag = false;

/**
 * Resolve the passphrase for a command. Precedence:
 *   1. `--passphrase-file <path|->` — a file, or `-` for stdin
 *   2. `OPBS_PASSPHRASE` environment variable
 *   3. `--passphrase <p>` (legacy)
 *
 * argv is readable by other processes on the machine (process lists, WMI),
 * so the legacy flag keeps working for compatibility but announces itself
 * once on stderr and points at the safer alternatives. Throws when the
 * passphrase file cannot be read — failing loudly beats silently running an
 * encrypted-image operation without a passphrase.
 */
export function resolvePassphrase(argv: string[]): { value?: string; source: PassphraseSource } {
  const file = flagValue(argv, '--passphrase-file');
  if (file !== undefined) {
    let raw: string;
    try {
      raw = file === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(file, 'utf-8');
    } catch (error) {
      const where = file === '-' ? '(stdin)' : JSON.stringify(file);
      throw new Error(
        `cannot read --passphrase-file ${where}: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
    // Strip the trailing newline editors and `echo` add, keep everything else.
    return { value: raw.replace(/\r?\n$/, ''), source: 'file' };
  }

  const env = process.env.OPBS_PASSPHRASE;
  if (env) return { value: env, source: 'env' };

  const flag = flagValue(argv, '--passphrase');
  if (flag !== undefined) {
    if (!warnedLegacyFlag) {
      warnedLegacyFlag = true;
      console.error(
        'warning: --passphrase is visible in process lists; prefer --passphrase-file <path|-> or the OPBS_PASSPHRASE environment variable.'
      );
    }
    return { value: flag, source: 'flag' };
  }

  return { source: 'none' };
}

/** Test hook: forget that the legacy-flag warning was already printed. */
export function resetLegacyPassphraseWarning(): void {
  warnedLegacyFlag = false;
}
