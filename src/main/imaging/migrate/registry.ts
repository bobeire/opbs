import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RegArgRun, IdentityOps } from './identity';
import type { MigrateRegistryOutcome, MigrateSource } from './types';

/**
 * Tier-2 per-user registry transplants (MIGRATE.md §8): key-level copies
 * from the source profile's NTUSER.DAT into the target profile's hive.
 * Never a wholesale hive replacement — the curated knowledge-base keys are
 * the product. HKLM is never written.
 *
 * Mechanics: the source hive is *extracted* through the migrate source
 * (works identically for live disks and image partitions) and loaded under
 * a temporary `HKU\opbs_mig_src_*` mount with `reg load`. The target hive
 * is written through its already-loaded root when the profile is the
 * current user's (or another logged-on profile), otherwise loaded in
 * place. Keys move with `reg copy /s /f`, which creates missing
 * destination paths (verified empirically 2026-10-21), and every copy is
 * verified by existence + direct subkey/value counts.
 *
 * Everything runs behind an injectable `RegArgRun` so tests exercise the
 * full flow without administrator rights.
 */

const execReg: RegArgRun = (args) => {
  const res = spawnSync(path.join(process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), args, { encoding: 'utf8', windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? '', ...(res.error ? { error: res.error.message } : {}) };
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RegistryTransplantRequest {
  source: MigrateSource;
  /** Source profile relative to the volume root (`Users/<name>`). */
  profileRelPath: string;
  /** Absolute source profile dir (live mode) — enables the already-loaded-hive fast path. */
  sourceProfileDir?: string;
  targetProfileDir: string;
  /** Curated knowledge-base keys (HKCU-style), deduplicated by the caller or here. */
  keys: { appId?: string; appName?: string; key: string }[];
  elevated: boolean;
  identity: IdentityOps;
  run?: RegArgRun;
}

/** `HKCU/Software/X` (or `HKCU\Software\X`) → `Software\X` with backslashes. */
export function hiveRelativeKey(key: string): string {
  return key
    .replace(/^HKCU[\\/]/i, '')
    .replace(/\//g, '\\')
    .replace(/^\\+/, '')
    .replace(/\\{2,}/g, '\\');
}

/**
 * Parse a `reg query <key>` (non-recursive) dump into direct subkey and
 * value counts. Layout: root header line, then the root's values, then a
 * section per direct subkey (full-path header lines) — value lines are
 * indented and carry a `REG_*` type token.
 */
export function parseQueryCounts(stdout: string | undefined): { subkeys: number; values: number } {
  let subkeys = 0;
  let values = 0;
  let seenRoot = false;
  let inRootSection = true;
  for (const raw of (stdout ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^HKEY_/i.test(raw)) {
      if (!seenRoot) {
        seenRoot = true;
        continue;
      }
      inRootSection = false;
      subkeys += 1;
      continue;
    }
    if (inRootSection && /^\s+\S/.test(raw) && /\sREG_[A-Z_]+\s/.test(raw)) values += 1;
  }
  return { subkeys, values };
}

/**
 * Executes the registry tier for one profile. Returns one outcome per
 * curated key; never throws — failures are per-key outcomes (files are
 * already copied and verified at this point, §6.3). Temporary hive mounts
 * are always unloaded and the extracted source hive always deleted.
 */
export function transplantRegistry(req: RegistryTransplantRequest): MigrateRegistryOutcome[] {
  const run = req.run ?? execReg;
  const seen = new Set<string>();
  const keys = req.keys.filter((k) => {
    const norm = k.key.toLowerCase().replace(/\//g, '\\');
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  const notRun = (detail: string): MigrateRegistryOutcome[] =>
    keys.map((k) => ({ ...(k.appId !== undefined ? { appId: k.appId } : {}), ...(k.appName !== undefined ? { appName: k.appName } : {}), key: k.key, status: 'not-run' as const, detail }));

  if (keys.length === 0) return [];
  if (!req.elevated) {
    return notRun('registry tier requires an elevated shell (reg load/unload of NTUSER.DAT needs administrator rights)');
  }

  const tmpHive = path.join(os.tmpdir(), `opbs-hive-${process.pid}-${Date.now()}.dat`);
  const srcMount = `HKU\\opbs_mig_src_${process.pid}_${Date.now().toString(36)}`;
  const mounted: string[] = [];
  const load = (mount: string, hiveFile: string): boolean => {
    const res = run(['load', mount, hiveFile]);
    if (res.status === 0) mounted.push(mount);
    return res.status === 0;
  };

  try {
    // Source root: the profile's already-loaded hive when reachable (live, logged-on
    // profile — its NTUSER.DAT file is locked, extraction would fail), else extract
    // and load (image sources, offline profiles).
    let srcRoot: string;
    const loadedSrcSid = req.sourceProfileDir ? req.identity.sidForProfileDir(req.sourceProfileDir) : null;
    if (loadedSrcSid && run(['query', `HKU\\${loadedSrcSid}`]).status === 0) {
      srcRoot = `HKU\\${loadedSrcSid}`;
    } else {
      try {
        req.source.copyFileTo(`${req.profileRelPath}/NTUSER.DAT`, tmpHive);
      } catch (error) {
        return notRun(`source NTUSER.DAT unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!load(srcMount, tmpHive)) {
        return notRun(`reg load of the source hive failed — run elevated (extracted to ${tmpHive})`);
      }
      srcRoot = srcMount;
    }

    // Target root: the profile's already-loaded hive when reachable, else load in place.
    let tgtRoot: string;
    const userprofile = process.env.USERPROFILE;
    const targetIsCurrentUser = Boolean(userprofile) && path.resolve(req.targetProfileDir).toLowerCase() === path.resolve(userprofile!).toLowerCase();
    if (targetIsCurrentUser && req.identity.currentSid()) {
      tgtRoot = `HKU\\${req.identity.currentSid()}`;
    } else {
      const loadedSid = req.identity.sidForProfileDir(req.targetProfileDir);
      if (loadedSid && run(['query', `HKU\\${loadedSid}`]).status === 0) {
        tgtRoot = `HKU\\${loadedSid}`;
      } else {
        const targetHive = path.join(req.targetProfileDir, 'NTUSER.DAT');
        if (!fs.existsSync(targetHive)) {
          return notRun(`target profile hive missing: ${targetHive} (not a Windows profile?)`);
        }
        const tgtMount = `HKU\\opbs_mig_tgt_${process.pid}_${Date.now().toString(36)}`;
        if (!load(tgtMount, targetHive)) {
          return notRun('reg load of the target hive failed — run elevated (is the target user logged on?)');
        }
        tgtRoot = tgtMount;
      }
    }

    if (srcRoot === tgtRoot) {
      return notRun('source and target resolve to the same loaded hive — nothing to transplant');
    }

    const outcomes: MigrateRegistryOutcome[] = [];
    for (const key of keys) {
      const rel = hiveRelativeKey(key.key);
      const base = { ...(key.appId !== undefined ? { appId: key.appId } : {}), ...(key.appName !== undefined ? { appName: key.appName } : {}), key: key.key };
      const srcKey = `${srcRoot}\\${rel}`;
      const dstKey = `${tgtRoot}\\${rel}`;
      const srcQuery = run(['query', srcKey]);
      if (srcQuery.status !== 0) {
        outcomes.push({ ...base, status: 'skipped-source-missing', detail: 'key not present in the source profile hive' });
        continue;
      }
      const srcCounts = parseQueryCounts(srcQuery.stdout);
      const copy = run(['copy', srcKey, dstKey, '/s', '/f']);
      if (copy.status !== 0) {
        outcomes.push({ ...base, status: 'failed', detail: `reg copy failed: ${(copy.stdout || copy.error || `exit ${copy.status}`).trim()}` });
        continue;
      }
      const dstQuery = run(['query', dstKey]);
      if (dstQuery.status !== 0) {
        outcomes.push({ ...base, status: 'failed', detail: 'target key missing after copy' });
        continue;
      }
      const dstCounts = parseQueryCounts(dstQuery.stdout);
      const detail = `${srcCounts.subkeys} subkeys / ${srcCounts.values} values at key root`;
      if (dstCounts.subkeys !== srcCounts.subkeys || dstCounts.values !== srcCounts.values) {
        outcomes.push({
          ...base,
          status: 'failed',
          detail: `count mismatch after copy: source ${srcCounts.subkeys}/${srcCounts.values}, target ${dstCounts.subkeys}/${dstCounts.values}`,
          sourceSubkeys: srcCounts.subkeys,
          sourceValues: srcCounts.values,
          targetSubkeys: dstCounts.subkeys,
          targetValues: dstCounts.values
        });
        continue;
      }
      outcomes.push({
        ...base,
        status: 'copied',
        detail,
        sourceSubkeys: srcCounts.subkeys,
        sourceValues: srcCounts.values,
        targetSubkeys: dstCounts.subkeys,
        targetValues: dstCounts.values
      });
    }
    return outcomes;
  } finally {
    for (const mount of [...mounted].reverse()) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (run(['unload', mount]).status === 0) break;
        sleepSync(400);
      }
    }
    try {
      fs.rmSync(tmpHive, { force: true });
    } catch {
      /* best effort */
    }
  }
}
