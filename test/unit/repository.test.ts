import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isRepository,
  initRepository,
  loadHeader,
  loadJournal,
  resolveRepoKey,
  recordImageCreate,
  verifyRepository,
  pruneRepository,
  unlockRepository,
  repoImageStates,
  verifyChain
} from '../../src/main/imaging/repository';
import { protectFiles, unprotectFiles } from '../../src/main/utils/file-protect';
import { applyRetention } from '../../src/main/backup/retention';
import { finalizeBackupRepo } from '../../src/main/cli/repo';
import type { BackupJobConfig } from '../../src/main/imaging/backup-engine';
import type { JobResult } from '../../src/main/imaging/imaging-job';

// Repository init/protect round-trips spawn PowerShell for ACL updates, which
// can exceed the 5s default under parallel test load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEYFILE = 'repo-key.key';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-repo-test-'));
  tempDirs.push(dir);
  return dir;
}

async function removeTree(dir: string): Promise<void> {
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  if (fs.existsSync(dir)) {
    await unprotectFiles(walk(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Create a fake image file (and optional extra volumes) inside the repo. */
function makeImage(repoDir: string, name: string, content: string | Buffer, volume2?: string): string {
  const file = path.join(repoDir, 'images', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (volume2 !== undefined) {
    fs.writeFileSync(`${file}.001`, volume2);
  }
  return file;
}

async function newRepo(opts: { passphrase?: string; lockDays?: number; keyfileDir?: string } = {}) {
  const dir = tempDir();
  const repoDir = path.join(dir, 'repo');
  const keyfile = path.join(dir, KEYFILE);
  const result = await initRepository(repoDir, {
    keyfile,
    passphrase: opts.passphrase,
    lockDays: opts.lockDays
  });
  return { repoDir, keyfile, header: result.header, dir };
}

function keyOpts(keyfile: string, passphrase?: string) {
  return passphrase ? { passphrase } : { keyfile };
}

function base64Block(seed: number, size = 4096): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (seed + i) % 256;
  return buf;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTree));
});

describe('repository init', () => {
  it('creates header, journal and images dir, and refuses double init', async () => {
    const { repoDir, header } = await newRepo();
    expect(isRepository(repoDir)).toBe(true);
    expect(header.schema).toBe(1);
    expect(header.algo).toBe('sha256');
    expect(header.defaultLockDays).toBe(30);
    expect(header.kdf).toBeNull();
    expect(header.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.statSync(path.join(repoDir, 'opbs-repo.journal')).isFile()).toBe(true);
    expect(fs.statSync(path.join(repoDir, 'images')).isDirectory()).toBe(true);
    await expect(initRepository(repoDir)).rejects.toThrow(/Already an OPBS repository/);
  });

  it('stores the signing key outside the repository', async () => {
    const { repoDir, keyfile, header } = await newRepo();
    expect(fs.existsSync(keyfile)).toBe(true);
    const key = resolveRepoKey(header, { keyfile });
    expect(key).toHaveLength(32);
    // No key material anywhere inside the repo dir.
    for (const name of fs.readdirSync(repoDir)) {
      const entry = path.join(repoDir, name);
      if (!fs.statSync(entry).isFile()) continue;
      const raw = fs.readFileSync(entry, 'utf-8');
      expect(raw).not.toContain(key.toString('hex'));
    }
  });

  it('finds the keyfile automatically via OPBS_REPO_KEY_DIR', async () => {
    const dir = tempDir();
    const keyDir = path.join(dir, 'keys');
    const previous = process.env.OPBS_REPO_KEY_DIR;
    process.env.OPBS_REPO_KEY_DIR = keyDir;
    try {
      const repoDir = path.join(dir, 'repo');
      const { header } = await initRepository(repoDir);
      expect(fs.existsSync(path.join(keyDir, `${header.id}.key`))).toBe(true);
      // No explicit options — auto-resolve works.
      expect(() => resolveRepoKey(header)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.OPBS_REPO_KEY_DIR;
      else process.env.OPBS_REPO_KEY_DIR = previous;
    }
  });

  it('passphrase mode stores no keyfile and rejects wrong passphrases', async () => {
    const { repoDir, header } = await newRepo({ passphrase: 'correct horse battery' });
    expect(header.kdf?.alg).toBe('pbkdf2-sha256');
    expect(() => resolveRepoKey(header, { passphrase: 'wrong' })).toThrow(/Wrong passphrase/);
    expect(() => resolveRepoKey(header)).toThrow(/key not found|passphrase/i);
    const key = resolveRepoKey(header, { passphrase: 'correct horse battery' });
    expect(key).toHaveLength(32);
  });
});

describe('repository journal', () => {
  it('records images with lock window and passes full verification', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'full.opbs', base64Block(1), base64Block(2));
    const { record, lockUntil } = await recordImageCreate(repoDir, loadHeader(repoDir), resolveRepoKey(loadHeader(repoDir), { keyfile }), image, { lockDays: 7 });
    expect(record.seq).toBe(1);
    expect(record.volumes).toHaveLength(2);
    expect(record.lock?.until).toBe(lockUntil);
    expect(Date.parse(lockUntil) - Date.now()).toBeGreaterThan(6 * 86_400_000);

    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.signaturesVerified).toBe(true);
    expect(report.states[0].filesPresent).toBe(true);
  });

  it('links incremental backups to their base image', async () => {
    const { repoDir, keyfile } = await newRepo();
    const header = loadHeader(repoDir);
    const key = resolveRepoKey(header, { keyfile });
    const full = makeImage(repoDir, 'chain-full.opbs', base64Block(3));
    const delta = makeImage(repoDir, 'chain-delta.opbs', base64Block(4));
    await recordImageCreate(repoDir, header, key, full, { lockDays: 30 });
    await recordImageCreate(repoDir, header, key, delta, { lockDays: 30, base: path.basename(full) });
    const states = repoImageStates(loadJournal(repoDir));
    expect(states[1].base).toBe('chain-full.opbs');
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(true);
  });

  it('detects a tampered journal byte (signature mismatch)', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'x.opbs', 'payload');
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    const journal = path.join(repoDir, 'opbs-repo.journal');
    const raw = fs.readFileSync(journal, 'utf-8');
    const idx = raw.indexOf('"bytes"');
    expect(idx).toBeGreaterThan(0);
    const tampered = raw.slice(0, idx + 8) + '9' + raw.slice(idx + 9);
    fs.writeFileSync(journal, tampered);
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === 'signature' || p.kind === 'chain')).toBe(true);
  });

  it('detects journal truncation via orphan files', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'gone.opbs', 'payload');
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    // Simulate history rollback: journal wiped back to empty.
    fs.writeFileSync(path.join(repoDir, 'opbs-repo.journal'), '');
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === 'orphan')).toBe(true);
  });

  it('detects a deleted image file', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'victim.opbs', base64Block(5));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    await unprotectFiles([image]);
    fs.unlinkSync(image);
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === 'missing-file' && p.detail.includes('victim.opbs'))).toBe(true);
  });

  it('detects same-size content replacement (silent encryption)', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'swap.opbs', base64Block(6));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    await unprotectFiles([image]);
    const replaced = Buffer.alloc(fs.statSync(image).size, 0xaa);
    fs.writeFileSync(image, replaced);
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === 'hash-mismatch')).toBe(true);
  });

  it('detects a size change', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'grown.opbs', base64Block(7));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    await unprotectFiles([image]);
    fs.appendFileSync(image, Buffer.alloc(16, 1));
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === 'size-mismatch')).toBe(true);
  });

  it('reports missing keys without failing structural checks', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'nokey.opbs', 'data');
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    const report = await verifyRepository(repoDir, { keyfile: path.join(tempDir(), 'not-there.key') });
    expect(report.ok).toBe(false);
    expect(report.signaturesVerified).toBe(false);
    expect(report.problems.some((p) => p.kind === 'missing-key')).toBe(true);
    expect(report.problems.some((p) => p.kind === 'chain')).toBe(false);
  });

  it('flags a broken chain structure', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'a.opbs', 'a');
    const header = loadHeader(repoDir);
    const key = resolveRepoKey(header, { keyfile });
    await recordImageCreate(repoDir, header, key, image);
    // Forge a second record with a bogus prev link.
    fs.appendFileSync(
      path.join(repoDir, 'opbs-repo.journal'),
      JSON.stringify({ seq: 2, type: 'prune', at: new Date().toISOString(), image: 'a.opbs', prev: 'f'.repeat(64), sig: 'a'.repeat(64) }) + '\n'
    );
    expect(verifyChain(loadJournal(repoDir))).toMatch(/chain break/);
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.problems.some((p) => p.kind === 'chain')).toBe(true);
  });
});

describe('repository prune / unlock', () => {
  it('never touches locked images', async () => {
    const { repoDir, keyfile } = await newRepo({ lockDays: 30 });
    const image = makeImage(repoDir, 'locked.opbs', base64Block(8));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    const dry = await pruneRepository(repoDir, { dryRun: true });
    expect(dry.eligible).toHaveLength(0);
    expect(dry.skipped).toHaveLength(1);
    const result = await pruneRepository(repoDir, { keyfile });
    expect(result.removed).toHaveLength(0);
    expect(fs.existsSync(image)).toBe(true);
    expect((await verifyRepository(repoDir, { keyfile })).ok).toBe(true);
  });

  it('prunes expired images and keeps the journal consistent', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'expired.opbs', base64Block(9));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image, { lockDays: 0 });
    const result = await pruneRepository(repoDir, { keyfile });
    expect(result.removed.map((e) => e.name)).toEqual(['expired.opbs']);
    expect(fs.existsSync(image)).toBe(false);
    const records = loadJournal(repoDir);
    expect(records[records.length - 1].type).toBe('prune');
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(true);
  });

  it('a locked delta keeps its expired root alive', async () => {
    const { repoDir, keyfile } = await newRepo();
    const header = loadHeader(repoDir);
    const key = resolveRepoKey(header, { keyfile });
    const full = makeImage(repoDir, 'root.opbs', base64Block(10));
    const delta = makeImage(repoDir, 'leaf.opbs', base64Block(11));
    await recordImageCreate(repoDir, header, key, full, { lockDays: 0 });
    await recordImageCreate(repoDir, header, key, delta, { lockDays: 30, base: 'root.opbs' });
    const result = await pruneRepository(repoDir, { keyfile });
    expect(result.removed).toHaveLength(0);
    expect(result.skipped.find((e) => e.name === 'root.opbs')?.reason).toMatch(/waiting for 1 locked delta/);
    expect(fs.existsSync(full)).toBe(true);
    expect(fs.existsSync(delta)).toBe(true);
  });

  it('unlock is audited and lets prune remove a locked image', async () => {
    const { repoDir, keyfile } = await newRepo({ lockDays: 365 });
    const image = makeImage(repoDir, 'escape.opbs', base64Block(12));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image);
    await expect(unlockRepository(repoDir, 'missing.opbs', { keyfile })).rejects.toThrow(/No active image/);
    const unlocked = await unlockRepository(repoDir, 'escape.opbs', { keyfile });
    expect(unlocked).toEqual(['escape.opbs']);
    const records = loadJournal(repoDir);
    expect(records[records.length - 1].type).toBe('unlock');
    const result = await pruneRepository(repoDir, { keyfile });
    expect(result.removed.map((e) => e.name)).toEqual(['escape.opbs']);
    expect(fs.existsSync(image)).toBe(false);
    expect((await verifyRepository(repoDir, { keyfile })).ok).toBe(true);
  });

  it('prune refuses when the journal structure is broken', async () => {
    const { repoDir, keyfile } = await newRepo();
    fs.appendFileSync(
      path.join(repoDir, 'opbs-repo.journal'),
      JSON.stringify({ seq: 1, type: 'prune', at: 'x', image: 'y', prev: 'z', sig: 'a'.repeat(64) }) + '\n'
    );
    await expect(pruneRepository(repoDir, { keyfile })).rejects.toThrow(/Refusing to prune/);
  });
});

describe('automatic retention guard', () => {
  it('never prunes inside a repository', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'keep.me.opbs', base64Block(13));
    const header = loadHeader(repoDir);
    await recordImageCreate(repoDir, header, resolveRepoKey(header, { keyfile }), image, { lockDays: 0 });
    const plan = await applyRetention(repoDir, { keepFull: 0, keepDeltasPerFull: 0, retentionDays: 0, dryRun: false });
    expect(plan.prune).toHaveLength(0);
    expect(plan.reminders[0]).toMatch(/OPBS repository/);
    expect(fs.existsSync(image)).toBe(true);
  });
});

describe('finalizeBackupRepo (backup hook)', () => {
  it('journals the backup result and verifies afterwards', async () => {
    const { repoDir, keyfile } = await newRepo();
    const image = makeImage(repoDir, 'hooked.opbs', base64Block(14));
    const result = { ok: true, imagePath: image } as JobResult;
    const config = {} as BackupJobConfig;
    await finalizeBackupRepo(repoDir, config, result, { keyfile, quiet: true, lockDays: 5 });
    const records = loadJournal(repoDir);
    expect(records).toHaveLength(1);
    expect(records[0].image).toBe('hooked.opbs');
    const report = await verifyRepository(repoDir, { keyfile });
    expect(report.ok).toBe(true);
    expect(Date.parse(report.states[0].lockUntil!) - Date.now()).toBeGreaterThan(4 * 86_400_000);
  });

  it('does nothing for failed backups and throws when the image vanished', async () => {
    const { repoDir, keyfile } = await newRepo();
    const config = {} as BackupJobConfig;
    await finalizeBackupRepo(repoDir, config, { ok: false, imagePath: '' } as JobResult, { keyfile, quiet: true });
    expect(loadJournal(repoDir)).toHaveLength(0);
    await expect(
      finalizeBackupRepo(repoDir, config, { ok: true, imagePath: '' } as JobResult, { keyfile, quiet: true })
    ).rejects.toThrow(/could not be located/);
  });
});

describe.skipIf(process.platform !== 'win32')('file protection (win32)', () => {
  it('blocks writes but keeps reads working until unprotected', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'protected.txt');
    fs.writeFileSync(file, 'locked down');
    await protectFiles([file]);
    // Reads (repo verify, hashing) keep working...
    expect(fs.readFileSync(file, 'utf-8')).toBe('locked down');
    // ...but every write path is refused — no ransomware encryption.
    expect(() => fs.openSync(file, 'r+')).toThrow();
    expect(() => fs.writeFileSync(file, 'tampered')).toThrow();
    // Deletion of a readable file cannot be ACL-blocked on Windows (it falls
    // back to the parent directory's DELETE_CHILD grant), so verify instead
    // detects it — here we only guarantee the protect/unprotect roundtrip.
    await unprotectFiles([file]);
    fs.writeFileSync(file, 'writable again');
    expect(fs.readFileSync(file, 'utf-8')).toBe('writable again');
  });
});
