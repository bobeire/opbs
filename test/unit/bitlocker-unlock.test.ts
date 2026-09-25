import { describe, it, expect } from 'vitest';
import {
  validateRecoveryPassword,
  buildWindowsUnlockScript,
  parseUnlockOutput,
  unlockVolume,
  volumesHaveRecoveryProtector,
  UNLOCK_OK_MARKER
} from '../../src/main/utils/bitlocker-unlock';
import { BITLOCKER_STATUS_PS } from '../../src/main/utils/bitlocker';

const VALID = '123456-234567-345678-456789-567890-678901-789012-890123';

describe('validateRecoveryPassword', () => {
  it('accepts the canonical dashed form', () => {
    const result = validateRecoveryPassword(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized).toBe(VALID);
  });

  it('canonicalises contiguous and space-separated input', () => {
    const contiguous = validateRecoveryPassword(VALID.replace(/-/g, ''));
    expect(contiguous.ok).toBe(true);
    if (contiguous.ok) expect(contiguous.normalized).toBe(VALID);

    const spaced = validateRecoveryPassword('  123456 234567 345678 456789 567890 678901 789012 890123  ');
    expect(spaced.ok).toBe(true);
    if (spaced.ok) expect(spaced.normalized).toBe(VALID);
  });

  it('rejects wrong lengths, non-digits and empty input', () => {
    expect(validateRecoveryPassword('').ok).toBe(false);
    expect(validateRecoveryPassword('   ').ok).toBe(false);
    expect(validateRecoveryPassword('123456').ok).toBe(false);
    expect(validateRecoveryPassword(VALID.replace(/\d$/, '')).ok).toBe(false);
    expect(validateRecoveryPassword(`${VALID}1`).ok).toBe(false);
    expect(validateRecoveryPassword('abcdefgh-ijklmn-opqrstu-vwxyza-bcdefg-hijklm-nopqrs-tuvwxyz').ok).toBe(false);
  });

  it('rejects the reserved all-zero group', () => {
    expect(validateRecoveryPassword('000000-234567-345678-456789-567890-678901-789012-890123').ok).toBe(false);
    expect(validateRecoveryPassword('123456-234567-345678-456789-000000-678901-789012-890123').ok).toBe(false);
  });

  it('rejects injection attempts — accepted values are ALWAYS canonical digits+dashes', () => {
    const nasty = [
      "123456-234567-345678-456789-567890-678901-789012-890123'; rm -rf C:\\",
      '123456-234567-345678-456789-567890-678901-789012-890123$(calc)',
      '123456-234567-345678-456789-567890-678901-789012-890123\nrm x',
      '`whoami`-234567-345678-456789-567890-678901-789012-890123',
      '123456-234567-345678-456789-567890-678901-789012-890123 '
    ];
    for (const input of nasty) {
      const result = validateRecoveryPassword(input);
      if (result.ok) {
        expect(result.normalized).toMatch(/^\d{6}(-\d{6}){7}$/);
      } else {
        expect(typeof result.error).toBe('string');
      }
    }
  });
});

describe('buildWindowsUnlockScript', () => {
  it('reads the password from the environment and never embeds it', () => {
    const script = buildWindowsUnlockScript('d');
    expect(script).toContain('$env:OPBS_BL_RECOVERY_PW');
    expect(script).toContain('Unlock-BitLocker');
    expect(script).toContain("-MountPoint 'D:'");
    // No password-shaped literal can be in the script: there is no 48-digit run.
    expect(script).not.toMatch(/\d{6}-\d{6}-\d{6}/);
    expect(script).not.toMatch(/\d{48}/);
  });

  it('verifies the unlock and prints marker before the status JSON', () => {
    const script = buildWindowsUnlockScript('C');
    expect(script).toContain('LockStatus');
    expect(script).toContain(`throw 'Volume C: is still locked.'`);
    const markerAt = script.indexOf(UNLOCK_OK_MARKER);
    const jsonAt = script.indexOf('ConvertTo-Json');
    expect(markerAt).toBeGreaterThan(0);
    expect(jsonAt).toBeGreaterThan(markerAt);
  });

  it('appends the shared status projection unchanged', () => {
    const script = buildWindowsUnlockScript('C');
    expect(script).toContain(BITLOCKER_STATUS_PS);
    expect(script).toContain('KeyProtectorType');
  });

  it('quotes the mount point defensively', () => {
    const script = buildWindowsUnlockScript("c'");
    // psQuote doubles embedded apostrophes: value C': becomes ' + C'': + '.
    const quoted = "-MountPoint '" + "C''" + ":'";
    expect(script).toContain(quoted);
  });
});

describe('parseUnlockOutput', () => {
  const statusJson = '[{"MountPoint":"D:","LockStatus":0,"VolumeStatus":1,"ProtectionStatus":1,"Protectors":[{"type":"RecoveryPassword"}]}]';

  it('extracts the marker and the status JSON after it', () => {
    const parsed = parseUnlockOutput(`${UNLOCK_OK_MARKER}\r\n${statusJson}\r\n`);
    expect(parsed.ok).toBe(true);
    expect(parsed.volumes).toHaveLength(1);
    expect(parsed.volumes![0].letter).toBe('D');
    expect(parsed.volumes![0].locked).toBe(false);
  });

  it('treats marker-without-JSON as success with unknown status', () => {
    const parsed = parseUnlockOutput(`noise\r\n${UNLOCK_OK_MARKER}\r\n`);
    expect(parsed.ok).toBe(true);
    expect(parsed.volumes).toBeNull();
  });

  it('fails when the marker is absent', () => {
    expect(parseUnlockOutput('Access denied').ok).toBe(false);
    expect(parseUnlockOutput('').ok).toBe(false);
    expect(parseUnlockOutput('OPBS_UNLOCK_NOT_REALLY').ok).toBe(false);
  });
});

describe('unlockVolume input guards (no elevation reached)', () => {
  it('rejects invalid drive letters before doing anything', async () => {
    const result = await unlockVolume('XY', VALID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('drive letter');
  }, 15_000);

  it('rejects malformed passwords before doing anything', async () => {
    const result = await unlockVolume('C', 'not-a-password');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('48 digits');
  }, 15_000);
});

describe('volumesHaveRecoveryProtector', () => {
  const vol = (types: string[]) => ({
    letter: 'C',
    volumeType: '',
    locked: false,
    protectionOn: true,
    conversion: 'FullyEncrypted',
    protectors: types.map((type) => ({ type }))
  });

  it('detects both WMI and manage-bde spellings', () => {
    expect(volumesHaveRecoveryProtector([vol(['TPM'])])).toBe(false);
    expect(volumesHaveRecoveryProtector([vol(['TPM', 'RecoveryPassword'])])).toBe(true);
    expect(volumesHaveRecoveryProtector([vol(['Numerical Password'])])).toBe(true);
    expect(volumesHaveRecoveryProtector([])).toBe(false);
  });
});
