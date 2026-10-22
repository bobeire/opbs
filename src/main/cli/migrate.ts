import * as fs from 'fs';
import * as path from 'path';
import { flagValue } from './flags';
import { resolvePassphrase } from './passphrase';
import type { CommandContext } from './index';
import { loadAppsDb } from '../imaging/migrate/apps-db';
import { executePlan } from '../imaging/migrate/execute';
import { isElevatedSync } from '../imaging/migrate/identity';
import { buildInventory, listProfileNames } from '../imaging/migrate/inventory';
import { buildPlan, computePlanHash } from '../imaging/migrate/plan';
import { defaultLiveRoot, openMigrateSource } from '../imaging/migrate/source';
import type { MigrateInventory, MigratePlan, MigrationReport } from '../imaging/migrate/types';

function fmtBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function parseSource(ctx: CommandContext): { live: boolean; liveRoot?: string; imagePath?: string; partitionIndex: number; passphrase?: string } {
  const live = ctx.argv.includes('--live');
  const liveRoot = flagValue(ctx.argv, '--live-root');
  const positional = ctx.argv.filter((a, i) => i > 0 && !a.startsWith('-') && ctx.argv[i - 1] !== '--partition' && ctx.argv[i - 1] !== '--live-root' && ctx.argv[i - 1] !== '--profile' && ctx.argv[i - 1] !== '--target' && ctx.argv[i - 1] !== '--apps-db' && ctx.argv[i - 1] !== '--folder' && ctx.argv[i - 1] !== '--plan-hash' && ctx.argv[i - 1] !== '--json-out');
  const imagePath = live ? undefined : positional[0];
  const partitionRaw = flagValue(ctx.argv, '--partition');
  const partitionIndex = partitionRaw === undefined ? 0 : Number.parseInt(partitionRaw, 10);
  if (!Number.isInteger(partitionIndex) || partitionIndex < 0) throw new Error('Invalid --partition value');
  const passphrase = resolvePassphrase(ctx.argv).value;
  return { live, liveRoot, imagePath, partitionIndex, passphrase };
}

function renderInventory(inv: MigrateInventory): void {
  console.log(`Source: ${inv.sourceLabel}`);
  console.log(`Generated: ${inv.generatedAt}`);
  console.log('');
  if (inv.profiles.length === 0) {
    console.log('No user profiles found (looked under Users/).');
    return;
  }
  console.log(`Profiles (${inv.profiles.length}):`);
  for (const profile of inv.profiles) {
    const cap = profile.capped ? ' [capped]' : '';
    console.log(`  ${profile.name}  ${fmtBytes(profile.totalBytes)}  ${profile.itemCount} files${cap}`);
    for (const folder of profile.standardFolders) {
      const cap = folder.capped ? ' [capped]' : '';
      console.log(`    ${folder.name.padEnd(12)} ${fmtBytes(folder.bytes).padStart(10)}  ${folder.itemCount} files${cap}`);
    }
    for (const store of profile.stores) {
      console.log(`    store: ${store.appName} (${store.relPath}) — ${fmtBytes(store.bytes)}`);
    }
  }
}

function renderPlan(plan: MigratePlan): void {
  console.log(`Source: ${plan.sourceLabel}`);
  console.log(`Profile: ${plan.profile} (${plan.profileRelPath})`);
  console.log(`Generated: ${plan.generatedAt}`);
  console.log(`Plan hash: ${plan.planHash ?? '(not computed)'}`);
  console.log('');
  console.log(`Planned file data: ${fmtBytes(plan.totalBytes)} across ${plan.totalItems} files`);
  console.log('');
  console.log('Entries:');
  for (const entry of plan.entries) {
    const tag = entry.category === 'app-store' ? ` [${entry.appId}]` : '';
    console.log(`  ${entry.sourceRelPath}${tag}  ${fmtBytes(entry.bytes)}  ${entry.itemCount} files${entry.capped ? '  [capped]' : ''}`);
  }
  if (plan.stores.length > 0) {
    console.log('');
    console.log('Registry transplants (tier 2 — planned; executed with --execute --registry from an elevated shell):');
    for (const store of plan.stores) {
      for (const key of store.registry ?? []) {
        console.log(`  ${store.appName}: ${key}`);
      }
    }
  }
  if (plan.reinstallHints.length > 0) {
    console.log('');
    console.log('Reinstall on target (winget):');
    for (const hint of plan.reinstallHints) {
      console.log(`  winget install ${hint.winget}   # ${hint.name}`);
    }
  }
  if (plan.refusals.length > 0) {
    console.log('');
    console.log('Refusals:');
    for (const refusal of plan.refusals) {
      console.log(`  [${refusal.reason}] ${refusal.detail}`);
    }
  }
  console.log('');
  console.log('Notes:');
  for (const note of plan.phaseNotes) console.log(`  - ${note}`);
}

function renderReport(report: MigrationReport): void {
  console.log(`Migration ${report.executed ? 'executed' : 'NOT executed'} — plan ${report.planHash.slice(0, 16)}…`);
  console.log(`Source: ${report.sourceLabel}`);
  console.log(`Profile: ${report.profile} -> ${report.targetProfileDir}`);
  console.log('');
  const s = report.summary;
  console.log(`Planned: ${s.plannedFiles} files, ${fmtBytes(s.plannedBytes)}`);
  console.log(`Copied: ${s.copied} (${fmtBytes(s.bytesCopied)})  resume-skipped: ${s.skippedResume}  reparse-skipped: ${s.skippedReparse}  depth-skipped: ${s.skippedDepth}  failed: ${s.failed}`);
  console.log(`Verify: ${s.verifyChecked} checked, ${s.verifyMismatches} mismatch(es)`);
  if (report.registry) {
    console.log(`Registry tier: ${s.registryCopied} transplanted, ${s.registryFailed} failed, ${report.registry.length} planned`);
    if (report.registry.length > 0) {
      for (const outcome of report.registry) {
        const who = outcome.appName ?? outcome.appId ?? 'app';
        console.log(`  [${outcome.status}] ${who}: ${outcome.key}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
      }
    }
  }
  if (report.owner) {
    console.log(`Owner rewrite: ${report.owner.status}${report.owner.sid ? ` (sid ${report.owner.sid}, ${report.owner.roots} root(s))` : ''}${report.owner.detail ? ` — ${report.owner.detail}` : ''}`);
  }
  if (report.outcomes.length > 0) {
    console.log('');
    console.log(`Outcomes needing attention (${report.outcomes.length}):`);
    for (const outcome of report.outcomes.slice(0, 50)) {
      const verifyTag = outcome.verify && outcome.verify !== 'ok' ? ` [verify: ${outcome.verify}]` : '';
      console.log(`  [${outcome.action}] ${outcome.sourceRelPath}${outcome.error ? ` — ${outcome.error}` : ''}${verifyTag}`);
    }
    if (report.outcomes.length > 50) console.log(`  … ${report.outcomes.length - 50} more (see report.json)`);
  }
  if (report.artifacts.wingetPath) {
    console.log('');
    console.log(`Winget import list: ${report.artifacts.wingetPath}`);
  }
  if (report.stores.length > 0) {
    console.log('');
    console.log(`Stores inventoried: ${report.stores.length}${report.registry ? '' : ' (registry transplants run with --execute --registry from an elevated shell)'}`);
  }
  console.log('');
  console.log('Notes:');
  for (const note of report.notes) console.log(`  - ${note}`);
  if (report.artifacts.reportPath) {
    console.log('');
    console.log(`Report written: ${report.artifacts.reportPath}`);
  }
}

/**
 * JSON output for machine consumers: always to stdout, plus `--json-out FILE`
 * when given (the wizard/drill child processes parse the file — immune to any
 * stray stdout noise from the runtime).
 */
function emitJson(value: unknown, jsonOutPath?: string): void {
  const text = JSON.stringify(value, null, 2);
  if (jsonOutPath) fs.writeFileSync(jsonOutPath, text);
  console.log(text);
}

export async function cmdMigrate(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  if (action !== 'inventory' && action !== 'plan' && action !== 'run') {
    console.error('Usage: migrate inventory|plan|run [--live] [image] [--partition N] [--passphrase p] [--profile name] [--target DIR] [--folder name] [--apps-db file] [--execute --plan-hash H] [--merge] [--resume] [--no-verify] [--registry] [--no-owner] [--json] [--json-out FILE]');
    return 1;
  }
  const jsonOutPath = flagValue(ctx.argv, '--json-out');

  const sourceOpts = parseSource(ctx);
  let source;
  try {
    source = openMigrateSource(sourceOpts);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const appsDb = loadAppsDb(flagValue(ctx.argv, '--apps-db'));

    if (action === 'inventory') {
      const inv = buildInventory(source, appsDb);
      if (ctx.opts.json) {
        emitJson(inv, jsonOutPath);
      } else {
        renderInventory(inv);
      }
      return 0;
    }

    const profile = flagValue(ctx.argv, '--profile');
    if (!profile) {
      console.error(`migrate ${action} requires --profile <name|all>`);
      return 1;
    }
    const onlyFolders = flagValuesForFolder(ctx.argv);
    const target = flagValue(ctx.argv, '--target');

    if (profile === 'all') {
      if (action === 'run') {
        console.error('migrate run works on a single --profile (run one profile at a time).');
        return 1;
      }
      const names = listProfileNames(source);
      if (names.length === 0) {
        console.error('No user profiles found under Users/.');
        return 1;
      }
      const plans = names.map((name) => buildPlan(source, name, appsDb, { targetProfileDir: undefined, onlyFolders: onlyFolders.length > 0 ? onlyFolders : undefined }));
      for (const plan of plans) plan.planHash = computePlanHash(plan);
      if (ctx.opts.json) {
        emitJson(plans, jsonOutPath);
      } else {
        for (const plan of plans) {
          renderPlan(plan);
          console.log('');
        }
      }
      return plans.some((p) => p.refusals.length > 0) ? 1 : 0;
    }

    const plan = buildPlan(source, profile, appsDb, {
      targetProfileDir: target,
      onlyFolders: onlyFolders.length > 0 ? onlyFolders : undefined
    });
    plan.planHash = computePlanHash(plan);

    if (action === 'run') {
      if (!target) {
        console.error('migrate run requires --target <existing target profile directory>');
        return 1;
      }
      if (!ctx.argv.includes('--execute')) {
        if (ctx.opts.json) {
          emitJson(plan, jsonOutPath);
        } else {
          renderPlan(plan);
          console.log('');
          console.log('Dry run — nothing written.');
          console.log(`Execute with: migrate run <source> --profile ${profile} --target "${target}" --execute --plan-hash ${plan.planHash}`);
        }
        return plan.refusals.length > 0 ? 1 : 0;
      }
      if (plan.refusals.length > 0) {
        console.error('Plan has refusals — refusing to execute:');
        for (const refusal of plan.refusals) console.error(`  [${refusal.reason}] ${refusal.detail}`);
        return 1;
      }
      const wantHash = flagValue(ctx.argv, '--plan-hash');
      if (!wantHash) {
        console.error('migrate run --execute requires --plan-hash <hash> — run without --execute to print it.');
        return 1;
      }
      if (wantHash !== plan.planHash) {
        console.error('Plan hash mismatch:');
        console.error(`  provided: ${wantHash}`);
        console.error(`  current:  ${plan.planHash}`);
        console.error('The source or options changed since the plan was printed. Re-run the plan.');
        return 1;
      }
      const wantRegistry = ctx.argv.includes('--registry');
      if (wantRegistry) {
        if (!fs.existsSync(path.join(target, 'NTUSER.DAT'))) {
          console.error(`migrate run --registry needs the target profile's NTUSER.DAT — not a Windows profile? (${target})`);
          return 1;
        }
      }
      const elevated = isElevatedSync();
      if (wantRegistry && !elevated) {
        console.error('migrate run --registry requires an elevated shell: loading the source/target NTUSER.DAT hives (reg load) needs administrator rights.');
        console.error('Re-run from an elevated terminal, or drop --registry to copy files only.');
        return 1;
      }
      const report = executePlan(source, plan, {
        targetProfileDir: target,
        planHash: plan.planHash,
        merge: ctx.argv.includes('--merge'),
        resume: ctx.argv.includes('--resume'),
        verify: !ctx.argv.includes('--no-verify'),
        registry: wantRegistry,
        ...(sourceOpts.live ? { sourceProfileDir: path.join(sourceOpts.liveRoot ?? defaultLiveRoot(), plan.profileRelPath) } : {}),
        ownerRewrite: !ctx.argv.includes('--no-owner'),
        elevated
      });
      if (ctx.opts.json) {
        emitJson(report, jsonOutPath);
      } else {
        renderReport(report);
      }
      const registryFailed = report.registry?.some((o) => o.status === 'failed') ?? false;
      const ownerFailed = report.owner?.status === 'failed' || report.owner?.status === 'partial';
      return report.summary.failed > 0 || report.summary.verifyMismatches > 0 || registryFailed || ownerFailed ? 1 : 0;
    }

    if (ctx.opts.json) {
      emitJson(plan, jsonOutPath);
    } else {
      renderPlan(plan);
    }
    return plan.refusals.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    source.close();
  }
}

function flagValuesForFolder(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}
