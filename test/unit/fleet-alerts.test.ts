import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { alertTransition, evaluateAlerts, postWebhook, WebhookPayload } from '../../src/main/fleet/alerts';
import { FLEET_SCHEMA_VERSION, FleetCheckin, FleetDestinationReport } from '../../src/main/fleet/schema';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function destination(overrides: Partial<FleetDestinationReport> = {}): FleetDestinationReport {
  return {
    directory: 'D:\\OPBS',
    exists: true,
    imageCount: 3,
    chainCount: 3,
    completeChains: 3,
    brokenChains: 0,
    unparseableImages: 0,
    lastBackupAt: NOW - 60 * 60 * 1000,
    lastBackupImage: 'img.opbs',
    lastBackupBytes: 1024,
    lastBackupIncremental: true,
    anomalyOk: true,
    criticalAnomalies: 0,
    warningAnomalies: 0,
    drillTotal: 1,
    drillFailed: 0,
    drillLastAt: NOW - 2 * DAY_MS,
    drillLastOk: true,
    ...overrides
  };
}

function checkinDoc(overrides: Partial<FleetCheckin> = {}): FleetCheckin {
  return {
    schema: FLEET_SCHEMA_VERSION,
    machineId: 'm1',
    hostname: 'WORKSTATION-01',
    os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
    appVersion: '0.6.70',
    sentAt: NOW - 1000,
    destinations: [destination()],
    media: [],
    ...overrides
  };
}

describe('alertTransition', () => {
  it('alerts when a machine becomes critical or stale', () => {
    expect(alertTransition(undefined, 'critical')).toBe('critical');
    expect(alertTransition('ok', 'critical')).toBe('critical');
    expect(alertTransition('warning', 'critical')).toBe('critical');
    expect(alertTransition('ok', 'stale')).toBe('stale');
    expect(alertTransition('critical', 'stale')).toBe('stale'); // bad state changed materially
  });

  it('never repeats the same bad state', () => {
    expect(alertTransition('critical', 'critical')).toBeNull();
    expect(alertTransition('stale', 'stale')).toBeNull();
    expect(alertTransition(undefined, 'ok')).toBeNull();
    expect(alertTransition(undefined, 'warning')).toBeNull();
    expect(alertTransition('ok', 'warning')).toBeNull();
    expect(alertTransition('ok', 'ok')).toBeNull();
  });

  it('sends a recovery only after a previously alerted bad state', () => {
    expect(alertTransition('critical', 'ok')).toBe('recovery');
    expect(alertTransition('stale', 'ok')).toBe('recovery');
    expect(alertTransition('critical', 'warning')).toBe('recovery');
    expect(alertTransition('stale', 'warning')).toBe('recovery');
    expect(alertTransition('warning', 'ok')).toBeNull(); // never alerted on warning
    expect(alertTransition(undefined, 'ok')).toBeNull();
  });
});

describe('evaluateAlerts', () => {
  const base = { staleDays: 7, now: NOW, fleetUrl: 'http://central:8787' };

  it('is silent for a healthy fleet', () => {
    const store = { machines: { m1: { receivedAt: NOW - 1000, checkin: checkinDoc() } } };
    expect(evaluateAlerts(store, base)).toEqual([]);
  });

  it('builds a critical alert with reasons and a human text line', () => {
    const store = {
      machines: {
        m1: {
          receivedAt: NOW - 1000,
          checkin: checkinDoc({ destinations: [destination({ brokenChains: 1 })] })
        }
      }
    };
    const [alert] = evaluateAlerts(store, base);
    expect(alert.machineId).toBe('m1');
    expect(alert.kind).toBe('critical');
    expect(alert.status).toBe('critical');
    expect(alert.previousStatus).toBeNull();
    expect(alert.reasons.some((r) => r.includes('broken restore chain'))).toBe(true);

    const p = alert.payload as WebhookPayload;
    expect(p.event).toBe('status-change');
    expect(p.kind).toBe('critical');
    expect(p.hostname).toBe('WORKSTATION-01');
    expect(p.appVersion).toBe('0.6.70');
    expect(p.fleetUrl).toBe('http://central:8787');
    expect(p.at).toBe(NOW);
    expect(p.content).toBe(p.text);
    expect(p.text).toContain('WORKSTATION-01 is critical');
    expect(p.text).toContain('broken restore chain');
    expect(p.text).toContain('http://central:8787');
  });

  it('does not repeat an already-alerted state and does not mutate the store', () => {
    const store = {
      machines: {
        m1: {
          receivedAt: NOW - 1000,
          checkin: checkinDoc({ destinations: [destination({ brokenChains: 1 })] }),
          lastAlertedStatus: 'critical' as const
        }
      }
    };
    const snapshot = JSON.parse(JSON.stringify(store));
    expect(evaluateAlerts(store, base)).toEqual([]);
    expect(store).toEqual(snapshot);
  });

  it('flags a machine that stopped checking in as stale (time-based)', () => {
    const store = { machines: { m1: { receivedAt: NOW - 10 * DAY_MS, checkin: checkinDoc() } } };
    const [alert] = evaluateAlerts(store, base);
    expect(alert.kind).toBe('stale');
    expect(alert.reasons.some((r) => r.includes('no check-in'))).toBe(true);
    expect(alert.payload.text).toContain('WORKSTATION-01 is stale');
  });

  it('flags backups that aged past the threshold as stale', () => {
    const store = {
      machines: {
        m1: {
          receivedAt: NOW - 1000,
          checkin: checkinDoc({ destinations: [destination({ lastBackupAt: NOW - 30 * DAY_MS })] })
        }
      }
    };
    const [alert] = evaluateAlerts(store, { ...base, backupStaleDays: 14 });
    expect(alert.kind).toBe('stale');
    expect(alert.reasons.some((r) => r.includes('last backup 30 day'))).toBe(true);
  });

  it('recovers a machine that came back healthy', () => {
    const store = {
      machines: { m1: { receivedAt: NOW - 1000, checkin: checkinDoc(), lastAlertedStatus: 'stale' as const } }
    };
    const [alert] = evaluateAlerts(store, base);
    expect(alert.kind).toBe('recovery');
    expect(alert.status).toBe('ok');
    expect(alert.previousStatus).toBe('stale');
    expect(alert.payload.text).toContain('recovered (now ok)');
  });
});

describe('postWebhook', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    );
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  const payload: WebhookPayload = {
    event: 'status-change',
    kind: 'critical',
    status: 'critical',
    previousStatus: null,
    hostname: 'HOST',
    machineId: 'm1',
    appVersion: '0.6.70',
    reasons: ['bad chains'],
    fleetUrl: 'http://central:8787',
    at: NOW,
    text: 'OPBS fleet: HOST is critical',
    content: 'OPBS fleet: HOST is critical'
  };

  it('returns true on 2xx and delivers the JSON payload', async () => {
    let received: { body: string; contentType: unknown } | undefined;
    const url = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = { body: Buffer.concat(chunks).toString('utf-8'), contentType: req.headers['content-type'] };
        res.writeHead(204);
        res.end();
      });
    });
    expect(await postWebhook(url, payload, { timeoutMs: 2000 })).toBe(true);
    expect(received?.contentType).toContain('application/json');
    expect(JSON.parse(received!.body)).toEqual(payload);
  });

  it('returns false on a non-2xx reply', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    expect(await postWebhook(url, payload, { timeoutMs: 2000 })).toBe(false);
  });

  it('returns false when the receiver hangs past the timeout', async () => {
    const url = await listen(() => {
      /* never respond */
    });
    expect(await postWebhook(url, payload, { timeoutMs: 80 })).toBe(false);
  });

  it('returns false when nothing is listening', async () => {
    const url = await listen((_req, res) => res.end());
    // Grab a port that is now guaranteed closed.
    const closed = url;
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await postWebhook(closed, payload, { timeoutMs: 500 })).toBe(false);
  });
});
