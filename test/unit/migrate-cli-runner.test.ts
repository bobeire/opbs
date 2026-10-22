import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMigrateArgs } from '../../src/main/imaging/migrate/cli-runner';
import { cmdMigrate } from '../../src/main/cli/migrate';

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildMigrateArgs', () => {
  it('builds a minimal live plan invocation', () => {
    expect(buildMigrateArgs({ action: 'plan', source: { live: true }, profile: 'rober' })).toEqual([
      '--cli',
      'migrate',
      'plan',
      '--live',
      '--profile',
      'rober',
      '--json'
    ]);
  });

  it('places the image path first (positional) with a spaced partition', () => {
    const args = buildMigrateArgs({
      action: 'plan',
      source: { imagePath: 'D:\\imgs\\pc.opbs', partitionIndex: 3 },
      profile: 'alice'
    });
    expect(args.slice(0, 6)).toEqual([
      '--cli',
      'migrate',
      'plan',
      'D:\\imgs\\pc.opbs',
      '--partition',
      '3'
    ]);
    expect(args).toContain('--json');
  });

  it('defaults the partition to 0 when the source omits it', () => {
    const args = buildMigrateArgs({
      action: 'plan',
      source: { imagePath: 'x.opbs' },
      profile: 'alice'
    });
    expect(args[args.indexOf('--partition') + 1]).toBe('0');
  });

  it('passes run flags only for the run action', () => {
    const plan = buildMigrateArgs({ action: 'plan', source: { live: true }, profile: 'p' });
    for (const flag of ['--execute', '--plan-hash', '--registry', '--no-owner', '--merge', '--resume', '--no-verify']) {
      expect(plan).not.toContain(flag);
    }

    const run = buildMigrateArgs({
      action: 'run',
      source: { live: true },
      profile: 'p',
      target: 'C:\\Users\\Bob',
      planHash: 'abc123',
      execute: true,
      registry: true,
      noOwner: true,
      merge: true,
      resume: true,
      noVerify: true
    });
    expect(run).toContain('--execute');
    expect(run).toContain('--registry');
    expect(run).toContain('--no-owner');
    expect(run).toContain('--merge');
    expect(run).toContain('--resume');
    expect(run).toContain('--no-verify');
    expect(run[run.indexOf('--plan-hash') + 1]).toBe('abc123');
    expect(run[run.indexOf('--target') + 1]).toBe('C:\\Users\\Bob');
  });

  it('repeats --folder in spaced form (the CLI reads it with strict equality)', () => {
    const args = buildMigrateArgs({
      action: 'plan',
      source: { live: true },
      profile: 'p',
      folders: ['Desktop', 'AppData']
    });
    const folders = args.filter((a) => a === '--folder');
    expect(folders).toHaveLength(2);
    expect(args[args.indexOf('--folder') + 1]).toBe('Desktop');
    expect(args.lastIndexOf('--folder') + 1).toBeLessThan(args.length);
    expect(args[args.lastIndexOf('--folder') + 1]).toBe('AppData');
  });

  it('never places a passphrase on argv', () => {
    const args = buildMigrateArgs({
      action: 'run',
      source: { imagePath: 'enc.opbs', partitionIndex: 1, passphrase: 'hunter2-secret' },
      profile: 'p',
      target: 'C:\\Users\\Bob',
      planHash: 'h',
      execute: true
    });
    const joined = args.join(' ');
    expect(joined).not.toContain('hunter2-secret');
    expect(joined).not.toContain('--passphrase');
  });
});

describe('migrate plan --json-out', () => {
  it('writes the plan JSON to the file and prints it to stdout', async () => {
    const root = tempDir('opbs-migrate-jsonout-');
    const profileDir = path.join(root, 'Users', 'TestUser');
    fs.mkdirSync(path.join(profileDir, 'Desktop'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Desktop', 'hello.txt'), 'hi');
    fs.mkdirSync(path.join(profileDir, 'Documents'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Documents', 'note.txt'), 'notes');

    const outFile = path.join(root, 'plan.json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exit = await cmdMigrate({
      argv: ['plan', '--live', '--live-root', root, '--profile', 'TestUser', '--json-out', outFile],
      opts: { json: true }
    });

    expect(exit).toBe(0);
    const plan = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(plan.profile).toBe('TestUser');
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.totalItems).toBe(2);
    expect(Array.isArray(plan.refusals)).toBe(true);
    expect(plan.refusals).toHaveLength(0);

    // emitJson also mirrors to stdout for plain `--json` consumers.
    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toContain('"planHash"');
  });
});
