import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// settings-manager imports `app` from electron at module load and resolves its
// config dir from it; give it the minimum it touches so the module can be used
// in a test, and point it at a per-test directory.
const electronState = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isReady: () => false, getPath: () => electronState.userData }
}));

import { tryDecryptSecret, isSecretEncrypted, encryptSecret } from '../../src/main/utils/secret-store';

/**
 * Two defects found by code review on 2026-11-04, both of the same shape: a
 * failure that looked like success.
 *
 * 1. `decryptSecret` returns an undecryptable blob unchanged, and a caller
 *    used it as a passphrase — so a backup was encrypted with `enc:v1:...` as
 *    the literal key. Nobody could ever open it, and nothing said so.
 * 2. A corrupt settings.json fell back to defaults, and the next save
 *    overwrote the damaged file. Schedules and stored credentials vanished.
 */
describe('secrets that cannot be decrypted', () => {
  it('reports the blob instead of returning it as if it were a secret', () => {
    // A blob safeStorage cannot decrypt here: the value must not pass for a
    // usable passphrase.
    const blob = 'enc:v1:' + Buffer.from('not really encrypted').toString('base64');
    expect(isSecretEncrypted(blob)).toBe(true);

    const result = tryDecryptSecret(blob);
    // Whether it decrypts depends on the machine's safeStorage; what matters
    // is that failure is not indistinguishable from success.
    if (!result.ok) {
      expect(result.stillEncrypted).toBe(true);
    } else {
      expect(isSecretEncrypted(result.value)).toBe(false);
    }
  });

  it('passes plaintext through as usable', () => {
    const result = tryDecryptSecret('hunter2');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hunter2');
  });

  it('never hands back something that still looks like a blob', async () => {
    // The invariant every caller depends on: if we say ok, the value is a
    // real secret.
    const { tryDecryptSecret: tryDecrypt } = await import('../../src/main/utils/secret-store');
    for (const value of ['plain', 'enc:v1:AAAA', encryptSecret('x')]) {
      const result = tryDecrypt(value);
      if (result.ok) expect(isSecretEncrypted(result.value)).toBe(false);
    }
  });
});

describe('settings persistence', () => {
  let dir: string;
  const originalUserData = electronState.userData;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-settings-'));
    electronState.userData = dir;
  });

  afterEach(() => {
    electronState.userData = originalUserData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Where the manager keeps its file, discovered rather than assumed. */
  async function settingsPath(): Promise<string> {
    const { SettingsManager } = await import('../../src/main/utils/settings-manager');
    const probe = new SettingsManager();
    return (probe as unknown as { settingsFile: string }).settingsFile;
  }

  it('keeps a damaged settings file instead of overwriting it with defaults', async () => {
    const file = await settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The old behaviour: parse error -> defaults -> the next save destroyed
    // the evidence and the user's schedules with it.
    fs.writeFileSync(file, '{"defaultCompression": 3, "schedules": [TRUNCATED');

    const { SettingsManager } = await import('../../src/main/utils/settings-manager');
    const manager = new SettingsManager();

    // Nothing is silently destroyed: the damaged bytes still exist somewhere
    // under a name that says what happened.
    const survivors = fs
      .readdirSync(path.dirname(file))
      .filter((f) => f.includes('corrupt') || f === path.basename(file));
    expect(survivors.length).toBeGreaterThan(0);

    // And saving afterwards must not be the thing that loses them: whatever
    // the manager writes, a copy of the damaged file survives.
    manager.save();
    const afterSave = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('corrupt'));
    expect(afterSave.length).toBeGreaterThan(0);
  });

  it('replaces settings atomically, never leaving a half-written file', async () => {
    const file = await settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ defaultCompression: 5 }));

    const { SettingsManager } = await import('../../src/main/utils/settings-manager');
    const manager = new SettingsManager();
    manager.save();

    // No stray .tmp left behind, and the file is valid JSON.
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).not.toThrow();
  });
});
