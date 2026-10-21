import * as fs from 'fs';
import * as path from 'path';
import { hashFileMd5 } from './source';
import { EXCLUDED_PROFILE_SUBTREES } from './types';
import { realIdentity, rewriteCopiedOwner } from './identity';
import type { IdentityOps, IcaclsRun, RegArgRun } from './identity';
import { transplantRegistry } from './registry';
import type {
  MigrateCopyOutcome,
  MigrateOwnerRewrite,
  MigratePlan,
  MigratePlanEntry,
  MigrateRegistryOutcome,
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
  /** Tier 2: transplant the curated per-user registry keys after the file copy (needs `elevated`). */
  registry?: boolean;
  /** Tier 2: rewrite ownership of the copied tree to the target profile SID. Default false — the CLI passes this unless `--no-owner`. */
  ownerRewrite?: boolean;
  /** Whether this process holds administrator rights (the CLI detects once and passes it in). */
  elevated?: boolean;
  /** Identity/elevation primitives — injected by tests; defaults to the live Windows implementations. */
  identity?: IdentityOps;
  /** `reg.exe` argument runner — injected by tests. */
  registryRun?: RegArgRun;
  /** `icacls.exe` argument runner — injected by tests. */
  icaclsRun?: IcaclsRun;
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
    skippedDepth: 0,
    failed: 0,
    bytesCopied: 0,
    verifyChecked: 0,
    verifyMismatches: 0,
    registryCopied: 0,
    registryFailed: 0
  };
  let registryOutcomes: MigrateRegistryOutcome[] | undefined;
  let ownerResult: MigrateOwnerRewrite | undefined;

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
    ...(registryOutcomes ? { registry: registryOutcomes } : {}),
    ...(ownerResult ? { owner: ownerResult } : {}),
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
            // Same boundary the plan's sizing walk skips — aligned, not a failure (drill F4).
            outcomes.push({ sourceRelPath: childRel, destPath: childDest, action: 'skipped-depth' });
            summary.skippedDepth += 1;
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

  const destRootFor = (entry: MigratePlanEntry): string => {
    const folderName = entry.sourceRelPath.slice(entry.sourceRelPath.lastIndexOf('/') + 1);
    return path.join(target, folderName);
  };
  const touchedRoots: string[] = [];
  for (const entry of standardEntries) {
    if (aborted) break;
    const before = summary.copied + summary.skippedResume;
    walkEntry(entry);
    if (summary.copied + summary.skippedResume > before) touchedRoots.push(destRootFor(entry));
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
  if (summary.skippedDepth > 0) {
    notes.push(`${summary.skippedDepth} subtree(s) beyond the depth cap skipped — excluded from plan counts too.`);
  }

  // ── Tier 2 (phase 2): owner/SID rewrite, then curated registry transplants ──
  const identity = options.registry === true || options.ownerRewrite === true ? (options.identity ?? realIdentity) : null;
  const elevated = options.elevated ?? (identity ? identity.elevated() : false);

  if (identity && options.ownerRewrite === true) {
    // SID resolution (ProfileList/whoami) works unelevated — only the
    // actual setowner of a *foreign* profile needs admin rights.
    const targetSid = identity.sidForProfileDir(target);
    const processSid = identity.currentSid();
    if (!targetSid) {
      ownerResult = { status: 'skipped', roots: 0, detail: 'target directory has no Windows profile SID mapping' };
      notes.push('Owner rewrite skipped — target is not a registered Windows profile (no SID mapping).');
    } else if (processSid && targetSid === processSid) {
      ownerResult = { status: 'not-needed', sid: targetSid, roots: touchedRoots.length, detail: 'target profile is the account running OPBS — ownership already correct' };
    } else if (!elevated) {
      ownerResult = { status: 'skipped', sid: targetSid, roots: 0, detail: 'owner rewrite requires an elevated shell' };
      notes.push(`Owner rewrite skipped — target profile ${targetSid} differs from the migrating account; needs an elevated shell (--no-owner to silence).`);
    } else {
      ownerResult = rewriteCopiedOwner(touchedRoots, targetSid, options.icaclsRun);
      if (ownerResult.status === 'ok') {
        notes.push(`Owner rewritten to ${targetSid} on ${ownerResult.roots} copied folder root(s) — rights come from target-profile ACL inheritance.`);
      } else {
        notes.push(`Owner rewrite ${ownerResult.status}: ${ownerResult.detail ?? 'unknown error'}`);
      }
    }
  }

  if (identity && options.registry === true) {
    const seenKeys = new Set<string>();
    const registryKeys: { appId?: string; appName?: string; key: string }[] = [];
    for (const store of plan.stores) {
      for (const key of store.registry ?? []) {
        const norm = key.toLowerCase().replace(/\//g, '\\');
        if (seenKeys.has(norm)) continue;
        seenKeys.add(norm);
        registryKeys.push({
          ...(store.appId !== undefined ? { appId: store.appId } : {}),
          ...(store.appName !== undefined ? { appName: store.appName } : {}),
          key
        });
      }
    }
    registryOutcomes = transplantRegistry({
      source,
      profileRelPath: plan.profileRelPath,
      targetProfileDir: target,
      keys: registryKeys,
      elevated,
      identity,
      ...(options.registryRun ? { run: options.registryRun } : {})
    });
    for (const outcome of registryOutcomes) {
      if (outcome.status === 'copied') summary.registryCopied += 1;
      else if (outcome.status === 'failed') summary.registryFailed += 1;
    }
    if (registryOutcomes.length === 0) {
      notes.push('Registry tier: no curated keys matched this profile — nothing to transplant.');
    } else if (registryOutcomes.every((o) => o.status === 'not-run')) {
      notes.push(`Registry tier not executed — ${registryOutcomes[0]?.detail ?? 'requires an elevated shell'}.`);
    } else {
      const missing = registryOutcomes.filter((o) => o.status === 'skipped-source-missing').length;
      if (missing > 0) notes.push(`${missing} curated key(s) absent from the source hive — skipped.`);
      if (summary.registryFailed > 0) notes.push(`${summary.registryFailed} registry transplant(s) failed — see registry outcomes.`);
      if (summary.registryCopied > 0 && summary.registryFailed === 0) notes.push(`Registry tier complete: ${summary.registryCopied} key(s) transplanted and count-verified.`);
    }
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
