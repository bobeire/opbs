# Design: User-State Migration (`migrate`)

**Status**: Phase 2 shipped — `migrate inventory` / `migrate plan` /
`migrate run` (tier-1 execute, verify, report) plus tier 2 (curated
registry transplants with `--registry`, owner/SID rewrite) are live.
Phase 3 shipped — knowledge base expanded to 43 seed apps with
validated schema + contribution docs (§7); `--apps-db` files merge over
the seed. Phase 4+ are design-only.
**Date**: 2026-10-20 (design), 2026-10-21 (phases 1 + 2 + 3)
**Related**: [ROADMAP.md](ROADMAP.md) (Investigate), [README.md](README.md)
(imaging, mounts, VHD restore)

## 1. Problem

When a machine is replaced or a Windows install is rebuilt, the data people
actually care about — profiles, mail stores, browser state, chat histories,
game saves, per-app settings — lives scattered across `%USERPROFILE%`,
`%APPDATA%`, `%LOCALAPPDATA%`, and per-user registry hives. Today that
means either a paid tool (PCmover, Zinstall, EaseUS Todo PCTrans), a
Windows built-in that was killed in Win10 (Easy Transfer), or Microsoft's
enterprise-only CLI (USMT's `scanstate`/`loadstate`) that most people have
never heard of.

OPBS already owns the hard primitives for the first two sources of truth
an old machine leaves behind: **full-disk images** (`.opbs`, Macrium
`.mrimg`/`.mrimgx`) and the machinery to read them without the original
hardware (file-level browse, read-only WinFsp mounts, restore-to-VHD).
The missing piece is the last mile: **turning an old image into a migrated
user environment on a live new install.**

## 2. Goals

1. Migrate **user profile data and per-user settings** from an image (or
   attached volume) onto a live Windows installation.
2. Be **honest about applications**: inventory them, migrate their data and
   settings where safe, and produce a reinstall manifest for the binaries.
   Never pretend installed programs can be copied between machines.
3. Follow the OPBS trust contract already established for Macrium images:
   **dry-run by default, refuse dangerous cases up front, verify after,
   never leave a half-finished state the user can't reason about.**
4. Work headlessly (CLI + JSON) first; GUI wizard later.

## 3. Non-goals

- **Copying installed program binaries** between machines. Licensing
  (device-bound activation), COM registrations, services, drivers and
  per-machine paths make this a trap; commercial tools that promise it
  still ship long "reinstall anyway" lists.
- **Migrating the operating system.** The target runs its own Windows;
  we migrate user state into it.
- **Driver-level / kernel-integrated software** (antivirus, virtual disk
  filters, niche hardware suites): reinstall-only, always.
- **Domain/GPO-managed state.** Managed machines re-apply policy; profile
  migration is for workgroup/personal machines in v1.
- Cross-architecture edge cases beyond x64→x64 in v1 (ARM64 targets are a
  later phase).

## 4. The three tiers

| Tier | Content | Mechanism | Confidence |
|---|---|---|---|
| **1. Profile data** | Documents, Desktop, Downloads, Pictures…, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` dot-folders, known app data stores | File copy + ACL rewrite | Safe default; ~80% of the value |
| **2. Per-user settings** | Selected per-user registry keys (browsers beyond profile dirs, terminal emulators, app preferences stored in `NTUSER.DAT`) | Offline hive transplant (`reg load` → key-level copy → `reg unload`) | Curated list only; every key versioned in the app knowledge base |
| **3. Programs** | Installed-app inventory | Uninstall-key scan → human list + `winget export` JSON | Reinstall on target; we never move binaries |

Tier 3 output is a feature, not an apology: `winget import` on the new
machine is a better 2026 answer to "reinstall my apps" than any
binary-copy scheme.

## 5. Source models

All sources funnel into one abstraction: *a readable NTFS volume + its
user profiles*.

| Source | Existing machinery |
|---|---|
| Live local disk | Direct read (existing disk access path) |
| `.opbs` / Macrium image | `image-browse.ts` / `ChainPartitionReader` (browse chain members; placement from image geometry) |
| Image partition → WinFsp mount | `mount-manager.ts`, `mount-fs.ts` (read-only) |
| Image partition → VHD attach | `targetVirtualDisk` restore path (attach on target, migrate from the mounted VHD) |
| External drive with an old Windows install | Direct volume read (classic "pull the disk, plug it in") |

The VHD route matters for the flagship story: *restore the old machine
into a VHD on the new PC, attach it, migrate the profiles onto the live
OS* — no bare-metal restore on the target, no second machine needed.

## 6. Pipeline architecture

```
source ──▶ inventory ──▶ plan (dry-run JSON) ──▶ execute ──▶ verify ──▶ report
                                                              │
                                              reinstall manifest (winget + list)
```

### 6.1 Inventory

- **Users**: enumerate profile directories + SIDs (`profileList` registry
  key of the *source*), detect domain vs local, note roaming/missing
  profiles.
- **App scan**: uninstall keys (`HKLM/HKCU\...\Uninstall\*` +
  `WOW6432Node`) from the source hive; map each entry through the app
  knowledge base (§7) to a migration class.
- **Data scan**: per-user folder sizes, known store detection (PST/OST,
  browser profiles, chat DBs, save-game folders), free-space check on
  target.
- **Exclusions**: pagefile/hiberfil/recycle bin/system profile/`AppData\Local
  \Temp`, plus per-class excludes from the knowledge base.

### 6.2 Plan (dry-run)

A serializable `MigratePlan` (same pattern as `NtfsShrinkPlan`): every
file move with sizes and hashes-to-verify, every registry key transplant,
every refusal with a reason, the reinstall manifest, and a total-space
requirement. `opbs migrate --plan` prints it; `--json` emits it. Nothing
writes without an accepted plan.

### 6.3 Execute

- **Files**: copy engine with progress, long-path handling, reparse-point
  policy (skip junctions into system trees; follow safe ones), sparse and
  compression attribute preservation where practical, ADS carried where
  the reader supports it.
- **Registry**: per-user hive transplants (§8) run after files for each
  profile; failures mark that profile's settings tier failed without
  aborting file data already verified.
- **Transactions**: per-profile unit of work. A crash mid-profile leaves a
  journal for `migrate --resume` (same philosophy as backup `resume`).

### 6.4 Verify

Post-copy verification pass (hash compare for a configurable sample or
full set; full by default for v1 — migration is one-shot and
latency-tolerant), registry key/count verification, then a
`MigrationReport`: migrated / skipped / refused / needs-reinstall, with
paths. This is the "migration drill" answer to the project's
prove-your-restore thesis.

### 6.5 Reinstall manifest

- `winget export -o apps.json` executed **on the source** when live, or
  synthesized from the inventory's knowledge-base winget IDs when the
  source is an image (best-effort; ids may be missing — the human-readable
  list is the fallback).
- A plain-text report groups: automatic (winget id known), manual
  (installer must be fetched), reinstall-only (driver-level, excluded).

## 7. App knowledge base

An open, versioned JSON dataset (shipped in-repo as
`src/main/imaging/migrate/apps-db.ts`, user-extendable via
`--apps-db <file>`), one entry per app:

```json
{
  "id": "google-chrome",
  "name": "Google Chrome",
  "data": ["%LOCALAPPDATA%/Google/Chrome/User Data"],
  "registry": ["HKCU/Software/Google/Chrome"],
  "winget": "Google.Chrome",
  "class": "data+settings"
}
```

| Field | Required | Semantics |
|---|---|---|
| `id` | yes | kebab-case, unique — keys JSON output and `--include/--exclude` |
| `name` | yes | display name |
| `data` | yes (may be `[]`) | profile-relative data locations; tokens `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%` resolve per profile (backslashes or slashes accepted) |
| `registry` | no | per-user subtrees planned for the tier-2 transplant — **HKCU only** |
| `winget` | no | `Publisher.Package` id for the reinstall manifest; omit when unknown |
| `class` | yes | `data` \| `data+settings` \| `reinstall-only` (AV, Office suites, anything COM/service heavy — `data` paths ignored) \| `ignore` (skipped entirely) |

**Loader validation** (applies to the seed and every `--apps-db` file;
errors name the entry and the file): required fields present, kebab-case
unique ids, class from the enum, registry keys under `HKCU` (HKLM is never
written — §8), data paths free of unknown `%TOKENS%` and not
drive-absolute, winget ids shaped `Publisher.Package`.

**Merge semantics**: the file is a JSON array of entries that merges *over*
the seed by `id` (same id overrides the seed entry; new ids are added;
`migrate plan --apps-db` runs the full validation on load).

### Contributing entries

The seed currently carries 43 apps across browsers, mail, chat, dev tools,
media, utilities and game launchers — growth is a community-maintenance
problem, same shape as USMT's migration.xml, but open and diffable:

1. Copy a seed entry as your template; keep paths to the smallest
   meaningful directory (prefer real user files over regenerable caches).
2. Verify the winget id before adding it: `winget show --id Publisher.Package --exact`.
   No confident id? Leave `winget` out — the app then falls back to the
   manual-install list instead of a broken import.
3. Only well-known per-user `HKCU` keys; if you can't confirm the key
   exists (`reg query`), leave `registry` out — a missing key merely
   skips in the report, but noise erodes trust in the tier.
4. Test against a real profile: `migrate plan --live --profile <you>
   --apps-db my.json` must load the file without validation errors and
   list your stores.
5. Open a PR against `apps-db.ts` (or attach the JSON in an issue) —
   entries land with the next release.


## 8. Registry strategy (the hard part, scoped)

- Only **per-user hives** are touched. Source `NTUSER.DAT` is loaded
  offline under a temporary mount point (`reg load HKU\opbs_migrate_<id>`),
  selected subtrees from the knowledge base are exported/copied into the
  **target** user's hive (also loaded via the same mechanism, or written
  through the loaded target), then unloaded.
- **HKLM is never written.** Machine-wide state belongs to reinstall (§3).
- Key-level fidelity: values, types, subkeys; no attempt at COM class
  registration or service configuration — refuse if a knowledge-base
  entry asks for it (schema has no field for it, deliberately).
- Hive files from the source are never dropped in wholesale: per-user
  hives contain machine-specific and SID-specific state (device lists,
  MRU paths, class registrations). Wholesale hive replacement is a
  documented footgun; key-level transplant is the product.
- Registry verification: post-transplant key existence + value-count
  checks recorded in the report.

## 9. Identity, ACLs and security

- **SID mismatch is the default case** (new local account ≠ old SID).
  Files are copied as the migrating user (elevated), then ACLs rewritten
  to grant the target profile's SID the old owner's rights
  (`icacls`/security APIs; owner → target user, inheritable ACEs from the
  target profile root). The old SID may be retained as an audit trail
  entry, never as an active grant beyond what the plan shows.
- **EFS**: encrypted source files are detected via the existing EFS
  reader path. v1 policy: **copy decrypted** (we're elevated on a
  unlocked volume, plaintext is readable) and do **not** re-encrypt or
  migrate EFS private keys — documented, report-flagged. BitLocker source
  volumes must be unlocked before the run (detected → refused otherwise).
- **Passwords/secrets**: browser "Login Data" DBs copy as files; we never
  extract or re-inject OS credentials, DPAPI master keys are **not**
  migrated (they are machine/user bound — copied browser profiles may
  need re-login; the report says so). This is the honest behavior: better
  a password prompt than a broken security model.

## 10. Safety and refusal philosophy

Same contract as the Macrium reader, applied end to end:

- **Dry-run is the default**; `--execute` requires an accepted plan hash.
- Refuse up front, with reasons: unlocked BitLocker, missing chain
  members (image source), insufficient target free space, target profile
  does not exist yet (we do not create Windows accounts in v1), unknown
  app class with user-data overlap (asks for an explicit `--include`).
- No overwrite of existing target files without `--merge` (default:
  collision aborts that profile's file tier and is reported).
- Journal + `--resume`, like backup `resume`.

## 11. Surfaces

CLI first:

```
opbs migrate inventory --from <image|disk|vhd> [--json]
opbs migrate plan      --from ... --profile <name|all> [--json]
opbs migrate run       --from ... --profile <name|all> [--execute] [--resume]
opbs migrate report    <plan-file>
```

GUI (phase 4): a wizard that is a thin shell over the same CLI verbs —
source picker (image/disk/VHD), profile checkboxes with sizes, plan
review, progress, report. Config-builder JSON gains a `migrate` block for
scripted fleets.

## 12. Prior art

- **USMT** (`scanstate`/`loadstate`, ADK): the reference implementation
  for user-state migration; unattended, XML-configurable, enterprise
  UX-free. Our knowledge base is a friendlier, open cousin of
  `migapp.xml`/`miguser.xml`.
- **Windows Easy Transfer** (killed in Win10): proof there is consumer
  demand and that file+settings-only scope has a ceiling — tier 3's
  winget manifest is how 2026 crosses that ceiling honestly.
- **PCmover & friends**: prove the market; their "copy installed apps"
  claims are the exact overpromise this design refuses.

## 13. Risks and open questions

1. **Registry transplant blast radius** — mitigated by per-key
   knowledge-base curation, dry-run diffs, and per-profile units. This is
   the part that gets the most test matrices (per app: clean install →
   transplant → app launches and sees settings).
2. **SID translation edge cases** — junctions/reparse points, OneDrive
   placeholder rehydration, sparse files. Each needs explicit tests.
3. **winget id coverage** — synthesis from images will be lossy; the
   human-readable fallback list must be genuinely useful on its own.
4. **Scope creep toward "migrate Windows"** — actively resisted; every
   non-goal above exists to keep this shippable and trustworthy.
5. **Legal**: per-user data migration is the user's own data; we provide
   no assistance for circumventing application licensing (the reinstall
   manifest assumes legitimate entitlements).

## 14. Phasing

- **Phase 0 (spike) — shipped 2026-10-20**: mount an existing image →
  inventory users/apps → emit a dry-run plan. No writes. Validates the
  knowledge base and the inventory scanner against real machines.
  *Uses only shipped OPBS.*
- **Phase 1 (v1) — shipped 2026-10-21**: tier 1 (file data) execute via
  `migrate run`: dry-run by default, `--execute` gated on the printed
  plan hash, per-file journal + `--resume`, `--merge` collision policy,
  reparse/legacy-junction skips, post-copy verify (MD5; size-only
  fallback for large image reads), `report.json` + `winget-import.json`
  artifacts. ACL policy: files are copied into the *existing*
  target Windows profile, which grants access by inheritance; live
  copies carry content and timestamps only (no ADS/EFS metadata — the
  report says so per run). Owner rewriting lands with tier 2.
- ✅ **Phase 2 — shipped 2026-10-21**: tier 2 registry transplants for the
  curated knowledge-base keys (`migrate run --execute --registry`,
  elevated shell): the source `NTUSER.DAT` is extracted through the
  migrate source (one path for live disks and image partitions), loaded
  under a temporary `HKU` mount, keys moved key-level with `reg copy /s
  /f` (never a wholesale hive replacement), count-verified after copy,
  mounts always unloaded. Target hive is written through its loaded root
  when the profile is logged on, otherwise loaded in place. Owner/SID
  rewrite on the copied tree is on by default when elevated
  (`--no-owner` to skip): the copied folder roots get
  `icacls /setowner <target-SID> /T`, rights arrive via target-profile
  ACL inheritance. Both tiers are injectable (fake `reg`/`icacls`/identity
  runners) and fully unit-tested without admin rights; failures mark the
  settings tier failed in the report without touching verified file data.
- ✅ **Phase 3 — shipped 2026-10-21**: knowledge base expanded 18 → 43
  apps (browsers, chat, dev tools, media, utilities, game launchers —
  every winget id verified against winget-pkgs; three seed ids fixed or
  added where the old ones didn't resolve, FileZilla ships without a
  winget id since it's no longer in the source). Schema hardening:
  `validateAppsDbEntries` runs over the seed *and* every `--apps-db`
  file — kebab-case unique ids, enum class, HKCU-only registry keys
  (the §8 promise enforced at load time), known `%TOKENS%` only, no
  drive-absolute paths, `Publisher.Package` winget shape.
  §7 is now the contribution reference: field table, merge semantics,
  validation errors, and a 5-step recipe for testing a file against a
  real profile before PR.
- **Phase 4**: GUI wizard, migration "drill" scheduling (dry-run against
  a periodic image — the migration analogue of restore drills).

Rough effort: phase 0 is days; phase 1 is the first multi-week block
(copy/ACL/verify hardening); phase 2 adds a focused registry workstream
with per-app test fixtures; phase 4 is UI work over stable verbs.
