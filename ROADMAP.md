# Roadmap

Prioritized backlog for OPBS (Open Pickle Backup System). Items in **Planned**
are designed but not
implemented; **Investigate** items need spike work first.

## In Progress

### File-level / image-browse restore
- ✅ NTFS reader (`imaging/fs/ntfs.ts`): boot sector, MFT FILE records,
  update-sequence fixup, attributes (Standard Info / File Name / Data),
  data runlists, directory tree from parent references, resident + non-resident
  file data.
- ✅ `imaging/image-browse.ts`: `ChainPartitionReader` lazily decompresses only
  the blocks covering a requested range and is chain-aware (full + deltas).
- ✅ `imaging/fs/file-browse.ts`: `openBrowse` / `listDirectory` / `readPath` /
  `extractPath` (file or recursive directory), case-insensitive path resolve.
- ✅ CLI: `browse <image> [--partition N] [--path DIR]` and
  `extract <image> --partition N --path DIR --out DEST` (no elevation needed).
- ✅ Mitigated a `zstdify` encoder bug (throws at levels 2-3 on boot-sector-like
  data) with a safe-level fallback in `compressBlock`.
- ✅ Multiple extents and `$ATTRIBUTE_LIST`: files whose data spans multiple
  runs (fragmentation) and files whose attributes span multiple MFT records are
  merged and read correctly via `resolveAttributeLists`.
- ✅ Sparse files: sparse runs (zero offset-field length) are read as zeros,
  so VHD/VM/sparse-database extraction is correct.
- ✅ Alternate data streams (ADS): named `$DATA` streams are parsed and written
  back as `file:stream` during extraction (skipped on non-NTFS targets).
- ✅ `$I30` directory index: `readDirectoryIndex` parses `$INDEX_ROOT` (and
  `$INDEX_ALLOCATION` buffers) so `listDirectory` reads a directory's children
  directly instead of scanning the whole MFT; falls back to the pre-built tree.
- ✅ MFTMirr recovery: if the `$MFT` record 0 is corrupt, `readFileRecords`
  falls back to `$MFTMirr` to recover the `$MFT` runlist.
- ✅ NTFS LZNT1 (LZNTX) compression: `lznt1.ts` decompresses compressed
  chunks (dynamic offset/length split); `readFileData` decodes compressed
  files via compression units.
- ✅ GUI browse view (`BrowseView`): pick an image, choose a partition, browse
  the live NTFS tree (breadcrumbs, `$I30` listing), and extract files/folders
  through a save dialog. Backed by IPC `browse-partitions/list/extract` with
  cached MFT sessions and optional passphrase for encrypted images.
- ✅ EFS: `$EFS` (attribute 0x100) records are parsed per file in the real
  on-disk layout (header + chained DDF/DRF fields, certificate-thumbprint
  credentials) and encrypted files are flagged in the browse tree (🔒).
  Live EFS **decryption** ships in 0.6.58: the file encryption key is unwrapped
  with the owning user's private key through Windows CryptoAPI
  (`src/native/src/efs.cpp`: `CryptAcquireCertificatePrivateKey` +
  `CryptDecrypt`/`NCrypt`), then every 512-byte sector is decrypted in
  `src/main/imaging/fs/efs.ts` (AES-256-CBC, 3DES-CBC, DES-CBC and the DESX
  variant, with the offset-derived IVs and the trailing zero-padding dropped),
  so `readPath`, `extractPath`, folder extraction and the GUI Extract button
  return plaintext. Both observed on-disk size conventions are handled
  (`data_size` spanning ciphertext + pad field, or `data_size` as plaintext
  with `initialized_size` as the extent). With no local key the safe behaviour
  stands: `EFS_ENCRYPTED` for single-file reads, skip for folder extraction.
  Validated live against `cipher /e` (26 B and 5 KB round trips through the
  native unwrap + product decryptor); golden vectors are pinned in
  `test/fixtures/efs-golden.json` so the offline suite covers them too. The
  browse path itself is exercised live as well: Windows' ciphertext and `$EFS`
  attribute are rebuilt into a synthetic NTFS volume and read back through
  `listDirectory`/`readPath`/`extractPath` and ranged reads.

### WinPE / bare-metal restore
- ✅ `media check` / `media create`; `winpe-media.ts` locates the ADK
  (`locateAdk`) and bundled Node, plans the payload (dist + codecs +
  `opbs_native.node` at the path `native-loader` expects + `node.exe`).
- ✅ One elevated PowerShell drive: `copype` → payload into
  `<stage>/media/OPBS` → DISM mount `boot.wim` → inject `startnet.cmd`
  (finds the OPBS folder across drive letters, launches `restore.cmd`) →
  commit → `MakeWinPEMedia /ISO` (or `/USB`, with `--yes` guard).
- ✅ Headless restore via bundled `winpe-entry.js` calling `runCli` under a
  stock Node.exe: `node.exe winpe-entry.js restore <cfg> --elevated`.
- ✅ Pre-seeded restore config: `media create --restore-config <restore.json>`
  drops the config onto the media as `OPBS-restore.json`, so `restore.cmd` runs
  it automatically instead of prompting.
- ✅ GUI flow: `MediaView` checks the ADK/Node tooling, picks an ISO path or USB
  drive letter (with the destructive-write confirmation), optionally pre-seeds a
  restore config, and reports the created media.
- ✅ Third-party drivers: `media create --driver <dir,...>` injects each driver
  folder into the mounted WIM (`dism /Add-Driver /Recurse`) before it is
  committed, so NIC/storage drivers ship on the media.
- ✅ No-UAC staging: `media create --script-only` writes the ADK `build.ps1`
  and returns the path (no `Start-Process -Verb RunAs`), so CI or non-admin
  shells run the script from an already-elevated PowerShell.
- ✅ Headless payload smoke: `media smoke` stages the exact payload (Node,
  dist, native addon, codecs, embedded files) and boots
  `node.exe winpe-entry.js smoke-selfcheck`, which loads the native addon +
  codecs in the *payload* — everything except the live WinPE boot is exercised
  without elevation. The smoke exposed and fixed three real launch bugs: the
  payload's `--cli` prefix, eager `ssh2`/`node-cron`/`electron` requires in the
  CLI graph, and ESM-only `zstdify` (bundled to `dist/zstdify.cjs` for the
  desktop app; the app now starts cleanly in Electron).
- ✅ **Real boot smoke test on physical hardware**: the USB media (label
  `WINPE`) boots through `startnet.cmd` (which runs `wpeinit`) into WinPE and
  `OPBS\test-vhd.cmd` reports `ALL PASS` (disks / network probe /
  `backup --source-vhd` / restore into a fresh GPT VHD), with `judge.js`
  confirming byte-exact partitions on the dev machine (`JUDGE ALL PASS`).
  Evidence: `test/winpe-test-log.txt` + `test/judge-log.txt` on the media for
  2026-10-03 and twice on 2026-10-06 (`ALL PASS` each time, `JUDGE ALL PASS`
  byte-exact) against the refreshed 0.6.60 payload — byte-identical to the
  release build, `smoke-selfcheck` green. The harness is versioned at
  `tools/winpe-live-test/` and includes the network probe (IPv4 + TCP, WARN by
  default, `--require-net` makes it hard).
- ✅ Network drivers: the first probe run reported `ipv4=none` (the stock
  WinPE image carries no driver for the host NIC), so the host's Intel
  Ethernet packages (`e1d.inf` 12.19.2.60/62) were injected into the media's
  `boot.wim` with DISM (`oem0.inf`/`oem1.inf` now in the image); the
  product's supported path for this is `media create --driver <dir,...>`.
  Confirmed on the follow-up boot: `net: ipv4=Ethernet=192.168.178.75
  tcp=true` → `PASS: network probe (IPv4 + TCP reachable)` in
  `test/winpe-test-log.txt` (2026-10-06, together with `ALL PASS` for
  disks/backup/restore). Wi-Fi cannot associate in WinPE — there is no WLAN
  service — so the wired NIC is the supported path.

### zstd compression + multithreaded compression
- ✅ `COMPRESSION_ZSTD = 2` added; `compressBlock`/`decompressBlock` handle
  zstd (via `zstdify`/`fzstd`, both pure JS) and `readImageInfo` accepts it.
- ✅ Multithreaded worker-thread pool (`compression-pool.ts`) compresses blocks
  out of order and resolves in submission order; wired into the backup loop
  (`job.compressionThreads`); sync path preserved when threads ≤ 1.
- ✅ Multithreaded *restore* decompression: the same pool decompresses blocks
  out of order and writes them in submission order; `readFrameFromImage`
  decouples frame read/CRC from decompression; gated on a shared compressed
  codec and `compressionThreads > 1`.
- ✅ Config/CLI/UI threading: `compressionType`/`compressionThreads` on
  `BackupJobConfig`, `ImagingJob`, `RestoreJobConfig`/`RestoreJob`, scheduled
  backups; wizard defaults to zstd; `restore --threads N`.
- ✅ Native zstd in the C++ addon: vendored libzstd v1.5.6
  (`src/native/vendor/zstd`, simple API only, legacy/dictBuilder stripped) is
  compiled into `opbs_native.node`; N-API `zstdCompress`/`zstdDecompress`
  (grow-on-`dstSize_tooSmall`, 2 GiB bomb guard) are used by
  `compressBlock`/`decompressBlock` lazily, falling back to zstdify/fzstd.
  ~4.5× faster compression and reliably encodes content that triggers
  zstdify's FSE encoder bug.
- ✅ **Remaining**: none — zstd is fully native.

### Foreign Macrium browse (.mrimgx / .mrimg)
- ✅ `.mrimgx` (Reflect X) reader validated against the official Macrium demo
  image: footer → chained metadata blocks → `$JSON` navigation → per-partition
  `$INDEX` zstd blocks; `mrimg info`, `browse`, and `extract` all work.
- ✅ `.mrimg` (Reflect 7/8) container: clean-room QuickLZ 1.31 level-2 decoder
  (`quicklz.ts`, MD5-verified against a real 5.9 MB image) plus trailer/footer/
  index parsing (`mrimg-format.ts`): length-prefixed XML, 30-byte block records,
  MBR/GPT + backup-type descriptor, `mrimg info` reports disk geometry and
  compression. Browsing works for partition images whose volume carries a
  resident boot sector; block streams without one (e.g. data-only backups)
  report a clear error instead of a listing.
- ✅ **Unsupported-variant detection (0.6.56)**: encrypted and split images are
  detected from file contents — mrimgx `_encryption`/`split_file` plus a
  skipped (never misparsed) delta `$INDEX` walk, and v7 footer XML `<aes>`
  plus the `-<inc>-<file>.mrimg` filename (sibling parts prove a split) — and
  refused with `MacriumUnsupportedError` from a single shared predicate
  (`macriumUnsupportedReason`) used by the partition reader, the filesystem
  probe (which now surfaces the reason instead of collapsing to "Unknown"),
  and `mrimg info` (prints an `unsupported:` line). The GUI browse view shows
  the refusal reason and hides the useless passphrase box for Macrium images.
  v7 chain members whose base image is present are browsable (see
  **v7 differential/incremental chains** below); mrimgx delta containers and
  chain members missing their base stay refused with a merge-in-Reflect hint
  (superseded by **mrimgx delta chains** below, 0.6.66).

### Foreign Macrium restore (.mrimgx / .mrimg) (0.6.64)
- ✅ `runRestoreJob` auto-detects a Macrium container (`detectMacriumFormat`)
  and dispatches to a dedicated `runMacriumRestoreJob` (`helper/job-runner.ts`)
  — one path for CLI, GUI and the restore-to-VHD route (all call `buildJob`
  then `runRestoreJob`), so no `RestoreJob.sourceKind` field was needed.
- ✅ `buildJob` source adapter (`RestoreSourceView`): placement comes from the
  container itself — `_geometry.start` in bytes (spec-verified `length =
  end - start + 1`) plus the v7 footer's MBR/GPT table entries, matched per
  partition by extent size, which also tighten `geometry.length` to the true
  partition extent (cutting block padding). Containers that record no offset
  are refused with a `--layout P:<offsetBytes>` hint instead of guessing.
- ✅ Streaming write: the `MacriumPartitionReader` decompresses (zstd /
  QuickLZ) and MD5-verifies every block; 4 MiB chunks land at
  `target.offset + pos`, the uncaptured tail/block padding is zero-filled
  unless `clearFreeSpace:false`, grow-on-restore runs through `planNtfsGrow`
  as best-effort (warning, never failure), and `verifyAfterRestore` MD5
  read-back checks the target against the image index. Cancellation,
  progress, fresh-table writes and the restore drill are shared with the
  `.opbs` path.
- ✅ Safety gates reuse `macriumRestoreRefusal` at both `summarizeImage`/
  `buildJob` (throws) and in the runner (clean `ok:false` job result before
  any target byte): encrypted/split containers, mrimgx delta containers,
  v7 chain members missing their base, `backup_format: file_and_folder`, and
  `backup_type: diff/inc` never touch the disk (mrimgx chains now restore
  when their set is on disk — **mrimgx delta chains** below). `verifyBeforeWrite` stays
  false for Macrium (the reader's per-block MD5 is the integrity check),
  encryption keys are never carried, and compression threads default to 0.
- ✅ Surfaces: `summarizeImage` reports the Macrium layout (sizes, offsets,
  `fsType` probe, `backup_time` in seconds → ISO date); the `restore` CLI,
  restore wizard, ConfigBuilder/GUI pickers and drive scans accept
  `.mrimg`/`.mrimgx`; ESP typing works through `probeEspPartition`.
- ✅ Tests: `buildJob` placement/refusal/grow/shrink/fit/summarize (12),
  runner round-trips incl. tail-zero, verify match/mismatch, grow, cancel
  and refusals (8), a real Reflect v7 `.mrimg` sample round-tripped through
  the runner, plus a wizard typed-`.mrimgx`-path test.

### v7 differential/incremental chains (.mrimg) (0.6.65)
- ✅ Chain linkage from the filename `<id>-<inc>-<inc>.mrimg` (base of member
  N is `<id>-<N-1>-<N-1>.mrimg` in the same directory) plus the footer XML
  `<method>`: increment 0 is full, increment 1 (or method 2) is differential,
  later members are incremental. Split detection now only fires for real
  `-00-<n>` part numbers, so chain members are no longer misclassified.
- ✅ Differential: a full-extent 30-byte index whose records for unchanged
  blocks are copies of the base's records (keeping BASE file positions —
  the two files' data regions are independent). The discriminator is the
  per-block md5 vs the base's: equal → `carry`, resolved from the base image
  at the same logical index; different → the changed block is stored in this
  file. Real-sample ground truth: 54 local frames + 5,672 carries + zeros.
- ✅ Incremental: a 34-byte delta index (`{u16, u32 0x00020100, u32
  logicalIndex, u64 filePos, md5[16]}`, header `{u16, u32 count, pad[8],
  md5}` + sentinel) located by a native search for the flag word (a
  differential's footer can be tens of MB); every delta block QuickLZ-
  decompresses and MD5-matches (55/55 on the real sample). Unlisted blocks
  inherit the base's resolution; extent (`blockCount`) and `fsType` are
  inherited at parse time so size reporting, restore planning and the
  reader agree.
- ✅ Reader chain resolution (`mrimg-reader.ts`): `MacriumPartitionReader`
  serves logical blocks through the chain — delta hit → local frame,
  carry/unlisted → recursive base resolution down to the full image —
  with per-block MD5 verification against the record that supplied the
  block. `openMacriumPartitionReader` refuses a member whose base is missing
  (`base image … not found; restore or merge the chain in Reflect first.`).
- ✅ Restore: a restored chain member writes the full logical volume state
  (base + deltas composed by the reader); the refusal gates allow it only
  when the whole chain is on disk. `mrimg info` prints the chain role, base
  and changed-block count; exports carry `MacriumV7ChainMember` and the
  delta constants.
- ✅ Tests (`mrimg-v7-chain.test.ts`, gated on the real
  `imagefilesamples/` chain): role/extent/delta parsing, boot-sector and
  unchanged-block equality across all three members, all 54 differential
  locals and all 55 incremental deltas verified through the reader, and the
  missing-base refusal.

### mrimgx (Reflect X) delta chains (0.6.66)
- ✅ Delta `$INDEX` parsing: 34-byte `DeltaDataBlock` records (`{i64 pos,
  md5[16], u32 length, u16 file_number, u32 block_index}` behind the standard
  reserved-count prefix) into `part.deltaBlocks`; the group cursor advances
  for delta containers too, fixing multi-partition alignment. The composed
  full-extent view lands in `part.blocks` once the set resolves.
- ✅ Backup-set discovery mirroring the reference `createBackupSet`: scan the
  image's folder for the same extension + `imageid` +
  `increment_number <= target` (header-only phase first, so foreign backup
  sets cost one $JSON parse each); map `file_number` (plus `merged_files`
  consolidation aliases) → file for cross-file block routing.
- ✅ Delta composition (`buildIndex`/`mapDeltaToFullIndex`): seed each
  partition from the newest non-delta image's full-extent index, then overlay
  every delta's changed blocks walking seed→newest so the most recent value
  wins; composed elements keep the `file_number` of the file storing their
  bytes. Missing increments below the target are recorded (a pruned middle
  member would silently compose a stale volume).
- ✅ Reader: cross-file elements resolve through `backupSet.files` (per-file
  compression honored); refusals report the missing base
  (`base image … not found`), a missing member file, a pruned increment, or —
  when no set exists at all — the standard delta/incremental set-not-found
  message. Non-delta incrementals/differentials are readable once their set
  is present; lone ones stay refused.
- ✅ `mrimg info` prints the mrimgx chain (role, increment, base file,
  changed-block count, set size); exports carry `MacriumBackupSet*`.
- ✅ Tests (`mrimgx-delta-chain.test.ts`): set composition (routed file
  numbers, delta md5s), full composed-volume reads through the reader,
  hash-failure on base corruption, foreign-set isolation, base-disappears
  refusal, pruned-increment refusal, non-delta incremental with set present;
  fixture builder grew a `delta` option + `buildMrimgxDeltaIndex`.

### Multi-machine fleet control — Tier 0 (0.6.67)
- ✅ Check-in contract (`src/main/fleet/schema.ts`): versioned, flat
  `FleetCheckin` JSON — machine identity (hostname+arch hash, `--machine-id`
  override), per-destination backup health (chain integrity, last run from the
  analytics sidecar, anomaly counts, restore-drill history) and the SMART disk
  inventory; `validateCheckin` accepts unknown fields (forward tolerance) and
  names the exact offending path on reject. Machine status derives from the
  data alone: `critical` (broken chains, critical anomalies, failed latest
  drill, measured SMART problems) > `stale` (no check-in for `stale-days`,
  default 7) > `warning` (warning anomalies, never backed up, unreachable
  destination, unparseable images) > `ok`, each with human reasons.
- ✅ Data producer (`fleet report` / `fleet checkin`, `fleet/report.ts`):
  scans the recent backup destinations (or repeated `--dir`) through the
  existing chain-health/analytics/anomaly/drill readers — best-effort, so a
  dead USB or missing SMART never blocks a check-in; `--no-media` skips the
  PowerShell inventory, `--dry-run` prints the JSON instead of sending.
- ✅ Fleet server (`fleet/server.ts`) — dependency-free `node:http`, no cloud
  services: `fleet serve` holds the CLI process, accepts bearer-token
  (or `X-OPBS-Token`, timing-safe compare) `POST /api/checkin` with a 256 KiB
  cap, keeps the newest document per machine in one atomic `checkins.json`,
  and serves `GET /api/fleet` (aggregate with derived statuses + summary) and
  the read-only HTML dashboard at `/`. Token is generated into the data dir on
  first start (`server-token.txt`); default bind is localhost, `--host
  0.0.0.0` opts into LAN check-ins.
- ✅ Client (`fleet/client.ts`): `fetch`-based `sendCheckin`/`fetchFleet` with
  timeouts and clean failure messages; `fleet status --server <url>` prints the
  fleet summary (exits 1 on any critical/stale machine — cron-friendly).
- ✅ Dashboard (`fleet/dashboard.ts`): single self-contained page — status
  chips, one row per machine sorted worst-first (status, last check-in age,
  last backup age, chains, anomalies, drills, media), reasons inline, auto
  refresh every 60 s. No external assets, no build step.
- ✅ Tests (43): schema validation/status precedence, the report builder
  against real fixture images + fabricated sidecars (incl. critical size
  anomaly, failed drill, unreachable dir, failing SMART inventory), server
  integration (401/400/413/404/405 paths, aggregation, per-machine replace,
  persistence + token reuse across restarts, dashboard/health), client
  round-trip/dead-server/bad-URL, and the store helpers.

### Fleet Tier 1 — scheduled check-ins, staleness, policy distribution (0.6.68)
- ✅ Scheduled check-ins (`schedule install-checkin <name> --server <url>`):
  registers a daily Windows task (default 02:00, `--time HH:MM` or
  `--on-login`, same `--run-as-user`/`--as-system`/`--elevated` knobs as
  `install-drill`) that runs `--cli fleet checkin`. Inline mode embeds
  `--server`/`--token-file`/`--token`/repeatable `--dir`/`--no-media` and
  warns about cleartext tokens or command lines near the schtasks 261-char
  cap; `--settings <file>` mode keeps the task short and the token off it
  entirely — the task just references a JSON settings file.
- ✅ Check-in settings file (`fleet checkin --settings <file>`): JSON object
  `{server, token?, tokenFile?, dirs?, noMedia?, machineId?}` with precise
  type errors; precedence is CLI flags > settings file > `OPBS_FLEET_TOKEN`
  env, so a machine can be configured once and driven from a task forever.
- ✅ Backup-staleness alerts: `fleet serve --backup-stale-days N` (default 14,
  `0` disables) flags machines whose newest backup is older than N days —
  the machine goes `stale` with a `last backup X day(s) ago (threshold Y)`
  reason alongside the existing no-check-in staleness; never-backed-up
  machines stay `warning`, unreachable destinations are already reported
  separately, and `critical` still outranks both. The threshold is exposed
  on `GET /api/fleet` and shown in the dashboard footer.
- ✅ Policy distribution (backup job configs): `fleet policy push <config>
  --server <url> [--name n.json]` uploads to the server, `fleet policy pull`
  downloads every policy (refuses to overwrite existing files unless
  `--overwrite`), `fleet policy list` shows what's published. Server side:
  token-gated `GET /api/policy` + `PUT|POST /api/policy/<name>` with a
  boring `<name>.json` regex (traversal/extension rejected), a 256 KiB cap,
  plain files under `<dataDir>/policies/` (drop files there by hand to
  publish), and unreadable files listed as `invalid` instead of failing.
  No auto-apply yet — machines pull, application lands in Tier 2.
- ✅ Tests (+22, 65 fleet tests): backup-staleness derivation (threshold
  crossed/inside/disabled, never-backed-up, unreachable, critical outranks),
  aggregate with `backupStaleDays`, policy name validation, 401/400/404/405
  policy routes, push→pull round-trip + on-disk store, invalid-file listing,
  and settings load/merge precedence (flags > file > env).

### Fleet Tier 2 — auto-apply at check-in (0.6.69)
- ✅ Auto-apply (`fleet checkin --auto-apply`, or `"autoApply": true` in the
  `--settings` file): before sending, the machine pulls the server's policy
  list and reconciles local state (`fleet/policy.ts`) — new/changed backup
  configs are validated, written to `<policyDir>/<name>.json` and registered
  (or refreshed) as a Windows task `OPBS Fleet <name>` running `--cli backup
  <config> --elevated` on the policy's schedule (`fleetSchedule: {time, onLogin}`,
  default daily 02:00); unchanged policies are skipped by content hash;
  policies that disappeared from the server get their task + local config
  removed. The apply result rides inside the check-in (`policies:
  [{name, status, task?, reason?, appliedAt?}]`).
- ✅ Safety rails: opt-in only (flag/settings — scheduled check-ins get it via
  `schedule install-checkin --auto-apply` or the settings file), token-gated
  pull, and `validateBackupPolicy` refuses any job that is not plainly a
  backup (`kind` must be `backup` or absent — restores/clones/drills never run
  from a pushed policy), requires integer disk/partition fields plus a real
  destination, type-checks known knobs and validates `fleetSchedule.time` as
  24h HH:MM. Policy names are re-validated locally (defense in depth against
  traversal), invalid configs keep their last-known-good task, failed
  registrations leave state untouched so the next check-in retries, and a
  failed pull never removes tasks.
- ✅ Visibility: `validateCheckin` accepts the `policies` array,
  `deriveMachineStatus` turns `invalid`/`failed` into warning reasons on the
  dashboard and `fleet status`, the dashboard gained a Policies column
  (applied/total, failed highlighted), and `fleet policy apply [--dry-run]`
  runs the same reconciliation manually with a printed result table.
- ✅ Tests (+35, 100 fleet tests): config validation (kind gate, field types,
  schedule format, unknown-field tolerance), the full apply lifecycle with
  injected task helpers (apply/unchanged/re-register/removal/invalid-keeps-
  task/failed-retry/remove-error/dry-run/sorted order/state file round-trip),
  check-in contract for the `policies` array, status derivation with policy
  reasons, aggregate surfacing, and settings/flag merge for
  `autoApply`/`policyDir`.

### Fleet Tier 3 — webhook alerting (0.6.70)
- ✅ Alert engine (`fleet/alerts.ts`): transition-based, not status-based —
  a machine is messaged when it *becomes* `critical` or `stale` and again when
  it *recovers* from one of those states; repeats of the same state, `warning`
  and `ok` never fire. `evaluateAlerts` is a pure store→candidates function
  (same status derivation as the dashboard), and `postWebhook` is a timeout-
  bounded JSON POST that reports success/failure without throwing.
- ✅ Two evaluation paths in `fleet serve`: after every accepted check-in
  (fast reaction) and a sweep timer (default every 5 min, `--alert-sweep-minutes`,
  0 disables) — the sweep is what catches machines that *stopped* checking in
  or whose backups aged past the threshold, since a dead machine sends nothing.
  The store is re-read from disk on every cycle so time passes and hand edits
  count.
- ✅ Delivery semantics: `lastAlertedStatus` per machine is persisted in
  checkins.json and only advanced on a successful POST — failed deliveries
  (bad URL, timeout, receiver down) retry on the next cycle; check-in
  overwrites carry the marker across so an unchanged bad status never
  re-alerts. Re-entrancy guard keeps sweep + check-in bursts from double-
  sending.
- ✅ Payload: plain JSON `{event, kind, status, previousStatus, hostname,
  machineId, appVersion, reasons, fleetUrl, at, text, content}` — `text` for
  Slack-compatible receivers, `content` for Discord, everything else is there
  for relays/collectors (ntfy, Grafana, self-hosted). `fleet serve --webhook
  <url>` enables it; delivery is logged, the dashboard is unchanged.
- ✅ Tests (+16, 116 fleet tests): transition matrix (enter/hold/recover,
  warning never alerts), candidate building with reasons + payload shape +
  no mutation, time-based and backup-based staleness, recovery text, webhook
  POST success/5xx/timeout/refused, server integration (critical → quiet →
  recovery round-trip with persisted markers, unreachable webhook leaves the
  marker unset for retry, sweep catching a machine that went silent by
  writing an old receivedAt).


### Disk-to-disk clone (selected partitions → another disk)
- ✅ `CloneEngine` (`imaging/clone-engine.ts`): builds clone jobs exactly like
  a restore (captured offsets by default, custom `targetLayout`, fresh
  GPT/MBR partition table via `buildRestoreTablePlan`), but the source is the
  live volume — no intermediate image or cloud upload.
- ✅ Elevated runner `runCloneJob` (`helper/job-runner.ts`): VSS snapshots the
  source volumes, reads live blocks, and writes them to the target disk at
  `target.offset + blockIndex * blockSize`; optional grow-on-copy via
  `planNtfsGrow` from live metadata; cancellation + progress via the standing
  cancel/progress files; `CloneJobResult` outcome.
- ✅ Safety gates: custom layout requires `acknowledgeLayout` (CLI
  `--confirm-layout`), cloning onto the source disk requires
  `acknowledgeSameDisk` (CLI `--acknowledge-same-disk`), shrinking is
  refused, target fit is checked, `--no-write-table` does raw blocks only.
- ✅ CLI: `clone <config.json> [--elevated] [--used-blocks-only] [--layout
  P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout]
  [--no-write-table] [--acknowledge-same-disk]`; `runCloneJob` dispatched from
  `type: 'clone'` jobs.
- ✅ GUI **Partition Copy**: `CloneManager` (start/cancel/preflight + progress)
  wired to IPC, and a drag-and-drop screen (`PartitionCopy.tsx`) — pick a
  target disk, drag partition chips onto it or “Copy all partitions”, preview
  the auto-sequential 1 MiB-aligned layout (`utils/clone-layout.ts`) with
  optional grow-to-fill, preflight through the engine, confirm the erase
  warning, and stream `clone-progress` to a live bar.

### Used-blocks-only capture (NTFS $Bitmap)
- ✅ `readNtfsBitmap` (`imaging/fs/ntfs.ts`): MFT record 6 (`$Bitmap`), non-
  resident runlist read via record 0 with `$MFTMirr` fallback → cluster size,
  total clusters, bitmap bytes.
- ✅ `readUsedBlockIndexes` (`imaging/fs/used-blocks.ts`): maps allocated
  clusters to capture block indexes; `null` for non-NTFS or unreadable
  bitmaps → full-capture fallback (never a failure).
- ✅ Backups: `--used-blocks-only` (`config.usedBlocksOnly`) skips unallocated
  blocks in `runBackupJob` via the existing `.opbs` gap mechanism (same one
  incrementals use) — no container/format change.
- ✅ Clones: same flag skips free space while copying live.
- ✅ Unit tests: `used-blocks.test.ts`, `clone-job.test.ts`, `clone-engine.test.ts`
  (20 tests) — full suite green.

### Read-only mount of image partitions (WinFsp)
- ✅ Vendored WinFsp SDK headers (`native/vendor/winfsp`, GPLv3-compatible) +
  `binding.gyp`/`addon.cpp` wiring; addon builds cleanly.
- ✅ `native/winfsp_mount.cpp`: read-only volume with the JS bridge
  (`winfspAvailable`, `winfspMount`, `winfspUnmount`). NT paths (`\foo`, root
  `\`); u64 sizes/FILETIMEs travel as decimal strings; replies return NTSTATUS
  as unsigned hex; readDirectory filters entries past the marker to avoid
  enumeration loops.
- ✅ Bridge handler `imaging/fs/mount-fs.ts` over the existing chain-aware NTFS
  reader; `readFileRange` (`imaging/fs/ntfs.ts`) serves ranged reads (resident,
  compressed, non-resident, encrypted → clear error).
- ✅ `imaging/mount-manager.ts`: availability + mount/unmount lifecycle.
- ✅ Elevated mount jobs: `job-runner` `type:'mount'` (`runMountJob` polls the
  cancel file, unmounts, writes result).
- ✅ GUI: `Browse view → Mount as drive / Unmount` + WinFsp hint + status line;
  IPC (`winfsp-status`, `mount-image`, `unmount-image`, `mount-status` events).
- ✅ CLI: `mount <image> --partition N [--letter X:] [--label L]
  [--passphrase p] [--check]`, blocks until Ctrl+C.
- ✅ Unit tests: `mount-fs.test.ts` (bridge stat/read/readDir + export presence,
  `winfspAvailable() === false` on this machine).
- ✅ Live smoke test on a machine with the WinFsp runtime installed
  (shipped 0.6.57): `test/integration/mount-live.test.ts` mounts a generated
  NTFS image as a real drive letter, serves a separate-process probe
  (`opendir`/reads/`stat`/`cmd dir`), unmounts, and verifies the letter is
  gone. Fixed a host-process heap corruption (double-close of a WinFsp file
  context: the second `delete` in `OpClose` detected 0xC0000374 at unmount —
  contexts are now tracked and never freed twice). Non-admin mounts use
  WinFsp's per-LUID volume namespace (auto-detected; GUI shows a hint when
  the runtime is missing).

### Immutable repositories (shipped 0.6.48 — Phase 1)
- ✅ Repository format (`imaging/repository.ts`): `opbs-repo.json` header
  (uuid, algo, key id, default lock) + append-only `opbs-repo.journal` where
  every record (create / prune / unlock) is HMAC-SHA256 signed and chained
  via `seq`/`prev`; `create` records carry per-volume SHA-256 hashes and a
  lock-until date. Key never stored inside the repo — keyfile
  (`~/.opbs/repo-keys/<id>.key`, `OPBS_REPO_KEY_DIR`, `--keyfile`) or
  passphrase-derived (PBKDF2-SHA256, 210k iterations, no file written).
- ✅ Write protection (`utils/file-protect.ts`): a deny ACE with the exact
  mask `DELETE | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
  FILE_WRITE_ATTRIBUTES` (applied via PowerShell/.NET — icacls shorthand and
  .NET-with-SYNCHRONIZE both break Node reads) keeps every read working for
  verify/browse/restore while blocking all write/encrypt paths. The journal
  must stay appendable, so it is chain-verified instead of ACL-protected.
- ✅ Deletion honesty: Windows falls back to the parent folder's
  `FILE_DELETE_CHILD` when a readable file denies DELETE, so deletion cannot
  be ACL-blocked without breaking reads — it is *detected* instead (missing
  files / orphans fail `repo verify`).
- ✅ CLI: `repo init/list/verify/prune/unlock` + `backup --repo <dir>
  [--lock-days N]` (image written into `images/`, signed create record
  appended). Prune chain rules: a root waits for all of its deltas to be
  eligible, deltas prune individually, unlock does not cascade; dry-run
  needs no key. Flag/positional parsing shared in `cli/flags.ts`.
- ✅ Retention guard: automatic retention never touches a repository —
  `planRetention`/`applyRetention` short-circuit with a "use `repo prune`"
  reminder (prevents silent deletes by the normal GFS path).
- ✅ Tests: `test/unit/repository.test.ts` (22 tests — key handling, chain
  tamper/truncation/size/hash/orphan detection, prune eligibility + root
  protection, unlock, retention guard, win32 write-block roundtrip).
- ✅ Phase 2 — GUI: sidebar **Repositories** view (`Repositories.tsx`):
  pick/initialize a repository (remembers the last one via
  `settings.lastRepoDir`), header card with key/chain/orphan badges,
  image table with per-image lock badges, **Verify** (full/fast, streamed
  `repo-progress` events), **Prune** (dry-run → two-step confirm) and
  **Unlock** (per image or all). Backed by `repo-open/init/verify/prune/unlock`
  IPC handlers over `repoOverview()` + the existing repository API; smoke
  tested end-to-end (init → verify → prune → error path) and covered by the
  gui-click integration test.
- ✅ Backup-wizard integration: destination step **"Use a repository…"**
  picker (validated via `repo-open`, routes images to `<repo>/images`,
  per-run lock-days input defaulting to the repository setting),
  `start-backup` finalizes the signed journal record after the run
  (`JobResult.repoRecord`, failures surface as warnings), and the completion
  screen shows the lock date. `repoDir`/`repoLockDays` inside a job JSON
  work for the CLI/scheduler too (`--repo` overrides), profiles persist the
  repository link.
- ✅ Off-box journal anchor (0.6.51): `repo anchor <dir> --to <target>`
  snapshots the exact header + journal bytes (with SHA-256 checksums) to a
  local directory, `s3://bucket/prefix` or `sftp://host/path`, stored as
  `<target>/<repo-id>/opbs-repo.anchor`; `repo verify --anchor <target>`
  byte-compares local vs anchored state and reports rollback (shorter
  journal), rewritten history, header swaps, corrupted anchors and forged
  snapshots as `anchor-missing`/`anchor-mismatch`/`signature` problems.
  GUI: **Anchor target** field + "Anchor now" in the Repositories view
  (target remembered in `settings.lastRepoAnchorTarget`), Verify includes
  the anchor line, and successful repository backups re-anchor automatically
  (`JobResult.repoAnchor`, surfaced on the wizard's completion screen).
  Covered by `test/unit/repo-anchor.test.ts` (14 tests, incl. a mock-S3
  roundtrip). Also fixed: `start-backup` passed the S3 profile into
  `sftpProfile` for `sftp://` destinations.
- ✅ S3 Object Lock uploads (0.6.52): `objectLockMode`/`objectLockRetainDays`
  on the S3 profile (**Settings → Cloud (S3)** UI, or
  `OPBS_S3_OBJECT_LOCK_MODE`/`OPBS_S3_OBJECT_LOCK_RETAIN_DAYS` env for CLI
  jobs) → `buildObjectLock()` attaches `x-amz-object-lock-mode` +
  `x-amz-object-lock-retain-until-date` to every image, sidecar and manual
  chain upload — S3-enforced WORM (GOVERNANCE or COMPLIANCE) that holds
  against a compromised machine. `S3Store.putFile` streams single PUTs ≤16 MB
  and multiparts above (aborting failed uploads), replacing the old
  read-the-whole-image-into-`readFileSync` path; `store put`-style callers
  keep the in-memory `put`. Covered by `s3.test.ts` (16 tests: mock MPU
  initiate/part/complete with assembled-bytes equality, lock headers at PUT
  and initiate, `buildObjectLock` validation, profile/env resolution).
- ✅ Repository S3 mirror (0.6.53): `repo init --remote=s3://bucket/prefix
  [--remote-lock GOVERNANCE|COMPLIANCE]` stores the mirror target in the
  header (no credentials on disk); `recordImageCreate` streams every volume
  to S3 (Object-Lock headers when a lock mode is set) *before* the signed
  `create` record is appended, `repo prune` deletes remote copies first (an
  Object-Lock refusal aborts with the image fully intact), and `repo verify`
  checks the mirror via listing/size (`remote-missing`/`remote-size`/
  `remote-error`). S3 profile plumbed through `repo init|verify|prune` and
  `start-backup` finalization for both CLI and GUI; GUI init form gains the
  mirror URI + Object Lock select, header grid a mirror badge. CLI hardening:
  `flagValue` accepts `--flag=…` and a stray `--` is stripped, because
  Electron's protocol-handler argv check silently exits (-1) when a
  `scheme://` token appears before other arguments (URI args must be last,
  use `--flag=` or precede them with `--`). Covered by
  `test/unit/repo-remote.test.ts` (8 tests, mock-S3 ordering/refusal
  paths) and `test/unit/cli-flags.test.ts` (10 tests).
- ✅ Repository-on-S3 backend (0.6.54): `repo init s3://bucket/prefix` writes
  the header + empty journal into the bucket with conditional
  `If-None-Match: *` puts (plus Object Lock retention when `--remote-lock` is
  set) and records the repository's own location in `header.remote`. Every
  later command runs through `openRepoSession` (`repo-s3.ts`): header +
  journal hydrate into a per-open cache staging dir
  (`~/.opbs/cache/repos/<hash>/s-…`, `OPBS_REPO_CACHE_DIR` override, 24 h
  sweep), the existing local logic runs there, and `flush()` uploads changed
  metadata with `If-Match` against the hydrated ETags — a concurrent writer
  gets a `Repository changed in S3 while it was open` error instead of
  history being overwritten. Image volumes are staged (never cached),
  uploaded before the signed `create` record lands, and the staging dir is
  removed after a successful flush. `repo verify` for S3 targets is
  remoteOnly: one listing covers presence/size/pruned-present/orphans and
  `S3Store.hashObject` streams each active volume's SHA-256 (size-only with
  `--fast`); prune/unlock skip local fs work; `repoOverview` takes a
  precomputed `imageIndex` from the listing. CLI gains `OPBS_S3_ENDPOINT` /
  `OPBS_S3_FORCE_PATH_STYLE` env fallbacks (MinIO/Ceph) and `--remote-lock`
  now applies to s3 init without `--remote`; `verifyWithAnchor` no longer
  drops `s3Profile` from the base verify. Backup (CLI + GUI `start-backup`)
  and all repo IPC handlers are session-wired (flush → cleanup → optional
  re-anchor); a cloud `destinationPath` equal to the repo target is allowed.
  GUI: repository dir accepts `s3://…` (badge *S3 storage*), init form
  switches wording + hides the mirror field, wizard gains *Open S3 repo*.
  Covered by `test/unit/repo-s3.test.ts` (13 tests: conditional init,
  hydrate/flush/conflict, end-to-end verify/tamper/orphans, Object-Lock prune
  refusal, anchor round-trip, cleanup).

## Planned

### Cloud / network destinations
- ✅ `backupLocation` URI handling (`utils/location.ts`): `file://`, `smb://`,
  `smb3://` and UNC (`\\server\share`) locations are normalised into filesystem
  paths, so network-share (NAS) destinations are first-class.
- ✅ S3 backend (`utils/s3.ts`): dependency-free S3 client with AWS SigV4
  signing, PUT/GET/DELETE, ranged GET, ListObjectsV2 (`list`), custom endpoints
  and path-style addressing. `store put/get/list/verify` CLI + backup upload: an
  `s3://bucket/prefix` destination writes the image to a local temp dir, uploads
  after the job, then cleans up. `store verify` re-downloads + runs per-block CRC
  verification.
- ✅ S3 retention: `prune s3://bucket/prefix` lists objects, reads headers
  (ranged GET), reuses the chain/GFS policy, and deletes pruned objects.
- ✅ Cloud settings/UI wiring: `Settings → Cloud (S3)` stores the key
  profile (`resolveS3Config` falls back to AWS env vars; the destination URI
  still picks the bucket/prefix); `restore-engine`/scheduler path not needed —
  `ImagingEngine` injects the profile via `start-backup` for `s3://`
  destinations; a "Test Connection" handler lists objects.
- ✅ SFTP backend: `utils/sftp.ts` (`parseSftpLocation`,
  `resolveSftpConfig` with `SFTP_USER`/`SFTP_PASSWORD`/`SFTP_PRIVATE_KEY` env
  fallbacks, `SftpStore` — an `S3Store`-compatible object store over the
  `ssh2` SFTP subsystem, streamed uploads + ranged reads). `sftp://user@host/path`
  destinations write to a temp dir then stream up after the job; `Settings →
  Cloud (SFTP)` holds the profile with a Test Connection handler; the CLI
  `store put/get/list/verify` and `prune` commands and S3 retention now work
  over either backend (shared `CloudStore` interface). ssh2 works without its
  install script (pure-JS fallback), so the `allow-scripts` guard is not a
  blocker.
- ✅ **Remaining**: none for SFTP.
- ✅ FTP/FTPS backend: `utils/ftp.ts` (`parseFtpLocation`, `resolveFtpConfig`
  with `FTP_USER`/`FTP_PASSWORD`/`FTP_SECURE` env fallbacks, `FtpStore` — an
  `SftpStore`-compatible object store over the `basic-ftp` client, streamed
  uploads + ranged reads). `ftp://user@host/path` (and `ftps://` implicit)
  destinations write to a temp dir then stream up after the job; `Settings →
  Cloud (FTP/FTPS)` holds the profile with a Test Connection handler and a TLS
  mode selector (Explicit TLS default; implicit; plain opt-in). The CLI
  `store put/get/list/verify` and `prune` commands work over FTP too. Images
  stay AES-256-GCM encrypted regardless of transport.

### Native partition-table builder (dissimilar-hardware restore)
- ✅ Native addon `buildPartitionTable(scheme, lbaCount, entries, {diskGuid})`
  emits a full GPT layout (protective MBR @0, primary header @LBA1, primary
  entries @LBA2, backup entries @lastLBA−32, backup header @lastLBA, with
  header/entry CRCs, deterministic disk GUID, UTF-16LE entry names) or an MBR
  table (≤4 entries, bootable flag, 0x55AA signature) as a list of byte regions.
- ✅ TS planner (`partition-table.ts`): automatic scheme selection (MBR only
  when representable — ≤4 partitions, ≤2 TiB, 32-bit LBAs, ≥LBA63 offsets —
  otherwise GPT), overlap/alignment/bounds validation, and a serializable
  `RestoreJob.writeTable` plan handed to the elevated helper.
- ✅ Safety gate: a custom layout that moves a partition away from its captured
  offset now requires `acknowledgeLayout:true` (CLI `--confirm-layout`);
  otherwise the restore refuses with an explicit warning. `writePartitionTable:false`
  (`--no-write-table`) restores raw blocks only.
- ✅ `restore --table-scheme gpt|mbr|auto`, `--table-disk-guid`/JSON-config
  `tableDiskGuid`, per-partition `tableTypeGuids`, and `tableBootPartition`
  (MBR boot flag). The elevated runner lays the table down before any
  partition blocks via `writeBlocks`.
- ✅ Disk-identity safety: backups record the source disk's model/serial in
  the image header. A dissimilar restore onto the *same physical disk* the
  image came from (matching serial) is refused unless
  `acknowledgeSameDisk:true` (`--acknowledge-same-disk`); a same-model
  different-serial target only produces a warning hint surfaced on the
  result.
- ✅ Filesystem grow-on-restore: `ntfs-resize.ts` plans an NTFS grow (boot
  total-sector patch, $Bitmap run/size extension + free-tail write, $BadClus
  sparse extension) using canonical BPB offsets; `--layout P:OFF[:SIZE]` (or
  `targetLayout[].size`) grows the partition after the blocks are written.
  Shrinking is refused; non-NTFS/growable layouts become warnings, never
  failures.

## Investigate

### Dissimilar-hardware restore
- ✅ Layout mapping: a restore may specify `targetLayout` (or CLI
  `restore --layout 0:4096,1:8388608`) to re-order/move captured partitions to
  different target offsets; placements are validated against target disk size.
- ✅ Partition-table builder + disk-identity guards + filesystem resize: see the
  "Native partition-table builder" section.

### Changed-block tracking via NTFS USN journal
- ✅ Native addon `queryUsnJournal` + `getUsnJournalInfo` read the NTFS USN
  journal (FSCTL_QUERY/READ_USN_JOURNAL); exposed via the CLI
  `usn-changes <volume>` (requires elevation).
- ✅ `computeChangedBlockIndices` maps USN change records (files) to changed
  block indices via the MFT; `runBackupJob` reads only those blocks for an
  incremental (`useUsnJournal`), falling back to a full scan whenever the
  journal is unavailable or uncertain. The journal position is recorded in a
  `.usn` sidecar after each run.
- ✅ **Remaining items (0.6.55)**: per-partition USN cursors (each volume-backed
  partition's journal position is captured pre-snapshot, stored in a v2
  `.usn` sidecar keyed by `{partitionIndex, volume}`, and never inherited
  across volumes; missing/foreign sidecars repair instead of disabling the
  journal) plus a tunable `usnFullScanThreshold` (GUI percent input, CLI
  `--usn-full-scan-threshold PCT`, scheduled-backup passthrough) that reverts
  to a full sequential scan when the flagged-change fraction exceeds the
  threshold.

### Delta-on-delta chain compaction
- ✅ `runBackupJob` unions the block CRCs of the *whole* ancestor chain
  (full image + every intermediate delta via `baseImagePath` links) instead of
  only the immediate parent, so a delta never rewrites a block a grandparent
  already holds. Skipped-block accounting still reflects the true source bytes.

### Self-healing verification / read-scrub
- Periodically re-read archived images and report bit-rot via CRC mismatch;
  optionally rebuild a degraded image by re-reading the source snapshot if still
  available. **Done (MVP)**: in-app cron-scheduled verification while the
  app runs (Settings → Scheduled Verification), plus native headless verification
  tasks via `--cli schedule install-verify` that run without the app being open.
- ✅ **Alert on repeated failure (webhook)**: `ConsecutiveFailureTracker`
  counts consecutive verification failures and only notifies once the
  `alertAfter` threshold is reached (default 2), so transient blips don't spam
  while persistent problems are surfaced; count resets on success/after alert.
- ✅ **Prune exceeding retention**: the scheduled verification run applies
  retention/GFS pruning when `autoCleanup` is enabled, mirroring the backup path.
- ✅ **Scrub-while-idle**: an optional low-frequency background task
  (`scrubWhileIdle` + `scrubIntervalHours`) re-verifies the newest images in the
  configured backup location and reports bit-rot through the same alert/prune
  channel, so degradation is caught proactively even without a configured
  verification schedule.

### Resumable imaging (interrupted backups)
- ✅ `scanPartialImage()` (`image-format.ts`): walks a partial image file
  (no block index yet) by reading self-describing compressed block frames,
  validates CRCs for plaintext, structurally validates encrypted frames, and
  returns completed partition counts, a resume cursor, and recovered
  `BlockRecord[]` for frames already written. `ResumeCheckpoint` type tracks
  the cursor and counters to seed a resumed run.
- ✅ `BackupJobConfig.resume?: boolean` gates resume detection in
  `buildJob()`: when set, a partial image at the target path is scanned
  and, if compatible (partition count, block size, compression, cipher match),
  the job carries a `resumeCheckpoint` through to the elevated helper.
- ✅ `runBackupJob` resume path: opens the image `'r+'` (not truncate),
  pre-seeds `blocks`/`partitionEntries` for completed partitions from the
  scan, skips those partitions in the capture loop, appends new frames from
  the interrupted partition's start offset, and writes the final block index
  as usual. `FLAG_RESUMED` is set in the header on completion and
  `JobResult.resumed` reflects the flag.
- ✅ Failure-path cleanup: when `job.resume` is true the partial image is
  *kept* on failure so a later `--resume` run can continue; otherwise it is
  deleted (default behaviour).
- ✅ CLI `--resume` flag on `backup`, unit tests for `scanPartialImage`
  (complete, truncated, corrupt-CRC, multi-partition) and for a resumed
  `runBackupJob` (partial image, kept frames, `FLAG_RESUMED`, verify).
- ✅ Backup wizard resume toggle, CLI `resume-list` to show interrupted
  images with frame-count progress, and resume-specific progress messages
  (`[resuming]` in CLI progress bar, highlighted UI banner).

### Hardware-accelerated crypto / native hashing
- ✅ Native CRC-32 (`crc32`) added to the addon and wired into `image-format`
  (lazy, graceful JS fallback) so per-block hashing during backup/verify runs in
  native code.
- ✅ PBKDF2 + AES-256-GCM already run through Node's OpenSSL-backed `crypto`
  (hardware-accelerated via CPU AES-NI), so no addon move is required for those.
- ✅ **Declined (2026-10-06, measured)**: porting PBKDF2/GCM into the addon.
  Benchmarks on the reference machine: PBKDF2-SHA256 @ 210k = 82 ms (run once
  per backup/restore/verify), AES-256-GCM = 850 us per 1 MiB block
  (~1.18 GB/s; only ~43 us of that is JS↔OpenSSL call overhead) versus
  ~20 ms of deflate for the same block. A perfect native port would therefore
  save at most ~40 ms once per job and roughly 5% CPU on a 100 GiB encrypted
  backup — while adding a second hand-maintained crypto implementation to the
  addon (audit + memory-safety surface and a duplicate OpenSSL-vs-BCrypt test
  matrix). Encryption stays on Node's OpenSSL-backed `crypto`; if it ever
  shows up in a profile, prefer overlapping it with the compression workers,
  larger blocks for encrypted images, or fewer frame Buffer copies over
  porting.