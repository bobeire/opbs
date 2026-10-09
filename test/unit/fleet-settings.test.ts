import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCheckinSettings, resolveCheckinInvocation, CheckinSettings } from '../../src/main/cli/fleet';

describe('loadCheckinSettings', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-settings-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeSettings(content: string): string {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  }

  it('loads a full settings file', () => {
    const file = writeSettings(
      JSON.stringify({
        server: 'http://central:8787',
        token: 't1',
        tokenFile: 'C:\\cfg\\token.txt',
        dirs: ['D:\\backups'],
        noMedia: true,
        machineId: 'fixed-id'
      })
    );
    expect(loadCheckinSettings(file)).toEqual({
      server: 'http://central:8787',
      token: 't1',
      tokenFile: 'C:\\cfg\\token.txt',
      dirs: ['D:\\backups'],
      noMedia: true,
      machineId: 'fixed-id'
    });
  });

  it('accepts a partial settings file and omits absent keys', () => {
    const file = writeSettings(JSON.stringify({ server: 'http://central:8787' }));
    expect(loadCheckinSettings(file)).toEqual({ server: 'http://central:8787' });
  });

  it('rejects unreadable files, bad JSON and non-objects with precise messages', () => {
    expect(() => loadCheckinSettings(path.join(dir, 'missing.json'))).toThrow(/cannot read --settings/);
    expect(() => loadCheckinSettings(writeSettings('{ nope'))).toThrow(/not valid JSON/);
    expect(() => loadCheckinSettings(writeSettings('[]'))).toThrow(/must be a JSON object/);
    expect(() => loadCheckinSettings(writeSettings('42'))).toThrow(/must be a JSON object/);
  });

  it('rejects wrong field types by name', () => {
    expect(() => loadCheckinSettings(writeSettings(JSON.stringify({ server: 5 })))).toThrow(/server must be a string/);
    expect(() => loadCheckinSettings(writeSettings(JSON.stringify({ dirs: 'D:\\x' })))).toThrow(/dirs must be an array/);
    expect(() => loadCheckinSettings(writeSettings(JSON.stringify({ dirs: [1] })))).toThrow(/dirs must be an array/);
    expect(() => loadCheckinSettings(writeSettings(JSON.stringify({ noMedia: 'yes' })))).toThrow(/noMedia must be a boolean/);
    expect(() => loadCheckinSettings(writeSettings(JSON.stringify({ token: 9 })))).toThrow(/token must be a string/);
  });
});

describe('resolveCheckinInvocation', () => {
  const savedToken = process.env.OPBS_FLEET_TOKEN;

  beforeEach(() => {
    delete process.env.OPBS_FLEET_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.OPBS_FLEET_TOKEN;
    else process.env.OPBS_FLEET_TOKEN = savedToken;
  });

  it('takes server/dirs/media from settings when no flags are present', () => {
    const settings: CheckinSettings = { server: 'http://s:1', dirs: ['D:\\b'], noMedia: true, machineId: 'm1' };
    const inv = resolveCheckinInvocation([], settings);
    expect(inv).toEqual({
      server: 'http://s:1',
      token: undefined,
      dirs: ['D:\\b'],
      includeMedia: false,
      machineId: 'm1',
      dryRun: false
    });
  });

  it('lets flags override the settings file', () => {
    const settings: CheckinSettings = { server: 'http://old:1', dirs: ['D:\\old'], noMedia: false };
    const inv = resolveCheckinInvocation(
      ['--server', 'http://new:2', '--dir', 'E:\\new', '--no-media', '--machine-id', 'flag-id', '--dry-run'],
      settings
    );
    expect(inv.server).toBe('http://new:2');
    expect(inv.dirs).toEqual(['E:\\new']);
    expect(inv.includeMedia).toBe(false);
    expect(inv.machineId).toBe('flag-id');
    expect(inv.dryRun).toBe(true);
  });

  it('reports no dirs (not an empty list) when neither source pins them', () => {
    expect(resolveCheckinInvocation([], {}).dirs).toBeUndefined();
  });

  it('prefers --token, then --token-file, then settings token, then settings tokenFile, then the env var', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-tok-'));
    try {
      const tokenFile = path.join(dir, 'tok.txt');
      fs.writeFileSync(tokenFile, 'from-file\n', 'utf-8');
      const settings: CheckinSettings = { token: 'settings-token', tokenFile };

      expect(resolveCheckinInvocation(['--token', 'flag-token'], settings).token).toBe('flag-token');
      expect(resolveCheckinInvocation(['--token-file', tokenFile], { token: 'settings-token' }).token).toBe(
        'from-file'
      );
      expect(resolveCheckinInvocation([], settings).token).toBe('settings-token');
      expect(resolveCheckinInvocation([], { tokenFile }).token).toBe('from-file');
      process.env.OPBS_FLEET_TOKEN = 'env-token ';
      expect(resolveCheckinInvocation([], {}).token).toBe('env-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a precise error when a referenced token file is missing', () => {
    expect(() => resolveCheckinInvocation(['--token-file', 'Z:\\nope.txt'], {})).toThrow(/cannot read token file/);
  });
});
