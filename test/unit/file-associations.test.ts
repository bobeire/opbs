import { describe, it, expect } from 'vitest';
import {
  collectAssociationEntries,
  regAddArgs,
  applyAssociationEntries,
  unregisterFileAssociations,
  parseFileActionArgs,
  FILE_VERBS
} from '../../src/main/utils/file-associations';

describe('collectAssociationEntries', () => {
  const entries = collectAssociationEntries('C:\\Program Files\\OPBS\\OPBS.exe');

  it('registers the extension, progid, icon and default verb', () => {
    expect(entries.some((e) => e.key === '.opbs' && e.default === 'Opbs.Image.1')).toBe(true);
    expect(entries.some((e) => e.key === 'Opbs.Image.1' && e.default === 'OPBS Disk Image')).toBe(true);
    expect(entries.some((e) => e.key === 'Opbs.Image.1\\DefaultIcon' && e.default === '"C:\\Program Files\\OPBS\\OPBS.exe",0')).toBe(true);
    expect(entries.some((e) => e.key === 'Opbs.Image.1\\shell' && e.default === 'open')).toBe(true);
  });

  it('registers a command for every verb pointing at --file-verb with the file placeholder', () => {
    for (const verb of FILE_VERBS) {
      const command = entries.find((e) => e.key === `Opbs.Image.1\\shell\\${verb}\\command`);
      expect(command).toBeDefined();
      expect(command!.default).toBe(
        `"C:\\Program Files\\OPBS\\OPBS.exe" --file-verb ${verb} "%1"`
      );
      expect(entries.some((e) => e.key === `Opbs.Image.1\\shell\\${verb}` && typeof e.default === 'string')).toBe(true);
    }
  });

  it('registers the Open-with app entry', () => {
    expect(entries.some((e) => e.key === 'Applications\\OPBS.exe')).toBe(true);
    expect(entries.some((e) => e.key === 'Applications\\OPBS.exe\\shell\\open\\command')).toBe(true);
  });
});

describe('regAddArgs', () => {
  it('builds a /ve default-value command', () => {
    const args = regAddArgs({ key: 'Opbs.Image.1\\shell\\verify\\command', default: '"x" --file-verb verify "%1"' });
    expect(args).toEqual([[
      'add',
      'HKCU\\Software\\Classes\\Opbs.Image.1\\shell\\verify\\command',
      '/f',
      '/ve',
      '/d',
      '"x" --file-verb verify "%1"'
    ]]);
  });
});

describe('applyAssociationEntries', () => {
  it('reports failures when the registry write fails', () => {
    const run = () => ({ status: 1, error: 'Access denied' });
    const result = applyAssociationEntries([{ key: '.opbs', default: 'X' }], run);
    expect(result.ok).toBe(false);
    expect(result.failures.join('')).toContain('.opbs');
    expect(result.failures.join('')).toContain('Access denied');
  });

  it('returns ok when every write succeeds', () => {
    const run = () => ({ status: 0 });
    const result = applyAssociationEntries(collectAssociationEntries('C:\\x\\OPBS.exe'), run);
    expect(result.ok).toBe(true);
  });
});

describe('unregisterFileAssociations', () => {
  it('deletes the class keys', () => {
    const seen: string[] = [];
    const run = (args: string[]) => {
      if (args[0] === 'delete') seen.push(args[1]);
      return { status: 0 };
    };
    const result = unregisterFileAssociations(run);
    expect(result.ok).toBe(true);
    expect(seen).toContain('HKCU\\Software\\Classes\\.opbs');
    expect(seen).toContain('HKCU\\Software\\Classes\\Opbs.Image.1');
  });
});

describe('parseFileActionArgs', () => {
  it('parses --file-verb restore with a path', () => {
    expect(parseFileActionArgs(['OPBS.exe', '--file-verb', 'restore', 'D:\\backups\\img.opbs'])).toEqual({
      verb: 'restore',
      imagePath: 'D:\\backups\\img.opbs'
    });
  });

  it('ignores unknown verbs', () => {
    expect(parseFileActionArgs(['OPBS.exe', '--file-verb', 'explode', 'D:\\img.opbs'])).toBeNull();
  });

  it('parses a bare absolute image path as the open verb', () => {
    expect(parseFileActionArgs(['OPBS.exe', 'C:\\data\\chain.opbs'])).toEqual({
      verb: 'open',
      imagePath: 'C:\\data\\chain.opbs'
    });
  });

  it('parses macrium images too', () => {
    expect(parseFileActionArgs(['OPBS.exe', 'C:\\data\\old.mrimg'])).toEqual({
      verb: 'open',
      imagePath: 'C:\\data\\old.mrimg'
    });
  });

  it('rejects non-image argv and relative paths', () => {
    expect(parseFileActionArgs(['OPBS.exe', 'C:\\data\\notes.txt'])).toBeNull();
    expect(parseFileActionArgs(['OPBS.exe', 'img.opbs'])).toBeNull();
  });
});