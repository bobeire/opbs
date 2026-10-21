import { flagValue } from './flags';
import { resolvePassphrase } from './passphrase';
import type { CommandContext } from './index';
import { loadAppsDb } from '../imaging/migrate/apps-db';
import { executePlan } from '../imaging/migrate/execute';
import { buildInventory, listProfileNames } from '../imaging/migrate/inventory';
import { buildPlan, computePlanHash } from '../imaging/migrate/plan';
import { openMigrateSource } from '../imaging/migrate/source';
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
  const positional = ctx.argv.filter((a, i) => i > 0 && !a.startsWith('-') && ctx.argv[i - 1] !== '--partition' && ctx.argv[i - 1] !== '--live-root' && ctx.argv[i - 1] !== '--profile' && ctx.argv[i - 1] !== '--target' && ctx.argv[i - 1] !== '--apps-db' && ctx.argv[i - 1] !== '--folder' && ctx.argv[i - 1] !== '--plan-hash');
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
      console.log(`    ${folder.name.padEnd(12)} ${fmtBytes(folder.bytes).padStart(10)}  ${folder.itemCount} files`);
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
    console.log(`  ${entry.sourceRelPath}${tag}  ${fmtBytes(entry.bytes)}  ${entry.itemCount} files`);
  }
  if (plan.stores.length > 0) {
    console.log('');
    console.log('Registry transplants (tier 2 — planned, NOT executed in this spike):');
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
  console.log(`Copied: ${s.copied} (${fmtBytes(s.bytesCopied)})  resume-skipped: ${s.skippedResume}  reparse-skipped: ${s.skippedReparse}  failed: ${s.failed}`);
  console.log(`Verify: ${s.verifyChecked} checked, ${s.verifyMismatches} mismatch(es)`);
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
    console.log(`Stores inventoried (registry tier-2 data, not yet executed): ${report.stores.length}`);
  }
  console.log('');
  console.log('Notes:');
  for (const note of report.notes) console.log(`  - ${note}`);
  if (report.artifacts.reportPath) {
    console.log('');
    console.log(`Report written: ${report.artifacts.reportPath}`);
  }
}

export async function cmdMigrate(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  if (action !== 'inventory' && action !== 'plan' && action !== 'run') {
    console.error('Usage: migrate inventory|plan|run [--live] [image] [--partition N] [--passphrase p] [--profile name] [--target DIR] [--folder name] [--apps-db file] [--execute --plan-hash H] [--merge] [--resume] [--no-verify] [--json]');
    return 1;
  }

  let source;
  try {
    source = openMigrateSource(parseSource(ctx));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const appsDb = loadAppsDb(flagValue(ctx.argv, '--apps-db'));

    if (action === 'inventory') {
      const inv = buildInventory(source, appsDb);
      if (ctx.opts.json) {
        console.log(JSON.stringify(inv, null, 2));
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
        console.log(JSON.stringify(plans, null, 2));
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
          console.log(JSON.stringify(plan, null, 2));
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
      const report = executePlan(source, plan, {
        targetProfileDir: target,
        planHash: plan.planHash,
        merge: ctx.argv.includes('--merge'),
        resume: ctx.argv.includes('--resume'),
        verify: !ctx.argv.includes('--no-verify')
      });
      if (ctx.opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        renderReport(report);
      }
      return report.summary.failed > 0 || report.summary.verifyMismatches > 0 ? 1 : 0;
    }

    if (ctx.opts.json) {
      console.log(JSON.stringify(plan, null, 2));
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
