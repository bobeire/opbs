import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { flagValue, flagValues } from './flags';
import type { CommandContext } from './index';
import { buildFleetReport } from '../fleet/report';
import { deriveMachineStatus, FleetCheckin, lastBackupAt, FLEET_ACTION_NAMES, validateActionRequest } from '../fleet/schema';
import { sendCheckin, fetchFleet, pullPolicies, pushPolicy, enqueueAction, fetchActionQueue, claimActions } from '../fleet/client';
import { startFleetServer, DEFAULT_BACKUP_STALE_DAYS, isValidPolicyName } from '../fleet/server';
import { applyPolicies, defaultPolicyDir } from '../fleet/policy';
import { runQueuedActions } from '../fleet/action';

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

/** Long-lived check-in settings, usually written once and referenced by a scheduled task. */
export interface CheckinSettings {
  server?: string;
  token?: string;
  tokenFile?: string;
  dirs?: string[];
  noMedia?: boolean;
  machineId?: string;
  /** Pull + apply server policies on every check-in (Tier 2 auto-apply). */
  autoApply?: boolean;
  /** Where applied policy configs + state live (default APPDATA/opbs/fleet-policies). */
  policyDir?: string;
  /** Claim and run queued remote actions on every check-in (Tier 4). */
  runActions?: boolean;
}

/** Loads and type-checks a `fleet checkin --settings` JSON file. Throws with a precise message. */
export function loadCheckinSettings(filePath: string): CheckinSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`cannot read --settings ${filePath}: ${error instanceof Error ? error.message : error}`, {
      cause: error
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--settings ${filePath} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--settings ${filePath} must be a JSON object`);
  }
  const value = parsed as Record<string, unknown>;
  const settings: CheckinSettings = {};
  const bad = (key: string, expected: string): never => {
    throw new Error(`--settings ${filePath}: ${key} must be ${expected}`);
  };
  if (value.server !== undefined) {
    settings.server = typeof value.server === 'string' ? value.server : bad('server', 'a string');
  }
  if (value.token !== undefined) {
    settings.token = typeof value.token === 'string' ? value.token : bad('token', 'a string');
  }
  if (value.tokenFile !== undefined) {
    settings.tokenFile = typeof value.tokenFile === 'string' ? value.tokenFile : bad('tokenFile', 'a string');
  }
  if (value.dirs !== undefined) {
    if (!Array.isArray(value.dirs) || !value.dirs.every((d) => typeof d === 'string')) {
      bad('dirs', 'an array of strings');
    }
    settings.dirs = value.dirs as string[];
  }
  if (value.noMedia !== undefined) {
    settings.noMedia = typeof value.noMedia === 'boolean' ? value.noMedia : bad('noMedia', 'a boolean');
  }
  if (value.machineId !== undefined) {
    settings.machineId = typeof value.machineId === 'string' ? value.machineId : bad('machineId', 'a string');
  }
  if (value.autoApply !== undefined) {
    settings.autoApply = typeof value.autoApply === 'boolean' ? value.autoApply : bad('autoApply', 'a boolean');
  }
  if (value.policyDir !== undefined) {
    settings.policyDir = typeof value.policyDir === 'string' ? value.policyDir : bad('policyDir', 'a string');
  }
  if (value.runActions !== undefined) {
    settings.runActions = typeof value.runActions === 'boolean' ? value.runActions : bad('runActions', 'a boolean');
  }
  return settings;
}

function readTokenFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch (error) {
    throw new Error(`cannot read token file ${filePath}: ${error instanceof Error ? error.message : error}`, {
      cause: error
    });
  }
}

/** Flags + settings + env for `fleet checkin`, flags winning over the settings file. */
export function resolveCheckinInvocation(
  argv: string[],
  settings: CheckinSettings
): {
  server?: string;
  token?: string;
  dirs?: string[];
  includeMedia: boolean;
  machineId?: string;
  dryRun: boolean;
  autoApply: boolean;
  policyDir?: string;
  runActions: boolean;
} {
  const server = flagValue(argv, '--server') ?? settings.server;
  const inlineToken = flagValue(argv, '--token');
  const inlineTokenFile = flagValue(argv, '--token-file');
  let token: string | undefined;
  if (inlineToken) {
    token = inlineToken;
  } else if (inlineTokenFile) {
    token = readTokenFile(inlineTokenFile);
  } else if (settings.token) {
    token = settings.token;
  } else if (settings.tokenFile) {
    token = readTokenFile(settings.tokenFile);
  } else if (process.env.OPBS_FLEET_TOKEN) {
    token = process.env.OPBS_FLEET_TOKEN.trim();
  }
  const explicitDirs = flagValues(argv, '--dir');
  return {
    server,
    token,
    dirs: explicitDirs.length > 0 ? explicitDirs : settings.dirs,
    includeMedia: !(argv.includes('--no-media') || settings.noMedia === true),
    machineId: flagValue(argv, '--machine-id') ?? settings.machineId,
    dryRun: argv.includes('--dry-run'),
    autoApply: argv.includes('--auto-apply') || settings.autoApply === true,
    policyDir: flagValue(argv, '--policy-dir') ?? settings.policyDir,
    runActions: argv.includes('--run-actions') || settings.runActions === true
  };
}

async function recentDestinations(): Promise<string[]> {
  try {
    const { getRecentDestinations } = await import('../utils/recent');
    return getRecentDestinations();
  } catch {
    return [];
  }
}

async function buildFromArgs(
  directories: string[],
  opts: { machineId?: string; includeMedia: boolean }
): Promise<FleetCheckin> {
  return buildFleetReport({
    directories,
    appVersion: await resolveAppVersion(),
    machineId: opts.machineId || undefined,
    includeMedia: opts.includeMedia
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
  const explicitDirs = flagValues(ctx.argv, '--dir');
  const checkin = await buildFromArgs(explicitDirs.length > 0 ? explicitDirs : await recentDestinations(), {
    machineId: flagValue(ctx.argv, '--machine-id'),
    includeMedia: !ctx.argv.includes('--no-media')
  });
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
  if (file) return readTokenFile(file);
  const env = process.env.OPBS_FLEET_TOKEN;
  return env ? env.trim() : undefined;
}

async function cmdFleetCheckin(ctx: CommandContext): Promise<number> {
  const settingsFile = flagValue(ctx.argv, '--settings');
  const settings = settingsFile ? loadCheckinSettings(settingsFile) : {};
  const invocation = resolveCheckinInvocation(ctx.argv, settings);
  const server = invocation.server;
  if (!server) {
    console.error(
      'Usage: fleet checkin --server <url> [--settings <file>] [--token T|--token-file F] ' +
        '[--dir <dir>]... [--no-media] [--auto-apply] [--policy-dir <dir>] [--run-actions] [--dry-run] [--json]'
    );
    return 1;
  }
  const token = invocation.token;
  if (invocation.autoApply && !token) {
    console.error('--auto-apply needs a token: pass --token/--token-file, put "token" in --settings, or set OPBS_FLEET_TOKEN.');
    return 1;
  }
  if (!invocation.dryRun && !token) {
    console.error('No token: pass --token/--token-file, put "token" in --settings, or set OPBS_FLEET_TOKEN.');
    return 1;
  }

  const directories = invocation.dirs ?? (await recentDestinations());
  const checkin = await buildFromArgs(directories, {
    machineId: invocation.machineId,
    includeMedia: invocation.includeMedia
  });

  // Tier 4: drain the server's action queue (read-only diagnostics), run each
  // one, and carry the results back inside this check-in. Dry-run stays pure
  // JSON — it never executes claimed actions.
  if (invocation.runActions && !invocation.dryRun && server && token) {
    try {
      const queued = await claimActions({ server, token }, checkin.machineId);
      if (queued.length > 0) {
        const results = await runQueuedActions(queued);
        checkin.actions = results;
        for (const result of results) {
          console.log(`action ${result.action}: ${result.ok ? 'ok' : 'FAILED'} — ${result.summary}`);
        }
      }
    } catch (error) {
      console.error(`action claim failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Tier 2: reconcile local scheduled backups against the server's policies
  // before the report goes out, so the check-in carries the apply result.
  if (invocation.autoApply && server && token) {
    try {
      const list = await pullPolicies({ server, token });
      checkin.policies = await applyPolicies(invocation.policyDir ?? defaultPolicyDir(), list, {
        dryRun: invocation.dryRun
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checkin.policies = [{ name: '(pull)', status: 'failed', reason: `cannot pull policies: ${detail}` }];
      console.error(`policy sync skipped: ${detail}`);
    }
  }

  if (invocation.dryRun) {
    console.log(JSON.stringify(checkin, null, 2));
    return 0;
  }

  const result = await sendCheckin(checkin, { server, token: token! });
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
  const backupStaleDays = Number(flagValue(ctx.argv, '--backup-stale-days') ?? String(DEFAULT_BACKUP_STALE_DAYS));
  const webhook = flagValue(ctx.argv, '--webhook');
  const sweepFlag = flagValue(ctx.argv, '--alert-sweep-minutes');
  const alertSweepMinutes = sweepFlag !== undefined ? Number(sweepFlag) : undefined;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port`);
    return 1;
  }
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    console.error(`invalid --stale-days`);
    return 1;
  }
  if (!Number.isInteger(backupStaleDays) || backupStaleDays < 0) {
    console.error(`invalid --backup-stale-days`);
    return 1;
  }
  if (webhook !== undefined && !/^https?:\/\//i.test(webhook)) {
    console.error('invalid --webhook (must start with http:// or https://)');
    return 1;
  }
  if (alertSweepMinutes !== undefined && (!Number.isFinite(alertSweepMinutes) || alertSweepMinutes < 0)) {
    console.error('invalid --alert-sweep-minutes (0 disables the sweep)');
    return 1;
  }

  const server = await startFleetServer({
    dataDir,
    host,
    port,
    token: resolveToken(ctx.argv),
    staleDays,
    backupStaleDays,
    webhook,
    alertSweepMs: alertSweepMinutes !== undefined ? alertSweepMinutes * 60_000 : undefined,
    log: (line) => console.log(line)
  });

  console.log(`fleet server listening on ${server.url}`);
  console.log(`  dashboard: ${server.url}/`);
  console.log(`  data:      ${path.join(dataDir, 'checkins.json')}`);
  console.log(`  policies:  ${path.join(dataDir, 'policies')}`);
  console.log(`  token:     ${server.token}`);
  console.log(
    `  stale:     no check-in for ${staleDays} day(s)` +
      (backupStaleDays > 0 ? `, no backup for ${backupStaleDays} day(s)` : ', backup-staleness off')
  );
  if (webhook) {
    console.log(`  webhook:   ${webhook}`);
    console.log(
      `             alerts on critical/stale transitions + recovery` +
        (alertSweepMinutes !== undefined && alertSweepMinutes === 0
          ? ' (sweep disabled — evaluated on check-ins only)'
          : ` (sweep every ${alertSweepMinutes ?? 5} min)`)
    );
  }
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

async function cmdFleetPolicy(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv[0];
  const rest = ctx.argv.slice(1);
  const server = flagValue(rest, '--server');
  if (!server) {
    console.error('Usage: fleet policy list|pull|apply|push --server <url> [--token T|--token-file F] ...');
    return 1;
  }
  const token = resolveToken(rest);
  if (!token) {
    console.error('No token: pass --token/--token-file or set OPBS_FLEET_TOKEN.');
    return 1;
  }

  switch (sub) {
    case 'list': {
      const result = await pullPolicies({ server, token });
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const policy of result.policies) {
          const label = typeof policy.config === 'object' && policy.config !== null && 'name' in policy.config
            ? String((policy.config as { name?: unknown }).name)
            : '';
          console.log(`  ${policy.name}${label ? ` — ${label}` : ''}`);
        }
        for (const bad of result.invalid) {
          console.log(`  ! ${bad.name}: ${bad.error}`);
        }
        console.log(`${result.policies.length} policy file(s), ${result.invalid.length} unreadable`);
      }
      return result.invalid.length > 0 ? 1 : 0;
    }

    case 'pull': {
      const out = flagValue(rest, '--out') ?? 'fleet-policies';
      const overwrite = rest.includes('--overwrite');
      const result = await pullPolicies({ server, token });
      fs.mkdirSync(out, { recursive: true });
      let written = 0;
      let skipped = 0;
      for (const policy of result.policies) {
        const target = path.join(out, path.basename(policy.name));
        if (fs.existsSync(target) && !overwrite) {
          skipped++;
          continue;
        }
        fs.writeFileSync(target, `${JSON.stringify(policy.config, null, 2)}\n`, 'utf-8');
        written++;
      }
      if (ctx.opts.json) {
        console.log(JSON.stringify({ out, written, skipped, invalid: result.invalid }, null, 2));
      } else {
        console.log(`${out}: wrote ${written} policy file(s)${skipped ? `, kept ${skipped} existing` : ''}`);
        for (const bad of result.invalid) {
          console.log(`  ! ${bad.name}: ${bad.error}`);
        }
      }
      return 0;
    }

    case 'apply': {
      const policyDir = flagValue(rest, '--policy-dir') ?? defaultPolicyDir();
      const dryRun = rest.includes('--dry-run');
      const list = await pullPolicies({ server, token });
      const results = await applyPolicies(policyDir, list, { dryRun });
      if (ctx.opts.json) {
        console.log(JSON.stringify({ policyDir, dryRun, results }, null, 2));
      } else {
        for (const r of results) {
          const marker = r.status === 'invalid' || r.status === 'failed' ? '!' : r.status === 'removed' ? '-' : '+';
          console.log(
            `  ${marker} ${r.status.padEnd(9)} ${r.name}` +
              (r.task ? ` → ${r.task}` : '') +
              (r.reason ? ` (${r.reason})` : '')
          );
        }
        const bad = results.filter((r) => r.status === 'invalid' || r.status === 'failed');
        console.log(
          `${dryRun ? 'would apply' : 'applied'} ${results.length} polic(y/ies) in ${policyDir}` +
            (bad.length ? `, ${bad.length} problem(s)` : '')
        );
      }
      return results.some((r) => r.status === 'invalid' || r.status === 'failed') ? 1 : 0;
    }

    case 'push': {
      const valueFlags = new Set(['--server', '--name', '--token', '--token-file']);
      let file: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg.startsWith('-')) {
          if (valueFlags.has(arg)) i++;
          continue;
        }
        file = arg;
        break;
      }
      if (!file) {
        console.error('Usage: fleet policy push <config.json> --server <url> [--name <name.json>]');
        return 1;
      }
      let config: unknown;
      try {
        config = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (error) {
        console.error(`cannot read ${file}: ${error instanceof Error ? error.message : error}`);
        return 1;
      }
      const name = flagValue(rest, '--name') ?? path.basename(file);
      if (!isValidPolicyName(name)) {
        console.error(`invalid policy name "${name}" — use a plain <name>.json (letters, digits, . _ -)`);
        return 1;
      }
      await pushPolicy({ server, token }, name, config);
      console.log(`pushed ${name} → ${server}`);
      return 0;
    }

    default:
      console.error('Usage: fleet policy list|pull|apply|push --server <url> ...');
      return 1;
  }
}

async function cmdFleetAction(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv[0];
  const rest = ctx.argv.slice(1);
  const server = flagValue(rest, '--server');
  if (!server) {
    console.error(
      `Usage: fleet action <${FLEET_ACTION_NAMES.join('|')}> --server <url> --machine <id|*> --dir <dir> [--scope newest|all]\n` +
        '       fleet action queue --server <url>'
    );
    return 1;
  }
  const token = resolveToken(rest);
  if (!token) {
    console.error('No token: pass --token/--token-file or set OPBS_FLEET_TOKEN.');
    return 1;
  }

  if (sub === 'queue') {
    const { queue } = await fetchActionQueue({ server, token });
    if (ctx.opts.json) {
      console.log(JSON.stringify({ queue }, null, 2));
    } else {
      for (const entry of queue) {
        console.log(
          `  ${entry.action} → ${entry.machineId} (${entry.dir})` +
            (entry.scope ? ` scope=${entry.scope}` : '') +
            ` [${entry.id}]`
        );
      }
      console.log(`${queue.length} queued action(s)`);
    }
    return 0;
  }

  const validation = validateActionRequest({
    action: sub,
    machineId: flagValue(rest, '--machine'),
    dir: flagValue(rest, '--dir'),
    scope: flagValue(rest, '--scope') ?? undefined
  });
  if (!validation.ok) {
    console.error(validation.error);
    return 1;
  }
  const result = await enqueueAction({ server, token }, validation.request);
  console.log(
    `queued ${result.action} for ${result.queued.map((q) => q.machineId).join(', ')} ` +
      `(${result.queued.length} machine(s)); it runs at the machine's next check-in`
  );
  return 0;
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
    case 'policy':
      return cmdFleetPolicy(rest);
    case 'action':
      return cmdFleetAction(rest);
    default:
      console.error('Usage: fleet report|checkin|serve|status|policy|action [options]  (see "fleet" in the main help)');
      return 1;
  }
}
