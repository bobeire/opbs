/**
 * Fleet server (Tier 0): a dependency-free node:http service that accepts
 * token-authenticated check-ins, keeps the newest document per machine on
 * disk, and serves the aggregated fleet as JSON plus the HTML dashboard.
 *
 * Storage is one atomic JSON file (checkins.json) in the data directory —
 * no database, nothing to install, the whole control plane is this file and
 * this process.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AddressInfo } from 'net';
import { FLEET_DASHBOARD_HTML } from './dashboard';
import { deriveMachineStatus, isValidPolicyName, FleetCheckin, FleetStatus, validateCheckin } from './schema';
import { evaluateAlerts, postWebhook } from './alerts';

export { isValidPolicyName } from './schema';

export const MAX_CHECKIN_BYTES = 256 * 1024;
/** Policy configs use the same cap as check-ins. */
export const MAX_POLICY_BYTES = MAX_CHECKIN_BYTES;
/** Default days without a backup before a machine reads as stale. */
export const DEFAULT_BACKUP_STALE_DAYS = 14;
/** Default interval for re-evaluating machines that stopped checking in. */
export const DEFAULT_ALERT_SWEEP_MS = 5 * 60_000;

export interface FleetStore {
  schema: number;
  machines: Record<string, { receivedAt: number; checkin: FleetCheckin; lastAlertedStatus?: FleetStatus }>;
}

export interface FleetServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  /** Bearer token for POST /api/checkin. Generated into the data dir when absent. */
  token?: string;
  staleDays?: number;
  /** Days without a backup before a machine reads as stale (0 disables, default 14). */
  backupStaleDays?: number;
  /**
   * Generic webhook (Slack/Discord/ntfy-style JSON POST) that receives an
   * alert whenever a machine becomes critical or stale — or recovers.
   */
  webhook?: string;
  /** How often machines are re-evaluated without a fresh check-in (default 5 min, 0 disables). */
  alertSweepMs?: number;
  /** Per-delivery webhook timeout (default 5 s). */
  webhookTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface FleetServer {
  url: string;
  host: string;
  port: number;
  token: string;
  /** Evaluate alert transitions now (also runs on every check-in and the sweep timer). */
  runAlerts(): Promise<void>;
  close(): Promise<void>;
}

function storePath(dataDir: string): string {
  return path.join(dataDir, 'checkins.json');
}

function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'server-token.txt');
}

export function policiesDir(dataDir: string): string {
  return path.join(dataDir, 'policies');
}

export function loadFleetStore(dataDir: string): FleetStore {
  try {
    const raw = fs.readFileSync(storePath(dataDir), 'utf-8');
    const parsed = JSON.parse(raw) as FleetStore;
    if (parsed && typeof parsed === 'object' && parsed.machines && typeof parsed.machines === 'object') {
      return { schema: 1, machines: parsed.machines };
    }
  } catch {
    /* first start or corrupt file: begin fresh rather than crash the server */
  }
  return { schema: 1, machines: {} };
}

function saveFleetStore(dataDir: string, store: FleetStore): void {
  const target = storePath(dataDir);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

export function loadOrCreateToken(dataDir: string, provided?: string): string {
  if (provided && provided.length > 0) return provided;
  try {
    const existing = fs.readFileSync(tokenPath(dataDir), 'utf-8').trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenPath(dataDir), `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  return token;
}

function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  // Compare digests so unequal lengths never leak through timingSafeEqual.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

/** Returns true when the request carries the valid bearer token; replies 401 otherwise. */
function requireToken(req: http.IncomingMessage, res: http.ServerResponse, expected: string): boolean {
  if (tokenMatches(expected, bearerToken(req))) return true;
  sendJson(res, 401, { error: 'missing or invalid bearer token' });
  return false;
}

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<JsonBodyResult> {
  let body: { overflow: boolean; buffer: Buffer | null };
  try {
    body = await readBody(req, maxBytes);
  } catch (error) {
    return { ok: false, status: 413, error: error instanceof Error ? error.message : 'body too large' };
  }
  if (body.overflow) {
    return { ok: false, status: 413, error: `body exceeds ${maxBytes} bytes` };
  }
  if (!body.buffer || body.buffer.length === 0) {
    return { ok: false, status: 400, error: 'empty body' };
  }
  try {
    return { ok: true, value: JSON.parse(body.buffer.toString('utf-8')) };
  } catch {
    return { ok: false, status: 400, error: 'body is not valid JSON' };
  }
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const custom = req.headers['x-opbs-token'];
  if (typeof custom === 'string') return custom;
  return undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * Reads the request body with a hard size cap. On overflow the rest of the
 * upload is drained (not buffered) so the client receives a clean 413 instead
 * of a reset connection; only a body beyond `hardLimit` is cut off.
 */
function readBody(
  req: http.IncomingMessage,
  limit: number,
  hardLimit = limit * 16
): Promise<{ overflow: boolean; buffer: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > hardLimit) {
        reject(new Error(`body exceeds ${hardLimit} bytes`));
        req.destroy();
        return;
      }
      if (overflow) return;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ overflow, buffer: overflow ? null : Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}

export interface FleetMachineView {
  machineId: string;
  hostname: string;
  receivedAt: number;
  status: FleetStatus;
  reasons: string[];
  checkin: FleetCheckin;
}

export interface FleetAggregate {
  generatedAt: number;
  staleDays: number;
  /** null when backup staleness checking is disabled. */
  backupStaleDays: number | null;
  machineCount: number;
  summary: { ok: number; warning: number; critical: number; stale: number };
  machines: FleetMachineView[];
}

export function aggregateFleet(
  store: FleetStore,
  opts: { staleDays: number; backupStaleDays?: number; now?: number }
): FleetAggregate {
  const now = opts.now ?? Date.now();
  const summary = { ok: 0, warning: 0, critical: 0, stale: 0 };
  const machines: FleetMachineView[] = [];
  for (const [machineId, entry] of Object.entries(store.machines)) {
    const { status, reasons } = deriveMachineStatus(entry.checkin, {
      receivedAt: entry.receivedAt,
      now,
      staleDays: opts.staleDays,
      backupStaleDays: opts.backupStaleDays
    });
    summary[status]++;
    machines.push({
      machineId,
      hostname: entry.checkin.hostname,
      receivedAt: entry.receivedAt,
      status,
      reasons,
      checkin: entry.checkin
    });
  }
  const order: Record<FleetStatus, number> = { critical: 0, stale: 1, warning: 2, ok: 3 };
  machines.sort((a, b) => order[a.status] - order[b.status] || a.hostname.localeCompare(b.hostname));
  return {
    generatedAt: now,
    staleDays: opts.staleDays,
    backupStaleDays: opts.backupStaleDays && opts.backupStaleDays > 0 ? opts.backupStaleDays : null,
    machineCount: machines.length,
    summary,
    machines
  };
}

export interface FleetPolicyList {
  policies: Array<{ name: string; config: unknown }>;
  invalid: Array<{ name: string; error: string }>;
}

/** Policies are plain job-config JSON files dropped into <dataDir>/policies/. */
export function listPolicies(dataDir: string): FleetPolicyList {
  const result: FleetPolicyList = { policies: [], invalid: [] };
  let entries: string[];
  try {
    entries = fs.readdirSync(policiesDir(dataDir));
  } catch {
    return result;
  }
  for (const name of entries.sort()) {
    if (!name.endsWith('.json') || !isValidPolicyName(name)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(policiesDir(dataDir), name), 'utf-8'));
      result.policies.push({ name, config });
    } catch (error) {
      result.invalid.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export async function startFleetServer(opts: FleetServerOptions): Promise<FleetServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8787;
  const staleDays = opts.staleDays ?? 7;
  const backupStaleDays = opts.backupStaleDays ?? DEFAULT_BACKUP_STALE_DAYS;
  const webhookTimeoutMs = opts.webhookTimeoutMs ?? 5_000;
  const log = opts.log ?? (() => undefined);
  const token = loadOrCreateToken(opts.dataDir, opts.token);
  const store = loadFleetStore(opts.dataDir);
  let fleetUrl = '';
  let alerting = false;

  /**
   * Evaluate alert transitions for every machine and deliver them. Reads the
   * store fresh from disk so time-based staleness and external edits count,
   * and only advances `lastAlertedStatus` after a successful POST so failed
   * deliveries retry on the next cycle. Re-entrancy is guarded: the sweep and
   * a burst of check-ins never run two deliveries at once.
   */
  async function runAlerts(): Promise<void> {
    if (!opts.webhook || alerting) return;
    alerting = true;
    try {
      const fresh = loadFleetStore(opts.dataDir);
      const candidates = evaluateAlerts(fresh, { staleDays, backupStaleDays, fleetUrl });
      for (const alert of candidates) {
        const delivered = await postWebhook(opts.webhook, alert.payload, { timeoutMs: webhookTimeoutMs });
        if (delivered) {
          // Synchronous read-modify-write: no other request can interleave
          // between load and save, so a concurrent check-in cannot be lost.
          const current = loadFleetStore(opts.dataDir);
          const entry = current.machines[alert.machineId];
          if (entry) {
            entry.lastAlertedStatus = alert.status;
            saveFleetStore(opts.dataDir, current);
          }
          const live = store.machines[alert.machineId];
          if (live) live.lastAlertedStatus = alert.status;
          log(`alert ${alert.kind}: ${alert.hostname} (${alert.machineId})`);
        } else {
          log(`alert delivery failed (${alert.kind}: ${alert.hostname}) — will retry`);
        }
      }
    } finally {
      alerting = false;
    }
  }

  const sweepMs = opts.alertSweepMs ?? DEFAULT_ALERT_SWEEP_MS;
  const sweep = opts.webhook && sweepMs > 0 ? setInterval(() => void runAlerts(), sweepMs) : undefined;
  sweep?.unref();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fleet.local');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    if (route === 'POST /api/checkin') {
      if (!requireToken(req, res, token)) return;
      const body = await readJsonBody(req, MAX_CHECKIN_BYTES);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const validation = validateCheckin(body.value);
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error });
        return;
      }
      const receivedAt = Date.now();
      const previous = store.machines[validation.checkin.machineId];
      store.machines[validation.checkin.machineId] = {
        receivedAt,
        checkin: validation.checkin,
        // Carry the alert marker across the overwrite so an unchanged bad
        // status does not re-alert on every check-in.
        ...(previous?.lastAlertedStatus ? { lastAlertedStatus: previous.lastAlertedStatus } : {})
      };
      saveFleetStore(opts.dataDir, store);
      log(
        `check-in: ${validation.checkin.hostname} (${validation.checkin.machineId}) — ` +
          `${validation.checkin.destinations.length} destination(s), ${validation.checkin.media.length} disk(s)`
      );
      await runAlerts();
      sendJson(res, 200, { ok: true, receivedAt });
      return;
    }

    if (route === 'GET /api/fleet') {
      sendJson(res, 200, aggregateFleet(store, { staleDays, backupStaleDays }));
      return;
    }

    if (route === 'GET /api/policy') {
      if (!requireToken(req, res, token)) return;
      sendJson(res, 200, listPolicies(opts.dataDir));
      return;
    }

    if ((req.method === 'PUT' || req.method === 'POST') && url.pathname.startsWith('/api/policy/')) {
      if (!requireToken(req, res, token)) return;
      const name = url.pathname.slice('/api/policy/'.length);
      if (!isValidPolicyName(name)) {
        sendJson(res, 400, { error: `invalid policy name "${name}" (expected <name>.json)` });
        return;
      }
      const body = await readJsonBody(req, MAX_POLICY_BYTES);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const dir = policiesDir(opts.dataDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), `${JSON.stringify(body.value, null, 2)}\n`, 'utf-8');
      log(`policy stored: ${name}`);
      sendJson(res, 200, { ok: true, name });
      return;
    }

    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FLEET_DASHBOARD_HTML);
      return;
    }

    if (route === 'GET /health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok\n');
      return;
    }

    const knownPath =
      url.pathname === '/api/checkin' ||
      url.pathname === '/api/fleet' ||
      url.pathname === '/api/policy' ||
      url.pathname.startsWith('/api/policy/') ||
      url.pathname === '/health' ||
      url.pathname === '/' ||
      url.pathname === '/index.html';
    sendJson(res, knownPath ? 405 : 404, { error: knownPath ? 'method not allowed' : 'not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${address.port}`;
  fleetUrl = url;

  return {
    url,
    host,
    port: address.port,
    token,
    runAlerts,
    close: () =>
      new Promise<void>((resolve) => {
        if (sweep) clearInterval(sweep);
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
