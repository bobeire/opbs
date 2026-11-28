# Versioned file/folder backups

OPBS can back up selected folders and files into an existing OPBS repository as
**encrypted, versioned snapshots**. This is a separate artifact from a disk
image: a snapshot is not a mountable volume and is never accepted by the disk
restore path.

This feature is available in the **Files & Folders** page in the GUI and through
the headless `files` CLI commands below. Both use the same in-process engine.
There is no live watcher and no VSS-backed file capture yet. It is intended for
desktop Windows paths that are readable by the current process; WinPE source
capture is not part of this version.

## What it does

- Creates a new immutable version on every `files backup` run.
- Stores file contents as deduplicated, encrypted, content-addressed chunks.
- Encrypts the per-snapshot manifest and signs an append-only file catalog with
  a key derived from the repository key.
- Restores a whole snapshot or selected relative paths.
- Verifies catalog signatures, manifest hashes, chunk authentication and
  content hashes.
- Applies retention only after lock expiry and a full verification pass.
- Offers a **one-way mirror** that makes a destination folder match a snapshot.
  It is never a two-way sync and is plan-only by default.

## Non-goals for this version

- Two-way sync or conflict resolution.
- Real-time watching or automatic background mirroring.
- Cloud destinations for file snapshots.
- VSS/application-consistent file reads. Files are read directly; a file that
  changes during capture is retried and then skipped with a warning (or fails
  the run when `onUnreadable` is `fail`).
- Full ACL, ownership, alternate-data-stream or junction fidelity. Permission
  bits are recorded, but ACLs and ADS are not restored.
- WinPE source capture.

## In the GUI

Open **Files & Folders** from the sidebar (or **Back up files & folders** on the
Standard home page). The page is organized as a short sequence:

1. **Repository & key** — choose an existing OPBS repository. Leave the
   passphrase and keyfile fields empty when the repository's automatic keyfile
   is available; otherwise supply one of them.
2. **Create a version** — add folders or files, add exclude patterns if needed,
   then choose **Preview — write nothing** or **Save a version**. The preview
   writes no snapshot, catalog record, or mirror change.
3. **Saved versions** — refresh the list, optionally select a version, and run
   a full or quick verification.
4. **Restore a version** — pick a destination folder, choose what happens to
   existing files (skip by default), and optionally narrow the restore with
   path patterns.
5. **One-way mirror** — set a destination, then plan or apply. Applying is a
   separate button; removals need their own checkbox, and a large removal set
   needs a further explicit confirmation. Allowed removals are moved into
   quarantine rather than deleted outright.
6. **Cleanup** — plan retention first; applying it is a separate button.

No modal or confirmation dialog appears when switching to this page. All
data-changing actions are explicit buttons inside the page.

## Prerequisites

An existing OPBS repository:

```bat
OPBS.exe --cli repo init D:\OPBS-REPO --lock-days 30
```

The repository key is resolved exactly like disk-image repositories: `--keyfile
F`, `--passphrase-file F`, `OPBS_PASSPHRASE`, or the legacy `--passphrase P`.
File snapshots use domain-separated subkeys, so file catalog records cannot be
replayed as disk-image journal records.

## Configuration

`OPBS.exe --cli new-config backup-files files.json` writes a starting point:

```json
{
  "type": "backup-files",
  "sources": ["C:\\Users\\me\\Documents", "C:\\Users\\me\\Pictures"],
  "repo": "D:\\OPBS-REPO",
  "excludes": ["**\\node_modules\\**", "**\\*.tmp"],
  "chunkSize": 1048576,
  "lockDays": 30,
  "onUnreadable": "warn",
  "mirror": {
    "enabled": false,
    "apply": false,
    "path": "E:\\Mirror",
    "deletions": "off",
    "maxDeleteFiles": 10,
    "maxDeleteBytes": 104857600
  }
}
```

- `sources` must exist when validation runs. Each source gets a safe basename
  prefix in the snapshot, so two sources named `Data` do not overwrite each
  other.
- `excludes` use `/` or `\` separators and support `*`, `?`, `**` and simple
  character classes. Excluding a directory excludes its contents.
- `chunkSize` defaults to 1 MiB (64 KiB–64 MiB).
- `lockDays` defaults to 30. A snapshot cannot be pruned before its lock ends.
- `onUnreadable` is `warn` (default) or `fail`.

## Commands

```bat
REM Plan a backup without writing any snapshot, catalog record or mirror change.
OPBS.exe --cli files backup files.json --dry-run

REM Create an encrypted version.
OPBS.exe --cli files backup files.json --keyfile C:\keys\opbs.key

REM List versions.
OPBS.exe --cli files list --repo D:\OPBS-REPO

REM Restore everything, or only matching relative paths.
OPBS.exe --cli files restore --repo D:\OPBS-REPO --id <id> --target E:\Restored
OPBS.exe --cli files restore --repo D:\OPBS-REPO --id <id> --target E:\Restored --include "**\*.docx" --overwrite skip

REM Verify the catalog and snapshot objects (--fast checks sizes only).
OPBS.exe --cli files verify --repo D:\OPBS-REPO [--id <id>] [--fast]

REM Plan retention, then apply it explicitly.
OPBS.exe --cli files prune --repo D:\OPBS-REPO --keyfile C:\keys\opbs.key
OPBS.exe --cli files prune --repo D:\OPBS-REPO --keyfile C:\keys\opbs.key --apply --keep 3
```

`repo verify` also checks the file catalog when `<repo>/files/catalog/` exists,
reporting problems with the `file-backup` kind.

## One-way mirror

A mirror takes an encrypted snapshot as its only source of truth. It never
copies changes from the destination back into the source or repository.

```bat
REM Plan only: print adds, changes and planned deletions; touch nothing.
OPBS.exe --cli files mirror --repo D:\OPBS-REPO --id <id> --target E:\Mirror

REM Apply, allowing deletions to be moved into quarantine.
OPBS.exe --cli files mirror --repo D:\OPBS-REPO --id <id> --target E:\Mirror --apply --allow-deletes

REM Same, from a backup run. Mirroring remains plan-only without --apply-mirror.
OPBS.exe --cli files backup files.json --mirror E:\Mirror --apply-mirror --allow-deletes
```

For a backup run, deletions additionally require `mirror.deletions` to be
`"quarantine"` in the config. `--allow-deletes` alone does not enable them;
`--no-deletes` always disables them.

Safety rules:

- The target must not overlap the repository, any configured source, the
  staging path, or the quarantine path.
- Staging and quarantine are siblings of the target so renames stay on one
  volume. Changed and deleted destination files are moved into quarantine
  before new files land, so a failed run leaves recoverable copies.
- Deletions are disabled unless the config says `deletions: "quarantine"` and
  the run passes `--allow-deletes`. With deletions disabled, an apply is
  refused rather than leaving a half-mirrored destination.
- More than 10 deletions or 100 MiB of deletions requires `--confirm-deletes`
  (configurable with `maxDeleteFiles` / `maxDeleteBytes`).
- Empty extra directories are left alone; file and symlink deletions are
  quarantined. Symlinks are recorded but never followed.

## Repository layout

```text
<repo>/files/
  catalog/opbs-files.journal   signed, hash-linked append-only catalog
  snapshots/<id>.opbsfiles     encrypted manifest
  objects/ab/<sha256>.chunk    encrypted content-addressed chunks
  reports/<id>.json            mirror and restore reports
```

The catalog is separate from `opbs-repo.journal`. Existing disk-image state
logic does not read it.

## Verification status

Verified in this codebase by automated tests only:

- snapshot create → restore round trip with deduplication and exclusions
- manifest/chunk tamper detection
- relative-path and traversal rejection
- mirror dry-run, apply, quarantine and deletion refusal
- lock expiry, mirror protection and retention/GC

Not yet verified:

- packaged-GUI end-to-end use (the GUI page has not been exercised in a packaged build)
- VSS or WinPE file capture
- real-world locked-file behavior under every Windows application
- large-scale performance or restore-speed claims

No commit, tag, push or release is implied by this document.
