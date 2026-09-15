# OPBS — Open Pickle Backup System

A FOSS disk imaging backup solution for Windows, inspired by Macrium Reflect.
created by **RHITCS** — named in honour of a certain well-preserved pickle.

Website: https://opbs.rhitcs.com

## Features

- **Disk & partition imaging** with per-block CRC-32 integrity checking
- **VSS support**: back up live systems using Windows Volume Shadow Copy Service
- **Compression**: Zstandard (zstd) with multithreaded worker-thread compression, plus classic zlib deflate for backward compatibility; multiple levels to balance speed vs. size
- **Incremental backups**: deltas capture only changed blocks against a base image; restore chains replay base + deltas in order. Optionally the NTFS **USN journal** (`useUsnJournal`) is used to read only the blocks touched by changed files instead of scanning the whole volume (falls back to a full scan if the journal is unavailable).
- **Resumable imaging**: `resume` (CLI `--resume`) continues an interrupted local backup from the partial image already at the target path — completed partitions are kept and the run resumes at the next partition boundary instead of restarting from scratch.
- **Used-blocks-only capture**: `usedBlocksOnly` (CLI `--used-blocks-only`) reads the NTFS `$Bitmap` and stores only blocks containing allocated clusters, dropping free space; non-NTFS partitions fall back to a full capture.
- **Read-only mount via WinFsp**: mount a partition from a `.opbs` or Macrium image as a virtual drive letter with **zero extra disk usage** — file reads are served lazily by decompressing only the covering blocks. Requires the free WinFsp runtime (https://winfsp.dev).
- **Disk-to-disk clone**: `clone` copies selected live partitions straight onto a different local disk (VSS snapshots, optional dissimilar layout + fresh GPT/MBR table, optional grow-on-restore), with no image file or cloud upload. The GUI **Partition Copy** screen makes this drag-and-drop: pick a target disk, drag partition chips onto it (or “Copy all partitions”), preview the auto-sequential 1 MiB-aligned layout with optional grow-to-fill, confirm the erase warning, and watch live progress.
- **Disk tools**: the **Disk Tools** screen (sidebar 🔧) groups four maintenance utilities — **MBR & Boot Repair** (read partition-table info from `Get-Disk`/`Get-Partition`, read the raw 512-byte MBR sector elevated for a full entry/CHS breakdown including the boot and disk signatures, and repair boot code / rebuild the BCD store via elevated `bootrec.exe`), **Disk Error Check** (read-only `chkdsk /scan`, plus elevated `/f` and slow `/r` modes), **SSD TRIM** (query `fsutil behavior query DisableDeleteNotify` and run an elevated `defrag /L` retrim), and **SMART Health** (per-disk reliability counters for every physical disk).
- **Encryption**: optional AES-256-GCM per-block encryption (master-key-derived via PBKDF2-SHA256)
- **Verification**: self-check images after write and before restore
- **Retention / GFS pruning**: keep the newest N full chains plus a bounded number of trailing deltas per chain; old images are pruned leaf-first. Retention runs after backup/verification when global auto-cleanup is on, and each scheduled backup can opt into its own retention policy (keep counts + age floor) independent of the global setting.
- **Scheduling + notifications**: scheduled backups run from a friendly
  day-picker (daily / chosen weekdays / a specific day of the month + time,
  with a raw cron editor for power users), with Windows toast + optional
  webhook notification on success/failure. The same picker works for
  scheduled backups targeting a network share (UNC or smb://).
- **Disk health warnings**: SMART/reliability counters surfaced before backup
- **Network-share destinations**: `destinationPath` accepts local paths, UNC
  (`\\server\share`), and `file://`/`smb://` URIs (normalised to filesystem
  paths). `s3://bucket/prefix` destinations write locally then upload to S3
  (SigV4, `AWS_*` env vars); `sftp://user@host/path` destinations stream the
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
incrementals already use), so the `.opbs` format is unchanged and restores
leave spare space untouched. CLI: `backup --used-blocks-only` /
`clone --used-blocks-only`.

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

## How a clone runs

A **clone** copies selected live partitions straight onto another local disk
— no intermediate image, no cloud upload. `CloneEngine` builds the job exactly
like a restore (captured offsets by default, `targetLayout` to move/resize,
fresh GPT/MBR partition table for dissimilar clones), but the source is the
live volume: the helper creates VSS snapshots, reads allocated blocks (skipping
free space with `--used-blocks-only`), and writes them to the target disk at
`target.offset + blockIndex * blockSize`. Same safety gates as restore apply:
a custom layout requires `--confirm-layout`, and cloning onto the source disk
requires `--acknowledge-same-disk`. Any NTFS grow-on-restore request is honored
the same way as a restore.

CLI: `clone <config.json> [--elevated] [--used-blocks-only] [--layout P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout] [--no-write-table] [--acknowledge-same-disk]`.

## How a restore runs

- The engine resolves the **restore chain** for the selected image: it walks
  `baseImagePath` links back to the root full image, then restores `[full, ...deltas]`
  in order so later blocks overwrite earlier writes at their original offsets.
- Each unverified image in the chain is verified (with the provided passphrase
  key) before any data is written.
- Blocks are written to the target disk at `target.offset + blockIndex * blockSize`.
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
  ≤2 TiB disk, ≥LBA63 start, 32-bit LBAs), otherwise GPT. Override with
  `tableScheme` / `--table-scheme gpt|mbr`.
- Optional knobs: `tableDiskGuid` (deterministic GPT disk GUID),
  `tableTypeGuids` (per-partition GPT type GUIDs; default is basic-data), and
  `tableBootPartition` (MBR boot flag).
- `writePartitionTable:false`/`--no-write-table` restores raw blocks only
  (still moves data, but leaves whatever table the target already has).

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
full + delta images, sparse runs, LZNT1-compressed files, and alternate data
streams. EFS-encrypted files are detected and skipped (browse shows a 🔒 and
extract refuses) — decryption is not implemented.

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
- Recognised-but-unreadable features are refused with a clear error instead of
  failing mid-browse: encryption, split multi-part images, and v7 delta chains.
- Whether a partition can be listed depends on the volume: partition images of
  NTFS/FAT volumes browse and extract normally; block streams without a
  resident boot sector (e.g. file/data backups) report that no filesystem is
  present.

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

Backup/restore still require the UAC prompt (raw I/O). Verification, listing,
pruning and health checks do not.

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
confirmation for the whole install). Mounting backup partitions as read-only
drives needs the WinFsp runtime; when it's missing the Dashboard shows a
non-blocking banner that installs the latest WinFsp MSI the same way.

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
  browse/extract (sparse, LZNT1, ADS, EFS detection), used-blocks-only capture
  via NTFS `$Bitmap`, disk-to-disk clone (live VSS copy, dissimilar layout +
  fresh partition table), Macrium `.mrimgx`/`.mrimg` browse/extract, read-only
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

GPL-3.0 (planned)
