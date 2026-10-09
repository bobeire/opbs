# OPBS — Open Pickle Backup System

The ultimate FOSS imaging solution

A FOSS disk imaging backup solution for Windows, inspired by Macrium Reflect.
created by **RHITCS** — named in honour of a certain well-preserved pickle.

Website: https://opbs.rhitcs.com

## Features

- **Disk & partition imaging** with per-block CRC-32 integrity checking
- **VSS support**: back up live systems using Windows Volume Shadow Copy Service
- **Compression**: Zstandard (zstd) with multithreaded worker-thread compression, plus classic zlib deflate for backward compatibility; multiple levels to balance speed vs. size
- **Incremental backups**: deltas capture only changed blocks against a base image; restore chains replay base + deltas in order. Optionally the NTFS **USN journal** (`useUsnJournal`) is used to read only the blocks touched by changed files instead of scanning the whole volume — with per-partition cursors in a `.usn` sidecar and a configurable `usnFullScanThreshold` that reverts to a full scan when too much of the volume changed (falls back to a full scan whenever the journal is unavailable or uncertain).
- **Resumable imaging**: `resume` (CLI `--resume`) continues an interrupted local backup from the partial image already at the target path — completed partitions are kept and the run resumes at the next partition boundary instead of restarting from scratch.
- **Used-blocks-only capture**: `usedBlocksOnly` (CLI `--used-blocks-only`) reads the NTFS `$Bitmap` and stores only blocks containing allocated clusters, dropping free space; non-NTFS partitions fall back to a full capture.
- **Read-only mount via WinFsp**: mount a partition from a `.opbs` or Macrium image as a virtual drive letter with **zero extra disk usage** — file reads are served lazily by decompressing only the covering blocks. Requires the free WinFsp runtime (https://winfsp.dev). Works for standard (non-admin) users through WinFsp's per-LUID volume namespace; a live smoke test covers mount → cross-process probe → unmount.
- **Restore from Macrium Reflect images**: `restore` also accepts Macrium `.mrimgx` (Reflect X) and `.mrimg` (Reflect 7/8) containers — placement is read from the image's own geometry/table entries, every block is decompressed and MD5-verified before it lands on the target, and unsupported variants (password-protected, split, file-and-folder backups, chain members with files missing from disk) are refused up front instead of touching the disk. v7 (`.mrimg`) **and mrimgx (Reflect X) delta** differential/incremental chains browse and restore when the base images / backup set are on disk — the member is resolved against its chain so you always see/restore the full logical volume state. Works from the CLI, the restore wizard and the Config Builder.
- **Disk-to-disk clone**: `clone` copies selected live partitions straight onto a different local disk (VSS snapshots, optional dissimilar layout + fresh GPT/MBR table, optional grow-on-restore), with no image file or cloud upload. The GUI **Partition Copy** screen makes this drag-and-drop: pick a target disk, drag partition chips onto it (or “Copy all partitions”), preview the auto-sequential 1 MiB-aligned layout with optional grow-to-fill, confirm the erase warning, and watch live progress.
- **Backup from a virtual disk (VHD/VHDX)**: `sourceVirtualDisk` (CLI `--source-vhd`, or "Back up from a VHD/VHDX file…" on the backup wizard's source step) images a `.vhd`/`.vhdx` file directly — the elevated helper attaches the file **write-protected** (no drive letter), discovers the physical disk index it maps to, builds the ordinary backup job (empty partition selection = every partition on the file), runs it, then detaches. No need to mount the volume or run the backup against the host's live disks.
- **Restore into a virtual disk (VHD/VHDX)**: `targetVirtualDisk` writes a restore into a `.vhd`/`.vhdx` file instead of a physical disk — the helper creates the file when missing (dynamic or fixed, up to 64 TiB), attaches it, re-runs every physical-disk safety gate against the attached disk, writes a fresh GPT/MBR table so the volumes are visible in Windows, then detaches the disk again. Available from the restore wizard, the Config Builder and JSON configs.
- **Disk tools**: the **Disk Tools** screen (sidebar 🔧) groups four maintenance utilities — **MBR & Boot Repair** (read partition-table info from `Get-Disk`/`Get-Partition`, read the raw 512-byte MBR sector elevated for a full entry/CHS breakdown including the boot and disk signatures, and repair boot code / rebuild the BCD store via elevated `bootrec.exe`), **Disk Error Check** (read-only `chkdsk /scan`, plus elevated `/f` and slow `/r` modes), **SSD TRIM** (query `fsutil behavior query DisableDeleteNotify` and run an elevated `defrag /L` retrim), and **SMART Health** (per-disk reliability counters for every physical disk).
- **Encryption**: optional AES-256-GCM per-block encryption (master-key-derived via PBKDF2-SHA256)
- **Verification**: self-check images after write and before restore
- **Retention / GFS pruning**: keep the newest N full chains plus a bounded number of trailing deltas per chain; old images are pruned leaf-first. Retention runs after backup/verification when global auto-cleanup is on, and each scheduled backup can opt into its own retention policy (keep counts + age floor) independent of the global setting.
- **Immutable repositories**: append-only, HMAC-signed local repositories with time-based locks (`repo init` / `list` / `verify` / `prune` / `unlock`), write-protected images (reads keep working, writes are refused) and a tamper-evident chain of signed audit records — software-based WORM for backups, no special hardware needed.
- **Multi-machine fleet dashboard (central control, self-hosted)**: run `OPBS.exe --cli fleet serve` on any one machine — no cloud services, no database; check-ins live in a single JSON file. Every other machine runs `fleet checkin --server http://central-host:8787` (ideally as a scheduled task right after its backup) and posts its backup health: restore-chain integrity, last backup, anomaly counts, restore-drill results and SMART status. The dashboard at the server URL answers "did my fleet back up last night?" with one green/amber/red row per machine, and `fleet status --server <url>` gives the same verdict for scripts (exits 1 when any machine is critical or stale). Enrolling a machine is one command: `schedule install-checkin <name> --server <url>` registers a daily task (default 02:00) — use `--settings <file>` to keep the token out of the task definition entirely. The server also flags machines whose backups *stopped*: after `--backup-stale-days` (default 14, `0` disables) without a backup the machine turns stale with the reason on its row, next to the existing 7-day no-check-in staleness. Backup job configs can be published as policies — `fleet policy push <config.json> --server <url>` on the server, `fleet policy pull` on each machine, or turned on with `fleet checkin --auto-apply` (`"autoApply": true` in the settings file): each check-in then reconciles the machine against the server — new and changed backup configs are validated and registered as scheduled backup tasks (`OPBS Fleet <name>`), removed policies have their tasks deleted again, and every apply result comes back in the check-in (visible as a Policies column and warning reasons). Auto-apply only ever runs plainly-backup jobs, is opt-in, and `fleet policy apply --dry-run` previews it. Add `fleet serve --webhook <url>` and the server pushes a JSON alert (Slack/Discord-compatible `text`/`content`, plus structured `kind`, `status`, `reasons`, `hostname`) the moment a machine becomes critical or stale — and again when it recovers. Machines that silently stop checking in are caught by a periodic sweep (default every 5 minutes), failed deliveries retry until acknowledged, and no alert ever repeats while the state stays the same. Check-ins are bearer-token authenticated (generated on first start), the dashboard is read-only, and the server binds to localhost until you opt into `--host 0.0.0.0`.
- **Scheduling + notifications**: scheduled backups run from a friendly
  day-picker (daily / chosen weekdays / a specific day of the month + time,
  with a raw cron editor for power users), with Windows toast + optional
  webhook notification on success/failure. The same picker works for
  scheduled backups targeting a network share (UNC or smb://).
- **Disk health warnings**: SMART/reliability counters surfaced before backup
- **Network-share destinations**: `destinationPath` accepts local paths, UNC
  (`\\server\share`), and `file://`/`smb://` URIs (normalised to filesystem
  paths). `s3://bucket/prefix` destinations write locally then upload to S3
  (SigV4, `AWS_*` env vars), streamed multipart above 16 MB, with optional
  **S3 Object Lock retention** — true WORM enforced by S3 itself (see
  “S3 Object Lock” below); `sftp://user@host/path` destinations stream the
  finished image over the `ssh2` SFTP client (`SFTP_USER`/`SFTP_PASSWORD`/
  `SFTP_PRIVATE_KEY` env vars or the Settings cloud profiles); `ftp://` and
  `ftps://` destinations stream over the `basic-ftp` client (FTPS — explicit
  TLS by default — or opt-in plain FTP; `FTP_USER`/`FTP_PASSWORD`/`FTP_SECURE`
  env vars or the Settings cloud profile).
- **Headless CLI**: run backups/restores/verification/pruning from a script or task scheduler
- **Simple wizard UI**: step-by-step backup and restore workflows
- **Windows file associations**: per-user `.opbs` registration with a
  right-click menu (Browse / Mount / Restore / Verify) plus a GUI toggle under
  Settings → File Associations
- **Automated restore drills**: prove restores actually work by periodically
  restoring the newest backup onto a scratch disk (destructively) and reading
  the filesystems back from disk — boot sector, `$MFT` record 0 and FAT
  geometry. Drill results are recorded per image and shown as a "drill-tested"
  badge in the Dashboard; failures alert after N consecutive misses.
- **Backup analytics & churn forensics**: per-image and per-chain metrics —
  compression ratio, dedup/churn footprint, chain efficiency, and estimated
  restore time — computed from image headers (works for historical images) and
  cached after every backup. Surfaced in the Dashboard and via a CLI
  `analytics <directory>` command. Tells you how much disk a chain truly
  covers and whether your increments are actually shrinking data re-stored.
- **Self-healing against bit-rot**: every backup gets a `.opar` XOR-parity
  sidecar (PAR2-style groups of 31 blocks over the stored frame bytes — works
  for encrypted images too, no passphrase needed to verify or repair). An idle
  or manual scrub reads every block back, re-checks frame/raw CRCs, and
  rebuilds any single damaged block in place from the parity group; scheduled
  runs (Settings → Scheduled Scrub), a Dashboard "Scrub Health" panel, and CLI
  `scrub` / `parity build|verify|repair` commands cover detection, repair, and
  per-image history in an `opbs-scrub.json` sidecar.
- **Ransomware / tamper resistance**: a backup-integrity layer compares the live
  backup directory to the last-known-good manifest (rewritten after every backup
  and prune) and to the chain structure. Missing delta bases (silent deletes
  that make a chain unrestorable), modified/unexpected images, and unparseable
  `.opbs` files are reported per destination — CLI `chain check --dir` and
  `tamper check --dir`, plus a Dashboard "Backup Integrity" panel. Exits 1 and
  flags the destination whenever drift or broken chains are detected.
- **Storage health dashboard**: a per-destination reliability snapshot that
  combines capacity/free space, restore-chain integrity, verification coverage
  (images stamped `FLAG_VERIFIED` after a successful verify), scrub history,
  restore-drill coverage, parity protection (`.opar` sidecars), tamper drift,
  and the SMART health of the physical drive backing the destination (best
  effort — offline/UNC/elevation limits never penalize the score). Produces a
  transparent 0–100 "reliability" score with a good/degraded/at-risk status —
  CLI `storage-health --dir`, plus a Dashboard "Storage Health" panel. Exits 1
  for at-risk destinations.
- **Disk write/read performance test**: a non-destructive benchmark that writes
  a scratch file (default 256 MiB in 1 MiB blocks, `fsync`'d, then read back and
  deleted) to measure sequential write/read throughput for any destination.
  Results are persisted to `opbs-perf.json` inside the destination (last 20
  runs, capped) and the latest measurement feeds the storage-health score —
  fast drives (`>= 100 MiB/s`) are never penalized, slow or critical drives
  subtract 5–15 points with an explanatory warning. CLI `opbs perf --dir
  <directory> [--size MB] [--json]`, plus a "Write perf" badge + Test button on
  the Dashboard Storage Health panel. Never writes outside the destination and
  always cleans the scratch file up, even on failure.
- **Volume Shadow Copy (VSS) maintenance**: the engine snapshots its sources
  through VSS, so a broken VSS install silently kills backups. A dedicated
  "Volume Shadow Copy" tab shows the service state and start type (unelevated
  `sc query`), a deep writer/provider inventory (`vssadmin list writers` /
  `list providers` via the elevated helper), a non-destructive smoke test that
  creates and immediately deletes a shadow copy on any mounted volume, and a
  repair action that re-registers the core VSS DLLs (`vssapi.dll`,
  `vss_ps.dll`, `vsscore.dll`, `vsstrace.dll` — missing files skipped) and
  ensures the service is running. Starting/stopping the service, the deep
  inspect, the smoke test and the repair all run through the UAC-elevated
  helper (the same path the backup engine uses) and always require
  confirmation. CLI `vss status`, `vss writers`, `vss smoke-test <volume>`,
  `vss start|stop` and `vss repair --yes`, each exiting 1 when the check or
  operation fails.
- **Backup-media quality checks (SMART)**: every backup is gated on the SMART
  health of the physical drive it writes to — backups are refused when the
  drive reports concrete problems (bad health status, high temperature, SSD
  wear, unreliable sectors, read errors). Only *reported* problems block:
  unreadable SMART data (no elevation, remote volumes) passes with a warning.
  A disk-wide inventory surfaces SMART health for every physical disk, not just
  configured destinations, so a dying backup drive is caught before it is ever
  pointed at — CLI `media smart`, Dashboard "Media Health" panel. Query results
  are cached 5 minutes so repeated runs stay fast.
- **Anomaly detection (backup deviations)**: the latest backup run is compared
  against a robust baseline (median + MAD over the last dozen runs) built from
  the per-destination analytics history (`opbs-analytics.json`). Flags run-size
  blow-ups/drops (type-aware — fulls against fulls, deltas against deltas),
  compression-ratio collapse (source turned incompressible, e.g. encryption/
  ransomware), throughput collapse (degraded destination), and backups that
  stopped arriving (cadence gap). Pure sidecar reads — no image access — with
  failures downgraded to informational notes until enough history exists. CLI
  `anomalies check --dir`, Dashboard "Anomaly Detection" panel. Exits 1 on any
  detected deviation.
- **Age-aware retention / prune reminders**: retention is lineage-aware and
  refuses to delete the last surviving restore point of a source disk — chains
  are grouped by the root full's source identity (serial, then model), and when
  a policy would fully prune a lineage the newest chain's full is rescued
  (works for `keepFull: 0` and aggressive GFS setups alike; unidentified
  legacy images are never guarded). Every prune plan also carries reminders:
  an explicit warning when `keepFull` is 0, and a heads-up before deleting
  never-verified images. Reminders print in `opbs prune --dry-run` and
  propagate through the auto-prune, IPC and Dashboard prune counts.

## Tech Stack

- **Electron**: Desktop application framework
- **React + TypeScript**: User interface
- **C++ Native Addon**: VSS integration, raw disk I/O, block writing, GPT/MBR
  partition-table generation, USN journal, CRC-32, and Native zstd (vendored
  libzstd in the addon)
- **Elevated helper**: the app relaunches itself with a UAC prompt (`--opbs-helper`) to gain admin for raw reads/writes + VSS; progress is streamed back over temp JSON files
- **Node zlib (deflate)**: compression, custom CRC-32 integrity checking
- **zstdify + fzstd (pure JS)**: Zstandard compression/decompression fallback when the native addon is unavailable
- **Node crypto (AES-256-GCM, PBKDF2)**: per-block encryption
- **Windows CryptoAPI (`CryptAcquireCertificatePrivateKey`, `CryptDecrypt`, NCrypt)**: EFS
  file-encryption-key unwrapping, so encrypted files in an image decrypt offline
- **worker_threads**: multithreaded zstd/deflate block compression in the backup loop
- **WinFsp** (runtime + a subset of the SDK headers vendored under
  `src/native/vendor/winfsp`, GPLv3): the read-only in-memory filesystem that
  exposes an image partition as a real drive letter. Only the *runtime* is
  installed on end-user machines; headers ship in the repo so the addon builds
  without a separate SDK install.
- **ssh2**: dependency-free SFTP client for `sftp://` cloud destinations
- **electron-builder**: Packaging

## Project Structure

```
src/
├── main/                  # Electron main process
│   ├── index.ts           # Entry point + IPC + helper-mode dispatch + CLI early-return
│   ├── cli/index.ts       # Headless CLI (backup/restore/verify/list/prune/health/disks)
│   ├── backup/
│   │   ├── manager.ts     # BackupManager facade (progress/status)
│   │   ├── scheduler.ts   # cron-based scheduling + retention + notifications
│   │   └── retention.ts   # GFS/retention planning, chain grouping, manifest
│   ├── imaging/
│   │   ├── image-format.ts    # .opbs container (header/partitions/blocks/CRC/cipher)
│   │   ├── imaging-job.ts     # job/progress/result types shared by both processes
│   │   ├── backup-engine.ts   # builds jobs, maps progress, drives launcher
│   │   ├── restore-engine.ts  # restore jobs, chain resolution, image summary
│   │   ├── mount-manager.ts   # WinFsp availability + mount/unmount lifecycle
│   │   └── fs/
│   │       ├── file-browse.ts # NTFS browse/extract over image readers
│   │       ├── ntfs.ts        # NTFS parsing + ranged file reads
│   │       └── mount-fs.ts    # WinFsp <-> JS bridge: stat/read/readDir handlers
│   ├── helper/
│   │   ├── job-runner.ts  # runs in the elevated instance: VSS + read + compress + write
│   │   └── launcher.ts    # spawns the elevated instance via UAC + file IPC
│   ├── restore/           # Restore logic
│   │   └── manager.ts
│   ├── utils/
│   │   ├── disk-enumerator.ts  # Disk/partition enumeration (native)
│   │   ├── disk-health.ts      # SMART/reliability counters via PowerShell
│   │   ├── notify.ts           # Toast + webhook notifications
│   │   ├── native-loader.ts    # Native addon path resolution (dev + packaged)
│   │   ├── settings-manager.ts # settings.json (retention, notifications, schedules)
│   │   └── logger.ts           # Logging
│   └── types/
│       └── native.d.ts         # Native addon types
├── renderer/              # React frontend
│   ├── App.tsx            # Main app with routing
│   ├── components/
│   │   ├── Dashboard.tsx     # Overview dashboard
│   │   ├── BackupWizard.tsx  # Backup creation flow (incremental + encryption options)
│   │   ├── RestoreWizard.tsx # Restore flow (chain + passphrase)
│   │   └── Settings.tsx      # App settings (retention, notifications)
│   └── styles/
│       └── globals.css       # Global styles
└── native/                # C++ native addon
    ├── binding.gyp
    ├── vendor/winfsp/      # WinFsp SDK headers (GPLv3, subset)
    └── src/
        ├── addon.cpp         # N-API bindings (registers WinFsp mount exports)
        ├── winfsp_mount.cpp  # Read-only WinFsp FS; JS bridge over the native addon
        ├── vss_manager.*     # VSS shadow copy create/delete
        ├── disk_reader.*     # Enumeration + raw block I/O
        └── backup_format.*   # .opbs format (native writer stubs)
```

## How a backup runs

1. **Main process (no admin)** builds a job: selected partitions + their volume
   device paths (enumerated via the native addon, no elevation needed).
2. If incremental, the engine validates the base image matches the selected
   partitions and records it; an optional passphrase is turned into per-job
   cipher metadata (the raw passphrase never reaches the helper).
3. The app relaunches **itself** elevated with `--opbs-helper <job> <result>
   <progress> <cancel>` through the UAC prompt.
4. In helper mode the app creates VSS shadow copies for live volumes, reads raw
   blocks (from snapshots or physical drives), compresses each block (zstd or
   deflate, optionally spread across worker threads for parallelism) and
   optionally encrypts each frame with AES-256-GCM, then writes the `.opbs`
   image with per-block CRC-32 + a block index + header metadata.
 5. For incremental images, unchanged blocks (matched by CRC against the
    **whole ancestor chain**'s block index — full image plus every intermediate
    delta, so a delta never rewrites a block a grandparent already holds) are
    skipped; the header records the base path and the delta flag.
6. Progress is streamed to `progress.json`; the main process polls it. Cancel is
   signalled via a `cancel` file.
7. If requested, the image is verified by re-reading and re-CRC-checking every
    block (decrypting as needed). The final outcome is written to `result.json`.

### Used-blocks-only capture (`usedBlocksOnly`)

A backup (or clone) can drop free space: `usedBlocksOnly` reads the NTFS
**$Bitmap** from the snapshot/volume and stores only blocks that contain at
least one allocated cluster (non-NTFS partitions fall back to a full capture).
Skipped blocks are simply absent from the image (the same gap mechanism
incrementals already use), so the `.opbs` format is unchanged. On restore,
blocks that are **not** in the image chain are zero-filled on the target by
default (`clearFreeSpace`, opt-out with `false` / skip only if you need the
faster older behaviour), so a file created on the drive after the backup cannot
survive. CLI: `backup --used-blocks-only` / `clone --used-blocks-only`.

### USN journal change tracking (`useUsnJournal`)

Incremental backups can skip the whole-volume CRC scan: the helper asks the
NTFS **USN journal** which files changed since the last backup, maps them
through the MFT to changed block indices (`computeChangedBlockIndices`), and
reads only those blocks. Cursor handling is **per partition**: each
volume-backed partition's journal position is captured *before* the VSS
snapshot is created (so changes made during snapshot creation are never lost)
and written to a `.usn` sidecar next to the image after each run (v2 entries
are `{partitionIndex, volume, usn}`; an old single-volume sidecar is still
read, but is attached only to the partition whose volume it names — it is
never inherited by other partitions).

The journal path only wins when it can prove the answer is complete; anything
uncertain falls back to reading every block:

- no base image (a full backup always reads the whole source),
- the sidecar missing or unreadable (the run re-covers from the beginning of
  the journal — effectively a full scan — and rewrites a fresh sidecar),
- a cursor recorded for a different volume than the partition being read
  (e.g. after a repartition or restore), or a sidecar entry whose volume
  identity no longer matches,
- the journal being unavailable, changed mid-run, or unreadable for that
  partition,
- or more than `usnFullScanThreshold` of the partition's blocks flagged as
  changed (a fraction 0–1: `0` accepts only an empty changed set, unset/`1`
  never falls back). The threshold exists because for very large changes the
  MFT walk costs more than the sequential full scan it was meant to save.

GUI: the Backup Wizard's options step has a **USN journal (read only changed
blocks for incrementals)** checkbox (on by default) with an optional **USN
full-scan threshold (%)** input (0–100, blank = no limit) shown when checked.
CLI: `backup <config.json> --usn [--usn-full-scan-threshold PCT]` (0–100,
implies `--usn`). Both the in-app scheduler and `schedule install-backup`
pass `useUsnJournal` / `usnFullScanThreshold` through to the job.

### Resumable imaging (`resume`)

A backup that is interrupted (power loss, cancellation, crash) can continue
where it left off instead of restarting: `resume` (CLI `--resume`, or
`config.resume`) makes the next run detect the partial `.opbs` already at the
target path and reuse every **fully written partition**. Completed partitions'
frames are recovered from the file itself (each frame is self-describing), and
the interrupted partition is restarted from its first block — so a resume only
re-does at most one partition. The image is then finalized normally (partition
table + block index) and stamped `FLAG_RESUMED`. Any leftover partial image is
*kept* on failure while `resume` is enabled and deleted otherwise. `resume`
targets local destinations; streaming destinations (S3/SFTP/FTP) always start
fresh.

CLI `resume-list [directory]` lists every interrupted image in a directory and
shows how many block frames have already been written (and how many bytes those
frames represent), so you can judge how close a partial image was to finishing.
Run `backup --resume <config.json>` to continue from where it stopped. The
Backup Wizard also offers a **Resume an interrupted backup** checkbox.

### Backing up from a virtual disk (VHD/VHDX)

A `.vhd`/`.vhdx` file can be imaged directly instead of selecting one of the
machine's physical disks:

```bash
# CLI: set the source in the config (or override with --source-vhd)
OPBS.exe --cli backup backup.json --source-vhd "D:\VMs\win11.vhdx"
```

- The GUI: on the backup wizard's source step, **Back up from a VHD/VHDX
  file…** picks the file; the disk list is replaced by the path, and *every
  partition on the virtual disk* is captured (the file's layout is only known
  once it is attached, so no checkboxes are shown).
- The elevated helper attaches the file **read-only** and without a drive
  letter, discovers the `\.\PhysicalDriveN` it maps to (exact virtdisk API
  path first, before/after disk-list diff as fallback), injects that index,
  builds the ordinary backup job and runs it — VSS snapshots and used-blocks
  capture behave exactly as for a physical source; anything the snapshot path
  cannot handle falls back to raw block reads. The file is detached when the
  job finishes (only if this run attached it; a file you attached yourself is
  left alone).
- `sourcePartitions: []` means "all partitions"; an explicit list is matched
  against the file's partitions after attach. Incremental (`baseImagePath`),
  `usedBlocksOnly`, encryption, resume and verification all work as usual.

## How a clone runs

A **clone** copies selected live partitions straight onto another local disk
— no intermediate image, no cloud upload. `CloneEngine` builds the job exactly
like a restore (captured offsets by default, `targetLayout` to move/resize,
fresh GPT/MBR partition table for dissimilar or blank targets), but the source
is the live volume: the helper creates VSS snapshots, reads allocated blocks
(skipping free space with `--used-blocks-only`), and writes them to the target
disk at `target.offset + blockIndex * blockSize`. Same safety gates as restore
apply: a custom layout requires `--confirm-layout`, and cloning onto the source
disk requires `--acknowledge-same-disk`. Any NTFS grow-on-restore request is
honored the same way as a restore.

Table typing is inferred from the live source (the same rules a restore uses):
an EFI System Partition (native type `0xEF`) is typed as `C12A7328-...` in a
fresh GPT table and makes `auto` prefer GPT so a UEFI source cannot silently
become an unbootable MBR clone; MBR type bytes come from each filesystem
(ESP→`0xEF`, FAT32→`0x0C`, FAT16→`0x06`, FAT12→`0x01`, NTFS/exFAT/unknown→
`0x07`, raw partitions keep their mapped source type) and the active flag
defaults to the first cloned partition. A target disk with no partition table
at all gets a fresh one automatically (no acknowledgement — there is no layout
to destroy); an unreadable target layout is never overwritten.

A clone is **source-table non-deviating** and byte-exact by construction: the
job only ever opens the source disk for reads — the fresh partition table and
every content block are written exclusively to the target drive — so the
source's MBR, GPT header/entries and backup GPT are hash-identical before and
after a clone (covered by `test/unit/clone-job.test.ts`). On the target side,
the helper issues a disk rescan *immediately after* writing the fresh table,
while the new partitions are still empty. That matters: Windows' first look at
a partition normally happens before any filesystem content exists, and if a
rescan instead *discovers an already-filled FAT32 volume*, Windows' arrival
processing asynchronously pokes a handful of bytes after the job reports
success (the BPB reserved byte at boot-sector offset `0x41` flips `0x00`→
`0x01`, plus a few data-area bytes). With the early rescan the later one only
refreshes layout, the OS never touches the copied data, and the target stays
byte-identical to the source — verified against a 100 MB FAT32 partition with
a zero-byte diff after settle.

CLI: `clone <config.json> [--elevated] [--used-blocks-only] [--layout P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout] [--no-write-table] [--acknowledge-same-disk]`.

## How a restore runs

- The engine resolves the **restore chain** for the selected image: it walks
  `baseImagePath` links back to the root full image, then restores `[full, ...deltas]`
  in order so later blocks overwrite earlier writes at their original offsets.
- Each unverified image in the chain is verified (with the provided passphrase
  key) before any data is written.
- Blocks are written to the target disk at `target.offset + blockIndex * blockSize`.
- After the image chain is applied, every block **not** present in the image
  (used-blocks free space and incremental gaps) is zero-filled on the target
  (`clearFreeSpace`, default true) so a file created after the backup cannot
  survive. Set `clearFreeSpace: false` only if you want the faster older
  behaviour that leaves spare space untouched. Volumes are lock+dismounted
  while writing when the native addon supports it, and write failures fail the
  restore instead of continuing with a warning.
- Decompression is multithreaded for compressed images (defaults to a few
  worker threads; `compressionThreads: 0` or `--threads 0` forces the
  synchronous path). Blocks are decompressed out of order but written in
  submission order.

### Dissimilar-hardware restore (moving partitions onto new disks)

A restore can re-order or move captured partitions to different offsets via
`targetLayout` (or CLI `restore --layout 0:4096,1:8388608`). Because that
placement **destroys the target disk's existing partition table**, the layout
must be acknowledged explicitly:

```bash
OPBS.exe --cli restore job-restore.json --layout 0:2097152 --confirm-layout
```

With a differing layout acknowledged, OPBS writes a fresh partition table to
the target disk **before** any partition contents:

- Native addon `buildPartitionTable` generates `gpt` or `mbr` tables as byte
  regions. GPT output includes the protective MBR, primary header/entries with
  header + entry CRCs, and the mirrored backup header/entries at the end of the
  disk. MBR output supports ≤4 partitions with the classic `0x55AA` signature.
- Scheme defaults to `auto`: MBR when every placement fits (≤4 partitions,
  ≤2 TiB disk, ≥LBA63 start, 32-bit LBAs), otherwise GPT. When the image
  contains an EFI System Partition, `auto` prefers GPT so a UEFI-sourced
  restore cannot silently become an unbootable MBR disk. Override with
  `tableScheme` / `--table-scheme gpt|mbr`.
- Optional knobs: `tableDiskGuid` (deterministic GPT disk GUID),
  `tableTypeGuids` (per-partition GPT type GUIDs; defaults: automatic EFI
  System detection — a FAT32 volume whose root contains the `\EFI` directory
  gets the EFI System type `C12A7328-...` so a restored disk boots in a VM —
  everything else is basic-data), `tableBootPartition` (MBR active partition;
  defaults to the first restored partition), and MBR partition type bytes
  inferred from each filesystem (ESP→`0xEF`, FAT32→`0x0C`, FAT16→`0x06`,
  FAT12→`0x01`, NTFS/exFAT/unknown→`0x07`) so legacy-BIOS restores keep the
  right types instead of everything becoming `0x07`.
- `writePartitionTable:false`/`--no-write-table` restores raw blocks only
  (still moves data, but leaves whatever table the target already has).

### Blank-target restores

A target disk with **no partition table at all** (brand-new, uninitialized,
RAW) would hide the restored volumes from Windows, so OPBS lays down a fresh
partition table automatically — no acknowledgement needed, because there is no
existing layout to destroy:

- An unreadable partition layout is treated as *not* blank: a fresh table is
  never written when the current one could not be inspected.
- The GPT preference, ESP typing, MBR type bytes, and active-flag default
  described above all apply; `writePartitionTable:false` opts out.
- A target that *does* have a partition table keeps it untouched unless a
  differing `targetLayout` is acknowledged.

Backups record the source disk's **model + serial** in the image header. A
dissimilar restore is refused when the target is the *same physical disk the
image came from* (matching serial) unless you also pass `--acknowledge-same-disk`:

```bash
# Restoring the exact disk that was imaged onto itself requires this extra flag.
OPBS.exe --cli restore job-restore.json --layout 0:2097152 --confirm-layout --acknowledge-same-disk
```

If only the *model* matches (serial differs), the restore proceeds with a
warning hint on the result instead of blocking.

### Filesystem grow-on-restore (NTFS)

A layout entry may also specify a **larger size** — `targetLayout[].size` or a
third field in `--layout` — so a captured partition can be expanded onto a
bigger disk:

```bash
# Place partition 0 at 2 MiB and grow it to 32 GiB.
OPBS.exe --cli restore job-restore.json --layout 0:2097152:34359738368 --confirm-layout
```

After the partition blocks are written, OPBS grows the NTFS volume in place:
the boot sector's total-sector field, the `$Bitmap` file (run + allocated/valid
sizes, with the newly added clusters marked free) and the `$BadClus` sparse run
are patched from the image's metadata. Growing is **grow-only** — a size below
the captured size is refused at job-build time; a target that is not
cluster-aligned, or a filesystem that is not a simple single-run NTFS layout,
is reported as a warning and the restore still completes.

### Restore into a virtual disk (VHD/VHDX)

A restore can write into a `.vhd`/`.vhdx` file instead of a physical disk —
handy for building VM disks from a backup, testing a restore safely, or
recovering when the physical target is unavailable:

```json
{
  "kind": "restore",
  "imagePath": "D:\\OPBS\\img_0_1746300000000.opbs",
  "targetVirtualDisk": { "path": "D:\\VMs\\restored.vhdx", "virtualSize": 137438953472, "type": "dynamic" },
  "targetPartitions": [0]
}
```

```bash
OPBS.exe --cli restore job-restore.json
```

- `targetVirtualDisk.path` is the `.vhd`/`.vhdx` file to write into.
  `virtualSize` (bytes) is required only when the file does not exist yet —
  the elevated helper creates it, dynamic by default (`type:"fixed"` for a
  fully pre-allocated file; max 2040 GiB for `.vhd`, 64 TiB for `.vhdx`).
  An existing file is attached as-is and its real capacity is used.
- The helper creates/attaches the virtual disk, resolves the resulting
  `\\.\PhysicalDriveN` (via `GetVirtualDiskPhysicalPath`, with a before/after
  size-diff fallback) and runs the ordinary restore against it — so every
  physical-disk safety gate (capacity fit, identity, same-disk) still
  applies, re-checked after the disk appears. The disk is detached again
  afterwards when this restore is the one that attached it.
- A fresh target gets a **new partition table** (the blank-target rule above:
  GPT preferred, MBR fallback; override with `tableScheme`) so the restored
  volumes show up in Windows. A restored EFI System Partition (FAT32 with a
  root `\EFI` directory) is automatically typed as the EFI System partition,
  so the disk is VM-bootable without extra configuration; `tableTypeGuids`
  overrides any partition's type. Use `writePartitionTable:false` to write
  raw blocks only.
- In the GUI, choose **Virtual disk (VHD / VHDX)** on the restore wizard's
  target step (path, size, dynamic/fixed) or in the Config Builder's Restore
  tab; the preflight flags an existing file (`targetFileExists`) before you
  confirm the overwrite.

### Automated restore drills

Every backup tool promises "you can restore", but that is rarely *proven* until
disaster strikes. OPBS runs real restore drills: it restores the newest
unencrypted backup in a directory onto a **scratch disk you dedicate** (its data
is overwritten), then **reads the filesystems back from the physical disk** and
validates the boot sector (`0x55AA` signature, OEM id, NTFS `$MFT` record 0
`FILE` magic and in-use flag, or FAT sector/cluster geometry). A restore that
completes but fails validation is surfaced as a failed drill.

- Configure a schedule under **Settings → Scheduled Restore Drills** (the script
  makes its own Windows Task with `--cli drill` when you use the CLI):
  ```bash
  # Manual drill: restore the newest unencrypted image in D:\OPBS onto disk 2.
  OPBS.exe --cli drill --dir D:\OPBS --disk 2 --verify
  ```
- Each successful drill records a per-image timestamp in
  `opbs-drill-history.json` next to the images; the Dashboard shows a
  "drill-tested" badge per image. Failures alert only after N consecutive misses
  (default 2) to avoid toast spam while still never silently accepting a broken
  chain.
- Encrypted images are skipped (no passphrase in the drill config) — the same
  policy as scheduled verification. Drills always run with `applyDeltas` and, by
  default, `verifyBeforeWrite`, so an unverified chain can never be written to
  your scratch disk.

## File-level browse / extract

You can browse and restore individual files/folders from a `.opbs` image
without restoring the whole disk. The engine resolves the image chain, opens a
partition reader that decompresses only the covering blocks on demand, and
parses NTFS directly from those bytes:

```bash
# List the root of partition 2
OPBS.exe --cli browse img.opbs --partition 2
# List a subdirectory
OPBS.exe --cli browse img.opbs --partition 2 --path "Users\me\Documents"
# Extract a file
OPBS.exe --cli extract img.opbs --partition 2 --path "Users\me\Documents\notes.txt" --out D:\restored\notes.txt
# Extract a whole folder (recursively)
OPBS.exe --cli extract img.opbs --partition 2 --path "Users\me" --out D:\restored
```

For encrypted images pass `--passphrase p`. The NTFS reader supports directory
trees, resident and non-resident files (via data runlists), chains of
full + delta images, sparse runs, LZNT1-compressed files, alternate data
streams, and EFS. EFS-encrypted files are flagged with a 🔒 and are decrypted
when this machine holds a private key matching one of the file's certificate
thumbprints (unwrapped through Windows CryptoAPI in the native addon, then
AES-256/3DES/DES/DESX sector decryption in `src/main/imaging/fs/efs.ts`).
Without a matching key, single-file reads refuse with `EFS_ENCRYPTED` and
folder extraction skips that file instead of aborting.

The GUI's Browse page exposes the same actions: every row has an **Extract**
button — for a folder this extracts the whole subtree recursively into a
folder you pick — and **Extract folder** in the breadcrumb bar extracts the
directory you are currently viewing (at the volume root, its contents land
directly in the chosen folder).

## Browsing Macrium images (.mrimgx and .mrimg)

OPBS can also open other tools' images read-only without mounting them:

```bash
# Inspect a Macrium Reflect 7/8 image (QuickLZ; reports backup type,
# compression, source disk geometry and partitions)
OPBS.exe --cli mrimg info img.mrimg
# Browse / extract a Reflect X image like any OPBS image
OPBS.exe --cli browse img.mrimgx --partition 2
OPBS.exe --cli extract img.mrimg --partition 1 --path "Users\me\notes.txt" --out D:\restored\notes.txt
```

- `.mrimgx` (Reflect X) is parsed from the official layout: footer → metadata
  chain → `$JSON` navigation → per-partition `$INDEX` of zstd blocks.
- `.mrimg` (Reflect 7/8) uses a proprietary QuickLZ 1.31 container. OPBS
  includes a clean-room decoder (`src/main/imaging/mrimg/quicklz.ts`) whose
  output is validated against each block's stored MD5, so corrupt images are
  detected rather than silently misread.
- Recognised-but-unreadable variants are **detected up front and refused with
  `MacriumUnsupportedError`** instead of failing mid-browse with a confusing
  parse error: password-protected images (mrimgx `$JSON` encryption / v7
  footer `<aes>`), split multi-part sets (mrimgx `split_file` / a v7 sibling
  part next to a `-00-00` filename), and chain members whose base image or
  backup-set files are missing from disk (mrimgx delta containers and v7
  chain members alike). Detection is shared across
  every path — `mrimg info` prints an `unsupported:` line with the same
  verdict, browse/extract/mount throw the refusal, and the GUI browse view
  shows the exact reason instead of the generic "no browsable partitions"
  hint.
- **v7 differential/incremental chains browse in place**: a
  `<id>-01-01.mrimg` (differential) or `<id>-02-02.mrimg` (incremental)
  resolves against its base (`<id>-00-00.mrimg`, `<id>-01-01.mrimg`, …)
  automatically — unchanged blocks come from the base, changed blocks from
  the member's own data, each MD5-verified. Restoring or browsing the latest
  member sees the full logical volume state; only a missing base is refused
  (with a merge-in-Reflect hint). `mrimg info` prints the chain role, base
  file and changed-block count.
- **mrimgx (Reflect X) delta incrementals browse in place too**: the delta
  container's `$INDEX` (34-byte records) is composed against its backup set —
  the newest non-delta image in the same folder seeds each partition's
  full-extent index and the delta's changed blocks overlay it, newest wins,
  every block MD5-verified against the file it routes to. Set membership
  mirrors Macrium's own reader: same folder, same extension, same image ID,
  increment number ≤ this image's. A missing base, a pruned middle increment
  or an absent member file is refused with the reason; lone containers stay
  refused. `mrimg info` prints the chain role, base file and changed-block
  count.
- Whether a partition can be listed depends on the volume: partition images of
  NTFS/FAT volumes browse and extract normally; block streams without a
  resident boot sector (e.g. file/data backups) report that no filesystem is
  present.

## Restoring Macrium images (.mrimgx and .mrimg)

Macrium containers restore through the same pipeline as `.opbs` images — the
CLI, the restore wizard and the Config Builder all accept them (the image
pickers list `.mrimgx`/`.mrimg` alongside `.opbs`):

```bash
# imagePath in the config may point at a Macrium image (wizard: just pick it)
OPBS.exe --cli restore job-restore.json
OPBS.exe --cli wizard
```

- Placement comes from the image itself: `_geometry.start` (mrimgx) and the
  v7 footer's MBR/GPT table entries (mrimg) give each partition's captured
  on-disk offset in bytes. Containers that record no offset are refused with a
  `--layout P:<offsetBytes>` hint instead of guessing.
- Every block is decompressed (zstd / QuickLZ) and **MD5-verified by the
  reader** before it lands on the target; the uncaptured tail and block
  padding are zero-filled (skip with `clearFreeSpace: false`),
  `verifyAfterRestore` reads the target back for a final MD5 pass, and
  grow-on-restore / fresh-partition-table / restore-drill behave exactly like
  an `.opbs` restore.
- Refused **before any target byte is written**: password-protected and split
  containers, chain members whose base image or backup-set files are missing
  from disk, file-and-folder backups, and mrimgx `diff`/`inc` backups with no
  set on disk — the reason surfaces in the wizard/GUI the same way it does for
  browsing.
- A v7 chain member restores the **full composed volume state**: the reader
  resolves carried-forward and delta blocks against the base chain (every
  block MD5-verified) before anything is written, so restoring the newest
  incremental is equivalent to restoring a merged full image. Keep the whole
  chain (`-00-00`, `-01-01`, …) in the same directory.
- An **mrimgx delta incremental** restores the full composed volume state the
  same way: the reader routes every index element to the file that stores its
  bytes (the base image for unchanged blocks, the delta member for changed
  ones, each MD5-verified), so restoring the newest incremental equals
  restoring a merged image. Keep the set (`*-00-00`, `*-01-01`, …) in the
  same directory.

## Mounting an image partition as a read-only drive

Instead of extracting, you can attach a partition from a `.opbs` or Macrium
image directly as a **drive letter** via WinFsp. The drive is fully virtual —
file reads are served on demand by decompressing only the covering blocks, so
**no extra disk space is used** and nothing is written back to the image.

```bash
# Mount partition 2 (GUI: Browse view → "Mount as drive")
OPBS.exe --cli mount D:\OPBS\img_0_1746300000000.opbs --partition 2
# Pin a specific drive letter (defaults to WinFsp auto-assign) + custom label
OPBS.exe --cli mount D:\OPBS\img_0_1746300000000.opbs --partition 2 --letter E: --label "Recovery 2026"
# Encrypted images
OPBS.exe --cli mount D:\OPBS\img_0_1746300000000.opbs --partition 2 --passphrase secret
# Just check whether WinFsp is installed (no elevation, no mount)
OPBS.exe --cli mount --check
```

The mount stays alive until you press **Ctrl+C** (or click **Unmount** in the
GUI); unmounting is a clean WinFsp teardown. Since drive letters require
admin rights, the command relaunches itself elevated through a UAC prompt (same
mechanism as backup/restore) and the read/write handlers run in the elevated
helper. Requires the **WinFsp runtime** (https://winfsp.dev); the GUI shows a
hint when it is missing.

## Windows file associations & context menu

On Windows, backup images (`.opbs`, plus Macrium `.mrimg`/`.mrimgx`) get a
right-click context menu when OPBS is installed. Registration is **per-user**
(`HKCU\Software\Classes`, no admin required) and is refreshed on every launch
so it stays in sync after updates:

- **Browse with OPBS** — opens the File Browser view on that image (also the
  double-click default)
- **Mount with OPBS** — opens the File Browser so a partition can be mounted
  read-only via WinFsp
- **Restore with OPBS** — opens the Restore wizard with the image preloaded
- **Verify with OPBS** — verifies block checksums headless and shows a toast
  when done (encrypted images open the Browse view instead so you can enter
  the passphrase)

Choose a verb while OPBS is already running and it focuses the existing window
and routes the action to it. Association handling itself needs no elevation —
like verification, listing and pruning.

Turn it on or off at any time in **Settings → File Associations** (default:
on). Disabling unregisters the `.opbs` handler and verb menu immediately and
keeps it off across restarts.

For repair/installer flows the associations can also be applied or removed
headlessly:

```bash
OPBS.exe --unregister-file-associations   # for uninstall/repair
OPBS.exe --register-file-associations     # re-apply after a manual registry edit
```

## Headless CLI

The app accepts a `--cli` flag that runs a single command and exits:

```bash
OPBS.exe --cli disks
OPBS.exe --cli partitions 0
OPBS.exe --cli list D:\OPBS
OPBS.exe --cli verify D:\OPBS\img_0_1746300000000.opbs --passphrase secret
OPBS.exe --cli backup job-backup.json
OPBS.exe --cli restore job-restore.json
OPBS.exe --cli restore job-restore.json --threads 4
OPBS.exe --cli prune D:\OPBS --keep-full 3 --keep-deltas 3 --dry-run
OPBS.exe --cli health 0
OPBS.exe --cli new-config example.json
OPBS.exe --cli verify --dir D:\OPBS --scope newest --json-out result.json
OPBS.exe --cli schedule install-backup "OPBS nightly" --config job-backup.json --time 02:00
OPBS.exe --cli schedule install-verify "OPBS verify" --dir D:\OPBS --scope newest --time 03:00 --run-as-user
OPBS.exe --cli schedule list
OPBS.exe --cli schedule remove "OPBS nightly"
OPBS.exe --cli media check
OPBS.exe --cli media create --iso D:\recovery\opbs-winpe.iso --arch amd64
OPBS.exe --cli browse D:\OPBS\img_0_1746300000000.opbs --partition 2
OPBS.exe --cli extract D:\OPBS\img_0_1746300000000.opbs --partition 2 --path "Users\me\Documents\notes.txt" --out D:\restored\notes.txt
OPBS.exe --cli store put s3://bucket/backups D:\OPBS\img_0_1746300000000.opbs
OPBS.exe --cli store list s3://bucket/backups
OPBS.exe --cli store verify s3://bucket/backups
OPBS.exe --cli prune s3://bucket/backups --keep-full 3 --keep-deltas 3 --dry-run
OPBS.exe --cli usn-changes C: --count 20
OPBS.exe --cli mount D:\OPBS\img_0_1746300000000.opbs --partition 2 --letter E:
OPBS.exe --cli mount --check
OPBS.exe --cli repo init D:\BackupRepo --lock-days 30
OPBS.exe --cli backup job-backup.json --repo D:\BackupRepo --lock-days 14
OPBS.exe --cli repo list D:\BackupRepo
OPBS.exe --cli repo verify D:\BackupRepo --fast
OPBS.exe --cli repo prune D:\BackupRepo --dry-run
```

Example `job-backup.json`:

```json
{
  "kind": "backup",
  "sourceDiskIndex": 0,
  "sourcePartitions": [2],
  "destinationPath": "D:\\OPBS",
  "compressionLevel": 3,
  "compressionType": "zstd",
  "compressionThreads": 4,
  "verificationEnabled": true,
  "baseImagePath": "D:\\OPBS\\img_0_1746300000000.opbs",
  "passphrase": "optional"
}
```

`compressionType` is `"zstd"` (default recommendation) or `"deflate"`;
`compressionThreads` (0 = synchronous, 1+ = multithreaded) is optional and
defaults to a sensible count on the app path.

These config files can be written by hand, generated as templates with
`--cli new-config`, or built from a form in the GUI: **sidebar → Config Builder**
(backup, restore, clone and drill job JSON with live preview, Copy/Save/Load,
plus a generator for the `schedule install-*` command lines).

Backup/restore still require the UAC prompt (raw I/O). Verification, listing,
pruning and health checks do not.

## S3 Object Lock (true WORM)

When **Settings → Cloud (S3)** has an Object Lock mode configured (Off /
GOVERNANCE / COMPLIANCE plus a retention window in days), every object OPBS
uploads to an `s3://` destination — images, BitLocker key sidecars, manual
chain uploads — carries S3 Object Lock retention headers
(`x-amz-object-lock-mode`, `x-amz-object-lock-retain-until-date`). For the
retention window the objects cannot be deleted or overwritten **by anyone,
including the account that wrote them** (COMPLIANCE), or by anyone without
the `s3:BypassGovernanceRetention` permission (GOVERNANCE). This is
S3-enforced WORM, not application-level protection: it holds even if the
backup machine itself is compromised.

Notes:

- The bucket must have Object Lock enabled (AWS console: S3 → bucket →
  Object Lock; a bucket-wide default retention is optional — OPBS sets
  per-object retention). Uploading to a bucket *without* Object Lock while
  the mode is set fails with an S3 error — leave the mode Off for ordinary
  buckets.
- Retention starts at upload time and lasts `objectLockRetainDays`
  (minimum 1 day). Uploads stream: single PUT up to 16 MB, multipart above
  that (aborted on failure), so multi-hundred-GB images no longer need to
  fit in RAM.
- Headless CLI jobs (which don’t read the settings profile) fall back to
  `OPBS_S3_OBJECT_LOCK_MODE=GOVERNANCE|COMPLIANCE` and
  `OPBS_S3_OBJECT_LOCK_RETAIN_DAYS=N`.
- Object deletion by `store prune` / retention cleanup is rejected by S3
  while an object is still locked — that is the point. Already-locked
  objects keep their retention; the setting only affects future uploads.
- Combine with the repository anchor below: images in S3 are WORM-protected
  there, and the local journal is rollback-evident against an off-box
  snapshot.

## Immutable repositories

An **immutable repository** is a directory managed by OPBS that keeps backups
append-only and tamper-evident — a poor-man's WORM that needs no special
hardware. Create one with:

```
OPBS.exe --cli repo init D:\BackupRepo --lock-days 30
```

which writes:

- `opbs-repo.json` — the repository header (id, algorithm, key id, default
  lock window)
- `opbs-repo.journal` — an append-only log; every record is HMAC-SHA256
  signed and chained to the previous one (`seq`/`prev`), covering image
  creation, prune and unlock events
- `images/` — protected image storage

The signing key is **never stored inside the repository**: by default it lives
in a keyfile under `~/.opbs/repo-keys/<id>.key` (override with `--keyfile f`
or the `OPBS_REPO_KEY_DIR` environment variable), or it is derived from
`--passphrase` (PBKDF2-SHA256, 210,000 iterations, no file written).

Back up into a repository with the `--repo` flag:

```
OPBS.exe --cli backup job-backup.json --repo D:\BackupRepo --lock-days 14
```

The image is written into `images/` and a signed `create` record locks it for
`--lock-days` days (the repository default when omitted). `<dir|s3://bucket/prefix>`
below also accepts an S3-hosted repository (see *Repository on S3*).

Repository commands:

- `repo list <dir|s3://…> [--json]` — images with lock/expiry state
- `repo verify <dir|s3://…> [--fast] [--anchor <target>] [--json]` — verifies the
  journal chain and all signatures, then re-hashes every image; detects
  edits, truncation, missing files and orphaned images (and therefore
  deletions). With `--anchor`, also byte-compares the journal against the
  off-box snapshot (see below).
- `repo prune <dir|s3://…> [--dry-run] [--json]` — deletes only images whose lock
  has expired, and only when every delta in their chain is also eligible (a
  locked delta keeps its full base). Dry-run shows the plan and needs no key.
- `repo unlock <dir|s3://…> <image|--all> [--passphrase p] [--keyfile f]` — the
  audited escape hatch: appends a signed `unlock` record instead of silently
  mutating the journal. Afterwards run `repo prune`.
- `repo anchor <dir|s3://…> --to <target> [--passphrase p] [--keyfile f]` — writes
  an off-box snapshot of the exact header + journal bytes to a local
  directory, `s3://bucket/prefix` or `sftp://host/path`, stored as
  `<target>/<repo-id>/opbs-repo.anchor`.

Rollback detection needs that anchor: journal history is tamper-evident but
not rollback-proof on its own. `repo verify <dir> --anchor <target>` compares
the local files against the snapshot byte-for-byte — a truncated journal
(rollback), rewritten records, a swapped header or a corrupted anchor all
fail with `anchor-mismatch`/`anchor-missing`, and the snapshot's embedded
HMAC chain is re-verified when the key is available. Appending records after
anchoring is fine (the anchored text stays a prefix until you anchor again),
so anchor after every repository backup — or just let OPBS do it: when an
anchor target is configured, successful repository backups re-anchor
automatically.

### Repository S3 mirror

A repository can keep a **WORM mirror** of every image volume in an S3
bucket. Initialize with `--remote`:

```
OPBS.exe --cli repo init D:\BackupRepo --lock-days 30 --remote=s3://bucket/backups --remote-lock GOVERNANCE
```

- The mirror target is stored in the header (`remote.uri` +
  `remote.lockMode`). Credentials never are: they come from **Settings →
  Cloud (S3)** in the GUI, or the `OPBS_S3_*` / `AWS_*` environment variables
  in headless CLI runs.
- With `--remote-lock GOVERNANCE|COMPLIANCE`, each mirrored volume is uploaded
  with S3 Object Lock retention headers — the bucket itself then refuses
  deletion (including by OPBS) until retention expires.
- Ordering is fail-safe in both directions: volumes are uploaded *before* the
  signed `create` record is appended (a failed upload never leaves a
  journaled image without its mirror), and `repo prune` deletes remote copies
  *before* local files (an Object-Lock refusal aborts the prune with the
  image fully intact locally and remotely).
- `repo verify` checks the mirror as well (listing + object sizes) and
  reports `remote-missing`, `remote-size` and `remote-error` problems next to
  the local chain/hash findings. `--fast` and `--anchor` keep working as
  usual.

### Repository on S3

The whole repository — header, journal **and** image volumes — can live in an
Object-Lock-enabled bucket instead of a local directory:

```
OPBS.exe --cli repo init --passphrase pw --lock-days 30 --remote-lock GOVERNANCE s3://bucket/backups
OPBS.exe --cli backup job.json --repo s3://bucket/backups
OPBS.exe --cli repo verify --passphrase pw --json s3://bucket/backups
```

- **Init** writes `opbs-repo.json` + `opbs-repo.journal` straight into the
  bucket with conditional puts (`If-None-Match: *`, so two inits cannot both
  win) and — with `--remote-lock` — Object Lock retention on the metadata
  versions themselves. The header records the repository's own location
  (`remote.uri`), which is how every later volume upload knows where to go.
- **Sessions, not a live mount:** each command hydrates header + journal into
  a throwaway local cache (`~/.opbs/cache/repos/<hash>/s-…`, override with
  `OPBS_REPO_CACHE_DIR`), runs the normal repository logic there, and flushes
  on the way out. Flushes are conditional on the ETags that were hydrated, so
  a second writer anywhere produces a clear
  `Repository changed in S3 while it was open (concurrent writer)` error
  instead of silently overwriting history. Expect **one writer at a time**.
  Cache staging dirs are removed after a successful run and swept after 24 h;
  image volumes are never cached — only staged while a backup runs, uploaded
  before the journal record is appended, then deleted after the flush.
- **Verify** lists the bucket once (presence, sizes, pruned-but-present
  objects, never-referenced orphans) and streams each active volume's SHA-256
  unless `--fast`. **Prune** and **unlock** operate on the bucket directly.
- **Backups:** `--repo s3://…` (GUI: *Open S3 repo* on the wizard's
  destination step) stages the image in the cache, uploads it with the
  repository's lock mode, journals it and flushes. The wizard performs full
  backups into S3 repositories (no local base image to delta against).
- **Credentials** never appear in the header: the GUI reads **Settings →
  Cloud (S3)**; headless CLI reads `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` plus `OPBS_S3_ENDPOINT` /
  `OPBS_S3_FORCE_PATH_STYLE=1` for S3-compatible stores (MinIO, Ceph).
- `repo anchor` works against an S3 repository too, and `--anchor` verification
  runs against the hydrated journal as usual.

> **Argument forms:** Electron silently rejects a command line (exit `-1`,
> no output) when a bare `scheme://…` token is followed by more arguments.
> Pass URIs in the equals form (`--remote=s3://…`, `--to=s3://…`), as the
> final argument (`repo verify --passphrase pw s3://bucket/x`), or put a
> standalone `--` before the URI-bearing arguments
> (`--cli repo init D:\Repo --remote -- s3://bucket/x`). The `--flag=…` form
> is recommended — it works in any position.

The same workflow lives in the GUI under **sidebar → 🗄️ Repositories**:
pick or initialize a repository, watch header / key / chain badges, browse
the image table with per-image lock badges (locked until, expired, unlocked,
files missing), and run **Verify** (full or fast, with streamed progress),
**Prune** (dry-run first, then a two-step confirm) and **Unlock** (per image
or all). The last opened repository is remembered across restarts. The
**Anchor target** field writes the off-box snapshot on demand and is included
in every Verify (which then reports `Anchor OK — through seq N`); the target
is remembered, and successful repository backups re-anchor automatically.
Initializing a repository offers an optional **S3 mirror** URI with an Object
Lock mode (validated before the header is written), and a mirror badge in the
header grid shows the target once configured. A repository directory field (or
the wizard's **Open S3 repo** input) also accepts an `s3://bucket/prefix`
target: the view hydrates it into the same cache, badges it as *S3 storage*,
and the init form switches to S3 wording (storing header, journal and images
in the bucket) when the target is a URI.

Backups can also *target* a repository straight from the wizard: on the
destination step, **Use a repository…** validates the pick, switches the
destination to `<repo>\images` and offers the lock window (defaulting to the
repository's). After the run the image is write-protected and journaled, and
the completion screen shows the lock-until date. The same
`repoDir`/`repoLockDays` fields inside a job JSON make CLI and scheduled
backups repository-aware (the `--repo` flag overrides them), and backup
profiles remember the repository link.

Protection layers (and their honest limits):

1. **Write protection** — completed images and the header get a Windows deny
   ACL for Everyone (`DELETE | FILE_WRITE_DATA | FILE_APPEND_DATA |
   FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES`). Reads keep working for OPBS
   itself (verify, browse, restore), but any write or encryption attempt from
   a running process — including ransomware running as the same user — fails.
   The journal must stay appendable, so it is protected by its hash chain
   instead of an ACL.
2. **Detection** — `repo verify` fails on modified, truncated or missing
   files, broken signatures, or images absent from the journal. Windows does
   not allow blocking deletion of a readable file with ACLs (the delete falls
   back to the parent folder's `FILE_DELETE_CHILD` grant), so deletion is
   handled by detection rather than prevention.
3. **Known limits** — a local administrator can still delete the entire
   folder. Rolling the journal back together with its images is *detected*
   (not prevented) by `repo verify --anchor` when an off-box anchor exists —
   keep the anchor target on storage the attacker cannot also rewrite (a
   separate machine, bucket, or ideally an Object-Lock bucket). For
   S3-stored copies, **S3 Object Lock** (see above) makes deletion
   impossible for the retention window — true WORM enforced outside the
   machine.

Retention stays journal-aware: automatic cleanup skips repository images and
points you at `repo prune` instead.

## Scheduled runs (Windows Task Scheduler)

While the in-app Settings scheduler runs backups/verification only while OPBS
is open, `schedule` commands register **native Windows tasks** that run the
headless CLI:

- `schedule install-backup <name> --config job.json [--time HH:MM|--on-login] [--as-system]`
  runs the backup elevated (`/RL HIGHEST` or `/RU SYSTEM`). Because the task is
  already elevated, the helper no longer triggers a **UAC prompt at run time**;
  elevation is only required once, at task registration time. Use the `--elevated`
  flag automatically added by the CLI so the job executes in-process.
- `schedule install-verify <name> --dir D:\OPBS [--scope newest|all] [--time HH:MM|--on-login]`
  registers a verification task. Verification only reads files, so use
  `--run-as-user` to register it **without admin rights**.
- `schedule list` / `schedule remove <name>` inspect and delete tasks.

Running the app's own scheduled verification is covered in **Settings →
Scheduled Verification** (cron, scope, destination, failure notification).
Failure alerts are only sent once a configurable number of consecutive
failures is reached (`alertAfter`, default 2), so transient blips don't spam
while persistent problems surface. When **auto-cleanup** is enabled, a
verification run also prunes images that exceed retention. An optional
**idle scrub** (`scrubWhileIdle`, interval in hours) re-verifies the newest
images in the backup location in the background to catch bit-rot early.

## WinPE recovery media

`media create` builds a bootable WinPE ISO (or USB key) carrying the OPBS
headless CLI, the native disk addon, and a stock Node.js runtime. Booting it
presents a restore prompt backed by:

```
node.exe winpe-entry.js restore <restore.json> --elevated
```

Prerequisites: the Windows ADK (with the **Windows Preinstallation
Environment** component) and Node.js. Run elevated (or confirm the UAC prompt,
which one elevation spawn covers the whole build):

```bash
OPBS.exe --cli media check
OPBS.exe --cli media create --iso D:\recovery\opbs-winpe.iso
OPBS.exe --cli media create --arch amd64 --usb E --yes
OPBS.exe --cli media create --iso D:\recovery\opbs-winpe.iso --restore-config D:\backups\restore.json
# Inject NIC/storage drivers into the WIM before it is committed
OPBS.exe --cli media create --iso D:\recovery\opbs-winpe.iso --driver D:\drivers\net,D:\drivers\storage
# Stage the payload + write build.ps1 WITHOUT attempting elevation; run the
# printed script from an already-elevated PowerShell (CI / non-admin shells):
OPBS.exe --cli media create --iso D:\recovery\opbs-winpe.iso --script-only
# Stage + headless-boot the payload without elevation (native addon + codecs)
OPBS.exe --cli media smoke [--node <node.exe>] [--dist <dir>] [--native <addon>]
```

If the ADK is missing, the GUI detects it at startup and offers to download and
silently install the Deployment Tools + WinPE add-on automatically (one UAC
confirmation for the whole install). The Recovery Media screen's Tools Check
names each gap separately: a missing ADK offers a silent **Install ADK**
button, and a missing Node.js runtime offers **Install Node.js**, which
downloads the official portable LTS runtime (~38 MB) into the app's data
folder — per-user, no admin rights or UAC prompt. Mounting backup partitions
as read-only drives needs the WinFsp runtime; when it's missing the Dashboard
shows a non-blocking banner that installs the latest WinFsp MSI the same way.

The generated script: `copype` a WinPE working dir, layer OPBS under
`media\OPBS\` (dist + codecs + `opbs_native.node` + `node.exe`), optionally
`dism /Image ... /Add-Driver /Recurse` each `--driver` folder, inject a
`startnet.cmd` into `boot.wim` that locates the OPBS folder and launches
`restore.cmd`, commit with DISM, then `MakeWinPEMedia`. `restore.cmd` uses a
`OPBS-restore.json` on the media if present (or one supplied via
`--restore-config`), otherwise asks for a config path.

## `.opbs` container v1

- **Header** (256 B): magic `OPBS`, version, timestamp, total bytes, block size,
  compression id, partition count, flags (`HAS_BLOCK_INDEX`, `VERIFIED`,
  `INCREMENTAL`), block-index offset, cipher id, KDF iterations, PBKDF2 salt,
  base-image path (128 B ASCII, incremental only).
  Compression id: `0` = none, `1` = deflate, `2` = zstd.
- **Partition table**: fixed 64 B entries (index, size, offset, first block
  offset, block count).
- **Frames**: `[frame header 16 B][IV 12 B (encrypted)][tag 16 B (encrypted)][compressed payload]`.
- **Block index**: `[u64 count][28 B entries]` (partition, block index, file
  offset, sizes, raw CRC-32).
- Encryption: AES-256-GCM, one IV+tag per frame, key derived from the passphrase
  via PBKDF2-SHA256 (210,000 iterations), salt stored in the header.

## Development

```bash
# Install dependencies
npm install
cd src/native && npm install && cd ../..

# Build native addon (requires Python + Visual Studio Build Tools)
npm run build:native

# Run in development mode
npm run dev

# Build production
npm run build

# Lint (ESLint 9 + typescript-eslint flat config)
npm run lint

# Run unit tests
npm test

# Run the Electron GUI click-test (launches the built app, walks every view)
npm run test:e2e

# Package installer
npm run package
```

### Building the native addon

The native addon requires:
- **Node.js + node-gyp**
- **Python** (for node-gyp)
- **Visual Studio Build Tools** with the "Desktop development with C++" workload

The addon uses the Windows SDK's volume and storage APIs (no admin required for
enumeration). Raw disk imaging/restore and VSS operations require elevation,
which the app acquires by relaunching itself elevated through the UAC prompt.

## Current Status

- **Working**: UI shell, disk/partition enumeration (native, no-admin), UAC
  helper elevation, VSS snapshots, `.opbs` imaging with zlib compression +
  per-block CRC-32 verification, encrypted images (AES-256-GCM), incremental
  backups + chain restore, retention/GFS pruning + manifest, cron scheduling +
  toast/webhook notifications, SMART/disk-health reporting, headless CLI, NTFS
  browse/extract (folder trees, sparse, LZNT1, ADS, EFS decryption), used-blocks-only capture
  via NTFS `$Bitmap`, disk-to-disk clone (live VSS copy, dissimilar layout +
  fresh partition table), Macrium `.mrimgx`/`.mrimg` browse/extract/restore, read-only
  WinFsp mount of image partitions (GUI + CLI), WinPE media with driver
  injection + headless payload smoke, `.opbs` right-click context menu verbs
  (browse/mount/restore/verify) with a Settings toggle, automated restore drills
  (scheduled scratch-disk restore + on-disk filesystem validation, per-image
  "drill-tested" status), backup analytics/churn forensics (per-chain
  compression, dedup footprint, chain efficiency, restore-time estimate — CLI
  `analytics` command + Dashboard panel), self-healing scrub with XOR-parity
  repair (`.opar` sidecars, scheduled/manual/CLI, Dashboard "Scrub Health"),
  ransomware/tamper resistance (chain-integrity + manifest-drift checks via CLI
  `chain check` / `tamper check` and a Dashboard "Backup Integrity" panel), a
  storage-health dashboard (per-destination reliability score combining SMART
  drive health, verification/scrub/drill/parity coverage, chain integrity and
  capacity — CLI `storage-health --dir` + Dashboard panel), backup-media quality
  checks (pre-backup SMART gate — refuse writing to a failing drive — plus a
  disk-wide `media smart` inventory and Dashboard "Media Health" panel),
  anomaly detection (baseline-comparison of run size, compression ratio,
  throughput and cadence gaps against the analytics history — CLI
  `anomalies check --dir` + Dashboard panel), a non-destructive disk write/read
  benchmark feeding the storage-health score (CLI `perf --dir` + Dashboard
  "Write perf" badge), a VSS maintenance tab (service state, writer/provider
  inventory, snapshot smoke test, DLL re-registration and start/stop via the
  UAC-elevated helper — CLI `vss status|writers|smoke-test|start|stop|repair`),
  age-aware retention (lineage
  guard prevents pruning the last surviving restore point of any source disk,
  with prune reminders for keepFull:0 and unverified-image deletion),
  400+ unit/integration tests
- **Planned**: see `ROADMAP.md`. Real WinFsp mounts are verified once the
  WinFsp runtime is installed (detected automatically; the mount bridge is
  unit-tested via in-memory browse sessions).

## License

GPL-3.0
User runs at own risk
Backup is not guaranteed - always test restores
