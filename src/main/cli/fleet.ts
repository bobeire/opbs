import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flagValue, flagValues } from './flags';
import type { CommandContext } from './index';
import { buildFleetReport } from '../fleet/report';
import { deriveMachineStatus, FleetCheckin, lastBackupAt } from '../fleet/schema';
import { sendCheckin, fetchFleet } from '../fleet/client';
import { startFleetServer } from '../fleet/server';

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fmtAge(ms: number | null): string {
  if (ms == null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function resolveAppVersion(): Promise<string> {
  try {
    const { app } = await import('electron');
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch {
    /* not running under Electron (tests) */
  }
  return 'unknown';
}

async function resolveDirectories(argv: string[]): Promise<string[]> {
  const explicit = flagValues(argv, '--dir');
  if (explicit.length > 0) return explicit;
  try {
    const { getRecentDestinations } = await import('../utils/recent');
    return getRecentDestinations();
  } catch {
    return [];
  }
}

async function buildFromArgs(argv: string[]): Promise<FleetCheckin> {
  const directories = await resolveDirectories(argv);
  const machineId = flagValue(argv, '--machine-id');
  const includeMedia = !argv.includes('--no-media');
  return buildFleetReport({
    directories,
    appVersion: await resolveAppVersion(),
    machineId: machineId || undefined,
    includeMedia
  });
}

function printReportSummary(checkin: FleetCheckin): void {
  console.log(
    `${checkin.hostname} (${checkin.machineId}) — OPBS ${checkin.appVersion}, ` +
      `${checkin.os.platform} ${checkin.os.release} ${checkin.os.arch}`
  );
  if (checkin.destinations.length === 0) {
    console.log('  no backup destinations known yet (pass --dir <directory>)');
  }
  for (const dest of checkin.destinations) {
    if (!dest.exists) {
      console.log(`  ! ${dest.directory}: unreachable`);
      continue;
    }
    const chains = dest.brokenChains > 0
      ? `${dest.completeChains}/${dest.chainCount} chains ok, ${dest.brokenChains} BROKEN`
      : `${dest.completeChains}/${dest.chainCount} chains ok`;
    const anomalies =
      dest.criticalAnomalies + dest.warningAnomalies > 0
        ? `${dest.criticalAnomalies} critical / ${dest.warningAnomalies} warning anomal(y/ies)`
        : 'no anomalies';
    const drills =
      dest.drillTotal > 0
        ? `drills ${dest.drillTotal - dest.drillFailed}/${dest.drillTotal} passed (last ${fmtAge(dest.drillLastAt)}${dest.drillLastOk === false ? ', FAILED' : ''})`
        : 'never drilled';
    console.log(
      `  ${dest.directory}: ${dest.imageCount} image(s), ${chains}, last backup ${fmtAge(dest.lastBackupAt)}` +
        `${dest.lastBackupBytes != null ? ` (${fmtBytes(dest.lastBackupBytes)} written)` : ''}, ${anomalies}, ${drills}`
    );
  }
  if (checkin.media.length > 0) {
    const bad = checkin.media.filter((m) => m.healthy === false && m.measured);
    const line = `${checkin.media.length} disk(s), ${bad.length === 0 ? 'SMART healthy' : `${bad.length} with SMART problems`}`;
    console.log(`  media: ${line}`);
    for (const m of bad) {
      console.log(`    ! disk ${m.diskIndex} (${m.model || 'unknown'}): ${m.warnings.join('; ') || 'SMART problems'}`);
    }
  }
}

async function cmdFleetReport(ctx: CommandContext): Promise<number> {
  const checkin = await buildFromArgs(ctx.argv);
  if (ctx.opts.json) {
    console.log(JSON.stringify(checkin, null, 2));
  } else {
    printReportSummary(checkin);
    const { status, reasons } = deriveMachineStatus(checkin, { receivedAt: checkin.sentAt });
    console.log(`status: ${status}`);
    for (const reason of reasons) console.log(`  - ${reason}`);
  }
  const { status } = deriveMachineStatus(checkin, { receivedAt: checkin.sentAt });
  return status === 'critical' ? 1 : 0;
}

function resolveToken(argv: string[]): string | undefined {
  const inline = flagValue(argv, '--token');
  if (inline) return inline;
  const file = flagValue(argv, '--token-file');
  if (file) {
    try {
      return fs.readFileSync(file, 'utf-8').trim();
    } catch (error) {
      throw new Error(`cannot read --token-file ${file}: ${error instanceof Error ? error.message : error}`, {
        cause: error
      });
    }
  }
  const env = process.env.OPBS_FLEET_TOKEN;
  return env ? env.trim() : undefined;
}

async function cmdFleetCheckin(ctx: CommandContext): Promise<number> {
  const server = flagValue(ctx.argv, '--server');
  if (!server) {
    console.error('Usage: fleet checkin --server <url> [--token T|--token-file F] [--dir <dir>]... [--no-media] [--dry-run] [--json]');
    return 1;
  }
  const checkin = await buildFromArgs(ctx.argv);

  if (ctx.argv.includes('--dry-run')) {
    console.log(JSON.stringify(checkin, null, 2));
    return 0;
  }

  const token = resolveToken(ctx.argv);
  if (!token) {
    console.error('No token: pass --token/--token-file or set OPBS_FLEET_TOKEN.');
    return 1;
  }
  const result = await sendCheckin(checkin, { server, token });
  if (ctx.opts.json) {
    console.log(JSON.stringify({ ...result, machineId: checkin.machineId }, null, 2));
  } else if (result.ok) {
    console.log(`check-in accepted by ${server} (${checkin.machineId}, ${checkin.destinations.length} destination(s))`);
  } else {
    console.error(`check-in failed: ${result.error ?? `HTTP ${result.status}`}`);
  }
  return result.ok ? 0 : 1;
}

async function defaultFleetDataDir(): Promise<string> {
  try {
    const { app } = await import('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'fleet-server');
    }
  } catch {
    /* not running under Electron */
  }
  return path.join(os.homedir(), '.opbs', 'fleet-server');
}

async function cmdFleetServe(ctx: CommandContext): Promise<number> {
  const dataDir = flagValue(ctx.argv, '--data') ?? (await defaultFleetDataDir());
  const host = flagValue(ctx.argv, '--host') ?? '127.0.0.1';
  const port = Number(flagValue(ctx.argv, '--port') ?? '8787');
  const staleDays = Number(flagValue(ctx.argv, '--stale-days') ?? '7');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port`);
    return 1;
  }
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    console.error(`invalid --stale-days`);
    return 1;
  }

  const server = await startFleetServer({
    dataDir,
    host,
    port,
    token: resolveToken(ctx.argv),
    staleDays,
    log: (line) => console.log(line)
  });

  console.log(`fleet server listening on ${server.url}`);
  console.log(`  dashboard: ${server.url}/`);
  console.log(`  data:      ${path.join(dataDir, 'checkins.json')}`);
  console.log(`  token:     ${server.token}`);
  if (host === '127.0.0.1') {
    console.log('  (bound to localhost — pass --host 0.0.0.0 to accept check-ins from other machines)');
  }
  console.log('Press Ctrl+C to stop.');

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      console.log('\nstopping fleet server…');
      server
        .close()
        .then(() => resolve(0))
        .catch(() => resolve(1));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function cmdFleetStatus(ctx: CommandContext): Promise<number> {
  const server = flagValue(ctx.argv, '--server');
  if (!server) {
    console.error('Usage: fleet status --server <url> [--json]');
    return 1;
  }
  const fleet = await fetchFleet({ server });
  if (ctx.opts.json) {
    console.log(JSON.stringify(fleet, null, 2));
  } else {
    const s = fleet.summary;
    console.log(
      `${fleet.machineCount} machine(s): ${s.ok} ok, ${s.warning} warning, ${s.critical} critical, ${s.stale} stale`
    );
    for (const machine of fleet.machines) {
      if (machine.status === 'ok') continue;
      console.log(`  ${machine.status === 'critical' ? '!' : machine.status === 'stale' ? '?' : '~'} ${machine.hostname} (${machine.status})`);
      for (const reason of machine.reasons) console.log(`      - ${reason}`);
    }
    const backupless = fleet.machines.filter((m) => lastBackupAt(m.checkin) === null);
    if (backupless.length > 0) {
      console.log(`  ${backupless.length} machine(s) have never backed up`);
    }
  }
  return fleet.summary.critical > 0 || fleet.summary.stale > 0 ? 1 : 0;
}

export async function cmdFleet(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  const rest: CommandContext = { argv: ctx.argv.slice(1), opts: ctx.opts };

  switch (action) {
    case 'report':
      return cmdFleetReport(rest);
    case 'checkin':
      return cmdFleetCheckin(rest);
    case 'serve':
      return cmdFleetServe(rest);
    case 'status':
      return cmdFleetStatus(rest);
    default:
      console.error('Usage: fleet report|checkin|serve|status [options]  (see "fleet" in the main help)');
      return 1;
  }
}
