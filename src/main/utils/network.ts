import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

const NET_CMD = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'net.exe')
  : 'net';
const DISCOVER_TIMEOUT_MS = 4000;
const ADMIN_SHARES = ['C$', 'D$', 'ADMIN$'];

export interface DiscoveredMachine {
  name: string;
  addresses: string[];
  /** mDNS service types seen (e.g. '_smb._tcp'). */
  services: string[];
}

export interface ShareInfo {
  unc: string;
  name: string;
  kind: 'share' | 'admin';
  reachable: boolean;
  writable: boolean;
  remark?: string;
}

export interface NetworkDestination {
  path: string;
  ok: boolean;
  reachable?: boolean;
  writable?: boolean;
  created?: boolean;
  error?: string;
}

function runNet(args: string[], timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(NET_CMD, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Discover machines able to share files on the local network. */
export async function discoverNetworkMachines(): Promise<DiscoveredMachine[]> {
  const hosts = new Map<string, DiscoveredMachine>();
  const add = (name: string, address: string | undefined, service: string) => {
    const key = name.trim().toUpperCase();
    if (!key) return;
    let m = hosts.get(key);
    if (!m) {
      m = { name: name.trim(), addresses: [], services: [] };
      hosts.set(key, m);
    }
    if (address && !m.addresses.includes(address)) m.addresses.push(address);
    if (service && !m.services.includes(service)) m.services.push(service);
  };

  await discoverMdns(add).catch((err) => logger.warn('mDNS discovery failed', err));
  await discoverNetView(add, hosts);

  // Always include the local machine (allows backing up the same machine's
  // other drives over the network without it being discoverable via mDNS).
  const self = os.hostname();
  if (self && !hosts.has(self.toUpperCase())) {
    add(self, undefined, '_local._tcp');
  }

  return [...hosts.values()];
}

function discoverMdns(
  add: (name: string, address: string | undefined, service: string) => void
): Promise<void> {
  return new Promise((resolve) => {
    let bonjourMod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      bonjourMod = require('bonjour-service');
    } catch {
      resolve();
      return;
    }
    let b: any = null;
    try {
      b = new bonjourMod.Bonjour();
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      teardown();
      resolve();
    }, DISCOVER_TIMEOUT_MS);

    const teardown = () => {
      clearTimeout(timer);
      try {
        b.destroy();
      } catch {
        // already destroyed
      }
    };

    const onUp = (srv: any) => {
      if (!srv) return;
      const svcType = typeof srv.type === 'object' ? srv.type.name : srv.type;
      add(srv.name ?? srv.host, srv.referer?.address, svcType ? `_${svcType}._tcp` : '_smb._tcp');
    };

    for (const type of ['smb', 'workstation', 'device-info']) {
      try {
        const browser: any = b.find({ type });
        browser.on('up', onUp);
        browser.on('error', () => {
          // ignore individual browse errors; timer handles completion
        });
      } catch {
        // ignore
      }
    }
  });
}

function parseHosts(stdout: string, add: (name: string, address: string | undefined, service: string) => void): void {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*\\\\?([^\s]+)/);
    if (m) add(m[1], undefined, '_netbios._tcp');
  }
}

async function discoverNetView(
  add: (name: string, address: string | undefined, service: string) => void,
  hosts: Map<string, DiscoveredMachine>
): Promise<void> {
  const r = await runNet(['view', '/all'], 15000);
  if (r.code === 0 && r.stdout) parseHosts(r.stdout, add);

  // Also probe workgroups/domains for the machine's own browsable peers.
  const dom = await runNet(['view', '/domain'], 15000);
  if (dom.code === 0 && dom.stdout) parseHosts(dom.stdout, add);
}

/** List SMB shares on a remote host, plus a reachability probe of standard admin shares. */
export async function enumerateShares(host: string): Promise<ShareInfo[]> {
  const shares: ShareInfo[] = [];
  const name = host.replace(/^\\\\+/, '').replace(/[\\/]/g, '').split('.')[0];
  if (!name) return shares;

  const r = await runNet(['view', `\\\\${name}`], 15000);
  if (r.code === 0) {
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(\S+)\s+(Disk|Print)\s+(\S+)\s*(.*)/i);
      if (m && !shares.some((s) => s.name.toLowerCase() === m[1].toLowerCase())) {
        shares.push({
          unc: `\\\\${name}\\${m[1]}`,
          name: m[1],
          kind: 'share',
          reachable: false,
          writable: false,
          remark: m[4] || undefined
        });
      }
    }
  }

  for (const share of ADMIN_SHARES) {
    const unc = `\\\\${name}\\${share}`;
    const { reachable, writable } = probeUnc(unc);
    shares.push({ unc, name: share, kind: 'admin', reachable, writable });
  }

  return shares;
}

function probeUnc(unc: string): { reachable: boolean; writable: boolean } {
  let reachable = false;
  let writable = false;
  try {
    fs.readdirSync(unc, { withFileTypes: true });
    reachable = true;
  } catch {
    // not reachable
  }
  const dir = path.join(unc, '.opbs-probe');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, 'w');
    fs.writeFileSync(probe, new Date().toISOString());
    fs.rmSync(probe, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    writable = true;
  } catch {
    // not writable
  }
  return { reachable, writable };
}

/**
 * Validate (and optionally create) a backup destination on a network share.
 * The destination may be a UNC path or smb:// URI (normalised to UNC).
 */
export function testNetworkDestination(input: string, create = true): NetworkDestination {
  // Normalise smb://host/share/path and smb3://host/share/path to a UNC path.
  const target = String(input || '')
    .trim()
    .replace(/^smb3?:\/\//i, '\\\\')
    .replace(/\//g, '\\');

  try {
    let created = false;
    if (create && !fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      created = true;
    }
    if (!fs.existsSync(target)) {
      return { path: target, ok: false, error: 'Destination does not exist' };
    }
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
      return { path: target, ok: false, error: 'Destination is not a directory' };
    }
    const probe = path.join(target, '.opbs-write-probe');
    fs.writeFileSync(probe, new Date().toISOString());
    const back = fs.readFileSync(probe, 'utf-8');
    fs.rmSync(probe, { force: true });
    return {
      path: target,
      ok: true,
      writable: back.length > 0,
      reachable: true,
      created
    };
  } catch (err) {
    return {
      path: target,
      ok: false,
      writable: false,
      reachable: fs.existsSync(target),
      error: err instanceof Error ? err.message : String(err)
    };
  }
}