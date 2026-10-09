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
import { deriveMachineStatus, FleetCheckin, FleetStatus, validateCheckin } from './schema';

export const MAX_CHECKIN_BYTES = 256 * 1024;

export interface FleetStore {
  schema: number;
  machines: Record<string, { receivedAt: number; checkin: FleetCheckin }>;
}

export interface FleetServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  /** Bearer token for POST /api/checkin. Generated into the data dir when absent. */
  token?: string;
  staleDays?: number;
  log?: (line: string) => void;
}

export interface FleetServer {
  url: string;
  host: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function storePath(dataDir: string): string {
  return path.join(dataDir, 'checkins.json');
}

function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'server-token.txt');
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
  machineCount: number;
  summary: { ok: number; warning: number; critical: number; stale: number };
  machines: FleetMachineView[];
}

export function aggregateFleet(store: FleetStore, opts: { staleDays: number; now?: number }): FleetAggregate {
  const now = opts.now ?? Date.now();
  const summary = { ok: 0, warning: 0, critical: 0, stale: 0 };
  const machines: FleetMachineView[] = [];
  for (const [machineId, entry] of Object.entries(store.machines)) {
    const { status, reasons } = deriveMachineStatus(entry.checkin, {
      receivedAt: entry.receivedAt,
      now,
      staleDays: opts.staleDays
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
  return { generatedAt: now, staleDays: opts.staleDays, machineCount: machines.length, summary, machines };
}

export async function startFleetServer(opts: FleetServerOptions): Promise<FleetServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8787;
  const staleDays = opts.staleDays ?? 7;
  const log = opts.log ?? (() => undefined);
  const token = loadOrCreateToken(opts.dataDir, opts.token);
  const store = loadFleetStore(opts.dataDir);

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
      if (!tokenMatches(token, bearerToken(req))) {
        sendJson(res, 401, { error: 'missing or invalid bearer token' });
        return;
      }
      let body: { overflow: boolean; buffer: Buffer | null };
      try {
        body = await readBody(req, MAX_CHECKIN_BYTES);
      } catch (error) {
        sendJson(res, 413, { error: error instanceof Error ? error.message : 'body too large' });
        return;
      }
      if (body.overflow) {
        sendJson(res, 413, { error: `body exceeds ${MAX_CHECKIN_BYTES} bytes` });
        return;
      }
      if (!body.buffer || body.buffer.length === 0) {
        sendJson(res, 400, { error: 'empty body' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.buffer.toString('utf-8'));
      } catch {
        sendJson(res, 400, { error: 'body is not valid JSON' });
        return;
      }
      const validation = validateCheckin(parsed);
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error });
        return;
      }
      const receivedAt = Date.now();
      store.machines[validation.checkin.machineId] = { receivedAt, checkin: validation.checkin };
      saveFleetStore(opts.dataDir, store);
      log(
        `check-in: ${validation.checkin.hostname} (${validation.checkin.machineId}) — ` +
          `${validation.checkin.destinations.length} destination(s), ${validation.checkin.media.length} disk(s)`
      );
      sendJson(res, 200, { ok: true, receivedAt });
      return;
    }

    if (route === 'GET /api/fleet') {
      sendJson(res, 200, aggregateFleet(store, { staleDays }));
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

    const allowed = ['GET', 'POST'].includes(req.method ?? '');
    sendJson(res, allowed ? 404 : 405, { error: allowed ? 'not found' : 'method not allowed' });
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

  return {
    url,
    host,
    port: address.port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
