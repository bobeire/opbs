/**
 * Fleet check-in client: POSTs a FleetCheckin to the fleet server over plain
 * HTTP with a bearer token. Uses global fetch (Node 18+/Electron 28) so no
 * extra dependency is added.
 */
import { FleetCheckin, validateCheckin } from './schema';

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
