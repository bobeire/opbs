/**
 * Passphrase confirmation helpers shared by the passphrase UI.
 *
 * A passphrase that is set once and never re-entered can silently lock the
 * user out of their own backups, so create flows require a confirm field.
 * Empty + empty is valid (e.g. "leave empty for no encryption").
 */

export type ConfirmStatus =
  /** Nothing typed in either field — valid (no encryption / nothing to confirm). */
  | 'empty'
  /** Passphrase typed but confirm field not filled in yet. */
  | 'incomplete'
  /** Both fields filled and identical. */
  | 'match'
  /** Both fields filled (or one cleared) and they differ. */
  | 'mismatch';

export function confirmStatus(value: string, confirm: string): ConfirmStatus {
  if (!value && !confirm) return 'empty';
  if (!confirm) return 'incomplete';
  return value === confirm ? 'match' : 'mismatch';
}

/** True when the passphrase is safe to save: both fields agree (both may be empty). */
export function confirmReady(value: string, confirm: string): boolean {
  return value === confirm;
}
