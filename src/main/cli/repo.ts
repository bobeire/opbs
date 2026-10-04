import * as fs from 'fs';
import * as path from 'path';
import { flagValue, positionals } from './flags';
import type { CommandContext } from './index';
import type { JobResult } from '../imaging/imaging-job';
import type { BackupJobConfig } from '../imaging/backup-engine';
import {
  isRepository,
  initRepository,
  loadHeader,
  resolveRepoKey,
  recordImageCreate,
  repoImageStates,
  loadJournal,
  verifyChain,
  verifyRepository,
  pruneRepository,
  unlockRepository,
  type RepoKeyOptions,
  type VerifyResult
} from '../imaging/repository';
import { verifyWithAnchor, writeRepositoryAnchor, type VerifyWithAnchorResult } from '../imaging/repo-anchor';

function keyOpts(argv: string[]): RepoKeyOptions {
  const opts: RepoKeyOptions = {};
  const passphrase = flagValue(argv, '--passphrase');
  if (passphrase) opts.passphrase = passphrase;
  const keyfile = flagValue(argv, '--keyfile');
  if (keyfile) opts.keyfile = keyfile;
  return opts;
}

/** Parse optional --lock-days; returns undefined when not given. */
export function parseLockDays(argv: string[]): number | undefined {
  const raw = flagValue(argv, '--lock-days');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('--lock-days must be a non-negative number');
  }
  return value;
}

function usage(): string {
  return [
    'Usage:',
    '  repo init <dir> [--lock-days N] [--passphrase p] [--keyfile f]',
    '  repo list <dir> [--json]',
    '  repo verify <dir> [--fast] [--anchor <target>] [--json] [--passphrase p] [--keyfile f]',
    '  repo anchor <dir> --to <target> [--passphrase p] [--keyfile f]',
    '  repo prune <dir> [--dry-run] [--json] [--passphrase p] [--keyfile f]',
    '  repo unlock <dir> <image|--all> [--passphrase p] [--keyfile f]'
  ].join('\n');
}

export async function cmdRepo(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  const pos = positionals(ctx.argv.slice(1));
  const dir = pos[0];
  if (!action || !dir) {
    console.error(usage());
    return 1;
  }

  try {
    switch (action) {
      case 'init': {
        const result = await initRepository(dir, {
          lockDays: parseLockDays(ctx.argv),
          ...keyOpts(ctx.argv)
        });
        const keyNote = result.keyfilePath
          ? `keyfile: ${result.keyfilePath} (BACK THIS UP — without it the journal cannot be signed or verified)`
          : 'key: derived from --passphrase (no keyfile stored)';
        if (ctx.opts.json) {
          console.log(JSON.stringify({ ok: true, dir, header: result.header, keyfile: result.keyfilePath ?? null }, null, 2));
        } else {
          console.log(`Initialized repository: ${dir}`);
          console.log(`  id: ${result.header.id}`);
          console.log(`  default lock: ${result.header.defaultLockDays} day(s)`);
          console.log(`  ${keyNote}`);
        }
        return 0;
      }

      case 'list': {
        if (!isRepository(dir)) {
          console.error(`Not an OPBS repository (run 'repo init ${dir}')`);
          return 1;
        }
        const header = loadHeader(dir);
        const records = loadJournal(dir);
        const chainError = verifyChain(records);
        if (chainError) {
          console.error(`Journal chain broken: ${chainError}`);
          return 1;
        }
        const states = repoImageStates(records).filter((s) => s.active);
        const hasKey = ctx.argv.includes('--passphrase') || ctx.argv.includes('--keyfile') || (() => {
          try {
            resolveRepoKey(header, keyOpts(ctx.argv));
            return true;
          } catch {
            return false;
          }
        })();
        if (ctx.opts.json) {
          console.log(JSON.stringify({ header, signaturesVerified: hasKey, images: states }, null, 2));
          return 0;
        }
        console.log(`Repository ${dir}`);
        console.log(`  id: ${header.id}  default lock: ${header.defaultLockDays} day(s)`);
        console.log(`  signatures: ${hasKey ? 'verified (key available)' : 'unverified (key not available)'}`);
        if (states.length === 0) {
          console.log('  (no images recorded)');
        } else {
          for (const state of states) {
            const stateTag = state.unlocked ? 'UNLOCKED' : state.expired ? 'EXPIRED' : 'locked';
            console.log(
              `  ${state.name}  ${state.bytes} bytes  created ${state.created}  ` +
                `lock until ${state.lockUntil ?? '-'} [${stateTag}]`
            );
          }
        }
        return 0;
      }

      case 'verify': {
        if (!isRepository(dir)) {
          console.error(`Not an OPBS repository (run 'repo init ${dir}')`);
          return 1;
        }
        const anchorTarget = flagValue(ctx.argv, '--anchor');
        const report: VerifyResult & { anchor?: VerifyWithAnchorResult['anchor'] } = anchorTarget
          ? await verifyWithAnchor(dir, {
              fast: ctx.argv.includes('--fast'),
              ...keyOpts(ctx.argv),
              anchorTarget
            })
          : await verifyRepository(dir, {
              fast: ctx.argv.includes('--fast'),
              ...keyOpts(ctx.argv)
            });
        if (ctx.opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return report.ok ? 0 : 1;
        }
        const active = report.states.filter((s) => s.active).length;
        console.log(
          `Repository ${report.ok ? 'OK' : 'FAILED'} — ${active} active image(s), ` +
            `signatures ${report.signaturesVerified ? 'verified' : 'not verified'}, ` +
            `hash mode: ${ctx.argv.includes('--fast') ? 'size only (--fast)' : 'full sha256'}`
        );
        if (report.anchor) {
          console.log(
            report.anchor.ok
              ? `  anchor: OK — through seq ${report.anchor.seq} (anchored ${report.anchor.anchoredAt})`
              : '  anchor: FAILED'
          );
        }
        for (const problem of report.problems) {
          console.error(`  [${problem.kind}] ${problem.detail}`);
        }
        return report.ok ? 0 : 1;
      }

      case 'anchor': {
        if (!isRepository(dir)) {
          console.error(`Not an OPBS repository (run 'repo init ${dir}')`);
          return 1;
        }
        const target = flagValue(ctx.argv, '--to');
        if (!target) {
          console.error('Usage: repo anchor <dir> --to <local-dir | s3://bucket/prefix | sftp://host/path>');
          return 1;
        }
        const result = await writeRepositoryAnchor(dir, target, keyOpts(ctx.argv));
        if (ctx.opts.json) {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        } else {
          console.log(
            `Anchored through seq ${result.seq} (${result.records} record(s), ${result.journalBytes} bytes)` +
              `\n  target: ${result.target}\n  at: ${result.anchoredAt}`
          );
          console.log(
            'Run "repo verify <dir> --anchor <target>" to check the local journal against this snapshot.'
          );
        }
        return 0;
      }

      case 'prune': {
        if (!isRepository(dir)) {
          console.error(`Not an OPBS repository (run 'repo init ${dir}')`);
          return 1;
        }
        const dryRun = ctx.argv.includes('--dry-run');
        const result = await pruneRepository(dir, { dryRun, ...keyOpts(ctx.argv) });
        if (ctx.opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        const verb = dryRun ? 'would delete' : 'deleted';
        console.log(`${verb} ${result.removed.length || result.eligible.length} image(s):`);
        for (const entry of dryRun ? result.eligible : result.removed) {
          console.log(`  - ${entry.name} (${entry.reason})`);
        }
        for (const entry of result.skipped) {
          console.log(`  kept ${entry.name}: ${entry.reason}`);
        }
        return 0;
      }

      case 'unlock': {
        if (!isRepository(dir)) {
          console.error(`Not an OPBS repository (run 'repo init ${dir}')`);
          return 1;
        }
        const target = pos[1] ?? (ctx.argv.includes('--all') ? '--all' : undefined);
        if (!target) {
          console.error('Usage: repo unlock <dir> <image|--all>');
          return 1;
        }
        const unlocked = await unlockRepository(dir, target === '--all' ? '*' : target, keyOpts(ctx.argv));
        if (ctx.opts.json) {
          console.log(JSON.stringify({ ok: true, unlocked }, null, 2));
        } else {
          if (unlocked.length === 0) {
            console.log('Nothing to unlock — all images are already unlocked.');
          } else {
            for (const name of unlocked) {
              console.log(`unlocked: ${name}`);
            }
          }
          console.log('Unlocked images can now be pruned or deleted manually.');
        }
        return 0;
      }

      default:
        console.error(usage());
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

/**
 * Post-backup hook: journal the freshly-written image as immutable and apply
 * OS-level protection. Throws so the CLI can exit non-zero — an image missing
 * from the journal would show up as an orphan on the next `repo verify`.
 */
export async function finalizeBackupRepo(
  repoDir: string,
  config: BackupJobConfig,
  result: JobResult,
  opts: RepoKeyOptions & { lockDays?: number; quiet?: boolean } = {}
): Promise<{ image: string; lockUntil: string } | undefined> {
  if (!result.ok) return undefined;

  let imagePath = result.imagePath;
  if (!imagePath || !fs.existsSync(imagePath)) {
    // backup-vhd / helper-written results can carry an empty imagePath.
    const imagesDir = path.join(repoDir, 'images');
    const candidates = fs
      .readdirSync(imagesDir)
      .filter((name) => name.endsWith('.opbs'))
      .map((name) => path.join(imagesDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    imagePath = candidates[0] ?? '';
  }
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error('Backup succeeded but the image file could not be located for journaling');
  }

  const header = loadHeader(repoDir);
  const key = resolveRepoKey(header, opts);
  const { record, lockUntil } = await recordImageCreate(repoDir, header, key, imagePath, {
    lockDays: opts.lockDays,
    base: config.baseImagePath ?? undefined
  });
  if (!opts.quiet && !process.env.OPBS_TEST_SILENT) {
    console.log(
      `Repository: ${record.image} recorded (${record.bytes} bytes), ` +
        `immutable until ${lockUntil}`
    );
  }
  return { image: record.image, lockUntil };
}
