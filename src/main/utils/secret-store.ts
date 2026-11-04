import { logger } from './logger';
import { getElectron } from './electron-access';

/**
 * At-rest encryption for secrets stored in JSON files (settings.json,
 * unattended task configs) via Electron's `safeStorage` — DPAPI on Windows,
 * Keychain on macOS, kwallet/gnome-libsecret on Linux. Encrypted values are
 * prefixed `enc:v1:` so plaintext (legacy or hand-written configs) is still
 * accepted everywhere: a value without the prefix is returned unchanged.
 *
 * `safeStorage` needs the Electron app to be ready and must not run under
 * plain node.exe (WinPE), so both are probed lazily — this module is safe to
 * import from CLI/payload code.
 */
const PREFIX = 'enc:v1:';

let warnedFallback = false;

function safeStorage(): typeof import('electron').safeStorage | undefined {
  try {
    const electron = getElectron();
    if (!electron?.app?.isReady?.()) return undefined;
    const storage = electron.safeStorage;
    if (!storage?.isEncryptionAvailable?.()) return undefined;
    return storage;
  } catch {
    return undefined;
  }
}

export function isSecretEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt for storage. Returns the input unchanged when it is empty, already
 * encrypted, or the OS secret store is unavailable (pre-ready / no keyring) —
 * the latter logs once and degrades to the pre-0.6.79 plaintext behavior
 * rather than failing the operation.
 */
export function encryptSecret(value: string): string {
  if (!value || isSecretEncrypted(value)) return value;
  const storage = safeStorage();
  if (!storage) {
    if (!warnedFallback) {
      warnedFallback = true;
      logger.warn('OS secret store unavailable — storing settings secrets in plaintext (as before).');
    }
    return value;
  }
  try {
    return PREFIX + storage.encryptString(value).toString('base64');
  } catch (error) {
    logger.warn('Secret encryption failed — storing in plaintext:', error);
    return value;
  }
}

/**
 * Reverse of `encryptSecret`. A value without the prefix is plaintext and
 * returned as-is.
 *
 * An encrypted value that fails to decrypt (settings copied from another
 * user or machine, a reinstalled Windows) is returned UNCHANGED. That is
 * deliberate for callers that must not throw during lazy hydration, but it
 * is a trap: a caller that uses the result as a passphrase would encrypt
 * data with `enc:v1:...` as the literal key — a secret nobody knows, created
 * without warning. So the result is indistinguishable from a real value and
 * every caller that needs a usable secret must check `isSecretEncrypted()`
 * afterwards and refuse when it still is. (Field report 2026-11-04: a backup
 * was encrypted with the blob and the old comment here claimed the caller
 * would "fail loudly as a wrong passphrase". It did not fail at all.)
 *
 * Before the app is ready the blob is also returned unchanged — callers
 * hydrate lazily and retry.
 */
export function decryptSecret(value: string): string {
  if (!isSecretEncrypted(value)) return value;
  const storage = safeStorage();
  if (!storage) return value;
  try {
    return storage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'));
  } catch (error) {
    logger.warn('Stored secret could not be decrypted (foreign machine/user?):', error);
    return value;
  }
}

/**
 * Decrypt, or report that the value is still an encrypted blob. Use this
 * wherever the result must be a real secret: it makes "cannot decrypt"
 * impossible to mistake for success.
 */
export function tryDecryptSecret(value: string): { ok: true; value: string } | { ok: false; stillEncrypted: true } {
  const decrypted = decryptSecret(value);
  return isSecretEncrypted(decrypted) ? { ok: false, stillEncrypted: true } : { ok: true, value: decrypted };
}
