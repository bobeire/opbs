import * as crypto from 'crypto';
import * as fs from 'fs';
import type { AppKnowledgeEntry, MigrateInventory, MigratePlan, MigratePlanEntry, MigrateRefusal, MigrateReinstallHint, MigrateSource } from './types';
import { EXCLUDED_PROFILE_SUBTREES, STANDARD_FOLDERS } from './types';
import { inventoryProfile } from './inventory';

export interface BuildPlanOptions {
  /** Optional live target profile directory (e.g. `C:\Users\Alice`); existence-checked only. */
  targetProfileDir?: string;
  /** Restrict to these standard folder names (default: all present). */
  onlyFolders?: string[];
}

const PHASE_NOTES = [
  'Phase 0 spike: plans tier-1 file data only — nothing is written.',
  'Registry transplant keys (tier 2) are listed per store and NOT executed; planned for phase 2.',
  'Installed program binaries are never copied — reinstall via the winget list on the target.',
  'App inventory from uninstall registry keys needs an offline SOFTWARE-hive scan — not in the spike; reinstall-only apps on the source are therefore not auto-detected.'
];

/** Builds a dry-run migration plan for one profile. Read-only against the source. */
export function buildPlan(source: MigrateSource, profileName: string, appsDb: AppKnowledgeEntry[], options: BuildPlanOptions = {}): MigratePlan {
  const inventory: MigrateInventory = {
    sourceKind: source.kind,
    sourceLabel: source.label,
    generatedAt: new Date().toISOString(),
    profiles: [],
    excludedProfileDirs: []
  };
  const profile = inventoryProfile(source, profileName, appsDb);
  inventory.profiles.push(profile);

  const refusals: MigrateRefusal[] = [];
  if (profile.itemCount === 0 && profile.stores.length === 0) {
    refusals.push({
      reason: 'profile-not-found-or-empty',
      detail: `No readable data under Users/${profileName} on ${source.label}. Check the profile name (migrate inventory lists them).`
    });
  }

  if (options.targetProfileDir) {
    try {
      const st = fs.statSync(options.targetProfileDir);
      if (!st.isDirectory()) {
        refusals.push({ reason: 'target-not-a-directory', detail: options.targetProfileDir });
      }
    } catch {
      refusals.push({
        reason: 'target-profile-missing',
        detail: `Target profile directory does not exist: ${options.targetProfileDir}. Create the Windows account first; this spike does not create accounts.`
      });
    }
  }

  const only = options.onlyFolders ? new Set(options.onlyFolders) : null;
  const entries: MigratePlanEntry[] = [];
  for (const folder of STANDARD_FOLDERS) {
    if (only && !only.has(folder)) continue;
    const hit = profile.standardFolders.find((f) => f.name === folder);
    if (!hit) continue;
    entries.push({
      profile: profileName,
      sourceRelPath: `${profile.profileRelPath}/${folder}`,
      category: 'standard-folder',
      bytes: hit.bytes,
      itemCount: hit.itemCount,
      registryExecuted: false
    });
  }

  for (const store of profile.stores) {
    if (only && !only.has('AppData')) continue; // store paths live under standard folders
    entries.push({
      profile: profileName,
      sourceRelPath: store.relPath,
      category: 'app-store',
      appId: store.appId,
      appName: store.appName,
      bytes: store.bytes,
      itemCount: store.itemCount,
      registry: store.registry,
      registryExecuted: false
    });
  }

  const seenHint = new Set<string>();
  const reinstallHints: MigrateReinstallHint[] = [];
  for (const store of profile.stores) {
    if (!store.winget || seenHint.has(store.appId)) continue;
    seenHint.add(store.appId);
    reinstallHints.push({ appId: store.appId, name: store.appName, winget: store.winget, class: store.class });
  }
  reinstallHints.sort((a, b) => a.name.localeCompare(b.name));

  // Tier-1 totals come from standard folders only (stores are a subset of AppData).
  const totalBytes = entries.filter((e) => e.category === 'standard-folder').reduce((sum, e) => sum + e.bytes, 0);
  const totalItems = entries.filter((e) => e.category === 'standard-folder').reduce((sum, e) => sum + e.itemCount, 0);

  return {
    sourceKind: source.kind,
    sourceLabel: source.label,
    generatedAt: new Date().toISOString(),
    profile: profileName,
    profileRelPath: profile.profileRelPath,
    entries,
    totalBytes,
    totalItems,
    stores: profile.stores,
    reinstallHints,
    refusals,
    phaseNotes: PHASE_NOTES.slice()
  };
}

/** Excluded subtrees exported for CLI text rendering/tests. */
export const PLAN_EXCLUDES = EXCLUDED_PROFILE_SUBTREES;

/**
 * sha256 over the plan's decision-relevant content — stable across runs
 * (excludes `generatedAt` and `planHash` itself). `migrate run --execute`
 * requires this hash, so scripted flows run `plan` first, then `run`.
 */
export function computePlanHash(plan: MigratePlan): string {
  const byPath = <T extends { key: string }>(a: T, b: T): number => a.key.localeCompare(b.key);
  const payload = JSON.stringify({
    sourceKind: plan.sourceKind,
    sourceLabel: plan.sourceLabel,
    profile: plan.profile,
    profileRelPath: plan.profileRelPath,
    totalBytes: plan.totalBytes,
    totalItems: plan.totalItems,
    entries: [...plan.entries].sort((a, b) => a.sourceRelPath.localeCompare(b.sourceRelPath)),
    stores: [...plan.stores].map((s) => ({ key: s.relPath, s })).sort(byPath).map(({ s }) => s),
    reinstallHints: [...plan.reinstallHints].map((h) => ({ key: h.appId, h })).sort(byPath).map(({ h }) => h),
    refusals: [...plan.refusals].map((r) => ({ key: r.reason + r.detail, r })).sort(byPath).map(({ r }) => r)
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}
