/**
 * Fleet alerting (Tier 3): the server pushes status transitions to a generic
 * webhook instead of waiting for someone to open the dashboard.
 *
 * Two evaluation paths feed the same transition rule:
 *
 *   - after every accepted check-in (fast reaction to a newly critical machine);
 *   - on a sweep timer (catches machines that *stopped* checking in or whose
 *     backups aged past the staleness threshold — a dead machine sends nothing,
 *     so time-based re-evaluation is the only way to notice it).
 *
 * Alerting is transition-based, not status-based: a machine is messaged when it
 * *becomes* critical or stale (or when it recovers from such a state), never
 * re-sent while it stays in the same state. Delivery state
 * (`lastAlertedStatus`) is persisted per machine and only advanced on
 * successful delivery, so a failed webhook retries on the next cycle.
 *
 * The payload is plain JSON with a human `text` (Slack-compatible services)
 * and `content` (Discord) line plus the structured fields — receivers can be
 * Slack, Discord, ntfy relays, Grafana hooks, or a self-hosted collector.
 */
import type { FleetCheckin, FleetStatus } from './schema';
import { deriveMachineStatus } from './schema';

/** What happened: the machine entered a bad state, or left one. */
export type AlertKind = 'critical' | 'stale' | 'recovery';

export interface WebhookPayload {
  event: 'status-change';
  kind: AlertKind;
  status: FleetStatus;
  previousStatus: FleetStatus | null;
  hostname: string;
  machineId: string;
  appVersion: string;
  reasons: string[];
  fleetUrl: string;
  at: number;
  /** Slack-compatible one-liner. */
  text: string;
  /** Discord-compatible copy of the same line. */
  content: string;
}

export interface AlertCandidate {
  machineId: string;
  kind: AlertKind;
  status: FleetStatus;
  previousStatus: FleetStatus | null;
  hostname: string;
  reasons: string[];
  payload: WebhookPayload;
}

function isBadStatus(status: FleetStatus): status is 'critical' | 'stale' {
  return status === 'critical' || status === 'stale';
}

/**
 * Should we notify about this machine? Rules:
 *   - entered critical/stale (different from the last alerted state) → alert;
 *   - left critical/stale (last alerted state was bad) → recovery;
 *   - anything else (including repeat sightings of the same bad state) → no.
 */
export function alertTransition(previous: FleetStatus | undefined, current: FleetStatus): AlertKind | null {
  if (isBadStatus(current) && previous !== current) return current;
  if (!isBadStatus(current) && previous !== undefined && isBadStatus(previous)) return 'recovery';
  return null;
}

export interface AlertStoreEntry {
  receivedAt: number;
  checkin: FleetCheckin;
  lastAlertedStatus?: FleetStatus;
}

/** Structurally satisfied by the fleet server's on-disk store. */
export interface AlertStoreLike {
  machines: Record<string, AlertStoreEntry>;
}

export interface EvaluateAlertsOptions {
  staleDays: number;
  backupStaleDays?: number;
  now?: number;
  fleetUrl?: string;
}

/** Pure: computes the alerts a store currently warrants, without mutating it. */
export function evaluateAlerts(store: AlertStoreLike, opts: EvaluateAlertsOptions): AlertCandidate[] {
  const now = opts.now ?? Date.now();
  const fleetUrl = opts.fleetUrl ?? '';
  const candidates: AlertCandidate[] = [];
  for (const [machineId, entry] of Object.entries(store.machines)) {
    const { status, reasons } = deriveMachineStatus(entry.checkin, {
      receivedAt: entry.receivedAt,
      now,
      staleDays: opts.staleDays,
      backupStaleDays: opts.backupStaleDays
    });
    const kind = alertTransition(entry.lastAlertedStatus, status);
    if (!kind) continue;
    const hostname = entry.checkin.hostname;
    const headline =
      kind === 'recovery'
        ? `OPBS fleet: ${hostname} recovered (now ${status})`
        : `OPBS fleet: ${hostname} is ${status}`;
    const reasonLine = reasons.length ? ` — ${reasons.join('; ')}` : '';
    const where = fleetUrl ? ` (${fleetUrl})` : '';
    const text = `${headline}${reasonLine}${where}`;
    candidates.push({
      machineId,
      kind,
      status,
      previousStatus: entry.lastAlertedStatus ?? null,
      hostname,
      reasons,
      payload: {
        event: 'status-change',
        kind,
        status,
        previousStatus: entry.lastAlertedStatus ?? null,
        hostname,
        machineId,
        appVersion: entry.checkin.appVersion,
        reasons,
        fleetUrl,
        at: now,
        text,
        content: text
      }
    });
  }
  return candidates;
}

/** POST the payload to the webhook; false on any failure (caller retries later). */
export async function postWebhook(
  url: string,
  payload: WebhookPayload,
  opts: { timeoutMs?: number } = {}
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
