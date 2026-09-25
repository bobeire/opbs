import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  parseBitlockerJson,
  parseManageBdeStatus,
  isRecoveryProtectorType,
  hasRecoveryProtector,
  isWinPE,
  listBitlockerStatus,
  invalidateBitlockerCache,
  BitlockerVolumeStatus
} from '../../src/main/utils/bitlocker';

/**
 * Fixture #1 is verbatim output captured from this machine's elevated
 * Get-BitLockerVolume query (two decrypted volumes, no protectors — PS enums
 * serialize as numbers, which is exactly what the parser must tolerate).
 */
const REAL_GBL_ELEVATED =
  '[{"MountPoint":"C:","LockStatus":0,"VolumeStatus":0,"ProtectionStatus":0,"protectors":""},' +
  '{"MountPoint":"D:","LockStatus":0,"VolumeStatus":0,"ProtectionStatus":0,"protectors":""}]';

/** Fixture #2: canonical shape emitted by BL_QUERY_PS for an encrypted volume. */
const ENCRYPTED_GBL =
  '[{"MountPoint":"C:","LockStatus":1,"VolumeStatus":1,"ProtectionStatus":1,"VolumeType":"",' +
  '"Protectors":[{"type":"NumericalPassword"},{"type":"TPM"}]}]';

/** manage-bde -status fixture in the documented stable format (WinPE backend). */
const MBD_STATUS = [
  'BitLocker Drive Encryption tool version 10.0.22621',
  'Copyright (C) 2013 Microsoft Corporation. All rights reserved.',
  '',
  'Volume C: [OS Volume]',
  '      Size:                 499 GB',
  '      Percentage Encrypted: 100.0%',
  '      Conversion Status:    Fully Encrypted',
  '      Protection Status:    Protection On',
  '      Encryption Method:    XTS-AES 128',
  '      Lock Status:          Locked',
  '      Key Protectors:',
  '          Numerical Password',
  '          TPM',
  '',
  'Volume D: [Data Volume]',
  '      Size:                 931 GB',
  '      Percentage Encrypted: 0.0%',
  '      Conversion Status:    Fully Decrypted',
  '      Protection Status:    Protection Off',
  '      Lock Status:          Unlocked',
  '      Key Protectors:',
  '          TPM',
  ''
].join('\r\n');

function volume(over: Partial<BitlockerVolumeStatus> = {}): BitlockerVolumeStatus {
  return {
    letter: 'C',
    volumeType: '',
    locked: false,
    protectionOn: false,
    conversion: 'FullyEncrypted',
    protectors: [{ type: 'NumericalPassword' }],
    ...over
  };
}

describe('parseBitlockerJson', () => {
  it('parses the real elevated Get-BitLockerVolume capture (numeric enums)', () => {
    const volumes = parseBitlockerJson(REAL_GBL_ELEVATED);
    expect(volumes).not.toBeNull();
    expect(volumes).toHaveLength(2);
    expect(volumes![0]).toEqual({
      letter: 'C',
      volumeType: '',
      locked: false,
      protectionOn: false,
      conversion: 'FullyDecrypted',
      protectors: []
    });
    expect(volumes![1].letter).toBe('D');
  });

  it('parses an encrypted locked volume with string protector types', () => {
    const volumes = parseBitlockerJson(ENCRYPTED_GBL);
    expect(volumes).toHaveLength(1);
    const v = volumes![0];
    expect(v.letter).toBe('C');
    expect(v.locked).toBe(true);
    expect(v.protectionOn).toBe(true);
    expect(v.conversion).toBe('FullyEncrypted');
    expect(v.protectors.map((p) => p.type)).toEqual(['NumericalPassword', 'TPM']);
    expect(hasRecoveryProtector(v)).toBe(true);
  });

  it('maps numeric protector enums to names', () => {
    const volumes = parseBitlockerJson(
      '[{"MountPoint":"E:","LockStatus":0,"VolumeStatus":1,"ProtectionStatus":1,"Protectors":[2,0,9]}]'
    );
    expect(volumes![0].protectors.map((p) => p.type)).toEqual([
      'NumericalPassword',
      'TPM',
      'RecoveryPassword'
    ]);
  });

  it('splits comma-joined protector strings (ad-hoc query shape)', () => {
    const volumes = parseBitlockerJson(
      '[{"MountPoint":"E:","LockStatus":0,"VolumeStatus":1,"ProtectionStatus":1,"protectors":"NumericalPassword, TPM"}]'
    );
    expect(volumes![0].protectors.map((p) => p.type)).toEqual(['NumericalPassword', 'TPM']);
  });

  it('maps KeyProtectorType objects and numeric-string enum values', () => {
    const volumes = parseBitlockerJson(
      '[{"MountPoint":"C:","LockStatus":0,"VolumeStatus":1,"ProtectionStatus":1,' +
        '"Protectors":[{"KeyProtectorType":"RecoveryPassword"},{"KeyProtectorType":"2"},{"ProtectorType":0}]}]'
    );
    expect(volumes![0].protectors.map((p) => p.type)).toEqual([
      'RecoveryPassword',
      'NumericalPassword',
      'TPM'
    ]);
  });

  it('accepts a single object, alternate casings and lock/protection spellings', () => {
    const volumes = parseBitlockerJson(
      '{"mountPoint":"f:","lockStatus":"Locked","protectionStatus":"On","volumeStatus":"Encryption In Progress"}'
    );
    expect(volumes).toHaveLength(1);
    expect(volumes![0].letter).toBe('F');
    expect(volumes![0].locked).toBe(true);
    expect(volumes![0].protectionOn).toBe(true);
    expect(volumes![0].conversion).toBe('EncryptionInProgress');
  });

  it('distinguishes valid-empty from unparseable', () => {
    expect(parseBitlockerJson('[]')).toEqual([]);
    expect(parseBitlockerJson('not json')).toBeNull();
    expect(parseBitlockerJson('')).toBeNull();
    expect(parseBitlockerJson('null')).toBeNull();
    expect(parseBitlockerJson('"just a string"')).toBeNull();
  });

  it('drops entries without a drive letter', () => {
    expect(parseBitlockerJson('[{"MountPoint":"XY:","LockStatus":0},{"nope":1}]')).toEqual([]);
  });
});

describe('parseManageBdeStatus', () => {
  it('parses both volumes from documented manage-bde output', () => {
    const volumes = parseManageBdeStatus(MBD_STATUS);
    expect(volumes).not.toBeNull();
    expect(volumes).toHaveLength(2);

    const c = volumes![0];
    expect(c.letter).toBe('C');
    expect(c.volumeType).toBe('OS Volume');
    expect(c.locked).toBe(true);
    expect(c.protectionOn).toBe(true);
    expect(c.conversion).toBe('FullyEncrypted');
    expect(c.protectors.map((p) => p.type)).toEqual(['Numerical Password', 'TPM']);
    expect(hasRecoveryProtector(c)).toBe(true);

    const d = volumes![1];
    expect(d.letter).toBe('D');
    expect(d.volumeType).toBe('Data Volume');
    expect(d.locked).toBe(false);
    expect(d.protectionOn).toBe(false);
    expect(d.conversion).toBe('FullyDecrypted');
    expect(d.protectors.map((p) => p.type)).toEqual(['TPM']);
    expect(hasRecoveryProtector(d)).toBe(false);
  });

  it('handles a volume without Lock Status or Key Protectors sections', () => {
    const volumes = parseManageBdeStatus(
      ['Volume X: [Data Volume]', '      Conversion Status:    Encryption In Progress', '      Protection Status:    Protection On', ''].join(
        '\r\n'
      )
    );
    expect(volumes).toHaveLength(1);
    expect(volumes![0].locked).toBe(false);
    expect(volumes![0].conversion).toBe('EncryptionInProgress');
    expect(volumes![0].protectors).toEqual([]);
    expect(volumes![0].volumeType).toBe('Data Volume');
  });

  it('returns null for tool errors and empty input (not valid-empty)', () => {
    expect(parseManageBdeStatus('')).toBeNull();
    expect(parseManageBdeStatus('   ')).toBeNull();
    expect(parseManageBdeStatus('ERROR: An attempt to access a required resource was denied.')).toBeNull();
    expect(parseManageBdeStatus('BitLocker Drive Encryption tool version 10.0')).toBeNull();
  });

  it('does not leak protector names across volume blocks', () => {
    const volumes = parseManageBdeStatus(MBD_STATUS);
    const dProtectors = volumes![1].protectors.map((p) => p.type);
    expect(dProtectors).not.toContain('Numerical Password');
  });
});

describe('isRecoveryProtectorType / hasRecoveryProtector', () => {
  it('accepts WMI and manage-bde spellings of the recovery password', () => {
    expect(isRecoveryProtectorType('NumericalPassword')).toBe(true);
    expect(isRecoveryProtectorType('RecoveryPassword')).toBe(true);
    expect(isRecoveryProtectorType('numerical password')).toBe(true);
    expect(isRecoveryProtectorType('recovery-password')).toBe(true);
    expect(isRecoveryProtectorType('RECOVERY_PASSWORD')).toBe(true);
  });

  it('rejects other protector kinds — including the plain Password protector', () => {
    expect(isRecoveryProtectorType('TPM')).toBe(false);
    expect(isRecoveryProtectorType('Password')).toBe(false);
    expect(isRecoveryProtectorType('StartupKey')).toBe(false);
    expect(isRecoveryProtectorType('Certificate')).toBe(false);
    expect(isRecoveryProtectorType('')).toBe(false);
  });

  it('hasRecoveryProtector scans every protector on the volume', () => {
    expect(hasRecoveryProtector(volume())).toBe(true);
    expect(hasRecoveryProtector(volume({ protectors: [{ type: 'TPM' }, { type: 'PIN' }] }))).toBe(false);
    expect(hasRecoveryProtector(volume({ protectors: [{ type: 'TPM' }, { type: 'Numerical Password' }] }))).toBe(true);
  });
});

describe('isWinPE', () => {
  it('detects the X: system drive of the recovery environment', () => {
    expect(isWinPE({ SystemDrive: 'X:' })).toBe(true);
    expect(isWinPE({ SystemDrive: 'x:' })).toBe(true);
  });

  it('is false on a normal Windows system drive', () => {
    expect(isWinPE({ SystemDrive: 'C:', SystemRoot: 'C:\\Windows' })).toBe(false);
  });
});

describe('listBitlockerStatus (live, non-elevated — must never trigger UAC)', () => {
  beforeAll(() => invalidateBitlockerCache());
  afterAll(() => invalidateBitlockerCache());

  it('returns a well-formed result without elevation', async () => {
    const res = await listBitlockerStatus({ refresh: true });
    expect(['bitlocker-json', 'manage-bde']).toContain(res.source);
    expect(Array.isArray(res.volumes)).toBe(true);
    if (res.ok) {
      for (const v of res.volumes) {
        expect(v.letter).toMatch(/^[A-Z]$/);
        expect(typeof v.locked).toBe('boolean');
        expect(typeof v.protectors).toBe('object');
      }
    } else {
      // A non-admin probe must fail OPEN with an elevation hint, never crash.
      expect(res.needsElevation).toBe(true);
      expect(res.error).toBeTruthy();
    }
  }, 30_000);

  it('serves subsequent no-flag calls from the session cache', async () => {
    const first = await listBitlockerStatus({ refresh: true });
    if (first.ok) {
      const second = await listBitlockerStatus();
      expect(second.source).toBe('cache');
      expect(second.volumes).toEqual(first.volumes);
    }
  }, 30_000);
});
