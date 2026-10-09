/**
 * Fleet policy application (Tier 2, auto-apply at check-in).
 *
 * The fleet server offers backup job configs as policies. When a machine
 * auto-applies, every check-in pulls the policy list and reconciles local
 * state against it:
 *
 *   - new/changed policy → validate, write `<policyDir>/<name>.json`,
 *     register (or refresh) a Windows scheduled task `OPBS Fleet <name>` that
 *     runs `--cli backup <config> --elevated` on the policy's schedule;
 *   - unchanged policy  → left alone (content hash match);
 *   - removed policy    → delete the task and the local config;
 *   - invalid policy    → reported, but any previously applied task is kept
 *     as last-known-good;
 *   - failed apply      → reported, state not advanced, retried next check-in.
 *
 * Auto-apply is opt-in (flag/settings), token-authenticated, and refuses any
 * job that is not plainly a backup — restores/clones/drills never run from a
 * pushed policy. Every side effect is skipped in dry-run mode so the whole
 * flow can be previewed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { isValidPolicyName, validateBackupPolicy, FleetPolicyApplied } from './schema';
import type { PolicyList } from './client';
import type { ScheduledTaskOptions } from '../utils/task-scheduler';
import { registerScheduledTask, removeScheduledTask } from '../utils/task-scheduler';

/** Scheduled-task prefix so fleet-owned tasks are easy to spot and clean up. */
export const POLICY_TASK_PREFIX = 'OPBS Fleet';

const STATE_SCHEMA = 1;
const STATE_FILE = 'applied-state.json';

/** Where applied policies live locally (configs + reconciliation state). */
export function defaultPolicyDir(): string {
  return path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'opbs',
    'fleet-policies'
  );
}

/** Windows task name for a policy: `OPBS Fleet nightly` for `nightly.json`. */
export function taskNameForPolicy(policyName: string): string {
  return `${POLICY_TASK_PREFIX} ${policyName.replace(/\.json$/i, '')}`;
}

interface AppliedStateEntry {
  hash: string;
  task: string;
  configPath: string;
  appliedAt: number;
}

interface AppliedState {
  schema: number;
  policies: Record<string, AppliedStateEntry>;
}

export function loadAppliedState(policyDir: string): AppliedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(policyDir, STATE_FILE), 'utf-8')) as AppliedState;
    if (parsed && parsed.schema === STATE_SCHEMA && typeof parsed.policies === 'object' && parsed.policies !== null) {
      return parsed;
    }
  } catch {
    /* missing or corrupt state starts from scratch */
  }
  return { schema: STATE_SCHEMA, policies: {} };
}

export function saveAppliedState(policyDir: string, state: AppliedState): void {
  fs.mkdirSync(policyDir, { recursive: true });
  const target = path.join(policyDir, STATE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, target);
}

function policyConfigPath(policyDir: string, name: string): string {
  return path.join(policyDir, name);
}

function readSchedule(config: Record<string, unknown>): { time?: string; onLogin?: boolean } {
  const schedule = config.fleetSchedule;
  if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) return {};
  const value = schedule as Record<string, unknown>;
  const opts: { time?: string; onLogin?: boolean } = {};
  if (typeof value.time === 'string') opts.time = value.time;
  if (value.onLogin === true) opts.onLogin = true;
  return opts;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ApplyPoliciesOptions {
  /** Compute the results without writing files or touching Task Scheduler. */
  dryRun?: boolean;
  /** Injectable for tests; defaults to the real schtasks-backed helpers. */
  registerTask?: (name: string, commandLine: string, opts: ScheduledTaskOptions) => Promise<void>;
  removeTask?: (name: string) => Promise<void>;
  now?: () => number;
}

/**
 * Reconcile the local policy state against the server's policy list.
 * Only call this after a successful pull — a failed pull must never remove
 * backup tasks.
 */
export async function applyPolicies(
  policyDir: string,
  list: PolicyList,
  opts: ApplyPoliciesOptions = {}
): Promise<FleetPolicyApplied[]> {
  const dryRun = opts.dryRun === true;
  const registerTask = opts.registerTask ?? ((name, commandLine, taskOpts) => registerScheduledTask(name, commandLine, taskOpts));
  const removeTask = opts.removeTask ?? removeScheduledTask;
  const now = opts.now ?? Date.now;
  const state = loadAppliedState(policyDir);
  const results: FleetPolicyApplied[] = [];
  const seen = new Set<string>();

  const policies = [...list.policies].sort((a, b) => a.name.localeCompare(b.name));
  for (const policy of policies) {
    const { name, config } = policy;
    seen.add(name);
    if (!isValidPolicyName(name)) {
      results.push({ name, status: 'invalid', reason: 'invalid policy name' });
      continue;
    }
    const validation = validateBackupPolicy(config);
    if (!validation.ok) {
      // Keep any previously applied task as last-known-good.
      results.push({ name, status: 'invalid', reason: validation.error });
      continue;
    }
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const existing = state.policies[name];
    if (existing && existing.hash === hash) {
      results.push({ name, status: 'unchanged', task: existing.task, appliedAt: existing.appliedAt });
      continue;
    }

    const configPath = policyConfigPath(policyDir, name);
    const task = taskNameForPolicy(name);
    const commandLine = `"${process.execPath}" --cli backup "${configPath}" --elevated`;
    try {
      if (!dryRun) {
        fs.mkdirSync(policyDir, { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
        await registerTask(task, commandLine, { ...readSchedule(validation.config), overwrite: true });
        const appliedAt = now();
        state.policies[name] = { hash, task, configPath, appliedAt };
        results.push({ name, status: 'applied', task, appliedAt });
      } else {
        results.push({ name, status: 'applied', task, appliedAt: now() });
      }
    } catch (error) {
      // State is not advanced, so the next check-in retries this policy.
      results.push({ name, status: 'failed', task, reason: errorMessage(error) });
    }
  }

  for (const [name, entry] of Object.entries(state.policies)) {
    if (seen.has(name)) continue;
    try {
      if (!dryRun) await removeTask(entry.task);
    } catch {
      /* task already gone */
    }
    if (!dryRun) {
      try {
        fs.unlinkSync(entry.configPath);
      } catch {
        /* config already gone */
      }
      delete state.policies[name];
    }
    results.push({ name, status: 'removed' });
  }

  if (!dryRun) saveAppliedState(policyDir, state);
  return results;
}
