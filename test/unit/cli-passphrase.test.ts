import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePassphrase, resetLegacyPassphraseWarning } from '../../src/main/cli/passphrase';

describe('resolvePassphrase', () => {
  let dir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-pass-'));
    delete process.env.OPBS_PASSPHRASE;
    resetLegacyPassphraseWarning();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.OPBS_PASSPHRASE;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const warnings = (): string[] =>
    errorSpy.mock.calls.map((args) => String(args[0])).filter((s) => s.includes('warning:'));

  it('reads the passphrase from a file and strips the trailing newline', () => {
    const file = path.join(dir, 'pw.txt');
    fs.writeFileSync(file, 'filesecret\n', 'utf-8');

    const result = resolvePassphrase(['--passphrase-file', file]);

    expect(result).toEqual({ value: 'filesecret', source: 'file' });
    expect(warnings()).toHaveLength(0);
  });

  it('supports the --flag=value form', () => {
    const file = path.join(dir, 'pw.txt');
    fs.writeFileSync(file, 'eqsecret', 'utf-8');
    expect(resolvePassphrase([`--passphrase-file=${file}`]).value).toBe('eqsecret');
  });

  it('reads the passphrase from OPBS_PASSPHRASE', () => {
    process.env.OPBS_PASSPHRASE = 'envsecret';
    expect(resolvePassphrase([])).toEqual({ value: 'envsecret', source: 'env' });
    expect(warnings()).toHaveLength(0);
  });

  it('uses the legacy flag but warns once on stderr', () => {
    expect(resolvePassphrase(['--passphrase', 'flagsecret'])).toEqual({
      value: 'flagsecret',
      source: 'flag'
    });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('process lists');

    // A second use in the same process does not repeat the warning.
    resolvePassphrase(['--passphrase', 'again']);
    expect(warnings()).toHaveLength(1);
  });

  it('prefers file over env over flag', () => {
    const file = path.join(dir, 'pw.txt');
    fs.writeFileSync(file, 'fromfile', 'utf-8');
    process.env.OPBS_PASSPHRASE = 'fromenv';

    expect(resolvePassphrase(['--passphrase-file', file, '--passphrase', 'fromflag']).value).toBe('fromfile');
    expect(resolvePassphrase(['--passphrase', 'fromflag']).value).toBe('fromenv');
    delete process.env.OPBS_PASSPHRASE;
    expect(resolvePassphrase([]).source).toBe('none');
  });

  it('ignores an empty env value', () => {
    process.env.OPBS_PASSPHRASE = '';
    expect(resolvePassphrase(['--passphrase', 'flagsecret']).source).toBe('flag');
    expect(resolvePassphrase([]).source).toBe('none');
  });

  it('throws when the passphrase file cannot be read', () => {
    expect(() => resolvePassphrase(['--passphrase-file', path.join(dir, 'missing.txt')])).toThrow(
      /cannot read --passphrase-file/
    );
  });

  it('returns no passphrase when nothing is supplied', () => {
    expect(resolvePassphrase([])).toEqual({ source: 'none' });
    expect(warnings()).toHaveLength(0);
  });
});
