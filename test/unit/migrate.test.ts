import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSource, walkSource, sourcePathExists } from '../../src/main/imaging/migrate/source';
import { buildInventory, listProfileNames } from '../../src/main/imaging/migrate/inventory';
import { buildPlan } from '../../src/main/imaging/migrate/plan';
import { loadAppsDb, resolveKbPath, SEED_APPS_DB } from '../../src/main/imaging/migrate/apps-db';

let root: string;

function writeFixture(rel: string, bytes: number | string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 0x61));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-migrate-'));
  writeFixture('Users/Alice/Documents/readme.txt', 'hello');
  writeFixture('Users/Alice/Downloads/big.bin', 2048);
  writeFixture('Users/Alice/AppData/Local/Google/Chrome/User Data/Default/History', 100);
  writeFixture('Users/Alice/AppData/Local/Temp/junk.tmp', 9999);
  writeFixture('Users/Public/Public Documents/shared.txt', 'shared');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('migrate source (live)', () => {
  it('lists the volume root and profile directories', () => {
    const source = new LiveSource(root);
    const names = source.list('').map((e) => e.name);
    expect(names).toContain('Users');
    const users = source.list('Users').map((e) => e.name).sort();
    expect(users).toEqual(['Alice', 'Public']);
    source.close();
  });

  it('walks with excludes and reports stats', () => {
    const source = new LiveSource(root);
    const total = walkSource(source, 'Users/Alice', {
      excludeRelPaths: ['Users/Alice/AppData/Local/Temp']
    });
    // readme (5) + big.bin (2048) + History (100); junk.tmp excluded
    expect(total.totalBytes).toBe(5 + 2048 + 100);
    expect(total.itemCount).toBe(3);
    expect(total.capped).toBe(false);
    source.close();
  });

  it('flags capped walks', () => {
    const source = new LiveSource(root);
    const stats = walkSource(source, 'Users/Alice', { maxFiles: 1 });
    expect(stats.capped).toBe(true);
    source.close();
  });

  it('depth cap excludes only the deep subtree and flags the folder as capped (drill F3)', () => {
    const deepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-deep-'));
    try {
      let chain = path.join(deepRoot, 'Users', 'Alice', 'Documents');
      fs.mkdirSync(chain, { recursive: true });
      fs.writeFileSync(path.join(chain, 'shallow.txt'), 'shallow');
      for (let i = 1; i <= 15; i++) {
        chain = path.join(chain, `d${i}`);
        fs.mkdirSync(chain);
        if (i === 14) fs.writeFileSync(path.join(chain, 'mid.txt'), 'mid');
        if (i === 15) fs.writeFileSync(path.join(chain, 'deep.txt'), 'deep');
      }
      const source = new LiveSource(deepRoot);
      try {
        const stats = walkSource(source, 'Users/Alice/Documents');
        // shallow.txt + d14/mid.txt counted; the d15 subtree excluded; siblings NOT abandoned
        expect(stats.itemCount).toBe(2);
        expect(stats.capped).toBe(true);
        const inv = buildInventory(source, SEED_APPS_DB);
        const docs = inv.profiles[0].standardFolders.find((f) => f.name === 'Documents');
        expect(docs?.capped).toBe(true);
        expect(docs?.itemCount).toBe(2);
        expect(inv.profiles[0].capped).toBe(true);
      } finally {
        source.close();
      }
    } finally {
      fs.rmSync(deepRoot, { recursive: true, force: true });
    }
  });

  it('checks path existence', () => {
    const source = new LiveSource(root);
    expect(sourcePathExists(source, 'Users/Alice/Documents')).toBe(true);
    expect(sourcePathExists(source, 'Users/Alice/Documents/readme.txt')).toBe(true);
    expect(sourcePathExists(source, 'Users/Alice/Nope')).toBe(false);
    source.close();
  });
});

describe('migrate inventory', () => {
  it('excludes system profile dirs and temp subtrees', () => {
    const source = new LiveSource(root);
    const inv = buildInventory(source, SEED_APPS_DB);
    expect(inv.profiles.map((p) => p.name)).toEqual(['Alice']);
    const alice = inv.profiles[0];
    expect(alice.totalBytes).toBe(5 + 2048 + 100);
    expect(alice.itemCount).toBe(3);
    expect(alice.standardFolders.map((f) => f.name).sort()).toEqual(['AppData', 'Documents', 'Downloads']);
    source.close();
  });

  it('matches known app stores from the knowledge base', () => {
    const source = new LiveSource(root);
    const inv = buildInventory(source, SEED_APPS_DB);
    const chrome = inv.profiles[0].stores.find((s) => s.appId === 'google-chrome');
    expect(chrome).toBeDefined();
    expect(chrome?.relPath).toBe('Users/Alice/AppData/Local/Google/Chrome/User Data');
    expect(chrome?.bytes).toBe(100);
    expect(chrome?.winget).toBe('Google.Chrome');
    source.close();
  });

  it('lists profile names only for real users', () => {
    const source = new LiveSource(root);
    expect(listProfileNames(source)).toEqual(['Alice']);
    source.close();
  });
});

describe('migrate plan', () => {
  it('builds a dry-run plan with entries, hints and no refusals', () => {
    const source = new LiveSource(root);
    const plan = buildPlan(source, 'Alice', SEED_APPS_DB);
    expect(plan.refusals).toEqual([]);
    const folderEntries = plan.entries.filter((e) => e.category === 'standard-folder');
    expect(folderEntries.map((e) => e.sourceRelPath).sort()).toEqual([
      'Users/Alice/AppData',
      'Users/Alice/Documents',
      'Users/Alice/Downloads'
    ]);
    expect(plan.totalBytes).toBe(5 + 2048 + 100);
    const storeEntry = plan.entries.find((e) => e.category === 'app-store' && e.appId === 'google-chrome');
    expect(storeEntry).toBeDefined();
    expect(storeEntry?.registryExecuted).toBe(false);
    expect(plan.reinstallHints.some((h) => h.winget === 'Google.Chrome')).toBe(true);
    expect(plan.phaseNotes.some((n) => n.includes('nothing is written'))).toBe(true);
    source.close();
  });

  it('refuses unknown profiles with a reason', () => {
    const source = new LiveSource(root);
    const plan = buildPlan(source, 'Ghost', SEED_APPS_DB);
    expect(plan.refusals.map((r) => r.reason)).toContain('profile-not-found-or-empty');
    source.close();
  });

  it('refuses a missing target profile directory', () => {
    const source = new LiveSource(root);
    const plan = buildPlan(source, 'Alice', SEED_APPS_DB, {
      targetProfileDir: path.join(root, 'Users', 'Ghost')
    });
    expect(plan.refusals.map((r) => r.reason)).toContain('target-profile-missing');
    source.close();
  });

  it('honours --folder restrictions', () => {
    const source = new LiveSource(root);
    const plan = buildPlan(source, 'Alice', SEED_APPS_DB, { onlyFolders: ['Documents'] });
    expect(plan.entries.filter((e) => e.category === 'standard-folder').map((e) => e.sourceRelPath)).toEqual([
      'Users/Alice/Documents'
    ]);
    source.close();
  });
});

describe('apps db', () => {
  it('resolves KB path tokens per profile', () => {
    expect(resolveKbPath('%LOCALAPPDATA%/Google/Chrome/User Data', 'Users/Alice')).toBe(
      'Users/Alice/AppData/Local/Google/Chrome/User Data'
    );
    expect(resolveKbPath('%APPDATA%/discord', 'Users/Bob')).toBe('Users/Bob/AppData/Roaming/discord');
    expect(resolveKbPath('%USERPROFILE%/Documents/Outlook Files', 'Users/Eve')).toBe('Users/Eve/Documents/Outlook Files');
  });

  it('merges an extra apps-db file, deduping by id', () => {
    const extra = path.join(root, 'apps-extra.json');
    fs.writeFileSync(
      extra,
      JSON.stringify([
        { id: 'google-chrome', name: 'Chrome (overridden)', data: [], class: 'ignore' },
        { id: 'custom-app', name: 'Custom', data: ['%APPDATA%/Custom'], winget: 'Custom.App', class: 'data' }
      ])
    );
    const db = loadAppsDb(extra);
    const chrome = db.find((a) => a.id === 'google-chrome');
    expect(chrome?.name).toBe('Chrome (overridden)');
    expect(db.filter((a) => a.id === 'custom-app')).toHaveLength(1);
  });

  it('rejects malformed extra dbs', () => {
    const bad = path.join(root, 'apps-bad.json');
    fs.writeFileSync(bad, JSON.stringify({ id: 'nope' }));
    expect(() => loadAppsDb(bad)).toThrow(/JSON array/);
  });
});
