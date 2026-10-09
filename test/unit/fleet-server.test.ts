import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import {
  startFleetServer,
  loadFleetStore,
  loadOrCreateToken,
  aggregateFleet,
  isValidPolicyName,
  listPolicies,
  policiesDir,
  FleetServer,
  FleetStore,
  MAX_CHECKIN_BYTES
} from '../../src/main/fleet/server';
import { sendCheckin, fetchFleet, pullPolicies, pushPolicy } from '../../src/main/fleet/client';
import { FLEET_SCHEMA_VERSION, fleetMachineId, FleetCheckin, FleetDestinationReport } from '../../src/main/fleet/schema';
import { FLEET_DASHBOARD_HTML } from '../../src/main/fleet/dashboard';

function destination(overrides: Partial<FleetDestinationReport> = {}): FleetDestinationReport {
  return {
    directory: 'D:\\backups',
    exists: true,
    imageCount: 2,
    chainCount: 1,
    completeChains: 1,
    brokenChains: 0,
    unparseableImages: 0,
    lastBackupAt: Date.now() - 60 * 60 * 1000,
    lastBackupImage: 'D:\\backups\\pc.opbs',
    lastBackupBytes: 5000,
    lastBackupIncremental: false,
    anomalyOk: true,
    criticalAnomalies: 0,
    warningAnomalies: 0,
    drillTotal: 1,
    drillFailed: 0,
    drillLastAt: Date.now() - 60 * 60 * 1000,
    drillLastOk: true,
    ...overrides
  };
}

function makeCheckin(overrides: Partial<FleetCheckin> = {}): FleetCheckin {
  return {
    schema: FLEET_SCHEMA_VERSION,
    machineId: fleetMachineId('PC-A', 'x64'),
    hostname: 'PC-A',
    os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
    appVersion: '0.6.67',
    sentAt: Date.now(),
    destinations: [destination()],
    media: [],
    ...overrides
  };
}

async function postCheckin(server: FleetServer, body: string, token?: string): Promise<Response> {
  return fetch(`${server.url}/api/checkin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {})
    },
    body
  });
}

describe('fleet server', () => {
  const dataDirs: string[] = [];
  const servers: FleetServer[] = [];

  async function start(overrides: Partial<Parameters<typeof startFleetServer>[0]> = {}): Promise<FleetServer> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-data-'));
    dataDirs.push(dataDir);
    const server = await startFleetServer({ dataDir, port: 0, ...overrides });
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    for (const dir of dataDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects check-ins without or with the wrong token', async () => {
    const server = await start();
    expect((await postCheckin(server, JSON.stringify(makeCheckin()))).status).toBe(401);
    expect((await postCheckin(server, JSON.stringify(makeCheckin()), 'wrong')).status).toBe(401);
    const ok = await postCheckin(server, JSON.stringify(makeCheckin()), server.token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it('accepts the X-OPBS-Token header too', async () => {
    const server = await start();
    const response = await fetch(`${server.url}/api/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opbs-token': server.token },
      body: JSON.stringify(makeCheckin())
    });
    expect(response.status).toBe(200);
  });

  it('rejects malformed bodies with 400s', async () => {
    const server = await start();
    expect((await postCheckin(server, 'not json', server.token)).status).toBe(400);
    expect((await postCheckin(server, '', server.token)).status).toBe(400);
    const wrongSchema = await postCheckin(server, JSON.stringify({ ...makeCheckin(), schema: 99 }), server.token);
    expect(wrongSchema.status).toBe(400);
    expect(((await wrongSchema.json()) as { error: string }).error).toMatch(/unsupported schema version/);
    const junk = await postCheckin(server, JSON.stringify({ machineId: 'x' }), server.token);
    expect(junk.status).toBe(400);
  });

  it('rejects oversized bodies with 413', async () => {
    const server = await start();
    const padded = JSON.stringify({ ...makeCheckin(), padding: 'x'.repeat(MAX_CHECKIN_BYTES) });
    expect((await postCheckin(server, padded, server.token)).status).toBe(413);
  });

  it('stores check-ins and aggregates them for /api/fleet', async () => {
    const server = await start();
    await postCheckin(server, JSON.stringify(makeCheckin()), server.token);
    await postCheckin(
      server,
      JSON.stringify(
        makeCheckin({
          machineId: fleetMachineId('PC-B', 'x64'),
          hostname: 'PC-B',
          destinations: [destination({ brokenChains: 2 })]
        })
      ),
      server.token
    );

    const fleet = await fetchFleet({ server: server.url });
    expect(fleet.machineCount).toBe(2);
    expect(fleet.summary.critical).toBe(1);
    expect(fleet.summary.ok).toBe(1);
    const byHost = new Map(fleet.machines.map((m) => [m.hostname, m]));
    expect(byHost.get('PC-A')?.status).toBe('ok');
    expect(byHost.get('PC-B')?.status).toBe('critical');
    expect(byHost.get('PC-B')?.reasons.some((r) => /broken restore chain/.test(r))).toBe(true);
    expect(byHost.get('PC-B')?.checkin.hostname).toBe('PC-B');
  });

  it('keeps only the newest check-in per machine', async () => {
    const server = await start();
    await postCheckin(server, JSON.stringify(makeCheckin({ appVersion: '0.6.66' })), server.token);
    await postCheckin(server, JSON.stringify(makeCheckin({ appVersion: '0.6.67' })), server.token);
    const fleet = await fetchFleet({ server: server.url });
    expect(fleet.machineCount).toBe(1);
    expect(fleet.machines[0].checkin.appVersion).toBe('0.6.67');
  });

  it('persists to disk and reuses the generated token across restarts', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-persist-'));
    dataDirs.push(dataDir);
    const first = await startFleetServer({ dataDir, port: 0 });
    servers.push(first);
    await postCheckin(first, JSON.stringify(makeCheckin()), first.token);
    const tokenFile = path.join(dataDir, 'server-token.txt');
    expect(fs.existsSync(tokenFile)).toBe(true);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const store = loadFleetStore(dataDir);
    expect(Object.keys(store.machines)).toHaveLength(1);

    const second = await startFleetServer({ dataDir, port: 0 });
    servers.push(second);
    expect(second.token).toBe(first.token);
    const fleet = await fetchFleet({ server: second.url });
    expect(fleet.machineCount).toBe(1);
    expect(fleet.machines[0].hostname).toBe('PC-A');
  });

  it('serves the dashboard and health endpoint', async () => {
    const server = await start();
    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toBe(FLEET_DASHBOARD_HTML);
    expect(html).toContain('OPBS Fleet');
    expect(html).toContain('/api/fleet');
    expect(html).toContain('<th>Policies</th>');

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok\n');
  });

  it('answers 404 for unknown routes and 405 for bad methods', async () => {
    const server = await start();
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/fleet`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(`${server.url}/api/checkin`, { method: 'PUT' })).status).toBe(405);
  });
});

describe('fleet client', () => {
  const dataDirs: string[] = [];
  const servers: FleetServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    for (const dir of dataDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a check-in through sendCheckin', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-client-'));
    dataDirs.push(dataDir);
    const server = await startFleetServer({ dataDir, port: 0 });
    servers.push(server);

    const result = await sendCheckin(makeCheckin(), { server: server.url, token: server.token });
    expect(result).toEqual({ ok: true, status: 200 });

    const wrong = await sendCheckin(makeCheckin(), { server: server.url, token: 'nope' });
    expect(wrong.ok).toBe(false);
    expect(wrong.status).toBe(401);
    expect(wrong.error).toMatch(/401/);
  });

  it('fails cleanly against a dead server and a bad URL', async () => {
    const dead = await sendCheckin(makeCheckin(), {
      server: 'http://127.0.0.1:1',
      token: 't',
      timeoutMs: 2000
    });
    expect(dead.ok).toBe(false);
    expect(dead.status).toBe(0);

    await expect(sendCheckin(makeCheckin(), { server: 'ftp://x', token: 't' })).rejects.toThrow(/http/);
  });

  it('refuses to send an invalid check-in locally', async () => {
    const result = await sendCheckin({ schema: 99 } as unknown as FleetCheckin, {
      server: 'http://127.0.0.1:1',
      token: 't'
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid check-in/);
  });
});

describe('aggregateFleet', () => {
  function store(receivedAt: number, overrides: Partial<FleetCheckin> = {}): FleetStore {
    const checkin = makeCheckin(overrides);
    return { schema: 1, machines: { [checkin.machineId]: { receivedAt, checkin } } };
  }

  it('marks machines stale past the threshold and counts statuses', () => {
    const now = 1_700_000_000_000;
    const fleetStore: FleetStore = {
      schema: 1,
      machines: {
        fresh: { receivedAt: now - 1000, checkin: makeCheckin({ machineId: 'fresh', hostname: 'fresh' }) },
        old: { receivedAt: now - 10 * 24 * 60 * 60 * 1000, checkin: makeCheckin({ machineId: 'old', hostname: 'old' }) },
        broken: {
          receivedAt: now - 1000,
          checkin: makeCheckin({ machineId: 'broken', hostname: 'broken', destinations: [destination({ brokenChains: 1 })] })
        }
      }
    };
    const fleet = aggregateFleet(fleetStore, { staleDays: 7, now });
    expect(fleet.summary).toEqual({ ok: 1, warning: 0, critical: 1, stale: 1 });
    expect(fleet.machines[0].status).toBe('critical');
    expect(fleet.machines[1].status).toBe('stale');
    expect(fleet.machines[2].status).toBe('ok');
    expect(fleet.backupStaleDays).toBeNull();
  });

  it('stales machines whose backups stopped, with the reason', () => {
    const now = 1_700_000_000_000;
    const fleetStore: FleetStore = {
      schema: 1,
      machines: {
        staleBackup: {
          receivedAt: now - 1000,
          checkin: makeCheckin({
            machineId: 'staleBackup',
            hostname: 'staleBackup',
            destinations: [destination({ lastBackupAt: now - 30 * 24 * 60 * 60 * 1000 })]
          })
        }
      }
    };
    const fleet = aggregateFleet(fleetStore, { staleDays: 7, backupStaleDays: 14, now });
    expect(fleet.backupStaleDays).toBe(14);
    expect(fleet.machines[0].status).toBe('stale');
    expect(fleet.machines[0].reasons.some((r) => /last backup 30 day/.test(r))).toBe(true);
  });

  it('returns an empty aggregate for a fresh store', () => {
    const fleet = aggregateFleet({ schema: 1, machines: {} }, { staleDays: 7 });
    expect(fleet.machineCount).toBe(0);
    expect(fleet.summary).toEqual({ ok: 0, warning: 0, critical: 0, stale: 0 });
    expect(fleet.backupStaleDays).toBeNull();
  });

  it('surfaces failed policy applies as a warning with the reason', () => {
    const now = 1_700_000_000_000;
    const fleetStore: FleetStore = {
      schema: 1,
      machines: {
        p: {
          receivedAt: now - 1000,
          checkin: makeCheckin({
            machineId: 'p',
            hostname: 'policy-host',
            policies: [{ name: 'nightly.json', status: 'failed', reason: 'schtasks exit 1' }]
          })
        }
      }
    };
    const fleet = aggregateFleet(fleetStore, { staleDays: 7, now });
    expect(fleet.summary.warning).toBe(1);
    expect(fleet.machines[0].status).toBe('warning');
    expect(fleet.machines[0].reasons).toContain('policy nightly.json failed: schtasks exit 1');
    expect(fleet.machines[0].checkin.policies).toHaveLength(1);
  });
});

describe('fleet policy API', () => {
  const dataDirs: string[] = [];
  const servers: FleetServer[] = [];
  const dataDirOf = new Map<FleetServer, string>();

  async function start(overrides: Partial<Parameters<typeof startFleetServer>[0]> = {}): Promise<FleetServer> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-policy-'));
    dataDirs.push(dataDir);
    const server = await startFleetServer({ dataDir, port: 0, ...overrides });
    servers.push(server);
    dataDirOf.set(server, dataDir);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    dataDirOf.clear();
    for (const dir of dataDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts only boring <name>.json policy names', () => {
    expect(isValidPolicyName('nightly-backup.json')).toBe(true);
    expect(isValidPolicyName('a.b_c-2.json')).toBe(true);
    expect(isValidPolicyName('../evil.json')).toBe(false);
    expect(isValidPolicyName('a/b.json')).toBe(false);
    expect(isValidPolicyName('.hidden.json')).toBe(false);
    expect(isValidPolicyName('evil.exe')).toBe(false);
    expect(isValidPolicyName('no-extension')).toBe(false);
    expect(isValidPolicyName('%2e%2e/x.json')).toBe(false);
    expect(isValidPolicyName(`${'x'.repeat(80)}.json`)).toBe(false);
  });

  it('requires the token for list and push', async () => {
    const server = await start();
    expect((await fetch(`${server.url}/api/policy`)).status).toBe(401);
    expect(
      (
        await fetch(`${server.url}/api/policy/x.json`, {
          method: 'PUT',
          body: JSON.stringify({ name: 'x' })
        })
      ).status
    ).toBe(401);
  });

  it('round-trips a policy push through to the pull', async () => {
    const server = await start();
    const config = { name: 'nightly', partitions: ['0'], destination: 'D:\\\\backups' };
    const pushed = await pushPolicy({ server: server.url, token: server.token }, 'nightly.json', config);
    expect(pushed).toEqual({ ok: true, name: 'nightly.json' });

    const listed = await pullPolicies({ server: server.url, token: server.token });
    expect(listed.invalid).toEqual([]);
    expect(listed.policies).toHaveLength(1);
    expect(listed.policies[0]).toEqual({ name: 'nightly.json', config });

    // Stored as a plain file on disk, readable without the server.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(policiesDir(dataDirOf.get(server)!), 'nightly.json'), 'utf-8')
    );
    expect(onDisk).toEqual(config);
  });

  it('rejects traversal names, wrong extensions and non-JSON bodies', async () => {
    const server = await start();
    const put = (name: string, body: string) =>
      fetch(`${server.url}/api/policy/${name}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${server.token}` },
        body
      });
    expect((await put('../evil.json', JSON.stringify({}))).status).toBe(404); // URL-normalized away
    expect((await put('..%2Fevil.json', JSON.stringify({}))).status).toBe(400); // reaches the handler
    expect((await put('evil.exe', JSON.stringify({}))).status).toBe(400);
    expect((await put('ok.json', 'not json')).status).toBe(400);
    const real = await put('ok.json', JSON.stringify({ a: 1 }));
    expect(real.status).toBe(200);
  });

  it('lists unreadable policy files as invalid instead of failing', async () => {
    const server = await start();
    const dataDir = dataDirOf.get(server)!;
    fs.mkdirSync(policiesDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(policiesDir(dataDir), 'broken.json'), '{ nope');
    const listed = await pullPolicies({ server: server.url, token: server.token });
    expect(listed.policies).toEqual([]);
    expect(listed.invalid).toHaveLength(1);
    expect(listed.invalid[0].name).toBe('broken.json');
    expect(listPolicies(dataDir).invalid).toHaveLength(1);
  });

  it('exposes the backup-staleness threshold on /api/fleet', async () => {
    const server = await start({ backupStaleDays: 5 });
    const fleet = await fetchFleet({ server: server.url });
    expect(fleet.backupStaleDays).toBe(5);
    expect(fleet.staleDays).toBe(7);
  });
});

describe('fleet webhook alerts', () => {
  const dataDirs: string[] = [];
  const servers: FleetServer[] = [];
  const collectors: http.Server[] = [];

  interface Collector {
    url: string;
    payloads: Array<Record<string, unknown>>;
  }

  async function collector(): Promise<Collector> {
    const payloads: Array<Record<string, unknown>> = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          /* ignore malformed probes */
        }
        res.writeHead(204);
        res.end();
      });
    });
    collectors.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, payloads };
  }

  async function start(overrides: Partial<Parameters<typeof startFleetServer>[0]> = {}): Promise<{
    server: FleetServer;
    dataDir: string;
  }> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-alerts-'));
    dataDirs.push(dataDir);
    const server = await startFleetServer({ dataDir, port: 0, ...overrides });
    servers.push(server);
    return { server, dataDir };
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    for (const srv of collectors.splice(0)) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    for (const dir of dataDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('alerts on a critical check-in, stays quiet while unchanged, then recovers', async () => {
    const hook = await collector();
    const { server, dataDir } = await start({ webhook: hook.url, alertSweepMs: 0 });
    const machineId = fleetMachineId('ALERT-PC', 'x64');

    const broken = makeCheckin({
      machineId,
      hostname: 'ALERT-PC',
      destinations: [destination({ brokenChains: 1 })]
    });
    expect((await sendCheckin(broken, { server: server.url, token: server.token })).ok).toBe(true);
    expect(hook.payloads).toHaveLength(1);
    expect(hook.payloads[0]).toMatchObject({
      event: 'status-change',
      kind: 'critical',
      status: 'critical',
      hostname: 'ALERT-PC',
      machineId
    });
    expect(String(hook.payloads[0].text)).toContain('broken restore chain');
    expect(loadFleetStore(dataDir).machines[machineId].lastAlertedStatus).toBe('critical');

    // Same bad state again → no repeat alert.
    expect((await sendCheckin(broken, { server: server.url, token: server.token })).ok).toBe(true);
    expect(hook.payloads).toHaveLength(1);

    // Fixed and healthy → recovery event, marker advanced.
    const healthy = makeCheckin({ machineId, hostname: 'ALERT-PC' });
    expect((await sendCheckin(healthy, { server: server.url, token: server.token })).ok).toBe(true);
    expect(hook.payloads).toHaveLength(2);
    expect(hook.payloads[1]).toMatchObject({ kind: 'recovery', status: 'ok', previousStatus: 'critical' });
    expect(loadFleetStore(dataDir).machines[machineId].lastAlertedStatus).toBe('ok');
  });

  it('does not mark delivery when the webhook is unreachable (retries later)', async () => {
    const hook = await collector();
    // Shut the collector down so its port refuses connections.
    const srv = collectors.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    const { server, dataDir } = await start({ webhook: hook.url, alertSweepMs: 0 });
    const machineId = fleetMachineId('DEAD-HOOK', 'x64');

    const broken = makeCheckin({ machineId, hostname: 'DEAD-HOOK', destinations: [destination({ brokenChains: 1 })] });
    expect((await sendCheckin(broken, { server: server.url, token: server.token })).ok).toBe(true);
    // The check-in is accepted, but the failed webhook leaves the marker unset
    // so the next cycle retries the alert.
    expect(loadFleetStore(dataDir).machines[machineId].lastAlertedStatus).toBeUndefined();
  });

  it('sweep catches a machine that silently stopped checking in', async () => {
    const hook = await collector();
    const { server, dataDir } = await start({ webhook: hook.url, alertSweepMs: 50 });
    const machineId = fleetMachineId('SILENT-PC', 'x64');

    // Simulate ten days of silence: write the store directly with an old
    // receivedAt — the sweep re-reads the store, exactly like production time
    // passing would.
    fs.writeFileSync(
      path.join(dataDir, 'checkins.json'),
      JSON.stringify(
        { schema: 1, machines: { [machineId]: { receivedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, checkin: makeCheckin({ machineId, hostname: 'SILENT-PC' }) } } },
        null,
        2
      ),
      'utf-8'
    );

    const deadline = Date.now() + 4000;
    while (hook.payloads.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(hook.payloads).toHaveLength(1);
    expect(hook.payloads[0]).toMatchObject({ kind: 'stale', status: 'stale', hostname: 'SILENT-PC' });
    expect(String(hook.payloads[0].text)).toContain('no check-in');
    expect(loadFleetStore(dataDir).machines[machineId].lastAlertedStatus).toBe('stale');
  });
});

describe('fleet store helpers', () => {
  it('loadOrCreateToken generates once and reuses', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-token-'));
    try {
      const first = loadOrCreateToken(dataDir);
      expect(first.length).toBeGreaterThan(20);
      expect(loadOrCreateToken(dataDir)).toBe(first);
      expect(loadOrCreateToken(dataDir, 'explicit')).toBe('explicit');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loadFleetStore survives a corrupt file', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-fleet-corrupt-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'checkins.json'), '{ nope');
      expect(loadFleetStore(dataDir)).toEqual({ schema: 1, machines: {} });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
