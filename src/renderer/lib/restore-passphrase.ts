/**
 * Restore-wizard passphrase plumbing.
 *
 * The same trimmed passphrase must reach every unlock-bearing restore config
 * (preflight, start and recovery staging). Keeping the payload builder here
 * lets the UI flow be unit-tested without a DOM renderer: the original bug was
 * a preflight that re-ran on every keystroke but never sent the passphrase.
 */

/** Extra fields to spread into a restore config when a passphrase was entered. */
export function restorePassphraseOption(passphrase: string): { passphrase?: string } {
  const trimmed = passphrase.trim();
  return trimmed ? { passphrase: trimmed } : {};
}
