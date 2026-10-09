import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyPolicies,
  defaultPolicyDir,
  loadAppliedState,
  saveAppliedState,
  taskNameForPolicy,
  POLICY_TASK_PREFIX
} from '../../src/main/fleet/policy';
import type { PolicyList } from '../../src/main/fleet/client';

const BACKUP_CONFIG = {
  kind: 'backup',
  sourceDiskIndex: 0,
  sourcePartitions: [2],
  destinationPath: 'D:\\OPBS',
  fleetSchedule: { time: '03:30' }
};

function policyList(...configs: Array<[string, unknown]>): PolicyList {
  return { policies: configs.map(([name, config]) => ({ name, config })), invalid: [] };
}

interface FakeDeps {
  registered: Array<{ name: string; commandLine: string; opts: Record<string, unknown> }>;
  removed: string[];
  registerTask: (name: string, commandLine: string, opts: Record<string, unknown>) => Promise<void>;
  removeTask: (name: string) => Promise<void>;
  now: () => number;
  failRegister?: string;
  failRemove?: string;
  clock: { value: number };
}

function fakeDeps(startAt = 1000): FakeDeps {
  const deps: FakeDeps = {
    registered: [],
    removed: [],
    clock: { value: startAt },
    registerTask: async (name, commandLine, opts) => {
      if (deps.failRegister) throw new Error(deps.failRegister);
      deps.registered.push({ name, commandLine, opts });
    },
    removeTask: async (name) => {
      if (deps.failRemove) throw new Error(deps.failRemove);
      deps.removed.push(name);
    },
    now: () => deps.clock.value
  };
  return deps;
}

describe('taskNameForPolicy', () => {
  it('builds a stable, prefix-marked task name', () => {
    expect(taskNameForPolicy('nightly.json')).toBe(`${POLICY_TASK_PREFIX} nightly`);
    expect(taskNameForPolicy('a.b_c-2.json')).toBe(`${POLICY_TASK_PREFIX} a.b_c-2`);
    expect(taskNameForPolicy('already')).toBe(`${POLICY_TASK_PREFIX} already`);
  });
});

describe('defaultPolicyDir', () => {
  it('lives under the per-user OPBS data area', () => {
    expect(defaultPolicyDir().replace(/\\/g, '/')).toMatch(/\/opbs\/fleet-policies$/);
  });
});

describe('applied state file', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-state-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when the file is missing or corrupt', () => {
    expect(loadAppliedState(dir)).toEqual({ schema: 1, policies: {} });
    fs.writeFileSync(path.join(dir, 'applied-state.json'), '{ nope', 'utf-8');
    expect(loadAppliedState(dir)).toEqual({ schema: 1, policies: {} });
  });

  it('round-trips a saved state', () => {
    const state = {
      schema: 1,
      policies: { 'nightly.json': { hash: 'abc', task: 'OPBS Fleet nightly', configPath: 'x.json', appliedAt: 42 } }
    };
    saveAppliedState(dir, state as never);
    expect(loadAppliedState(dir)).toEqual(state);
  });
});

describe('applyPolicies', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-apply-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies a new policy: config written + backup task registered', async () => {
    const deps = fakeDeps();
    const results = await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      name: 'nightly.json',
      status: 'applied',
      task: 'OPBS Fleet nightly',
      appliedAt: 1000
    });
    expect(deps.registered).toHaveLength(1);
    const reg = deps.registered[0];
    expect(reg.name).toBe('OPBS Fleet nightly');
    expect(reg.commandLine).toContain('--cli backup');
    expect(reg.commandLine).toContain(path.join(dir, 'nightly.json'));
    expect(reg.commandLine).toContain('--elevated');
    expect(reg.opts).toEqual({ time: '03:30', overwrite: true });

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'nightly.json'), 'utf-8'))).toEqual(BACKUP_CONFIG);
    const state = loadAppliedState(dir);
    expect(Object.keys(state.policies)).toEqual(['nightly.json']);
    expect(state.policies['nightly.json'].task).toBe('OPBS Fleet nightly');
  });

  it('defaults the schedule when the policy carries no fleetSchedule', async () => {
    const deps = fakeDeps();
    const { fleetSchedule: _drop, ...bare } = BACKUP_CONFIG;
    await applyPolicies(dir, policyList(['bare.json', bare]), deps);
    expect(deps.registered[0].opts).toEqual({ overwrite: true });
  });

  it('leaves an unchanged policy alone across runs', async () => {
    const deps = fakeDeps(1000);
    await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);
    deps.clock.value = 2000;
    const results = await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);

    expect(results[0].status).toBe('unchanged');
    expect(results[0].appliedAt).toBe(1000); // original apply time preserved
    expect(deps.registered).toHaveLength(1); // no re-registration
  });

  it('re-applies when the config changes and refreshes the state hash', async () => {
    const deps = fakeDeps();
    await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);
    const changed = { ...BACKUP_CONFIG, destinationPath: 'E:\\OPBS' };
    const results = await applyPolicies(dir, policyList(['nightly.json', changed]), deps);

    expect(results[0].status).toBe('applied');
    expect(deps.registered).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'nightly.json'), 'utf-8')).destinationPath).toBe('E:\\OPBS');
    expect(loadAppliedState(dir).policies['nightly.json'].hash).not.toBe('');
  });

  it('removes the task and config when the policy disappears from the server', async () => {
    const deps = fakeDeps();
    await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);
    const results = await applyPolicies(dir, policyList(), deps);

    expect(results).toEqual([{ name: 'nightly.json', status: 'removed' }]);
    expect(deps.removed).toEqual(['OPBS Fleet nightly']);
    expect(fs.existsSync(path.join(dir, 'nightly.json'))).toBe(false);
    expect(loadAppliedState(dir).policies).toEqual({});
  });

  it('keeps the last known good task when a policy turns invalid', async () => {
    const deps = fakeDeps();
    await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);
    const results = await applyPolicies(
      dir,
      policyList(['nightly.json', { kind: 'restore', imagePath: 'x.opbs', targetDiskIndex: 1 }]),
      deps
    );

    expect(results[0].status).toBe('invalid');
    expect(results[0].reason).toContain('only backup jobs can be auto-applied');
    expect(deps.removed).toEqual([]); // previous task untouched
    expect(fs.existsSync(path.join(dir, 'nightly.json'))).toBe(true);
    expect(Object.keys(loadAppliedState(dir).policies)).toEqual(['nightly.json']);
  });

  it('reports an invalid never-applied policy without registering anything', async () => {
    const deps = fakeDeps();
    const results = await applyPolicies(
      dir,
      policyList(['bad.json', { sourceDiskIndex: 'zero', sourcePartitions: [1], destinationPath: 'D:\\x' }]),
      deps
    );
    expect(results[0].status).toBe('invalid');
    expect(results[0].reason).toContain('sourceDiskIndex');
    expect(deps.registered).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'bad.json'))).toBe(false);
  });

  it('refuses traversal-style names even if the server sent them', async () => {
    const deps = fakeDeps();
    const results = await applyPolicies(dir, policyList(['../evil.json', BACKUP_CONFIG]), deps);
    expect(results[0]).toEqual({ name: '../evil.json', status: 'invalid', reason: 'invalid policy name' });
    expect(deps.registered).toEqual([]);
    expect(fs.existsSync(path.join(dir, '..', 'evil.json'))).toBe(false);
  });

  it('reports a registration failure and retries on the next run', async () => {
    const deps = fakeDeps();
    deps.failRegister = 'schtasks exited with code 1';
    const results = await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toBe('schtasks exited with code 1');
    expect(loadAppliedState(dir).policies).toEqual({}); // state not advanced

    deps.failRegister = undefined;
    const retry = await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);
    expect(retry[0].status).toBe('applied');
    expect(deps.registered).toHaveLength(1);
  });

  it('still drops removed policies when the task removal itself fails', async () => {
    const deps = fakeDeps();
    await applyPolicies(dir, policyList(['nightly.json', BACKUP_CONFIG]), deps);
    deps.failRemove = 'access denied';
    const results = await applyPolicies(dir, policyList(), deps);

    expect(results).toEqual([{ name: 'nightly.json', status: 'removed' }]);
    expect(loadAppliedState(dir).policies).toEqual({}); // not retried forever
  });

  it('previews everything in dry-run mode without side effects', async () => {
    const deps = fakeDeps();
    await applyPolicies(dir, policyList(['old.json', BACKUP_CONFIG]), deps);
    const dry = await applyPolicies(
      dir,
      policyList(['old.json', BACKUP_CONFIG], ['new.json', { ...BACKUP_CONFIG, fleetSchedule: { time: '04:00' } }]),
      { ...deps, dryRun: true }
    );

    expect(dry.find((r) => r.name === 'old.json')?.status).toBe('unchanged');
    expect(dry.find((r) => r.name === 'new.json')?.status).toBe('applied');
    expect(fs.existsSync(path.join(dir, 'new.json'))).toBe(false); // nothing written
    expect(deps.registered).toHaveLength(1); // only the pre-dry-run apply
    expect(deps.removed).toEqual([]);

    const gone = await applyPolicies(dir, policyList(), { ...deps, dryRun: true });
    expect(gone).toEqual([{ name: 'old.json', status: 'removed' }]);
    expect(fs.existsSync(path.join(dir, 'old.json'))).toBe(true); // config kept
    expect(deps.removed).toEqual([]);
  });

  it('processes policies deterministically sorted by name', async () => {
    const deps = fakeDeps();
    const results = await applyPolicies(
      dir,
      policyList(['zeta.json', BACKUP_CONFIG], ['alpha.json', BACKUP_CONFIG], ['mid.json', BACKUP_CONFIG]),
      deps
    );
    expect(results.map((r) => r.name)).toEqual(['alpha.json', 'mid.json', 'zeta.json']);
  });
});
