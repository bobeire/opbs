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
- ✅ EFS: `$EFS` (attribute 0x100) records are parsed per file; encrypted files
  are flagged in the browse tree (🔒) with Extract disabled, and
  `readPath`/`extractPath` refuse with `EFS_ENCRYPTED` instead of producing a
  plaintext stream. ⬜ **Remaining**: live EFS *decryption* (needs the owning
  user's DPAPI-protected private key and a real EFS volume to validate).

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
- ⬜ **Remaining**: a real boot smoke test on physical hardware/VM (network
  drivers, `startnet.cmd` boot path), which still needs a machine and
  elevated ADK tooling.

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
- ⬜ **Remaining**: none — zstd is fully native.

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
- ⬜ **Remaining**: encrypted images, split multi-.0000 volume files, and
  v7 delta/incremental chains are detected and refused with `MacriumUnsupportedError`.

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
- ⬜ **Remaining**: live smoke test on a machine with the WinFsp runtime
  installed (auto-detected; GUI shows a hint when missing).

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
- ⬜ **Remaining**: none for SFTP.
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
- ⬜ **Remaining**: (optional) multi-volume chains and manual override/tuning of
  the fallback threshold.

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

### Hardware-accelerated crypto / native hashing
- ✅ Native CRC-32 (`crc32`) added to the addon and wired into `image-format`
  (lazy, graceful JS fallback) so per-block hashing during backup/verify runs in
  native code.
- ✅ PBKDF2 + AES-256-GCM already run through Node's OpenSSL-backed `crypto`
  (hardware-accelerated via CPU AES-NI), so no addon move is required for those.
- ⬜ **Remaining**: (optional) port PBKDF2/GCM to the addon for marginal gains
  on very large encrypted volumes.