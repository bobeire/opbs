# Roadmap

Prioritized backlog for OPBS (Open Pickle Backup System). Everything designed
to date has shipped; **Investigate** items need spike work first.

## Shipped

### Shrink-on-restore (restore/clone onto a smaller drive)
- ✅ **NTFS planner** (`imaging/fs/ntfs-shrink.ts`): `planNtfsShrink` +
  `ntfsShrinkMinimum` walk the MFT with their own raw attribute walker, read
  the `$Bitmap` **prefix only** (bounded by the new size, not the volume),
  cross-check bitmap vs MFT (dirty volume → refuse), and pack vacated runs
  first-fit into free clusters below the boundary (splitting across
  fragmentation). Unmovable content above the boundary refuses: OS metadata /
  `$Extend` children / compressed / EFS / attribute-listed / shared clusters /
  `$BadClus`. Emits a serializable `NtfsShrinkPlan` (moves, on-disk MFT record
  patches with fixups planted, `$Bitmap` byte regions, shrunken boot sector,
  `$MFTMirr`). Minimum = used + 1 MiB margin, 1 MiB aligned. Crash-safe apply
  — a failed shrink FAILS the restore/clone: shrunken boot sector first (a
  crash never leaves a volume advertising a too-large size) → data blocks
  routed through the move map (blocks straddling the boundary split at cluster
  granularity; free blocks above it skipped entirely) → MFT patches /
  `$MFTMirr` → `$Bitmap`.
- ✅ **Surfaces**: restore accepts a smaller `--layout P:OFF:SIZE`
  (`buildJob` attaches `shrinkInfo`, refuses a target below the minimum,
  `--preflight` prints "minimum shrink target: X"); clones check feasibility
  helper-side against the live source before any write (the engine has no
  disk-read access) with the same crash-safe apply; the RestoreWizard's
  per-partition size field (GB) shows the minimum and surfaces refusals live
  via `shrinkInfo` on the preflight result.
- ✅ **Auto-shrink-to-fit (PartitionCopy)**: `planTargetLayout` gains a
  `shrinkToFit` option that scales scalable partitions down into a smaller
  target (1 MiB–aligned, never below a per-partition `minSize`; `noShrink`
  partitions keep their source size and the plan errors if the set can't
  fit), exposed as a "Scale partitions down to fit" checkbox.
- ✅ **FAT32 shrink** (`imaging/fs/fat32-shrink.ts`): `planFat32Shrink` /
  `fat32ShrinkMinimum` mirror the NTFS planner — relocate clusters at/above
  the boundary into free space below it (cluster→byte offset is
  `dataStart + (c−2)·clusterSize`, so moves carry partition-relative
  offsets), re-link the FAT, patch moved directory entries (split
  start-cluster) and the BPB root, and write a patched boot + fixed backup
  boot + FSInfo. The helper and the restore engine sniff the boot sector
  (`detectFatType`) and branch NTFS/FAT32 at every shrink site. Refusals: not
  FAT32, below minimum, bad cluster at/above the boundary, not enough free
  space below it, chain cycle.
- ✅ **Tests**: `ntfs-shrink.test.ts` (14 — planner fixtures: fragmented
  runs, sparse, front free space, refusal matrix, min-size math,
  bitmap-prefix-only reads; plan/apply round-trip re-parsed via `ntfs.ts`),
  `restore-shrink.test.ts`, `clone-job`/`clone-engine` shrink cases,
  `clone-layout.test.ts` (12, incl. 6 auto-shrink-to-fit),
  `fat32-shrink.test.ts` (7) with the synthetic FAT32 fixture in
  `test/helpers/fat32-shrink-fixture.ts`.

### Restore directly from cloud (0.6.83)
- ✅ `restore` accepts cloud URIs (`s3://`, `sftp://`, `ftp://`, `ftps://`):
  `imaging/cloud-restore.ts` plans the download — resolves the URI against the
  object-store listing (exact key, or a directory holding a single image; a
  delta key pulls its whole `baseImagePath` chain, root first, plus `.NNN`
  split volumes) — and `materializeImageFromCloud` stages the set into an
  `opbs-restore-*` temp dir with per-file progress (`cloud-download-progress`
  IPC), a free-space check against the temp volume, and dir cleanup on success
  or failure. `utils/cloud-store.ts` builds the right store from the URI
  scheme with the existing profile/env credential resolution
  (`utils/cloud-profiles.ts`).
- ✅ Surfaces: the Restore wizard cloud field (fetch + live download progress +
  staged-copy notice; staged copies are released when replaced, when the
  restore completes, and on wizard unmount), the `restore` CLI (cloud
  `imagePath`), and scheduled restore drills (cloud `--dir` listings via
  `cloudImageEntries`, staged before the drill runs).
- ✅ Tests: `cloud-restore.test.ts` (13) — URI classification, chain planning
  (root-first order, split volumes, missing base, cycles, ambiguity),
  staging lifecycle (progress, free-space refusal, partial-dir cleanup on
  failed downloads, non-cloud refusal) and the cloud listing → drill picker
  path; plus 3 chain-order regression tests in `restore-engine.test.ts`
  (a picked delta roots the job at the chain full — `applyDeltas` no longer
  drops it).
- ⏸️ Deferred by design: download resume and ranged-read streaming (the
  alternative to staging) — staging covers the drill/restore sizes seen so
  far; revisit if multi-TB offsite restores become common.

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


### Reflect 8 (.mrimg) real-sample validation (0.6.72)
- ✅ Ground-truth validation against a real Reflect 8 chain (full 206 MB +
  `-01-01` + `-02-02`, sparse 119 GiB NTFS partition, ~5.8k stored blocks):
  the container is byte-compatible with the v7 layout (same trailer magic and
  `07 00` version word, same footer XML tags `<aes>`/`<method>`, 30-byte
  records / 34-byte delta records), so the existing reader parses it
  unchanged — full images, differentials (full-extent index with carry
  markers) and incrementals (delta index) all browse with every stored block
  MD5-verified and carried blocks byte-identical to the base.
- ✅ Bug fixed for Reflect 8 incrementals: their footer packs the delta
  records tightly after the path marker, so the 30-byte marker scan latches
  onto adjacent metadata and invents a phantom second partition whose records
  hold garbage offsets (seen: a 79 TB filePosition) — generic block
  iteration then threw `read out of range`. The chain role now prunes
  impossible section kinds before partitions are built: an incremental keeps
  only its delta index, a differential/full only its full-extent index.
  Regression-guarded by an explicit one-partition-per-file assertion.
- ✅ Real-sample test suites now discover samples dynamically
  (`test/unit/helpers/v7-sample.ts`): `$OPBS_V7_SAMPLE` / `$OPBS_V7_CHAIN_DIR`
  first, then `*-00-00.mrimg` at the repo root or in `imagefilesamples/`,
  with chain roles read from each file's footer instead of assumed from the
  numbering — so future sample drops keep the suites running. The job-runner
  restore round-trip stays opt-in via `$OPBS_V7_SAMPLE` (and refuses samples
  over 64 MiB): it compares the restored extent in memory, which a sparse
  multi-hundred-gigabyte fleet partition would take down with it.

### Reflect X (.mrimgx) real-sample validation (0.6.73)
- ✅ Ground-truth validation against three real Reflect X full images
  (100 MiB FAT32 EFI system partitions on a 500 GB GPT disk, zstd/medium,
  unencrypted): the `$JSON`/`$INDEX`/`$TRACK0` chains parse cleanly
  (1 partition, 1600 × 64 KiB data blocks, ~5.8k blocks/sample when full),
  `unsupported` and `restoreRefusal` are null, and every stored block the
  reader serves is MD5-verified against its index record.
- ✅ Bug fixed for FAT32 volumes with large boot regions: the filesystem
  reserves megabytes before its first cluster (`lcn0_offset - start` =
  4 MiB on these samples), so the data blocks start at LCN 0 — not at the
  boot sector — and the boot area + FATs are captured separately as the
  index's single "reserved" track (one zstd frame at the head of the file,
  86 KB stored for the 4 MiB region). The reader used to refuse any
  partition with `dataStart > 0` ("only NTFS volumes are browsable");
  instead it now maps the reserved track in front of the data blocks
  (`MacriumPartitionInfo.reserved` is populated by the parser), so reader
  offset 0 is always the boot sector — what the NTFS/FAT32/exFAT browse
  and restore layers expect. A `dataStart > 0` image *without* a reserved
  track (a headless capture) is still refused with a clear message.
- ✅ End-to-end FAT32 browse proven on all three samples: boot sector
  (`EB 58 90 MSDOS5.0`, `"FAT32   "` @0x52, `55 AA`) reads from the
  reserved track, the filesystem layers detect FAT32, and directory
  listings walk the ESP (`EFI/`, `System Volume Information/`).
- ✅ Real-sample suite `test/unit/mrimgx-real.test.ts` (17 tests) discovers
  samples via `findMrimgxSamples()` (`$OPBS_MRIMGX_SAMPLE` or every
  `imagefilesamples/*.mrimgx`) and skips cleanly when none are present;
  synthetic regressions cover the reserved-track mapping (including a
  boundary-spanning read and the headless-capture refusal) without needing
  real samples.

### Incremental chain relocation (0.6.74)
- ✅ OPBS incremental headers store their base as an absolute path captured
  at backup time, which goes stale the moment the backup folder is moved,
  copied to a NAS, or its drive letter changes (USB drives, WinPE recovery
  media where letters are reassigned). Every chain walker now resolves each
  hop through `locateBaseImage` (`image-format.ts`): candidates come back
  **co-located file first, stored path second** — the base sitting beside
  the referencing image is the one written with that chain, while the stored
  path may still exist yet already hold a *different generation* of the same
  file (a copy with the original still attached, a rotated full). Ordering
  matters: stored-first would silently chain deltas onto the stale original.
- ✅ Retention and chain health follow the same rule via
  `baseImageCandidates` (`retention.ts`): `groupIntoChains` links deltas to
  the co-located base when the recorded path is stale (chain completeness
  and `inChain` manifest flags included), and the base-protection fixpoint
  now protects that co-located base from pruning — previously a kept delta
  in a relocated folder could not match its base, so retention was free to
  delete it out from under the delta. Chain-health reports derive from
  grouping, so healthy relocated sets no longer show up as orphaned chains
  with missing bases (which fed warning/critical fleet check-in status).
- ✅ Single walker: the duplicated `resolveBaseChain` copy in `job-runner.ts`
  is gone — restore, browse, and the backup base-CRC map all use
  `resolveImageChain`, so this class of fix can never be half-applied again.
- ✅ Tests: `chain-relocation.test.ts` (control, moved folder with exact
  chain assertion, **copy-with-original-alive must bind to the copy**,
  multi-hop move, cross-folder stored fallback, missing-base error naming
  the stored path); relocation cases added to `retention.test.ts`
  (grouping + base protection after a move) and `chain-health.test.ts`
  (moved folder reports complete, no missing bases).

### IPC input hardening — disk/volume sinks (0.6.75)
- ✅ Defense in depth at the IPC boundary: the disk tools
  (`get-mbr-info`, `get-mbr-raw`, `check-disk-health`) interpolated the
  renderer-supplied `diskIndex` straight into PowerShell `-Command` text
  (`Get-Disk -Number ${diskIndex}`, `\\.\PhysicalDrive${diskIndex}`,
  `$diskIndex = ${diskIndex}; ...`), and the chkdsk/retrim handlers did the
  same with `volume` (`chkdsk ${volume} /scan`, `& defrag ${volume} /L`).
  TypeScript annotations are erased at runtime — `contextIsolation` and
  `nodeIntegration: false` harden the renderer, but a compromised renderer
  can still `invoke` any handler with any argument shape, so main must
  re-validate anything that reaches a command string.
- ✅ New `src/main/utils/input-guard.ts`: `toDiskIndex` (non-negative
  integer only) and `toChkdskVolume` (bare drive letter, optional trailing
  slash — `^[A-Za-z]:\\?$`, matching what the UI sends). Both are applied
  at the **sinks** (`queryReliability`, `getMbrInfo`, `getMbrRaw`,
  `chkdskScan/Fix/BadSectors`, `retrimVolume`) so the CLI/helper-process
  paths are covered too, and at the IPC handlers for clean boundary
  errors. `get-partitions` was never injectable (the value crosses into
  the native addon, coerced to int32) but now validates at the boundary as
  well. BitLocker unlock already validated its letter (`/^[A-Z]$/`) —
  this brings the rest of the surface to the same standard.
- ✅ Tests: `input-guard.test.ts` — payload rejection (`0; Start-Process
  calc`, floats, negatives, non-strings) plus sink-level assertions that
  malicious values are refused *before* any process spawns.

### Renderer content-security policy (0.6.82)
- ✅ Production builds ship a `Content-Security-Policy` meta tag in the
  renderer: `default-src 'self'` with strict `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'` (React style attributes — the only
  inline exception), `img-src 'self'`, `font-src 'self'`, `connect-src
  'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
  The renderer does no fetch/XHR/websocket/worker/blob loading at all (every
  cross-boundary call goes through the contextBridge IPC), so nothing else
  needs an allowance; no `eval`/`new Function`, iframes, or data-URIs exist
  anywhere in the renderer.
- ✅ Injected by a build-only Vite plugin (`transformIndexHtml`, `apply:
  'build'`) so the dev server keeps its inline module preamble and Electron's
  dev-mode `localhost:5173` load is unaffected; the built
  `dist/renderer/index.html` carries the meta tag.
- ✅ Enforcement test: `gui-click.test.ts` collects renderer console messages
  matching `Content Security Policy` / `Refused to` and fails if any appear
  while it walks all seven sidebar views, so CI proves the policy blocks
  nothing the app actually needs.

### CI on GitHub Actions + encrypted-image restore drills (0.6.81)
- ✅ `.github/workflows/ci.yml`: every push/PR runs the full gate stack on
  `windows-latest` — `npm ci` (+ electron's binary invoked explicitly, since
  npm's allow-scripts guard leaves its postinstall pending), main/preload tsc
  (must be clean), renderer tsc (fails if error count exceeds the 16-error
  baseline — raised to a hard zero gate once that baseline was cleared in
  `b217f09`), eslint parsed from JSON output (fails above the 9-error /
  195-problem baseline), `npm run build`, the native addon, and the entire
  vitest suite — Electron integration test included. Two real bugs surfaced
  getting there: `build:native` ran `node-gyp rebuild` at the repo root where
  no `binding.gyp` exists (it now targets `src/native`, the only directory it
  ever worked from — historically masked by the manual `cd src/native &&
  npm install` flow), and root node-gyp needed 12.1+ for the runners'
  Visual Studio 2026. Native-dependent tests also self-skip cleanly when the
  addon is absent, so partial environments stay green. The gates that were
  previously only ever run by hand now guard every commit.
- ✅ **Restore drills cover encrypted images.** The scheduler's
  `pickDrillImage(entries, passphrase)` (in `retention.ts`, shared with the
  CLI's inline `--dir` mode) picks the newest *drillable* image: any image
  when a passphrase is configured, otherwise unencrypted-only as before. The
  drill schedule gained an **Image passphrase** field (Settings → Scheduled
  Restore Drills) that is encrypted at rest by the 0.6.79 secret walk, and
  the key reaches the elevated drill child inside the short-lived drill
  config — the same job-file channel backups already use, never on argv. The
  engine's existing `RestoreJobConfig.passphrase` does the actual decrypt, so
  no imaging code changed. Previously the backups you'd most want tested
  (encrypted) were the only ones never drilled.

### Theme selector — match Windows / light / dark (0.6.80)
- ✅ Settings → **Appearance** offers three modes: **Match Windows**
  (default-follows-OS), **Light**, and **Dark** (the app's current look, and
  still the default — existing installs render identically). The renderer
  resolves the mode to `data-theme` on `<html>`: the `:root` block keeps the
  dark palette as the shipped default (correct paint before any JS runs), a
  `:root[data-theme='light']` block overrides the surface/text/border/link
  vars, and `color-scheme` flips so native controls (scrollbars, form
  widgets) follow too. The mode lives in `settings.json` (`theme`), synced to
  Electron's `nativeTheme.themeSource` in main so OS-level UI (menus,
  `prefers-color-scheme`) matches the choice; **Match Windows** additionally
  subscribes to the `prefers-color-scheme` media query and re-renders live
  when Windows switches themes.
- ✅ Beyond the palette vars, the conversion swept the hard-coded colors that
  would break on white: the three light-grey hover/input text colors became
  `var(--text-color)`, link blues became `--link-color` (light variant darkens
  to `#2563eb` for contrast), and the white-alpha row tints/hovers (breadcrumb
  bar, file-table head, hover rows, zebra tables, inline code) became
  `--subtle-bg/-hover/-strong` vars with dark-alpha equivalents in light
  mode. Terminal-style panels (`.log-content`, `.disk-tools-pre`, copy-strip)
  deliberately keep their dark background in **both** themes so their light
  text stays correct — they're console output, not surfaces.
- ✅ No flash: the resolved mode is mirrored to `localStorage` and applied
  synchronously in `main.tsx` before React mounts; App then reconciles with
  the authoritative settings value over IPC, and the Settings page applies a
  change on Save (consistent with every other setting).

### Secrets encrypted at rest + passphrase off the command line (0.6.79)
- ✅ `settings.json` held every secret in plaintext: scheduled-backup and
  backup-profile passphrases, plus the S3 secret access key, SFTP
  password/private key and FTP password — readable by anything that can read
  the user's AppData. All six fields are now encrypted at rest with
  Electron's **safeStorage** (DPAPI on Windows — the same OS store BitLocker/
  EFS-style secrets live in, bound to the logged-in user), stored as
  `enc:v1:` blobs by the new `secret-store.ts`. In-memory settings stay
  plaintext so the scheduler, wizard and IPC round-trip are unchanged; the
  encrypted form only ever exists on disk. A legacy plaintext file is
  migrated on the first post-ready read (one rewrite, detected via the
  prefix), and if the OS secret store is ever unavailable the code degrades
  to the old plaintext behavior with a warning instead of failing the app.
  Hydration is lazy because `SettingsManager` is constructed at module load,
  before `app.whenReady()` — safeStorage only works after ready.
- ✅ The unattended-task job configs (`%APPDATA%\opbs\tasks\<id>.json`) were
  a **second plaintext copy** of the schedule passphrase; they now store the
  same `enc:v1:` blob. Only the GUI writes these files and only
  `OPBS.exe --cli backup` reads them — both post-ready, so the CLI decrypts
  transparently; hand-written configs stay plaintext and pass through
  unchanged.
- ✅ CLI passphrase sources: `--passphrase-file <path|->` (file, or `-` for
  stdin) and the `OPBS_PASSPHRASE` environment variable, resolved by one
  shared `resolvePassphrase()` across all eight call sites (verify, scrub,
  browse, extract, mount, store verify, repo key resolution) with precedence
  file > env > flag. The legacy `--passphrase p` keeps working — argv is
  readable by other processes, so it now prints a one-time stderr warning
  pointing at the alternatives, and an unreadable passphrase file throws a
  loud error rather than silently continuing without a key. The GUI never
  put a passphrase on argv (job files are consumed on read since 0.6.78) and
  scheduled tasks already used the config file, so this closes the last
  exposure surface.
- ✅ Tests: `secret-store.test.ts` (round-trip, no double-encrypt, legacy
  plaintext, pre-ready and unavailable fallbacks, foreign-blob handling),
  `settings-secrets.test.ts` (all six fields encrypted on disk + plaintext
  served in memory + reload round-trip + legacy migration + no-keyring
  fallback), task-config encryption cases in `task-scheduler.test.ts`, and
  `cli-passphrase.test.ts` (precedence, newline stripping, `=` form, one-time
  warning, unreadable file). A small `electron-access.ts` indirection makes
  the lazy `electron` require testable — `vi.mock('electron')` does not
  intercept raw `require()`.
- ⏸️ Left as-is by design: settings **export** writes the values a user
  explicitly picked a path for (import on the same machine keeps working),
  and the WinPE pre-seeded restore config template ships `passphrase: ''` for
  the user to fill on physical media.

### Helper job files consumed on read + stale temp sweep (0.6.78)
- ✅ The encryption key (or passphrase) travels from a writer to a runner in
  a plaintext `job.json` under the OS temp dir, and every runner used to
  leave it there: `dispatchHelperJob` read it for a type sniff and the
  runners re-read it, so the file survived until the launcher's `cleanup()`
  on settle — which never runs if the helper crashes or the machine dies.
  Every runner read now goes through **`readAndConsumeJob`**
  (`src/main/helper/job-file.ts`): read → delete → parse, at the six real
  read sites (`job-runner.ts` backup/restore/clone/mount plus the VSS
  branch of dispatch, `backup-vhd-job.ts`, `restore-vhd-job.ts`). The delete
  happens *before* the parse, so a corrupt file is destroyed rather than
  left for anyone to read. Dispatch keeps its own plain read (it only
  sniffs `type`); the runners consume milliseconds later regardless.
  The VHD jobs are a two-stage flow — consume the wrapper job, rebuild an
  inner `backup`/`restore` job, write it, hand it to the real runner which
  consumes again — verified end to end.
- ✅ Consumers that were already gone: `launchElevatedJob` writes the file
  and only ever reads `result.json`/`progress.json` afterwards; the CLI
  wizard/drill/scheduled paths read `resultPath`; `runAsHelper` reads
  `resultPath`. No engine (`backup-engine`, `restore-engine`, `clone-engine`)
  or scheduler code touches `job.json`.
- ✅ **Sweep for the crash gap** (`src/main/utils/job-dir-sweep.ts`): a
  defensive scan of the temp dir at GUI startup removes `opbs-job-`,
  `opbs-wizard-`, `opbs-scheduled-` and `opbs-drill-inproc-` directories
  whose *entries* are stale — 1h if an unconsumed `job.json` is still in
  there (the reader never ran: helper crashed between spawn and read), 24h
  if the job ran and only `progress.json`/`result.json` litter remains.
  Age is computed from the newest entry, not the directory's own mtime:
  NTFS never bumps a directory's mtime when files inside are rewritten, so
  a directory can look hours old while a job is actively progressing — and
  `runMountJob` heartbeats `progress.json` every 5s, so a multi-day mount
  is never swept. Best-effort per directory (races, in-use handles), logged
  and skipped.
- ✅ Tests: `job-file.test.ts` (consume + corrupt-JSON consume + missing),
  `job-dir-sweep.test.ts` (unconsumed stale, fresh, live-heartbeat with an
  artificially old dir mtime, consumed-stale, consumed-recent, all three
  temp-dir prefixes, non-matching prefixes and regular files untouched,
  empty-dir fallback), plus `existsSync(jobPath) === false` assertions after
  runs in `job-runner.test.ts` (success and cancelled), `mount-job.test.ts`
  (dispatch) and `backup-vhd-job.test.ts` (all four tests — the mocked
  inner runner now consumes like production).

### Parity build off the main thread (0.6.77)
- ✅ Post-backup XOR parity (`buildParity`) re-reads every frame of the new
  image via thousands of synchronous `fs` calls — on the Electron main
  thread that froze the whole UI during the "finalizing" phase (the label
  painted once, then the window went unresponsive until the sidecar was
  done, and the completion screen could not appear until parity finished).
  It now runs on a **worker thread** (`parity-worker.ts`): the main thread
  stays fully responsive, per-group progress streams back over
  `postMessage` so the finalizing label shows a live percentage
  (`Building parity recovery data… 47%`), and the sidecar is byte-identical
  to the sync build (both paths share the same code). Semantics unchanged:
  a backup is not "completed" until its recovery data exists, and parity
  failure remains a logged warning, never a backup failure. Sync
  `buildParity` is untouched for CLI/WinPE (`parity build`, scrub child
  processes) where there is no event loop to keep alive. Cancellable
  parity deliberately deferred (single sequential read, a fraction of the
  backup's own runtime; a half-written sidecar state isn't worth it yet).

### PBKDF2 work factor raised to OWASP guidance (0.6.76)
- ✅ New encrypted images and passphrase-mode repositories now stretch keys
  with **600,000** PBKDF2-HMAC-SHA256 iterations (OWASP 2023+ guidance),
  up from 210,000 (a ~2016-era figure). Both constants are create-time
  only — the iteration count has always been stored per container (image
  header field at offset 52; `kdf.iterations` in `opbs-repo.json`) and
  every decrypt path derives with the *stored* value, so all existing
  encrypted images and repositories keep opening unchanged; no migration
  and no format bump. Cost: ~+0.3–1s of `pbkdf2Sync` per image open,
  against operations that already take seconds to hours. Tests now pin
  the ≥600k floor for new ciphers and repo headers. (Argon2id remains
  OWASP's preferred KDF but needs a new alg id in the header — a future
  format extension, not a constant bump.)

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


### Fleet Tier 4 — remote actions (0.6.71)
- ✅ Bidirectional control plane: the fleet server's queue turns "run a
  diagnostic on that machine" into a one-liner (`fleet action ...`), and the
  machine runs it at its next check-in when enrolled with `--run-actions`
  (`"runActions": true` in the settings file) — results ride back inside the
  check-in, failures surface as warning reasons on the dashboard/status.
- ✅ Whitelist by construction (`FLEET_ACTION_NAMES`): only the six read-only
  diagnostics — `verify`, `scrub` (never `--repair`), `chain`, `analytics`,
  `anomalies`, `storage-health` — can be queued; the enqueue gate
  (`validateActionRequest`) refuses anything else, and the machine's runner
  re-checks the whitelist before spawning (defense in depth against a
  confused or malicious server). Every action requires a target `dir`; an
  optional `scope` (`newest`/`all`) applies where the command has one.
- ✅ Queue (`actions.json` in the server's dataDir, schema 1, atomic writes):
  `POST /api/action` enqueues (400 with a helpful message when `*` is
  broadcast before any machine has checked in), `GET /api/action` lists the
  pending queue for admins, and `POST /api/actions/<machineId>/claim` pops a
  machine's entries read-modify-write with no awaits in between — a machine
  never double-claims. Broadcast `*` expands to every known machine at
  enqueue time, sharing one action id across the batch.
- ✅ Machine side: `fleet checkin --run-actions` claims, runs each action
  sequentially in a child process (`OPBS --cli <action...> --json`, hard
  15-minute timeout per action, output capped), and attaches the results to
  the outgoing check-in; a claim failure only logs and never blocks the
  check-in itself, and `--dry-run` stays pure JSON (no actions run).
- ✅ Results (`actions: [{id, action, ok, startedAt, finishedAt, summary,
  detail?}]`) replace the previous run's list each check-in, pass the same
  schema validation as everything else (informational — an "unsupported
  action" failure is still reportable), and turn into
  `action <name> failed: <summary>` warning reasons that `critical` still
  outranks.
- ✅ CLI: `fleet action <name> --server <url> --machine <id|*> --dir <dir>
  [--scope newest|all]` queues, `fleet action queue --server <url>` lists.
- ✅ Tests (+28, 144 fleet tests): request validation matrix (dangerous
  actions refused, machineId/dir/scope rules), result validation +
  unsupported-action round-trip, arg mapping for all six commands (never
  emits `--repair`), runner behavior with an injected executor (JSON detail,
  stderr summaries, timeouts, oversized-output clipping, no-spawn on invalid
  requests), server routes (token gates, 400s, one-shot drain, broadcast
  sharing an id, restart persistence, 404/405 dispatch), settings
  (`runActions` load + flag/settings precedence).


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

### Dissimilar-hardware restore
- ✅ Layout mapping: a restore may specify `targetLayout` (or CLI
  `restore --layout 0:4096,1:8388608`) to re-order/move captured partitions to
  different target offsets; placements are validated against target disk size.
- ✅ Partition-table builder + disk-identity guards + filesystem resize: see the
  "Native partition-table builder" section.

## Investigate

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
- ✅ **Design pass complete (2026-10-12)** — implementation phased below; a
  bug here corrupts live backups, so every phase lands behind the full gate
  stack with round-trip tests.

#### Phase 0 — prerequisite: encrypted-chain key correctness (bugs found in design)
- The design audit surfaced two real bugs that flatten-and-re-encode depends
  on fixing first:
  - **Wrong key minted for every encrypted restore.** `buildJob` derives the
    job's `encryption` from `metadataFromCipher(newImageCipher(passphrase))`
    (`restore-engine.ts` — a *fresh random salt*), and the helper decrypts
    with that key (`job-runner.ts` `cipherFromMetadata(job.encryption).key`).
    The image was encrypted with the key derived from the *image header's*
    salt, so any encrypted restore with a passphrase fails at the verify
    gate (or the first encrypted frame when `FLAG_VERIFIED` skips it). The
    correct pattern already exists everywhere else (CLI verify/scrub/browse,
    IPC, mount, scrub all use `deriveImageKey(passphrase, header.salt,
    header.kdfIterations)`). This hits the GUI, the CLI `restore`, and the
    scheduled restore drills (`cmdDrill` → `buildJob`).
  - **One key for a whole chain, but each member has its own salt.** Every
    backup mints its own cipher, so `[full, Δ1, Δ2]` normally have three
    different keys; restore applies one job key to all sources, and browse
    derives one key from the chain *head* (`main-ipc.ts` →
    `ChainPartitionReader`). A block living only in a non-head member fails
    decryption even after the first bug is fixed.
- Fix: key material is derived **per source from that source's header** and
  carried as a per-source array on the job (`RestoreJob` gains
  `sourceEncryption[]`); the helper picks the key per source, and
  `ChainPartitionReader`/`openBrowse` take a per-member key map. Regression
  tests: encrypted full restore through `buildJob` → `runRestoreJob`, and an
  encrypted-chain browse/restore round-trip with per-member salts — both fail
  on today's code.
- Compaction's re-encode path reuses exactly this per-member derivation, so
  Phase 0 is shared plumbing, not a detour.

#### Composition semantics (all phases)
- **Logical block map**: for every `(partitionIndex, blockIndex)`, the newest
  member holding an index record wins — same newest-wins rule as
  `ChainPartitionReader` and the restore apply loop, so the compacted image
  is byte-equivalent to restoring the chain. Blocks absent from every member
  stay absent (sparse = zeros on restore; restore already zero-fills from the
  chain union).
- **Frame relocation, not re-encoding, for plaintext chains**: the exact
  stored frame bytes (self-describing 16-byte header + payload, incl. IV/tag
  for encrypted frames) are copied verbatim into the new file; the new
  `BlockRecord` keeps `rawSize`/`compSize`/`rawCrc32` and gets the new
  `fileOffset`. No decompress/recompress → no CPU cost, and the CRC fields
  (plaintext in the frame header) keep `verifyImage`/scrub/parity working on
  the output without any key. Multi-volume members are read volume-routed via
  `resolveVolumePath`.
- **Re-encode for encrypted chains** (needs the passphrase): each frame is
  decrypted with its *member's* key (Phase 0), the **compressed payload is
  preserved** (no recompression), re-encrypted under a new image cipher
  (`newImageCipher` — new salt, fresh IV per frame), CRCs unchanged. Mixed
  plaintext/encrypted members, or a chain mixing block sizes, compression
  codecs, or cipher modes, is refused — frame headers carry no codec field,
  so restore already assumes a chain's compressionId is uniform; compaction
  validates that invariant instead of inheriting a latent break.
- **New image header**: version 2, `timestamp = now` (it is a new restore
  point — retention grace and `findNewestImage` treat it accordingly, so the
  next incremental attaches to it), `totalBytes`/`blockSize`/`partitionCount`
  from the root with uniformity checks across members, no `FLAG_INCREMENTAL`,
  empty `baseImagePath`. Written through the normal header/index/patch
  sequence (`blockIndexOffset` patched, `FLAG_VERIFIED` set only after a full
  `verifyImage` of the output).
- **Sidecars**: the newest member's `.usn` cursors and `.bitlocker.json` are
  carried onto the new image (same partition/volume identity — the next
  incremental keeps USN tracking; BitLocker keys are per-disk), old
  `.volumes.json`/`.opar` are not carried; a fresh `.opar` is built for the
  new image best-effort (same as post-backup). Manifest/analytics/chain-health
  need no schema change — the output is a healthy 1-item chain.
- **Atomicity & source removal**: output is written into an
  `opbs-compact-<id>/` temp sibling dir (covered by the startup
  `job-dir-sweep` prefixes), fully verified, then atomically renamed into
  place. `--remove-source` deletes the old chain only after that rename,
  newest-delta-first, root last (same leaf-first order as retention), and
  never touches a member whose removal fails (report, don't half-delete).
  Default keeps sources for retention to age out.
- **Free space** is checked up front against the *composed unique bytes*
  (union size) plus headroom — the cloud-restore `statfs` pattern.

#### Triggers, surfaces, phasing
- ✅ **CLI (Phase 1, done 2026-10-12)**: `compact <image> [--remove-source]
  [--dry-run]` — any chain member names the whole chain; prints member list,
  composed unique blocks/bytes, estimated output, and the refusal reason when
  gated. IPC `compact-chain` (+ `cancel-compact` + `compact-progress`) mirrors
  it for the GUI. Encrypted chains re-encode under a fresh cipher (per-member
  keys, compressed payload preserved); plaintext chains relocate frames
  verbatim. Output lands in `opbs-compact-<id>/`, is fully verified, then
  atomically renamed; `--remove-source` deletes leaf-first with USN/BitLocker
  sidecar carry (BitLocker re-sealed under the new key) and a fresh `.opar`.
- ✅ **Automatic (Phase 1.5, done 2026-10-12)**: `compactAfterDeltas` setting
  (default 0 = off) runs compaction after a scheduled backup, before
  retention, with remove-source — retention then sees a single-image chain.
  Refusals are logged and never fail the scheduled run; the tamper manifest
  is rewritten after removal. Settings toggle (Chain Compaction section) +
  a Dashboard "Compact chains" action (Backup Integrity panel, keeps
  sources — retention ages them out) complete the GUI surface; concurrent
  compactions are refused cleanly.
- **Refused in v1**: Macrium containers, cloud destinations (Phase 2: stage
  via the new `cloud-restore`, compact locally, upload, prune). Repository
  members were refused until Phase 2; they now compact through the signed
  journal (see below).
- **Phase 2**: multi-volume output — ✅ done 2026-10-12: the compaction
  writer rolls frames into `.001`/`.002`… volumes at the destination
  filesystem's per-file limit (FAT32 → 3.9 GB auto-detected, same helper as
  backups; `CompactOptions.maxVolumeSize` overrides, 0 forces a single file).
  Frames are never split across volumes; the block index carries
  volume-relative offsets with `volumeIndex`; the real partition table is
  written to every volume while earlier volumes keep `blockIndexOffset` 0
  (readImageInfo redirects to the last); FLAG_VERIFIED is patched on every
  volume because readImageInfo returns the last volume's header; side volumes
  are renamed before the base so the base file marks a complete set; and the
  output-collision refusal also catches orphan `.001` leftovers.
  - ✅ **Repository compaction as a signed journal operation (done
    2026-10-13)**: `compactChain` routes repository members through a
    structured gate before any chain check — same repository, readable +
    signature-verified journal, every member active with base links matching
    the file chain, and (for `--remove-source`) every member eligible under
    the same expired-or-unlocked rule as `repo prune`. Output must stay
    inside `images/`, the compacted image is journaled with a signed create
    (mirror-first when an S3 profile is present, rolled back if the journal
    write fails), sources are removed via per-member signed prune records
    deltas-first stopping at the first failure, and the tamper manifest is
    skipped for repositories (the journal is the authority). CLI
    `--repo-keyfile`/`--repo-passphrase` (separate from the image
    passphrase), IPC passes the repo key + S3 profile; cache-hydrated S3
    repositories are refused (their journal lives with the session).
  - ✅ **S3/SFTP/FTP chains end-to-end (done 2026-10-13)**: `compactCloudChain`
    stages the cloud chain through the same `cloud-restore` download used by
    cloud restores, compacts locally in the staging dir, then uploads the
    compacted image (base + side volumes + BitLocker sidecar) into the same
    store prefix. With `--remove-source`, old remote members are deleted
    newest-first only AFTER the upload is re-listed and size-verified —
    failed or truncated uploads are rolled back and never touch the live
    chain. Directories holding a `opbs-repo.json` journal are refused
    (repository images compact through the repository), S3 uploads carry
    Object Lock retention from the profile, and the result reports the
    remote destination URI. CLI: `compact s3://… [--region <r>]`;
    IPC passes the saved S3/SFTP/FTP profiles; progress gains a `staging`
    phase (byte-based percent while downloading).
  - ✅ **parity/scrub multi-volume gap (fixed 2026-10-12)**: `.opar` building
    and `classifyImage` opened only `imagePath` while multi-volume
    `BlockRecord.fileOffset` is volume-relative (verify/restore volume-route
    correctly, parity did not) — sidecar v2 stores each member's
    `volumeIndex` (v1 sidecars still parse), and `buildParity`,
    `verifyParity`, `repairParityBlock` and `classifyImage` route every
    frame read through the volume the block lives in — repair rewrites the
    recovered frame inside its own volume, never the base file.
- **Tests**: composition map (newest-wins, sparse gaps, multi-hop),
  copy-mode round-trip (per-block equality against `ChainPartitionReader`
  over the original chain), encrypted re-encode with per-member salts,
  refusal matrix, remove-source ordering + sidecar carry, USN continuity
  (next delta after compaction still skips unchanged blocks), free-space and
  crash-simulation (mid-write kill leaves no final artifact, sweep cleans
  the temp dir), multi-volume output (frame-boundary rolls, cross-volume
  verify, orphan-side refusal), repository journal flow (`repo-compact`:
  signed create alongside a locked chain, lock/eligibility refusal, unlock →
  deltas-first signed prunes with signature-chain re-verification, output
  outside `images/` and missing-key refusals), cloud flow (`cloud-compact`:
  stage → compact → upload → verified prune, failed-upload rollback,
  size-mismatch verification, repository-directory refusal, dry-run
  passthrough), multi-volume parity/scrub
  (build → corrupt `.001` → repair → exact-byte compare, v1 sidecar parse),
  plus a restore-to-VHD byte-compare of pre- vs
  post-compaction chains.

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