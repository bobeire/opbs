import { flagValue, flagValues, positionals, VALUE_FLAGS } from './flags';
import { resolvePassphrase } from './passphrase';
import type { CommandContext } from './index';
import { loadHeader, resolveRepoKey } from '../imaging/repository';
import { runFileBackup } from '../files/backup';
import { readFileBackupConfig } from '../files/config';
import { deriveFileKeys } from '../files/crypto';
import { runFileMirror } from '../files/mirror';
import { listFileSnapshots, pruneFileSnapshots } from '../files/prune';
import { restoreFileSnapshot } from '../files/restore';
import { loadSnapshotManifest, verifyFileSnapshots } from '../files/verify';
import type { FileMirrorDeletionPolicy, FileOverwritePolicy } from '../files/types';

const FILE_VALUE_FLAGS = [
  ...VALUE_FLAGS,
  '--repo',
  '--mirror',
  '--staging',
  '--quarantine',
  '--id',
  '--target',
  '--include',
  '--overwrite',
  '--keep'
];

function keyOptions(argv: readonly string[]): { passphrase?: string; keyfile?: string } {
  const out: { passphrase?: string; keyfile?: string } = {};
  const passphrase = resolvePassphrase([...argv]).value;
  const keyfile = flagValue([...argv], '--keyfile');
  if (passphrase) out.passphrase = passphrase;
  if (keyfile) out.keyfile = keyfile;
  return out;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerFlag(argv: string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function mirrorPolicy(argv: string[], allowDeletes: boolean): FileMirrorDeletionPolicy | undefined {
  if (argv.includes('--no-deletes')) return 'off';
  if (allowDeletes) return 'quarantine';
  return undefined;
}

export async function cmdFiles(ctx: CommandContext): Promise<number> {
  const [subcommand, ...argv] = ctx.argv;
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printFilesHelp();
    return 0;
  }
  const keys = keyOptions(argv);

  switch (subcommand) {
    case 'backup': {
      const configPath = required(positionals(argv, FILE_VALUE_FLAGS)[0], 'Config path');
      const config = readFileBackupConfig(configPath);
      const allowDeletes = argv.includes('--allow-deletes');
      const result = await runFileBackup(config, {
        ...keys,
        dryRun: argv.includes('--dry-run'),
        mirrorTarget: flagValue(argv, '--mirror'),
        applyMirror: argv.includes('--apply-mirror'),
        allowDeletes,
        confirmDeletes: argv.includes('--confirm-deletes'),
        // Backup configs own their deletion policy. --no-deletes can tighten it;
        // --allow-deletes alone must not turn a config's "off" into "quarantine".
        deletions: argv.includes('--no-deletes') ? 'off' : undefined,
        stagingPath: flagValue(argv, '--staging'),
        quarantinePath: flagValue(argv, '--quarantine')
      });
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.dryRun) console.log('Dry run: no snapshot, catalog record, or mirror change was written.');
        else console.log(`Snapshot ${result.snapshotId ?? ''} created.`);
        console.log(
          `  ${result.manifest.stats.files} file(s), ${result.manifest.stats.logicalBytes} byte(s), ` +
            `${result.manifest.stats.uniqueChunks} chunk(s), ${result.filesRead} file(s) read.`
        );
        for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
        if (result.mirror) printMirrorSummary(result.mirror);
      }
      return result.ok ? 0 : 1;
    }

    case 'list': {
      const repo = required(flagValue(argv, '--repo'), '--repo');
      const records = listFileSnapshots(repo);
      if (ctx.opts.json) {
        console.log(JSON.stringify(records, null, 2));
        return 0;
      }
      for (const record of records) {
        console.log(
          `${record.id}\t${record.at}\t${record.files ?? 0} files\t${record.bytes ?? 0} bytes\t` +
            `lock: ${record.lockUntil ?? '-'}`
        );
      }
      console.log(`\n${records.length} file snapshot(s)`);
      return 0;
    }

    case 'restore': {
      const repo = required(flagValue(argv, '--repo'), '--repo');
      const id = required(flagValue(argv, '--id'), '--id');
      const target = required(flagValue(argv, '--target'), '--target');
      const overwrite = (flagValue(argv, '--overwrite') ?? 'skip') as FileOverwritePolicy;
      if (overwrite !== 'skip' && overwrite !== 'replace' && overwrite !== 'rename') {
        throw new Error('--overwrite must be skip, replace, or rename');
      }
      const result = restoreFileSnapshot({
        ...keys,
        repoDir: repo,
        id,
        target,
        include: flagValues(argv, '--include'),
        overwrite
      });
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Restored ${result.restored.length} file(s) to ${result.target}.`);
        for (const skipped of result.skipped) console.log(`  Skipped ${skipped.path}: ${skipped.reason}`);
        for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
      }
      return result.ok ? 0 : 1;
    }

    case 'verify': {
      const repo = required(flagValue(argv, '--repo'), '--repo');
      const report = await verifyFileSnapshots(repo, {
        ...keys,
        id: flagValue(argv, '--id'),
        fast: argv.includes('--fast')
      });
      if (ctx.opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `File snapshots: ${report.snapshots.length}, signatures ${report.signaturesVerified ? 'verified' : 'not verified'}.`
        );
        for (const problem of report.problems) console.log(`  ${problem.kind}: ${problem.detail}`);
      }
      return report.ok ? 0 : 1;
    }

    case 'prune': {
      const repo = required(flagValue(argv, '--repo'), '--repo');
      const apply = argv.includes('--apply');
      const result = await pruneFileSnapshots(repo, {
        ...keys,
        apply,
        keep: integerFlag(argv, '--keep', 3)
      });
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (!apply) console.log('Dry run: no snapshot was deleted.');
        console.log(
          `  Eligible: ${result.eligible.length}, skipped: ${result.skipped.length}, ` +
            `removed: ${result.removed.length}, chunks collected: ${result.chunksRemoved}.`
        );
      }
      return 0;
    }

    case 'mirror': {
      const repo = required(flagValue(argv, '--repo'), '--repo');
      const id = required(flagValue(argv, '--id'), '--id');
      const target = required(flagValue(argv, '--target'), '--target');
      const allowDeletes = argv.includes('--allow-deletes');
      const header = loadHeader(repo);
      const key = resolveRepoKey(header, keys);
      const { manifest } = loadSnapshotManifest(repo, id, deriveFileKeys(key).enc);
      const report = await runFileMirror({
        repoDir: repo,
        manifest,
        target,
        apply: argv.includes('--apply'),
        allowDeletes,
        confirmDeletes: argv.includes('--confirm-deletes'),
        deletions: mirrorPolicy(argv, allowDeletes),
        stagingPath: flagValue(argv, '--staging'),
        quarantinePath: flagValue(argv, '--quarantine'),
        repoKey: key
      });
      if (ctx.opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printMirrorSummary(report);
      }
      return report.ok ? 0 : 1;
    }

    default:
      console.error(`Unknown files command: ${subcommand}`);
      printFilesHelp();
      return 1;
  }
}

function printMirrorSummary(report: {
  dryRun: boolean;
  applied: boolean;
  added: unknown[];
  changed: unknown[];
  deleted: unknown[];
  replaced: unknown[];
  confirmationRequired: boolean;
  problems: string[];
  reportPath?: string;
}): void {
  console.log(
    `${report.dryRun ? 'Mirror plan' : 'Mirror result'}: ${report.added.length} added, ` +
      `${report.changed.length} changed, ${report.deleted.length} planned deletion(s), ` +
      `${report.replaced.length} replaced.`
  );
  if (!report.applied) console.log('  Destination was not changed.');
  if (report.confirmationRequired) console.log('  Deletion threshold exceeded; --confirm-deletes is required.');
  for (const problem of report.problems) console.log(`  Problem: ${problem}`);
  if (report.reportPath) console.log(`  Report: ${report.reportPath}`);
}

function printFilesHelp(): void {
  // prettier-ignore
  console.log(`OPBS file backups (CLI preview; no GUI flow yet)

Usage: <app> --cli files <command> [options]

  backup <config.json> [--dry-run] [--mirror <dir>] [--apply-mirror]
                       [--allow-deletes] [--no-deletes] [--confirm-deletes]
                       [--staging <dir>] [--quarantine <dir>]
                       Create one encrypted, versioned file snapshot. Mirroring is
                       one-way and plan-only unless --apply-mirror is given.
  list --repo <dir>    List file snapshots recorded in the repository catalog.
  restore --repo <dir> --id <id> --target <dir> [--include <glob>]...
                       [--overwrite skip|replace|rename]
                       Restore a snapshot or selected relative paths.
  verify --repo <dir> [--id <id>] [--fast]
                       Verify the signed catalog, manifests and chunks.
  prune --repo <dir> [--apply] [--keep N]
                       Plan (default) or apply expired-snapshot retention and GC.
  mirror --repo <dir> --id <id> --target <dir> [--apply]
                       [--allow-deletes] [--confirm-deletes]
                       Make the destination match a snapshot, one way only.

Repository keys: --keyfile F, --passphrase-file F, OPBS_PASSPHRASE, or legacy --passphrase P.
`);
}
