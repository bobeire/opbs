import { createInterface } from 'readline/promises';
import * as fs from 'fs';
import * as path from 'path';
import type { RestoreJob, RestoreJobProgress } from '../imaging/imaging-job';
import type { RestoreJobConfig } from '../imaging/restore-engine';

/**
 * Interactive, text-only restore wizard for the recovery console.
 *
 * The recovery media boots WinPE and runs `restore.cmd`, which historically
 * showed a bare "Config path:" prompt — useless when the user has no staged
 * config. This wizard walks a user through the whole restore instead:
 *
 *   1. find the backup image (drive scan / typed path / folder listing)
 *   2. pick the target disk (with partition list + same-disk warnings)
 *   3. options (pre-write verify, passphrase for encrypted images)
 *   4. review, preflight (no writes), explicit RESTORE confirmation,
 *      then the actual restore with a live progress line.
 *
 * All I/O goes through WizardIO and all system access through WizardDeps so
 * the flow is fully scriptable in unit tests (no real stdin, disks or
 * restore engine). Nothing here imports Electron or heavy imaging modules —
 * the CLI wires the real implementations in cmdWizard().
 */

export interface WizardIO {
  /** Print one line (empty = blank line). */
  print(line?: string): void;
  /** Write raw text without a newline (used for the progress line). */
  write(text: string): Promise<void> | void;
  /** Ask for one line of input; resolves the trimmed answer. */
  ask(prompt: string): Promise<string>;
  close(): void;
}

export interface WizardImage {
  path: string;
  name: string;
  size: number;
  timestamp: number;
  /** undefined when unknown (drive scan does not read headers). */
  incremental?: boolean;
  encrypted?: boolean;
}

export interface WizardDisk {
  index: number;
  size: number;
  model: string;
  serial: string;
}

export interface WizardPartition {
  partitionIndex: number;
  size: number;
  fsType: string;
  label?: string;
}

export interface WizardImageDetails {
  encrypted: boolean;
  incremental: boolean;
  totalSize: number;
  partitions: Array<{ index: number; size: number; fsType: string }>;
  sourceDisk?: { model: string; serial: string };
}

export interface WizardRestoreResult {
  ok: boolean;
  bytesWritten?: number;
  error?: string;
}

export interface WizardDeps {
  /** Find .opbs files on local drives (bounded scan). */
  scanDrives(): Promise<WizardImage[]>;
  /** List .opbs images in one folder (throws if the folder is missing). */
  scanDir(dir: string): Promise<WizardImage[]>;
  /** Read image header details (throws when the file is not a usable image). */
  describeImage(imagePath: string): Promise<WizardImageDetails>;
  getDisks(): Promise<WizardDisk[]>;
  getPartitions(diskIndex: number): Promise<WizardPartition[]>;
  /** Dry-run validation; rejects with a user-facing message on gate failure. */
  preflight(config: RestoreJobConfig): Promise<RestoreJob>;
  renderPlan(plan: RestoreJob): string;
  /** Run the restore, streaming progress; must resolve even on failure. */
  execute(config: RestoreJobConfig, onProgress: (p: RestoreJobProgress) => void): Promise<WizardRestoreResult>;
}

/** Thrown when the user types q at any prompt. */
class AbortWizard extends Error {
  constructor() {
    super('aborted by user');
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function fmtDate(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '';
  }
}

function printImageList(io: WizardIO, images: WizardImage[]): void {
  images.forEach((image, index) => {
    const tags: string[] = [];
    if (image.incremental === true) tags.push('delta');
    else if (image.incremental === false) tags.push('full');
    if (image.encrypted) tags.push('encrypted');
    const tagText = tags.length > 0 ? `  [${tags.join(', ')}]` : '';
    io.print(`    ${index + 1}) ${image.path}  ${fmtBytes(image.size)}  ${fmtDate(image.timestamp)}${tagText}`);
  });
}

function renderProgress(progress: RestoreJobProgress): string {
  const percent = Number.isFinite(progress.percent) ? Math.round(progress.percent) : 0;
  const parts: string[] = [`[${progress.phase || 'working'}]`, `${percent}%`];
  if (progress.totalBytes > 0) {
    parts.push(`${fmtBytes(progress.bytesDone)}/${fmtBytes(progress.totalBytes)}`);
  }
  if (progress.speed > 0) {
    parts.push(`${fmtBytes(progress.speed)}/s`);
  }
  if (progress.currentPartition) {
    parts.push(progress.currentPartition);
  }
  return parts.join('  ');
}

async function selectImage(
  io: WizardIO,
  deps: WizardDeps
): Promise<{ image: WizardImage; details: WizardImageDetails }> {
  io.print('  Scanning drives for .opbs backup images (this can take a moment)...');
  let found: WizardImage[] = [];
  let scanned = false;
  for (;;) {
    if (!scanned) {
      found = await deps.scanDrives();
      scanned = true;
      io.print();
      if (found.length > 0) {
        io.print(`  Found ${found.length} image(s):`);
        printImageList(io, found);
      } else {
        io.print('  No .opbs images found on the local drives.');
      }
    }
    io.print();
    io.print('  Enter a number, a path to an .opbs file or a backup folder,');
    io.print('  (r) rescan, (q) quit.');
    const input = (await io.ask('Image > ')).trim();
    if (input.toLowerCase() === 'q') throw new AbortWizard();
    if (input.toLowerCase() === 'r') {
      scanned = false;
      io.print();
      io.print('  Scanning drives for .opbs backup images...');
      continue;
    }

    let candidate: WizardImage;
    if (/^\d+$/.test(input)) {
      if (found.length === 0) {
        io.print('  No image list — enter a full path instead.');
        continue;
      }
      const index = Number(input) - 1;
      if (index < 0 || index >= found.length) {
        io.print(`  Pick a number between 1 and ${found.length}.`);
        continue;
      }
      candidate = found[index];
    } else if (input === '') {
      io.print('  Please enter a number or a path.');
      continue;
    } else if (input.toLowerCase().endsWith('.opbs')) {
      candidate = { path: input, name: path.basename(input), size: 0, timestamp: Date.now() };
    } else {
      let entries: WizardImage[];
      try {
        entries = await deps.scanDir(input);
      } catch (error) {
        io.print(`  Cannot list folder: ${errMsg(error)}`);
        continue;
      }
      if (entries.length === 0) {
        io.print('  That folder contains no .opbs images.');
        continue;
      }
      io.print(`  ${entries.length} image(s) in ${input}:`);
      printImageList(io, entries);
      for (;;) {
        const sub = (await io.ask('Number > ')).trim();
        if (sub.toLowerCase() === 'q') throw new AbortWizard();
        const index = Number(sub) - 1;
        if (/^\d+$/.test(sub) && index >= 0 && index < entries.length) {
          candidate = entries[index];
          break;
        }
        io.print(`  Pick a number between 1 and ${entries.length}.`);
      }
    }

    try {
      const details = await deps.describeImage(candidate.path);
      return { image: candidate, details };
    } catch (error) {
      io.print(`  Cannot use that image: ${errMsg(error)}`);
    }
  }
}

/** Run the full wizard. Returns the process exit code. */
export async function runRestoreWizard(io: WizardIO, deps: WizardDeps): Promise<number> {
  try {
    io.print('='.repeat(64));
    io.print('  OPBS Recovery Wizard');
    io.print('  Restore a backup image onto a disk, step by step.');
    io.print('='.repeat(64));
    io.print();

    // [1/4] image ------------------------------------------------------------
    io.print('[1/4] Select the backup image');
    const { image, details } = await selectImage(io, deps);
    io.print();
    io.print(`  Selected: ${image.path}`);
    io.print(`    Size      : ${fmtBytes(details.totalSize)}`);
    io.print(
      `    Partitions: ${details.partitions
        .map((p) => `${p.index} - ${fmtBytes(p.size)} (${p.fsType})`)
        .join(', ') || 'none'}`
    );
    if (details.incremental) {
      io.print('    Chain     : delta image (base resolved automatically)');
    }
    if (details.sourceDisk) {
      io.print(`    Source    : ${details.sourceDisk.model} / ${details.sourceDisk.serial}`);
    }

    let passphrase: string | undefined;
    if (details.encrypted) {
      io.print();
      io.print('  This image is encrypted. Enter its passphrase (blank if none).');
      const entered = await io.ask('Passphrase > ');
      passphrase = entered === '' ? undefined : entered;
    }

    // [2/4] target disk ------------------------------------------------------
    io.print();
    io.print('[2/4] Choose the target disk');
    io.print();
    const disks = await deps.getDisks();
    if (disks.length === 0) {
      io.print('  No disks found.');
      return 1;
    }
    io.print('  #  Size        Model                      Serial');
    io.print('  ------------------------------------------------------------');
    for (const disk of disks) {
      const index = String(disk.index).padEnd(2);
      const size = fmtBytes(disk.size).padEnd(11);
      const model = (disk.model || 'unknown').slice(0, 26).padEnd(26);
      io.print(`  ${index} ${size} ${model} ${disk.serial}`);
    }
    io.print();
    io.print('  WARNING: everything on the selected disk will be overwritten.');
    let targetDisk: WizardDisk;
    for (;;) {
      const input = (await io.ask('Disk > ')).trim();
      if (input.toLowerCase() === 'q') throw new AbortWizard();
      const index = Number(input);
      const match = disks.find((d) => d.index === index);
      if (/^\d+$/.test(input) && match) {
        targetDisk = match;
        break;
      }
      io.print(`  Enter a disk number from this list (e.g. ${disks[0].index}).`);
    }

    const currentPartitions = await deps.getPartitions(targetDisk.index);
    if (currentPartitions.length > 0) {
      io.print(`  Partitions currently on disk ${targetDisk.index}:`);
      for (const part of currentPartitions) {
        const label = part.label ? `  "${part.label}"` : '';
        io.print(`    ${part.partitionIndex}) ${fmtBytes(part.size).padEnd(10)} ${part.fsType}${label}`);
      }
    }
    if (details.sourceDisk && targetDisk.serial && targetDisk.serial === details.sourceDisk.serial) {
      io.print();
      io.print('  NOTE: this is the same physical disk the backup came from.');
    }

    let targetPartitions: number[];
    for (;;) {
      io.print();
      io.print('  Restore [w] whole disk (recommended), [p] specific partitions, or (q) quit.');
      const mode = (await io.ask('Mode > ')).trim().toLowerCase();
      if (mode === 'q') throw new AbortWizard();
      if (mode === '' || mode === 'w') {
        targetPartitions = details.partitions.map((p) => p.index);
        break;
      }
      if (mode !== 'p') {
        io.print('  Enter w or p.');
        continue;
      }
      io.print(
        `  Available image partitions: ${details.partitions
          .map((p) => `${p.index} (${fmtBytes(p.size)})`)
          .join(', ')}`
      );
      for (;;) {
        const raw = (await io.ask('Partitions > ')).trim();
        if (raw.toLowerCase() === 'q') throw new AbortWizard();
        const parsed = raw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n));
        const valid =
          parsed.length > 0 &&
          parsed.every((n) => details.partitions.some((p) => p.index === n)) &&
          new Set(parsed).size === parsed.length;
        if (valid) {
          targetPartitions = parsed.sort((a, b) => a - b);
          break;
        }
        io.print(`  Invalid selection; use comma-separated indexes from: ${details.partitions.map((p) => p.index).join(', ')}`);
      }
      break;
    }

    // [3/4] options ----------------------------------------------------------
    io.print();
    io.print('[3/4] Options');
    let verifyBeforeWrite: boolean;
    for (;;) {
      const input = (await io.ask('  Verify the image before writing? [Y/n] > ')).trim().toLowerCase();
      if (input === 'q') throw new AbortWizard();
      if (input === '' || input === 'y' || input === 'yes') {
        verifyBeforeWrite = true;
        break;
      }
      if (input === 'n' || input === 'no') {
        verifyBeforeWrite = false;
        break;
      }
      io.print('  Enter y or n.');
    }

    // [4/4] review + preflight + confirm ------------------------------------
    io.print();
    io.print('[4/4] Review and confirm');
    io.print();
    io.print(`  Image     : ${image.path}`);
    const allPartitions =
      details.partitions.length === targetPartitions.length &&
      targetPartitions.every((n) => details.partitions.some((p) => p.index === n));
    io.print(
      `  Partitions: ${targetPartitions.join(', ')}${allPartitions ? ' (all image partitions)' : ' (selected)'}`
    );
    io.print(`  Target    : disk ${targetDisk.index} - ${targetDisk.model || 'unknown'} (${fmtBytes(targetDisk.size)})`);
    io.print(`  Overwrite : ALL current data on disk ${targetDisk.index}`);
    io.print(`  Verify    : ${verifyBeforeWrite ? 'yes (before writing)' : 'no'}`);
    if (passphrase !== undefined) {
      io.print('  Passphrase: set (encrypted image)');
    }
    io.print();

    const config: RestoreJobConfig = {
      imagePath: image.path,
      targetDiskIndex: targetDisk.index,
      targetPartitions,
      verifyBeforeWrite
    };
    if (passphrase !== undefined) {
      config.passphrase = passphrase;
    }

    io.print('  Validating the plan (preflight — nothing is written)...');
    let plan: RestoreJob;
    try {
      plan = await deps.preflight(config);
    } catch (error) {
      io.print();
      io.print(`  Preflight FAILED: ${errMsg(error)}`);
      io.print('  Nothing was written. Run the wizard again to choose different options.');
      return 1;
    }
    const rendered = deps.renderPlan(plan);
    if (rendered) {
      io.print();
      for (const line of rendered.split('\n')) {
        io.print(`  ${line}`);
      }
    }
    io.print();
    io.print('  Type RESTORE to start the restore, anything else to cancel.');
    const confirm = (await io.ask('Confirm > ')).trim();
    if (confirm !== 'RESTORE') {
      io.print('  Cancelled — nothing was written.');
      return 0;
    }

    io.print();
    io.print('  Starting restore — do not power off this machine.');
    let result: WizardRestoreResult;
    try {
      result = await deps.execute(config, (progress) => {
        void io.write(`\r  ${renderProgress(progress)}   `);
      });
    } catch (error) {
      io.write('\n');
      io.print(`  Restore FAILED: ${errMsg(error)}`);
      return 1;
    }
    io.write('\n');
    if (result.ok) {
      io.print(`  Restore OK (${fmtBytes(result.bytesWritten ?? 0)} written)`);
      io.print('  Done. Remove the recovery media and reboot.');
      return 0;
    }
    io.print(`  Restore FAILED: ${result.error ?? 'unknown error'}`);
    return 1;
  } catch (error) {
    if (error instanceof AbortWizard) {
      io.print();
      io.print('  Aborted — nothing was written.');
      return 0;
    }
    io.print();
    io.print(`  Wizard failed: ${errMsg(error)}`);
    return 1;
  }
}

const SCAN_SKIP_DIRS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'node_modules',
  '.git'
]);

export interface DriveScanOptions {
  /** Drive letters to scan (default: C-Z; X is always skipped — WinPE ramdisk). */
  drives?: string[];
  /** Directory depth to descend into (default 4). */
  maxDepth?: number;
  /** Per-drive time budget (default 10s) so a huge disk cannot hang the wizard. */
  deadlineMs?: number;
  /** Stop after this many hits (default 200). */
  maxResults?: number;
}

/**
 * Bounded recursive scan of local drives for .opbs images. Used by the
 * wizard's first step; the budget/depth/result caps keep it responsive even
 * on multi-terabyte data disks. Returns entries sorted newest-first.
 */
export function scanDrivesForImages(options: DriveScanOptions = {}): WizardImage[] {
  const letters = options.drives ?? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const maxDepth = options.maxDepth ?? 4;
  const deadlineMs = options.deadlineMs ?? 10_000;
  const maxResults = options.maxResults ?? 200;
  const found: WizardImage[] = [];
  for (const letter of letters) {
    if (letter.toUpperCase() === 'X') continue;
    const root = `${letter.toUpperCase()}:\\`;
    if (!fs.existsSync(root)) continue;
    const deadline = Date.now() + deadlineMs;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && Date.now() < deadline && found.length < maxResults) {
      const current = stack.pop() as { dir: string; depth: number };
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (found.length >= maxResults) break;
        const full = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < maxDepth && !SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) {
            stack.push({ dir: full, depth: current.depth + 1 });
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.opbs')) {
          try {
            const stat = fs.statSync(full);
            found.push({ path: full, name: entry.name, size: stat.size, timestamp: stat.mtimeMs });
          } catch {
            /* vanished/unreadable — skip */
          }
        }
      }
    }
  }
  found.sort((a, b) => b.timestamp - a.timestamp);
  return found;
}

/**
 * Real console-backed WizardIO.
 *
 * Lines are queued by a persistent 'line' listener instead of readline's
 * question(): input that arrives while the wizard is busy (drive scan, or a
 * piped/automated session) used to be dropped, and a pending question never
 * settled when stdin closed — which made the process exit 0 with no restore
 * done. With the queue, buffered lines are drained first, and only a truly
 * closed console rejects the prompt.
 */
export function createConsoleIO(): WizardIO {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue: string[] = [];
  let settle: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
  let closed = false;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (settle) {
      const pending = settle;
      settle = null;
      pending.resolve(trimmed);
    } else {
      queue.push(trimmed);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (settle) {
      const pending = settle;
      settle = null;
      pending.reject(new Error('console input closed'));
    }
  });

  return {
    print: (line = '') => {
      process.stdout.write(line + '\r\n');
    },
    write: (text) => {
      process.stdout.write(text);
    },
    ask: async (prompt) => {
      process.stdout.write(prompt);
      if (queue.length > 0) {
        return queue.shift() as string;
      }
      if (closed) {
        throw new Error('console input closed');
      }
      return new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    close: () => {
      rl.close();
    }
  };
}
