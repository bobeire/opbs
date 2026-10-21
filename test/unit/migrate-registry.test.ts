import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSource } from '../../src/main/imaging/migrate/source';
import { buildPlan, computePlanHash } from '../../src/main/imaging/migrate/plan';
import { executePlan } from '../../src/main/imaging/migrate/execute';
import { SEED_APPS_DB } from '../../src/main/imaging/migrate/apps-db';
import { hiveRelativeKey, parseQueryCounts, transplantRegistry } from '../../src/main/imaging/migrate/registry';
import { currentProcessSid, isElevatedSync, resolveProfileSid, rewriteCopiedOwner } from '../../src/main/imaging/migrate/identity';
import type { CmdRun, IcaclsRun, IdentityOps, RegArgRun } from '../../src/main/imaging/migrate/identity';

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fake reg.exe ──────────────────────────────────────────────────────────

type FakeValues = Map<string, { type: string; data: string }>;

interface FakeRegState {
  /** Full keys, uppercase, backslash-separated. */
  keys: Map<string, FakeValues>;
  /** Seeded per `reg load` in call order (relative uppercase keys). */
  templates: Map<string, FakeValues>[];
  loads: { mount: string; file: string }[];
  unloads: string[];
  loaded: Map<string, string>;
  failCopy?: boolean;
}

function mkState(): FakeRegState {
  return { keys: new Map(), templates: [], loads: [], unloads: [], loaded: new Map() };
}

function fakeReg(state: FakeRegState): RegArgRun {
  /** Real reg.exe always prints full hive names — mirror that in dumps. */
  const display = (key: string): string =>
    key
      .replace(/^HKU\\/i, 'HKEY_USERS\\')
      .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
      .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\');
  return (args) => {
    const verb = (args[0] ?? '').toLowerCase();
    if (verb === 'load') {
      const mount = args[1]!.toUpperCase();
      const file = args[2]!;
      state.loads.push({ mount: args[1]!, file });
      state.loaded.set(mount, file);
      const template = state.templates.shift();
      if (template) {
        for (const [rel, values] of template) state.keys.set(`${mount}\\${rel}`.toUpperCase(), new Map(values));
      }
      return { status: 0, stdout: 'The operation completed successfully.' };
    }
    if (verb === 'unload') {
      const mount = args[1]!.toUpperCase();
      if (!state.loaded.has(mount)) return { status: 1, stdout: 'ERROR: The system was unable to find the specified registry key or value.' };
      state.loaded.delete(mount);
      state.unloads.push(args[1]!);
      return { status: 0, stdout: 'The operation completed successfully.' };
    }
    if (verb === 'query') {
      const key = args[1]!.toUpperCase();
      const exact = state.keys.get(key);
      const childPrefix = `${key}\\`;
      const children = [...state.keys.keys()].filter((k) => k.startsWith(childPrefix));
      if (args[2]?.toLowerCase() === '/v') {
        const value = exact?.get(args[3]!.toUpperCase());
        if (!value) return { status: 1, stdout: 'ERROR: The system was unable to find the specified registry key or value.' };
        return { status: 0, stdout: ['', display(key), `    ${args[3]}    ${value.type}    ${value.data}`, ''].join('\n') };
      }
      if (!exact && children.length === 0) return { status: 1, stdout: 'ERROR: The system was unable to find the specified registry key or value.' };
      const lines: string[] = ['', display(key)];
      if (exact) for (const [name, value] of exact) lines.push(`    ${name}    ${value.type}    ${value.data}`);
      const direct = new Set<string>();
      for (const child of children) direct.add(`${childPrefix}${child.slice(childPrefix.length).split('\\')[0]}`);
      for (const child of [...direct].sort()) lines.push(display(child), '');
      return { status: 0, stdout: lines.join('\n') };
    }
    if (verb === 'copy') {
      const src = args[1]!.toUpperCase();
      const dst = args[2]!.toUpperCase();
      const srcExact = state.keys.get(src);
      const srcPrefix = `${src}\\`;
      const srcChildren = [...state.keys.keys()].filter((k) => k.startsWith(srcPrefix));
      if (!srcExact && srcChildren.length === 0) return { status: 1, stdout: 'ERROR: The system was unable to find the specified registry key or value.' };
      if (state.failCopy) return { status: 1, stdout: 'ERROR: Access is denied.' };
      if (srcExact) state.keys.set(dst, new Map(srcExact));
      for (const child of srcChildren) state.keys.set(`${dst}${child.slice(src.length)}`, new Map(state.keys.get(child)!));
      return { status: 0, stdout: 'The operation completed successfully.' };
    }
    return { status: 1, stdout: `unexpected reg verb: ${verb}` };
  };
}

function values(entries: Record<string, [string, string]> = {}): FakeValues {
  const map: FakeValues = new Map();
  for (const [name, [type, data]] of Object.entries(entries)) map.set(name.toUpperCase(), { type, data });
  return map;
}

function fakeIdentity(overrides: Partial<IdentityOps> = {}): IdentityOps {
  return {
    elevated: () => true,
    currentSid: () => 'S-1-5-21-MACHINE-1001',
    sidForProfileDir: () => null,
    ...overrides
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function mkSourceWithHive(): string {
  const dir = tempDir('opbs-reg-src-');
  fs.mkdirSync(path.join(dir, 'Users', 'Alice'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Users', 'Alice', 'NTUSER.DAT'), 'hive-bytes');
  return dir;
}

function mkTargetWithHive(): string {
  const dir = tempDir('opbs-reg-target-');
  fs.writeFileSync(path.join(dir, 'NTUSER.DAT'), 'target-hive');
  return dir;
}

describe('migrate registry helpers', () => {
  it('normalizes HKCU knowledge-base keys to hive-relative paths', () => {
    expect(hiveRelativeKey('HKCU/Software/Google/Chrome')).toBe('Software\\Google\\Chrome');
    expect(hiveRelativeKey('HKCU\\Software\\Mozilla/Firefox')).toBe('Software\\Mozilla\\Firefox');
    expect(hiveRelativeKey('HKCU/Software//Odd//Path')).toBe('Software\\Odd\\Path');
  });

  it('parses reg query dumps into direct subkey/value counts', () => {
    const dump =
      '\r\nHKEY_CURRENT_USER\\Software\\Demo\r\n    (Default)    REG_SZ    \r\n    val1    REG_DWORD    0x1\r\n\r\nHKEY_CURRENT_USER\\Software\\Demo\\Sub\r\n    inner    REG_SZ    x\r\n';
    expect(parseQueryCounts(dump)).toEqual({ subkeys: 1, values: 2 });
    expect(parseQueryCounts('\r\nHKEY_CURRENT_USER\\Software\\Empty\r\n')).toEqual({ subkeys: 0, values: 0 });
    expect(parseQueryCounts(undefined)).toEqual({ subkeys: 0, values: 0 });
  });

  it('reads elevation, current SID and profile SID resolution from injected runners', () => {
    const ps: CmdRun = (_cmd, args) => ({ status: 0, stdout: args.includes('-Command') ? 'True\r\n' : '' });
    expect(isElevatedSync(ps)).toBe(true);
    expect(isElevatedSync(() => ({ status: 1, stdout: 'False' }))).toBe(false);
    expect(currentProcessSid(() => ({ status: 0, stdout: '"DESKTOP-X\\alice","S-1-5-21-9-8-7-1001"\r\n' }))).toBe('S-1-5-21-9-8-7-1001');
    const listKey = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList';
    const sidA = 'S-1-5-21-100-200-300-1001';
    const sidB = 'S-1-5-21-100-200-300-1002';
    const run: RegArgRun = (args) => {
      if (args[2] === '/v') {
        if (args[1].endsWith(sidA)) {
          return { status: 0, stdout: ['', `${listKey}\\${sidA}`, '    ProfileImagePath    REG_EXPAND_SZ    C:\\Users\\Alice', ''].join('\n') };
        }
        if (args[1].endsWith(sidB)) {
          return { status: 0, stdout: ['', `${listKey}\\${sidB}`, '    ProfileImagePath    REG_SZ    C:\\Users\\Bob', ''].join('\n') };
        }
        return { status: 1, stdout: 'ERROR: not found' };
      }
      return {
        status: 0,
        stdout: ['', listKey, `${listKey}\\${sidA}`, `${listKey}\\${sidB}`, ''].join('\n')
      };
    };
    expect(resolveProfileSid('C:\\Users\\Alice', run)).toBe(sidA);
    expect(resolveProfileSid('C:\\Users\\Nobody', run)).toBe(null);
  });
});

describe('migrate owner rewrite (tier 2)', () => {
  it('sets the owner on every copied root', () => {
    const calls: string[][] = [];
    const run: IcaclsRun = (args) => {
      calls.push(args);
      return { status: 0, stdout: '1 files processed' };
    };
    const result = rewriteCopiedOwner(['C:\\Users\\New\\Documents', 'C:\\Users\\New\\AppData'], 'S-1-5-21-FOREIGN', run);
    expect(result.status).toBe('ok');
    expect(result.sid).toBe('S-1-5-21-FOREIGN');
    expect(result.roots).toBe(2);
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args).toEqual(expect.arrayContaining(['/setowner', 'S-1-5-21-FOREIGN', '/T', '/C', '/Q']));
  });

  it('reports failed and partial rewrites honestly', () => {
    const failed = rewriteCopiedOwner(['X'], 'S-1', () => ({ status: 5, error: 'denied' }));
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('denied');
    const partial = rewriteCopiedOwner(['X', 'Y'], 'S-1', (args) => (args[0] === 'X' ? { status: 0 } : { status: 5 }));
    expect(partial.status).toBe('partial');
    expect(rewriteCopiedOwner([], 'S-1').status).toBe('not-needed');
  });
});

describe('migrate registry transplants (tier 2)', () => {
  const chromeKey = { appId: 'google-chrome', appName: 'Google Chrome', key: 'HKCU/Software/Google/Chrome' };
  const vscodeKey = { appId: 'vscode', appName: 'Visual Studio Code', key: 'HKCU/Software/Microsoft/VSCode' };

  function sourceTemplate(): Map<string, FakeValues> {
    const template = new Map<string, FakeValues>();
    template.set('SOFTWARE\\GOOGLE\\CHROME', values({ First: ['REG_SZ', 'run'] }));
    template.set('SOFTWARE\\GOOGLE\\CHROME\\PROFILES', values({ Count: ['REG_DWORD', '0x2'] }));
    template.set('SOFTWARE\\MICROSOFT\\VSCODE', values({ Telemetry: ['REG_SZ', 'off'] }));
    return template;
  }

  it('transplants curated keys, verifies counts and unloads both hives', () => {
    const srcRoot = mkSourceWithHive();
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [sourceTemplate(), new Map()];
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        targetProfileDir: target,
        keys: [chromeKey, vscodeKey],
        elevated: true,
        identity: fakeIdentity(),
        run: fakeReg(state)
      });
      expect(outcomes.map((o) => o.status)).toEqual(['copied', 'copied']);
      expect(outcomes[0]).toMatchObject({ appId: 'google-chrome', sourceSubkeys: 1, sourceValues: 1, targetSubkeys: 1, targetValues: 1 });
      expect(state.loads).toHaveLength(2);
      expect(state.unloads).toHaveLength(2);
      expect(state.loaded.size).toBe(0);
      expect(fs.existsSync(state.loads[0].file)).toBe(false);
      const tgtMount = state.loads[1].mount.toUpperCase();
      expect(state.keys.has(`${tgtMount}\\SOFTWARE\\GOOGLE\\CHROME`)).toBe(true);
      expect(state.keys.has(`${tgtMount}\\SOFTWARE\\MICROSOFT\\VSCODE`)).toBe(true);
    } finally {
      source.close();
    }
  });

  it('skips keys missing from the source hive without failing', () => {
    const srcRoot = mkSourceWithHive();
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [new Map(), new Map()];
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        targetProfileDir: target,
        keys: [chromeKey],
        elevated: true,
        identity: fakeIdentity(),
        run: fakeReg(state)
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('skipped-source-missing');
      expect(state.unloads).toHaveLength(2);
    } finally {
      source.close();
    }
  });

  it('records copy failures and still unloads the hives', () => {
    const srcRoot = mkSourceWithHive();
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [sourceTemplate(), new Map()];
    state.failCopy = true;
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        targetProfileDir: target,
        keys: [chromeKey, vscodeKey],
        elevated: true,
        identity: fakeIdentity(),
        run: fakeReg(state)
      });
      expect(outcomes.every((o) => o.status === 'failed')).toBe(true);
      expect(outcomes[0].detail).toContain('reg copy failed');
      expect(state.unloads).toHaveLength(2);
      expect(state.loads[0] && fs.existsSync(state.loads[0].file)).toBe(false);
    } finally {
      source.close();
    }
  });

  it('does nothing without elevation', () => {
    const srcRoot = mkSourceWithHive();
    const target = mkTargetWithHive();
    const state = mkState();
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        targetProfileDir: target,
        keys: [chromeKey],
        elevated: false,
        identity: fakeIdentity(),
        run: fakeReg(state)
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('not-run');
      expect(outcomes[0].detail).toContain('elevated');
      expect(state.loads).toHaveLength(0);
    } finally {
      source.close();
    }
  });

  it('fails cleanly when the target profile has no hive', () => {
    const srcRoot = mkSourceWithHive();
    const target = tempDir('opbs-reg-nohive-');
    const state = mkState();
    state.templates = [sourceTemplate()];
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        targetProfileDir: target,
        keys: [chromeKey],
        elevated: true,
        identity: fakeIdentity(),
        run: fakeReg(state)
      });
      expect(outcomes[0].status).toBe('not-run');
      expect(outcomes[0].detail).toContain('hive missing');
      expect(state.unloads).toHaveLength(1);
      expect(fs.existsSync(state.loads[0].file)).toBe(false);
    } finally {
      source.close();
    }
  });

  it('deduplicates repeated knowledge-base keys', () => {
    const srcRoot = mkSourceWithHive();
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [sourceTemplate(), new Map()];
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        targetProfileDir: target,
        keys: [chromeKey, { ...chromeKey, key: 'HKCU\\Software\\Google\\Chrome' }],
        elevated: true,
        identity: fakeIdentity(),
        run: fakeReg(state)
      });
      expect(outcomes).toHaveLength(1);
    } finally {
      source.close();
    }
  });

  it('reads a logged-on source through its already-loaded hive instead of extracting', () => {
    const srcRoot = tempDir('opbs-reg-live-');
    fs.mkdirSync(path.join(srcRoot, 'Users', 'Alice'), { recursive: true });
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [new Map()];
    const SID = 'S-1-5-21-777-888-999-1001';
    const loadedChrome = `HKU\\${SID}\\SOFTWARE\\GOOGLE\\CHROME`;
    state.keys.set(loadedChrome, values({ First: ['REG_SZ', 'run'] }));
    state.keys.set(`${loadedChrome}\\PROFILES`, values({ Count: ['REG_DWORD', '0x2'] }));
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        sourceProfileDir: srcRoot,
        targetProfileDir: target,
        keys: [chromeKey],
        elevated: true,
        identity: fakeIdentity({ sidForProfileDir: (dir) => (dir === srcRoot ? SID : null) }),
        run: fakeReg(state)
      });
      // No NTUSER.DAT exists in the fixture — extraction would have failed.
      expect(outcomes[0].status).toBe('copied');
      expect(state.loads).toHaveLength(1);
      expect(state.loads[0].mount.toUpperCase()).not.toBe(`HKU\\${SID}`);
      expect(state.unloads).toHaveLength(1);
      expect(state.keys.has(`${state.loads[0].mount.toUpperCase()}\\SOFTWARE\\GOOGLE\\CHROME`)).toBe(true);
      expect(state.keys.has(loadedChrome)).toBe(true);
    } finally {
      source.close();
    }
  });

  it('does nothing when source and target resolve to the same loaded hive', () => {
    const srcRoot = tempDir('opbs-reg-self-');
    fs.mkdirSync(path.join(srcRoot, 'Users', 'Alice'), { recursive: true });
    const state = mkState();
    const SID = 'S-1-5-21-777-888-999-1001';
    state.keys.set(`HKU\\${SID}\\SOFTWARE\\GOOGLE\\CHROME`, values({ First: ['REG_SZ', 'run'] }));
    const source = new LiveSource(srcRoot);
    try {
      const outcomes = transplantRegistry({
        source,
        profileRelPath: 'Users/Alice',
        sourceProfileDir: srcRoot,
        targetProfileDir: srcRoot,
        keys: [chromeKey],
        elevated: true,
        identity: fakeIdentity({ sidForProfileDir: () => SID }),
        run: fakeReg(state)
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('not-run');
      expect(outcomes[0].detail).toContain('same loaded hive');
      expect(state.loads).toHaveLength(0);
      expect(state.unloads).toHaveLength(0);
    } finally {
      source.close();
    }
  });
});

describe('migrate execute tier 2 integration', () => {
  let srcRoot: string;

  function writeFixture(rel: string, content: string): void {
    const full = path.join(srcRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function setup(): void {
    srcRoot = tempDir('opbs-t2-src-');
    writeFixture('Users/Alice/NTUSER.DAT', 'hive');
    writeFixture('Users/Alice/Documents/readme.txt', 'hello');
    writeFixture('Users/Alice/AppData/Local/Google/Chrome/User Data/Default/History', 'hist');
  }

  function runT2(
    target: string,
    options: { registry?: boolean; ownerRewrite?: boolean; elevated?: boolean; identity?: IdentityOps; registryRun?: RegArgRun; icaclsRun?: IcaclsRun }
  ) {
    const source = new LiveSource(srcRoot);
    try {
      const plan = buildPlan(source, 'Alice', SEED_APPS_DB, { targetProfileDir: target });
      return executePlan(source, plan, { targetProfileDir: target, planHash: computePlanHash(plan), ...options });
    } finally {
      source.close();
    }
  }

  setup();

  it('transplants registry keys and rewrites ownership of the copied roots', () => {
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [sourceTemplateForExecute(), new Map()];
    const icaclsCalls: string[][] = [];
    const report = runT2(target, {
      registry: true,
      ownerRewrite: true,
      elevated: true,
      identity: fakeIdentity({ sidForProfileDir: () => 'S-1-5-21-FOREIGN' }),
      registryRun: fakeReg(state),
      icaclsRun: (args) => {
        icaclsCalls.push(args);
        return { status: 0 };
      }
    });
    expect(report.executed).toBe(true);
    expect(report.registry).toHaveLength(1);
    expect(report.registry?.[0]).toMatchObject({ appId: 'google-chrome', status: 'copied' });
    expect(report.summary.registryCopied).toBe(1);
    expect(report.summary.registryFailed).toBe(0);
    expect(report.owner).toMatchObject({ status: 'ok', sid: 'S-1-5-21-FOREIGN', roots: 2 });
    expect(icaclsCalls).toHaveLength(2);
    expect(report.notes.some((n) => n.includes('Registry tier complete'))).toBe(true);
    expect(report.notes.some((n) => n.includes('Owner rewritten'))).toBe(true);
    expect(state.unloads).toHaveLength(2);
  });

  it('skips the owner rewrite for the current account and records not-needed', () => {
    const target = mkTargetWithHive();
    const icaclsCalls: string[][] = [];
    const report = runT2(target, {
      ownerRewrite: true,
      elevated: true,
      identity: fakeIdentity({ sidForProfileDir: () => 'S-1-5-21-MACHINE-1001' }),
      icaclsRun: (args) => {
        icaclsCalls.push(args);
        return { status: 0 };
      }
    });
    expect(report.owner?.status).toBe('not-needed');
    expect(icaclsCalls).toHaveLength(0);
    expect(report.registry).toBeUndefined();
  });

  it('skips the owner rewrite of a foreign profile without elevation', () => {
    const target = mkTargetWithHive();
    const report = runT2(target, {
      ownerRewrite: true,
      elevated: false,
      identity: fakeIdentity({ sidForProfileDir: () => 'S-1-5-21-FOREIGN' }),
      icaclsRun: () => {
        throw new Error('icacls must not run unelevated');
      }
    });
    expect(report.owner?.status).toBe('skipped');
    expect(report.notes.some((n) => n.includes('elevated shell'))).toBe(true);
  });

  it('marks the registry tier not-run without elevation', () => {
    const target = mkTargetWithHive();
    const state = mkState();
    const report = runT2(target, {
      registry: true,
      elevated: false,
      identity: fakeIdentity(),
      registryRun: fakeReg(state)
    });
    expect(report.registry?.every((o) => o.status === 'not-run')).toBe(true);
    expect(report.summary.registryCopied).toBe(0);
    expect(state.loads).toHaveLength(0);
    expect(report.notes.some((n) => n.includes('not executed'))).toBe(true);
  });

  it('counts registry failures in the summary and report notes', () => {
    const target = mkTargetWithHive();
    const state = mkState();
    state.templates = [sourceTemplateForExecute(), new Map()];
    state.failCopy = true;
    const report = runT2(target, {
      registry: true,
      elevated: true,
      identity: fakeIdentity(),
      registryRun: fakeReg(state)
    });
    expect(report.summary.registryFailed).toBe(1);
    expect(report.registry?.[0].status).toBe('failed');
    expect(report.notes.some((n) => n.includes('failed'))).toBe(true);
  });

  function sourceTemplateForExecute(): Map<string, FakeValues> {
    const template = new Map<string, FakeValues>();
    template.set('SOFTWARE\\GOOGLE\\CHROME', values({ First: ['REG_SZ', 'run'] }));
    return template;
  }
});
