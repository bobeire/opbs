import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFiles } from '../../src/main/cli/files';
import { initRepository } from '../../src/main/imaging/repository';
import { runFileBackup } from '../../src/main/files/backup';
import { loadFileCatalog } from '../../src/main/files/catalog';
import { validateFileBackupConfig } from '../../src/main/files/config';
import { objectPath } from '../../src/main/files/crypto';
import { runFileMirror } from '../../src/main/files/mirror';
import { matchesAnyGlob, normalizeRelativePath } from '../../src/main/files/paths';
import { pruneFileSnapshots } from '../../src/main/files/prune';
import { restoreFileSnapshot } from '../../src/main/files/restore';
import { verifyFileSnapshots } from '../../src/main/files/verify';
import type { FileBackupConfig } from '../../src/main/files/types';

describe('file/folder backups', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-files-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function newRepo(): Promise<{ repo: string; keyfile: string }> {
    const repo = path.join(root, 'repo');
    const keyfile = path.join(root, 'repo.key');
    await initRepository(repo, { keyfile, lockDays: 30 });
    return { repo, keyfile };
  }

  function config(repo: string, sources: string[], extra: Partial<FileBackupConfig> = {}): FileBackupConfig {
    return {
      type: 'backup-files',
      sources,
      repo,
      excludes: ['**/node_modules/**', '**/*.tmp'],
      chunkSize: 64 * 1024,
      lockDays: 30,
      ...extra
    };
  }

  function countObjects(repo: string): number {
    const objects = path.join(repo, 'files', 'objects');
    let count = 0;
    for (const bucket of fs.readdirSync(objects)) {
      count += fs.readdirSync(path.join(objects, bucket)).length;
    }
    return count;
  }

  it('backs up, deduplicates, excludes and restores a directory tree', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(source, 'b.txt'), 'hello');
    fs.writeFileSync(path.join(source, 'sub', 'c.txt'), 'world');
    fs.writeFileSync(path.join(source, 'scratch.tmp'), 'temporary');
    fs.writeFileSync(path.join(source, 'node_modules', 'junk.js'), 'junk');
    const { repo, keyfile } = await newRepo();

    const result = await runFileBackup(config(repo, [source]), { keyfile });
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeTruthy();
    expect(result.manifest.stats.uniqueChunks).toBe(2);
    expect(countObjects(repo)).toBe(2);

    const filePaths = result.manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
    expect(filePaths).toContain('src/a.txt');
    expect(filePaths).toContain('src/b.txt');
    expect(filePaths).toContain('src/sub/c.txt');
    expect(filePaths).not.toContain('src/scratch.tmp');
    expect(filePaths).not.toContain('src/node_modules/junk.js');

    const target = path.join(root, 'restored');
    const restored = restoreFileSnapshot({ repoDir: repo, keyfile, id: result.snapshotId!, target });
    expect(restored.ok).toBe(true);
    expect(fs.readFileSync(path.join(target, 'src', 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(target, 'src', 'b.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(target, 'src', 'sub', 'c.txt'), 'utf8')).toBe('world');
    expect(fs.existsSync(path.join(target, 'src', 'scratch.tmp'))).toBe(false);

    const verification = await verifyFileSnapshots(repo, { keyfile });
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.signaturesVerified).toBe(true);
  });

  it('detects a corrupted encrypted chunk', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'corrupt me');
    const { repo, keyfile } = await newRepo();
    const result = await runFileBackup(config(repo, [source]), { keyfile });
    const entry = result.manifest.entries.find((item) => item.path === 'src/a.txt');
    const sha = entry?.chunks[0]?.sha256;
    expect(sha).toBeTruthy();

    const file = objectPath(repo, sha!);
    const blob = fs.readFileSync(file);
    blob[blob.length - 1] ^= 0xff;
    fs.writeFileSync(file, blob);

    const verification = await verifyFileSnapshots(repo, { keyfile });
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((problem) => problem.kind === 'chunk')).toBe(true);
  });

  it('rejects traversal and absolute paths', () => {
    expect(() => normalizeRelativePath('../evil')).toThrow(/Parent traversal/);
    expect(() => normalizeRelativePath('a/../../b')).toThrow(/Parent traversal/);
    expect(() => normalizeRelativePath('C:\\Windows\\System32')).toThrow(/Absolute paths/);
    expect(() => normalizeRelativePath('C:evil')).toThrow(/Absolute paths/);
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(/Absolute paths/);
    expect(normalizeRelativePath('a\\sub\\file.txt')).toBe('a/sub/file.txt');
    expect(matchesAnyGlob('src/node_modules/a.js', ['**/node_modules/**'])).toBe(true);
    expect(matchesAnyGlob('src/a.txt', ['**/*.txt'])).toBe(true);
  });

  it('plans a one-way mirror by default and applies deletions only to quarantine', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(source, 'change.txt'), 'before');
    fs.writeFileSync(path.join(source, 'gone.txt'), 'gone');
    const { repo, keyfile } = await newRepo();
    const target = path.join(root, 'mirror');

    const first = await runFileBackup(
      config(repo, [source], {
        mirror: { enabled: true, apply: true, path: target, deletions: 'off' }
      }),
      { keyfile }
    );
    expect(first.mirror?.applied).toBe(true);
    expect(fs.readFileSync(path.join(target, 'src', 'keep.txt'), 'utf8')).toBe('keep');

    fs.writeFileSync(path.join(source, 'change.txt'), 'after');
    fs.unlinkSync(path.join(source, 'gone.txt'));
    fs.writeFileSync(path.join(source, 'new.txt'), 'new');

    const planned = await runFileBackup(
      config(repo, [source], {
        mirror: { enabled: true, apply: false, path: target, deletions: 'quarantine' }
      }),
      { keyfile }
    );
    expect(planned.mirror?.applied).toBe(false);
    expect(planned.mirror?.added).toHaveLength(1);
    expect(planned.mirror?.changed).toHaveLength(1);
    expect(planned.mirror?.deleted).toHaveLength(1);
    expect(fs.existsSync(path.join(target, 'src', 'gone.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'src', 'change.txt'), 'utf8')).toBe('before');

    const applied = await runFileBackup(
      config(repo, [source], {
        mirror: { enabled: true, apply: true, path: target, deletions: 'quarantine' }
      }),
      { keyfile, allowDeletes: true, confirmDeletes: true }
    );
    expect(applied.mirror?.applied).toBe(true);
    expect(fs.existsSync(path.join(target, 'src', 'gone.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'src', 'change.txt'), 'utf8')).toBe('after');
    expect(fs.readFileSync(path.join(target, 'src', 'new.txt'), 'utf8')).toBe('new');

    const quarantine = path.join(root, `.mirror.opbs-quarantine-${applied.snapshotId}`);
    const quarantinedFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else quarantinedFiles.push(name);
      }
    };
    walk(quarantine);
    expect(quarantinedFiles).toContain('gone.txt');

    const records = loadFileCatalog(repo);
    expect(records.some((record) => record.type === 'mirror')).toBe(true);
    expect(records.some((record) => record.type === 'mirror-state')).toBe(true);
  });

  it('refuses a mirror apply when deletions are not explicitly allowed', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'one');
    const { repo, keyfile } = await newRepo();
    const target = path.join(root, 'mirror');
    await runFileBackup(
      config(repo, [source], { mirror: { enabled: true, apply: true, path: target } }),
      { keyfile }
    );

    fs.unlinkSync(path.join(source, 'a.txt'));
    const result = await runFileBackup(
      config(repo, [source], {
        mirror: { enabled: true, apply: true, path: target, deletions: 'quarantine' }
      }),
      { keyfile }
    );
    expect(result.ok).toBe(false);
    expect(result.mirror?.ok).toBe(false);
    expect(result.mirror?.applied).toBe(false);
    expect(fs.existsSync(path.join(target, 'src', 'a.txt'))).toBe(true);
  });

  it('does not let --allow-deletes override a config with deletions off', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'one');
    const { repo, keyfile } = await newRepo();
    const target = path.join(root, 'mirror');
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(target, 'src', 'stray.txt'), 'stray');

    const configPath = path.join(root, 'files.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        config(repo, [source], {
          mirror: { enabled: true, apply: true, path: target, deletions: 'off' }
        })
      )
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let code: number;
    try {
      code = await cmdFiles({
        argv: ['backup', configPath, '--keyfile', keyfile, '--apply-mirror', '--allow-deletes'],
        opts: { json: false }
      });
    } finally {
      log.mockRestore();
    }
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(target, 'src', 'stray.txt'))).toBe(true);
  });

  it('keeps the active mirror snapshot and prunes older unlocked versions', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'first-version');
    const { repo, keyfile } = await newRepo();
    const target = path.join(root, 'mirror');

    const protectedSnapshot = await runFileBackup(
      config(repo, [source], {
        lockDays: 0,
        mirror: { enabled: true, apply: true, path: target }
      }),
      { keyfile }
    );
    fs.writeFileSync(path.join(source, 'a.txt'), 'second-version-with-different-bytes');
    const olderButUnprotected = await runFileBackup(config(repo, [source], { lockDays: 0 }), { keyfile });

    const plan = await pruneFileSnapshots(repo, { keyfile, keep: 0 });
    expect(plan.eligible.map((entry) => entry.id)).toContain(olderButUnprotected.snapshotId);
    expect(plan.skipped.map((entry) => entry.id)).toContain(protectedSnapshot.snapshotId);

    const result = await pruneFileSnapshots(repo, { keyfile, keep: 0, apply: true });
    expect(result.removed.map((entry) => entry.id)).toEqual([olderButUnprotected.snapshotId]);
    expect(result.chunksRemoved).toBeGreaterThan(0);
    expect((await verifyFileSnapshots(repo, { keyfile })).ok).toBe(true);
  });

  it('validates configs before touching the repository', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    const { repo } = await newRepo();

    expect(() => validateFileBackupConfig({ type: 'backup', sources: [source], repo })).toThrow(/type/);
    expect(() => validateFileBackupConfig({ type: 'backup-files', sources: [], repo })).toThrow(/sources/);
    expect(() => validateFileBackupConfig(config(repo, [source], { chunkSize: 10 }))).toThrow(/chunkSize/);
    expect(() =>
      validateFileBackupConfig(
        config(repo, [source], {
          mirror: { enabled: true, apply: false, path: undefined, deletions: 'off' }
        })
      )
    ).toThrow(/mirror\.path/);
    expect(() => validateFileBackupConfig(config(repo, [path.join(root, 'missing')]))).toThrow(/does not exist/);
  });

  it('can mirror an existing snapshot without creating another one', async () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'snapshot-content');
    const { repo, keyfile } = await newRepo();
    const backup = await runFileBackup(config(repo, [source]), { keyfile });
    const target = path.join(root, 'separate-mirror');

    const report = await runFileMirror({
      repoDir: repo,
      keyfile,
      manifest: backup.manifest,
      target,
      apply: true
    });
    expect(report.applied).toBe(true);
    expect(fs.readFileSync(path.join(target, 'src', 'a.txt'), 'utf8')).toBe('snapshot-content');
    const records = loadFileCatalog(repo);
    expect(records.filter((record) => record.type === 'snapshot')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'mirror')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'mirror-state')).toHaveLength(1);
  });
});
