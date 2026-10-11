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
 * returned as-is. An encrypted value that fails to decrypt (settings copied
 * from another user/machine) is returned unchanged and logged: downstream it
 * then fails loudly as a wrong passphrase instead of silently degrading to an
 * unencrypted run. Before the app is ready the blob is also returned
 * unchanged — callers hydrate lazily and retry.
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
