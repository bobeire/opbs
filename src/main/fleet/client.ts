/**
 * Fleet check-in client: POSTs a FleetCheckin to the fleet server over plain
 * HTTP with a bearer token. Uses global fetch (Node 18+/Electron 28) so no
 * extra dependency is added.
 */
import { FleetCheckin, FleetActionName, FleetActionRequest, validateCheckin } from './schema';

export interface CheckinTarget {
  /** Base URL of the fleet server, e.g. http://backup-host:8787 */
  server: string;
  token: string;
  timeoutMs?: number;
}

export interface CheckinResult {
  ok: boolean;
  status: number;
  error?: string;
}

function normalizeBaseUrl(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`server URL must start with http:// or https:// (got "${server}")`);
  }
  return trimmed;
}

export async function sendCheckin(checkin: FleetCheckin, target: CheckinTarget): Promise<CheckinResult> {
  const validation = validateCheckin(checkin);
  if (!validation.ok) {
    return { ok: false, status: 0, error: `refusing to send invalid check-in: ${validation.error}` };
  }

  const base = normalizeBaseUrl(target.server);
  const timeoutMs = target.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/checkin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`
      },
      body: JSON.stringify(checkin),
      signal: controller.signal
    });
    if (response.ok) {
      return { ok: true, status: response.status };
    }
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    return { ok: false, status: response.status, error: `server replied ${response.status} ${detail}` };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `no response from ${base} within ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export interface FleetSummary {
  generatedAt: number;
  staleDays: number;
  backupStaleDays: number | null;
  machineCount: number;
  summary: { ok: number; warning: number; critical: number; stale: number };
  machines: Array<{
    machineId: string;
    hostname: string;
    receivedAt: number;
    status: 'ok' | 'warning' | 'critical' | 'stale';
    reasons: string[];
    checkin: FleetCheckin;
  }>;
}

export async function fetchFleet(target: { server: string; timeoutMs?: number }): Promise<FleetSummary> {
  const base = normalizeBaseUrl(target.server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${base}/api/fleet`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`server replied ${response.status}`);
    }
    return (await response.json()) as FleetSummary;
  } finally {
    clearTimeout(timer);
  }
}

export interface PolicyList {
  policies: Array<{ name: string; config: unknown }>;
  invalid: Array<{ name: string; error: string }>;
}

async function policyFetch(
  target: { server: string; token?: string; timeoutMs?: number },
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  const base = normalizeBaseUrl(target.server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        ...init.headers
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`server replied ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Download every policy the server offers (invalid files are listed, not thrown). */
export async function pullPolicies(target: { server: string; token: string; timeoutMs?: number }): Promise<PolicyList> {
  const response = await policyFetch(target, '/api/policy');
  return (await response.json()) as PolicyList;
}

/** Upload a job-config JSON file under a server-side policy name. */
export async function pushPolicy(
  target: { server: string; token: string; timeoutMs?: number },
  name: string,
  config: unknown
): Promise<{ name: string }> {
  const response = await policyFetch(target, `/api/policy/${name}`, { method: 'PUT', body: JSON.stringify(config) });
  return (await response.json()) as { name: string };
}

// ---------------------------------------------------------------------------
// Remote actions (Tier 4): queue a read-only diagnostic, claim it later.
// ---------------------------------------------------------------------------

/** Queue an action for one machine, or for every known machine with `machineId: '*'`. */
export async function enqueueAction(
  target: { server: string; token: string; timeoutMs?: number },
  request: { action: FleetActionName; machineId: string; dir: string; scope?: 'newest' | 'all' }
): Promise<{ action: string; queued: Array<{ id: string; machineId: string }> }> {
  const response = await policyFetch(target, '/api/action', { method: 'POST', body: JSON.stringify(request) });
  return (await response.json()) as { action: string; queued: Array<{ id: string; machineId: string }> };
}

/** List the pending action queue (admin view). */
export async function fetchActionQueue(
  target: { server: string; token: string; timeoutMs?: number }
): Promise<{ queue: FleetActionRequest[] }> {
  const response = await policyFetch(target, '/api/action');
  return (await response.json()) as { queue: FleetActionRequest[] };
}

/**
 * Atomically take every action queued for this machine. The server pops the
 * entries as it answers, so a machine never runs the same action twice —
 * but a crash before reporting loses the results (they are diagnostics).
 */
export async function claimActions(
  target: { server: string; token: string; timeoutMs?: number },
  machineId: string
): Promise<FleetActionRequest[]> {
  const response = await policyFetch(target, `/api/actions/${encodeURIComponent(machineId)}/claim`, { method: 'POST' });
  const body = (await response.json()) as { actions?: FleetActionRequest[] };
  return Array.isArray(body.actions) ? body.actions : [];
}
