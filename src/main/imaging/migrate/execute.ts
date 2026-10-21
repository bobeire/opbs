import * as fs from 'fs';
import * as path from 'path';
import { hashFileMd5 } from './source';
import { EXCLUDED_PROFILE_SUBTREES } from './types';
import type {
  MigrateCopyOutcome,
  MigratePlan,
  MigratePlanEntry,
  MigrationReport,
  MigrateSource,
  MigrateSourceEntry
} from './types';

export interface ExecuteOptions {
  /** Existing Windows profile directory to copy into (existence enforced). */
  targetProfileDir: string;
  /** sha256 from `computePlanHash` — recorded in the report. */
  planHash: string;
  /** Default false: a truthy value reports what would happen without writing. */
  dryRun?: boolean;
  /** Overwrite existing destination files instead of failing on collision. */
  merge?: boolean;
  /** Skip files recorded in the journal of an interrupted run. */
  resume?: boolean;
  /** Verify content (hash) after copy. Default true. */
  verify?: boolean;
}

const JOURNAL_DIR_NAME = '.opbs-migrate';
const JOURNAL_PATH_REL = '.opbs-migrate/journal.jsonl';

/**
 * Legacy junction directory names that exist *inside* profile folders on
 * profiles migrated from older Windows (`AppData\Local\Application Data`
 * etc.). Live sources detect them as reparse points anyway; image sources
 * do not expose reparse tags, so the name check is the guard.
 * Deliberately narrow: real folders like `Microsoft\Windows\Start Menu`
 * or `Cookies` must still be copied.
 */
const LEGACY_REPARSE_DIR_NAMES = new Set(['Application Data', 'Local Settings']);

const MAX_DEPTH = 14;
const MAX_FILES = 500_000;

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes a tier-1 migration plan: copies standard-folder file data from
 * the source into the target profile, journaling every file, then verifies
 * content. App-store entries are metadata only (their data lives under
 * AppData, which is copied as part of that folder). Never runs when the
 * plan carries refusals.
 */
export function executePlan(source: MigrateSource, plan: MigratePlan, options: ExecuteOptions): MigrationReport {
  const startedAt = new Date().toISOString();
  const target = options.targetProfileDir;
  const notes: string[] = [];
  const outcomes: MigrateCopyOutcome[] = [];
  const summary = {
    plannedFiles: 0,
    plannedBytes: 0,
    copied: 0,
    skippedResume: 0,
    skippedReparse: 0,
    failed: 0,
    bytesCopied: 0,
    verifyChecked: 0,
    verifyMismatches: 0
  };

  const standardEntries = plan.entries.filter((e) => e.category === 'standard-folder');
  summary.plannedFiles = standardEntries.reduce((sum, e) => sum + e.itemCount, 0);
  summary.plannedBytes = standardEntries.reduce((sum, e) => sum + e.bytes, 0);

  const finish = (executed: boolean): MigrationReport => ({
    profile: plan.profile,
    sourceLabel: plan.sourceLabel,
    targetProfileDir: target,
    planHash: options.planHash,
    executed,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    outcomes,
    stores: plan.stores,
    refusals: plan.refusals,
    reinstallHints: plan.reinstallHints,
    artifacts: {},
    notes
  });

  if (plan.refusals.length > 0) {
    notes.push('Plan has refusals — nothing was written.');
    return finish(false);
  }
  if (options.dryRun) {
    notes.push('Dry run — nothing was written. Re-run with --execute --plan-hash <hash> to apply.');
    return finish(false);
  }
  try {
    if (!fs.statSync(target).isDirectory()) throw new Error('not a directory');
  } catch {
    notes.push(`Target profile directory unusable: ${target}`);
    return finish(false);
  }

  const journalDir = path.join(target, JOURNAL_DIR_NAME);
  const journalPath = path.join(journalDir, 'journal.jsonl');
  let journal: Set<string> | null = null;
  if (options.resume && fs.existsSync(journalPath)) {
    const dests = new Set<string>();
    for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { d?: string };
        if (parsed.d) dests.add(parsed.d);
      } catch {
        /* partial line from a crash — ignore */
      }
    }
    journal = dests;
    notes.push(`Resume: ${journal.size} previously copied file(s) honored from ${JOURNAL_PATH_REL}.`);
  } else if (fs.existsSync(journalPath)) {
    notes.push(`Journal from a previous run exists (${JOURNAL_PATH_REL}); pass --resume to skip already-copied files.`);
  }
  fs.mkdirSync(journalDir, { recursive: true });

  const appendJournal = (dest: string, srcRel: string, bytes: number): void => {
    fs.appendFileSync(journalPath, `${JSON.stringify({ d: dest, s: srcRel, b: bytes, t: new Date().toISOString() })}\n`);
  };

  const excludes = EXCLUDED_PROFILE_SUBTREES.map((p) => `${plan.profileRelPath}/${p}`);
  const verifyEnabled = options.verify !== false;
  const copiedPairs: { srcRel: string; dest: string; size: number }[] = [];
  let fileCount = 0;
  let sizeOnlyVerified = 0;
  let aborted: string | undefined;

  const walkEntry = (entry: MigratePlanEntry): void => {
    const folderName = entry.sourceRelPath.slice(entry.sourceRelPath.lastIndexOf('/') + 1);
    const destRoot = path.join(target, folderName);
    const stack: { srcDir: string; destDir: string; depth: number }[] = [
      { srcDir: entry.sourceRelPath, destDir: destRoot, depth: 0 }
    ];
    while (stack.length > 0 && !aborted) {
      const frame = stack.pop()!;
      let children: MigrateSourceEntry[];
      try {
        children = source.list(frame.srcDir);
      } catch (error) {
        outcomes.push({ sourceRelPath: frame.srcDir, destPath: frame.destDir, action: 'failed', error: `unreadable directory: ${msg(error)}` });
        summary.failed += 1;
        continue;
      }
      if (frame.depth === 0) {
        try {
          fs.mkdirSync(frame.destDir, { recursive: true });
        } catch (error) {
          outcomes.push({ sourceRelPath: frame.srcDir, destPath: frame.destDir, action: 'failed', error: `cannot create destination folder: ${msg(error)}` });
          summary.failed += 1;
          continue;
        }
      }
      for (const child of children) {
        if (aborted) break;
        const childRel = `${frame.srcDir}/${child.name}`;
        if (excludes.includes(childRel)) continue;
        const childDest = path.join(frame.destDir, child.name);
        if (child.isDirectory) {
          if (child.isSymlink || LEGACY_REPARSE_DIR_NAMES.has(child.name)) {
            outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'skipped-reparse' });
            summary.skippedReparse += 1;
            continue;
          }
          if (frame.depth + 1 > MAX_DEPTH) {
            outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'failed', error: 'depth cap exceeded' });
            summary.failed += 1;
            continue;
          }
          stack.push({ srcDir: childRel, destDir: childDest, depth: frame.depth + 1 });
          continue;
        }
        if (child.isSymlink) {
          outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'skipped-reparse' });
          summary.skippedReparse += 1;
          continue;
        }
        fileCount += 1;
        if (fileCount > MAX_FILES) {
          aborted = `File cap exceeded (${MAX_FILES}) — run aborted; journal preserved for --resume.`;
          break;
        }
        let destExists: boolean;
        try {
          destExists = fs.existsSync(childDest);
        } catch {
          destExists = false;
        }
        if (destExists && journal?.has(childDest)) {
          outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'skipped-resume', bytes: child.size });
          summary.skippedResume += 1;
          continue;
        }
        if (destExists && options.merge !== true) {
          outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'failed', bytes: child.size, error: 'destination exists (re-run with --merge to overwrite)' });
          summary.failed += 1;
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(childDest), { recursive: true });
          source.copyFileTo(childRel, childDest);
          const written = fs.statSync(childDest).size;
          appendJournal(childDest, childRel, written);
          summary.copied += 1;
          summary.bytesCopied += written;
          if (verifyEnabled) copiedPairs.push({ srcRel: childRel, dest: childDest, size: child.size });
        } catch (error) {
          outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'failed', error: msg(error) });
          summary.failed += 1;
        }
      }
    }
  };

  for (const entry of standardEntries) {
    if (aborted) break;
    walkEntry(entry);
  }
  if (aborted) notes.push(aborted);

  if (verifyEnabled && copiedPairs.length > 0) {
    for (const pair of copiedPairs) {
      try {
        const destStat = fs.statSync(pair.dest);
        if (destStat.size !== pair.size) {
          outcomes.push({ sourceRelPath: pair.srcRel, destPath: pair.dest, action: 'copied', bytes: destStat.size, verify: 'mismatch' });
          summary.verifyMismatches += 1;
          continue;
        }
        const srcHash = source.hashFile(pair.srcRel, pair.size);
        if (srcHash === null) {
          sizeOnlyVerified += 1;
          summary.verifyChecked += 1;
          continue;
        }
        summary.verifyChecked += 1;
        if (hashFileMd5(pair.dest) !== srcHash) {
          outcomes.push({ sourceRelPath: pair.srcRel, destPath: pair.dest, action: 'copied', bytes: destStat.size, verify: 'mismatch' });
          summary.verifyMismatches += 1;
        }
      } catch (error) {
        outcomes.push({ sourceRelPath: pair.srcRel, destPath: pair.dest, action: 'copied', verify: 'failed', error: msg(error) });
        summary.failed += 1;
      }
    }
    if (sizeOnlyVerified > 0) {
      notes.push(`${sizeOnlyVerified} large file(s) verified by size only (source hash above image buffer limit).`);
    }
    if (summary.verifyMismatches > 0) {
      notes.push(`${summary.verifyMismatches} content mismatch(es) — see outcomes; re-run with --merge after investigating.`);
    }
  } else if (!verifyEnabled) {
    notes.push('Verification disabled (--no-verify).');
  }

  if (source.kind === 'live') {
    notes.push('Live copies carry file content and timestamps only — no NTFS ACL/ADS/EFS metadata; the target profile applies its own ACLs by inheritance.');
  }
  if (summary.skippedReparse > 0) {
    notes.push('Reparse points/legacy junctions were skipped (never followed).');
  }

  const reportPath = path.join(journalDir, 'report.json');
  const wingetPath = path.join(journalDir, 'winget-import.json');
  const wingetDoc = {
    $schema: 'https://aka.ms/winget-command-export.schema.json',
    CreationDate: new Date().toISOString(),
    Sources: [
      {
        SourceDetails: { Name: 'winget', Argument: 'https://cdn.winget.microsoft.com/cache', Type: 'Microsoft.PreIndexed.Package' },
        Packages: plan.reinstallHints.filter((h) => h.winget).map((h) => ({ PackageIdentifier: h.winget }))
      }
    ]
  };
  fs.writeFileSync(wingetPath, `${JSON.stringify(wingetDoc, null, 2)}\n`);
  const report = finish(true);
  report.artifacts = { reportPath, wingetPath, journalPath };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
