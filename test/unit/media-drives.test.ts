import { describe, it, expect } from 'vitest';
import {
  parseMediaDrivesJson,
  formatMediaDriveOption,
  groupMediaDrives,
  protectedDriveLetters,
  usbTargetGuard,
  listMediaDrives,
  MediaDriveInfo
} from '../../src/main/utils/media-drives';

function drive(over: Partial<MediaDriveInfo> = {}): MediaDriveInfo {
  return {
    letter: 'E',
    volumeLabel: 'STICK',
    fs: 'exFAT',
    sizeBytes: 16_000_000_000,
    driveType: 'Removable',
    busType: 'USB',
    model: 'Cruzer Blade',
    removable: true,
    usb: true,
    isSystem: false,
    ...over
  };
}

describe('parseMediaDrivesJson', () => {
  it('parses the PowerShell array output', () => {
    const raw = JSON.stringify([
      {
        letter: 'E',
        volumeLabel: 'STICK',
        fs: 'exFAT',
        sizeBytes: 8_000_000_000,
        driveType: 'Removable',
        busType: 'USB',
        model: 'Cruzer',
        isSystem: false
      }
    ]);
    const drives = parseMediaDrivesJson(raw);
    expect(drives).toHaveLength(1);
    expect(drives[0]).toEqual({
      letter: 'E',
      volumeLabel: 'STICK',
      fs: 'exFAT',
      sizeBytes: 8_000_000_000,
      driveType: 'Removable',
      busType: 'USB',
      model: 'Cruzer',
      removable: true,
      usb: true,
      isSystem: false
    });
  });

  it('accepts a single object (not wrapped in an array)', () => {
    const drives = parseMediaDrivesJson('{"letter":"D","driveType":"Fixed","busType":"SATA"}');
    expect(drives).toHaveLength(1);
    expect(drives[0].letter).toBe('D');
    expect(drives[0].removable).toBe(false);
    expect(drives[0].usb).toBe(false);
  });

  it('defaults missing fields and normalizes letters and flags', () => {
    const drives = parseMediaDrivesJson(JSON.stringify([{ letter: 'e', driveType: 'Removable', busType: 'usb' }]));
    expect(drives[0].letter).toBe('E');
    expect(drives[0].usb).toBe(true);
    expect(drives[0].removable).toBe(true);
    expect(drives[0].volumeLabel).toBe('');
    expect(drives[0].sizeBytes).toBe(0);
  });

  it('drops garbage, invalid letters and null entries', () => {
    const drives = parseMediaDrivesJson(
      JSON.stringify([null, { letter: 'XY' }, { letter: '' }, 'nope', { driveType: 'Fixed' }])
    );
    expect(drives).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseMediaDrivesJson('not json')).toEqual([]);
    expect(parseMediaDrivesJson('')).toEqual([]);
    expect(parseMediaDrivesJson('null')).toEqual([]);
  });
});

describe('formatMediaDriveOption', () => {
  it('prefers the volume label and lists bus + removable traits', () => {
    const text = formatMediaDriveOption(drive());
    expect(text).toContain('E: — STICK');
    expect(text).toContain('GB');
    expect(text).toContain('USB, removable');
  });

  it('falls back to the disk model, then to "Local disk"', () => {
    expect(formatMediaDriveOption(drive({ volumeLabel: '' }))).toContain('Cruzer Blade');
    expect(formatMediaDriveOption(drive({ volumeLabel: '', model: '' }))).toContain('Local disk');
  });

  it('marks non-USB fixed disks as INTERNAL', () => {
    const text = formatMediaDriveOption(
      drive({ driveType: 'Fixed', busType: 'SATA', removable: false, usb: false })
    );
    expect(text).toContain('SATA, INTERNAL');
    expect(text).not.toContain('removable');
  });

  it('does not mark USB-attached SSDs as INTERNAL', () => {
    const text = formatMediaDriveOption(drive({ driveType: 'Fixed', removable: false, usb: true }));
    expect(text).toContain('USB');
    expect(text).not.toContain('INTERNAL');
  });
});

describe('groupMediaDrives', () => {
  it('routes USB/removable drives to primary and internal disks to others', () => {
    const groups = groupMediaDrives(
      [
        drive({ letter: 'E' }),
        drive({ letter: 'D', driveType: 'Fixed', busType: 'SATA', removable: false, usb: false, volumeLabel: 'DATA' }),
        drive({ letter: 'F', driveType: 'Fixed', busType: 'USB', removable: false, usb: true, volumeLabel: 'SSD' })
      ],
      []
    );
    expect(groups.primary.map((d) => d.letter)).toEqual(['E', 'F']);
    expect(groups.others.map((d) => d.letter)).toEqual(['D']);
    expect(groups.others[0].text).toContain('INTERNAL');
    expect(groups.primary[0].text).toContain('STICK');
  });

  it('never offers the system drive or explicitly protected letters', () => {
    const groups = groupMediaDrives(
      [
        drive({ letter: 'C', isSystem: true, volumeLabel: '' }),
        drive({ letter: 'A', volumeLabel: 'OPBS-ON-USB' }),
        drive({ letter: 'E' })
      ],
      ['A']
    );
    const letters = [...groups.primary, ...groups.others].map((d) => d.letter);
    expect(letters).toEqual(['E']);
  });

  it('drops optical and network volumes', () => {
    const groups = groupMediaDrives(
      [drive({ letter: 'D', driveType: 'CDRom' }), drive({ letter: 'Z', driveType: 'Network' }), drive({ letter: 'E' })],
      []
    );
    expect(groups.primary.map((d) => d.letter)).toEqual(['E']);
    expect(groups.others).toHaveLength(0);
  });

  it('sorts each group by drive letter', () => {
    const groups = groupMediaDrives([drive({ letter: 'M' }), drive({ letter: 'E' }), drive({ letter: 'G' })], []);
    expect(groups.primary.map((d) => d.letter)).toEqual(['E', 'G', 'M']);
  });
});

describe('protectedDriveLetters', () => {
  it('collects letters from the system drive, executable and app data paths', () => {
    expect(
      protectedDriveLetters({
        systemDrive: 'C:',
        execPath: 'D:\\Program Files\\OPBS\\opbs.exe',
        appData: 'C:\\Users\\me\\AppData\\Roaming\\opbs'
      })
    ).toEqual(['C', 'D']);
  });

  it('tolerates missing values', () => {
    expect(protectedDriveLetters({ systemDrive: null, execPath: undefined, appData: '' })).toEqual([]);
    expect(protectedDriveLetters()).toContain('C');
  });
});

describe('usbTargetGuard', () => {
  it('refuses the system/app drive even if the UI asks for it', () => {
    const err = usbTargetGuard('C:', ['C', 'D']);
    expect(err).toContain('Refusing');
    expect(err).toContain('C:');
    expect(usbTargetGuard('D', ['C', 'D'])).toContain('Refusing');
  });

  it('accepts a normal letter in any of the shapes the UI may send', () => {
    expect(usbTargetGuard('E', ['C'])).toBeNull();
    expect(usbTargetGuard('E:', ['C'])).toBeNull();
    expect(usbTargetGuard('E:\\', ['C'])).toBeNull();
    expect(usbTargetGuard('e', ['C'])).toBeNull();
  });

  it('refuses malformed targets', () => {
    expect(usbTargetGuard('', ['C'])).toContain('Invalid USB target');
    expect(usbTargetGuard('garbage', ['C'])).toContain('Invalid USB target');
    expect(usbTargetGuard('12:', ['C'])).toContain('Invalid USB target');
  });
});

describe('listMediaDrives (live query)', () => {
  it('returns grouped drives with valid letters and never a protected one', () => {
    const groups = listMediaDrives();
    expect(Array.isArray(groups.primary)).toBe(true);
    expect(Array.isArray(groups.others)).toBe(true);
    if (groups.error) {
      expect(groups.primary).toHaveLength(0);
      expect(groups.others).toHaveLength(0);
      return;
    }
    const protectedLetters = protectedDriveLetters();
    for (const d of [...groups.primary, ...groups.others]) {
      expect(d.letter).toMatch(/^[A-Z]$/);
      expect(d.text).toContain(`${d.letter}:`);
      expect(protectedLetters).not.toContain(d.letter);
      expect(d.isSystem).toBe(false);
    }
  }, 30_000);
});
