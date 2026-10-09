/**
 * Remote action runner (Tier 4): executes the read-only diagnostics a machine
 * claimed from the fleet server's queue.
 *
 * Every action is one of the whitelisted commands from FLEET_ACTION_NAMES,
 * spawned as `OPBS --cli <action...> --json` in a child process — the same
 * invocation a scheduled task would use, so actions are isolated from the
 * check-in process, bounded by a hard timeout, and their JSON output can be
 * carried back inside the check-in.
 *
 * The whitelist is enforced here again (defense in depth): the machine never
 * executes anything a malicious or confused server could smuggle in, and
 * anything unknown comes back as a failed result instead of running.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { FLEET_ACTION_NAMES, FleetActionName, FleetActionRequest, FleetActionResult } from './schema';

const execFileAsync = promisify(execFile);

/** How long one action may run before it is killed (verify on huge disks). */
export const ACTION_TIMEOUT_MS = 15 * 60_000;
/** Parsed output above this size is dropped (the check-in cap is 256 KiB). */
const MAX_DETAIL_BYTES = 32 * 1024;
const MAX_SUMMARY_CHARS = 300;

export interface ActionExecution {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}

export type ActionExecutor = (args: string[], timeoutMs: number) => Promise<ActionExecution>;

export const spawnSelfExecutor: ActionExecutor = async (args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--cli', ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return { code: 0, killed: false, stdout, stderr };
  } catch (error) {
    const err = error as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === 'number' ? err.code : null,
      killed: err.killed === true,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? ''
    };
  }
};

/** Map a queued request to CLI arguments — or refuse it outright. */
export function buildActionArgs(
  req: Pick<FleetActionRequest, 'action' | 'dir' | 'scope'>
): { ok: true; args: string[] } | { ok: false; error: string } {
  if (!(FLEET_ACTION_NAMES as readonly string[]).includes(req.action)) {
    return { ok: false, error: `unsupported action "${req.action}" (read-only diagnostics only)` };
  }
  if (!req.dir) {
    return { ok: false, error: 'missing target dir' };
  }
  const dir = req.dir;
  let args: string[];
  switch (req.action as FleetActionName) {
    case 'verify':
      args = ['verify', '--dir', dir, '--scope', req.scope ?? 'newest'];
      break;
    case 'scrub':
      args = ['scrub', '--dir', dir, '--scope', req.scope ?? 'newest'];
      break;
    case 'chain':
      args = ['chain', 'check', '--dir', dir];
      break;
    case 'analytics':
      args = ['analytics', dir];
      break;
    case 'anomalies':
      args = ['anomalies', 'check', '--dir', dir];
      break;
    case 'storage-health':
      args = ['storage-health', '--dir', dir];
      break;
    default:
      return { ok: false, error: `unsupported action "${req.action}"` };
  }
  return { ok: true, args: [...args, '--json'] };
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, MAX_SUMMARY_CHARS);
  }
  return '';
}

export interface RunActionsOptions {
  executor?: ActionExecutor;
  timeoutMs?: number;
  now?: () => number;
}

/** Run claimed actions sequentially and describe each outcome. */
export async function runQueuedActions(
  actions: FleetActionRequest[],
  opts: RunActionsOptions = {}
): Promise<FleetActionResult[]> {
  const executor = opts.executor ?? spawnSelfExecutor;
  const timeoutMs = opts.timeoutMs ?? ACTION_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const results: FleetActionResult[] = [];
  for (const req of actions) {
    const startedAt = now();
    const built = buildActionArgs(req);
    if (!built.ok) {
      results.push({ id: req.id, action: req.action, ok: false, startedAt, finishedAt: now(), summary: built.error });
      continue;
    }
    const exec = await executor(built.args, timeoutMs);
    const finishedAt = now();
    const ok = exec.code === 0;
    const trimmed = exec.stdout.trim();
    let detail: unknown;
    if (trimmed && Buffer.byteLength(trimmed, 'utf-8') <= MAX_DETAIL_BYTES) {
      try {
        detail = JSON.parse(trimmed);
      } catch {
        /* plain-text output stays in the summary only */
      }
    }
    let summary: string;
    if (exec.killed) {
      summary = `timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (!ok && firstLine(exec.stderr)) {
      summary = firstLine(exec.stderr);
    } else if (detail !== undefined) {
      summary = JSON.stringify(detail).slice(0, MAX_SUMMARY_CHARS);
    } else if (firstLine(trimmed)) {
      summary = firstLine(trimmed);
    } else if (ok) {
      summary = 'ok';
    } else {
      summary = `exit code ${exec.code}`;
    }
    const result: FleetActionResult = { id: req.id, action: req.action, ok, startedAt, finishedAt, summary };
    if (detail !== undefined) result.detail = detail;
    results.push(result);
  }
  return results;
}
