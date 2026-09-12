import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskEnumerator } from '../utils/disk-enumerator';
import { ImagingEngine } from '../imaging/backup-engine';
import { RestoreEngine } from '../imaging/restore-engine';
import { CloneEngine } from '../imaging/clone-engine';
import { summarizeImage } from '../imaging/restore-engine';
import { verifyImage, readImageInfo, deriveImageKey } from '../imaging/image-format';
import { applyRetention, planRetention, scanBackupDirectory, groupIntoChains, writeManifest, selectImagesForVerify, RetentionPlan } from '../backup/retention';
import { checkDiskHealth } from '../utils/disk-health';
import { registerScheduledTask, removeScheduledTask, listScheduledTasks } from '../utils/task-scheduler';
import { dispatchHelperJob } from '../helper/job-runner';
import { launchElevatedJob } from '../helper/launcher';
import { winfspAvailable } from '../imaging/mount-manager';
import { JobResult } from '../imaging/imaging-job';
import { locateAdk, peArchForProcess } from '../utils/adk';
import { createRecoveryMedia, resolveNodeExe, smokeMediaPayload } from '../utils/winpe-media';
import { openAnyBrowse, listDirectory, extractPath, formatTimestamp, resolvePath } from '../imaging/fs/file-browse';
import { detectMacriumFormat, readMacriumImage } from '../imaging/mrimg';
import { S3Store, parseS3Location } from '../utils/s3';
import { SftpStore, parseSftpLocation, resolveSftpConfig } from '../utils/sftp';
import { applyRetentionS3, planRetentionS3 } from '../backup/retention-s3';
import { loadNative } from '../utils/native-loader';
import { NativeImagingApi } from '../imaging/imaging-job';
import { computeAnalytics } from '../utils/backup-analytics';
import { scrubDirectory, classifyImage } from '../imaging/scrub';
import { buildParity, verifyParity, repairParityBlock, paritySidecarPath } from '../imaging/parity';
import { buildChainHealthReport } from '../backup/chain-health';
import { detectTamper } from '../utils/tamper';
import { buildStorageHealthReport } from '../utils/storage-health';
import { runDiskPerfTest, assessWriteSpeed } from '../utils/disk-perf';
import { queryVssServiceState, normalizeVolumeRoot, VssJob, VssJobResult } from '../utils/vss';

const diskEnumerator = new DiskEnumerator();
const imagingEngine = new ImagingEngine(diskEnumerator);
const restoreEngine = new RestoreEngine(diskEnumerator);
const cloneEngine = new CloneEngine(diskEnumerator);

export interface CliOptions {
  json: boolean;
}

interface CommandContext {
  argv: string[];
  opts: CliOptions;
}

export async function runCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  const opts: CliOptions = { json: rest.includes('--json') };
  const cleanArgv = rest.filter((a) => a !== '--json');
  const ctx: CommandContext = { argv: cleanArgv, opts };

  try {
    switch (command) {
      case 'disks':
        return await cmdDisks(ctx);
      case 'partitions':
        return await cmdPartitions(ctx);
      case 'list':
        return await cmdList(ctx);
      case 'backup':
        return await cmdBackup(ctx);
      case 'restore':
        return await cmdRestore(ctx);
      case 'drill':
        return await cmdDrill(ctx);
      case 'analytics':
        return cmdAnalytics(ctx);
      case 'clone':
        return await cmdClone(ctx);
      case 'verify':
        return await cmdVerify(ctx);
      case 'scrub':
        return await cmdScrub(ctx);
      case 'parity':
        return await cmdParity(ctx);
      case 'chain':
        return await cmdChainCheck(ctx);
      case 'tamper':
        return await cmdTamperCheck(ctx);
      case 'storage-health':
        return await cmdStorageHealth(ctx);
      case 'anomalies':
        return await cmdAnomalies(ctx);
      case 'perf':
        return cmdPerf(ctx);
      case 'vss':
        return await cmdVss(ctx);
      case 'schedule':
        return await cmdSchedule(ctx);
      case 'prune':
        return await cmdPrune(ctx);
      case 'health':
        return await cmdHealth(ctx);
      case 'media':
        return await cmdMedia(ctx);
      case 'mrimg':
        return await cmdMrimg(ctx);
      case 'browse':
        return await cmdBrowse(ctx);
      case 'extract':
        return await cmdExtract(ctx);
      case 'store':
        return await cmdStore(ctx);
      case 'usn-changes':
        return await cmdUsn(ctx);
      case 'mount':
        return await cmdMount(ctx);
      case 'new-config':
        return cmdNewConfig(ctx);
      case 'smoke-selfcheck':
        return cmdSmokeSelfcheck(ctx);
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

function printHelp(): void {
  // prettier-ignore
  console.log(`OPBS (Open Pickle Backup System) CLI

Usage: <app> --cli <command> [options]

Commands:
  disks                                  List physical disks.
  partitions <diskIndex>                 List partitions on a disk.
  list [directory]                       List backups in a directory (default: backup location).
  backup <config.json> [--elevated] [--zstd] [--threads N] [--used-blocks-only]
                           Run a backup job (config as JSON file).
  restore <config.json> [--elevated] [--threads N] [--layout P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout] [--no-write-table] [--acknowledge-same-disk] Run a restore job (config as JSON file).
  drill <config.json> [--elevated] [--json-out FILE]  Restore the newest image in a directory
  drill --dir <dir> --disk <targetDiskIndex> [--verify] [--elevated] [--json-out FILE]
                           Restore drill: writes an image to a scratch disk, reads it
                           back, and validates the filesystems so "restores work" is
                           proven. Exits 0 only when the restore AND validation pass.
                           Without a config it drills the newest unencrypted image in
                           <dir>; encrypted images are skipped.
  analytics [directory]              Compute backup analytics: chain efficiency,
                                     compression ratios, total disk vs image size,
                                     and estimated restore time.
                                     (default: backup location).
  clone <config.json> [--elevated] [--used-blocks-only] [--layout P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout] [--no-write-table] [--acknowledge-same-disk]
                           Clone live partitions to a different local disk.
  verify <image.opbs> [--passphrase p] Verify a single image (no elevation needed).
  verify --dir <directory> [--scope newest|all] [--passphrase p] [--json-out FILE]
                                         Verify images in a directory.
  scrub --dir <directory> [--scope newest|all] [--repair] [--passphrase p] [--json] [--json-out FILE]
                                         Idle scrub: read back every block of every image
                                         and report bit-rot per block. With --repair, blocks
                                         with a .opar sidecar are rebuilt from XOR parity
                                         (a corrupt block is fixed, not just reported) and
                                         the image is re-verified. Without parity data the
                                         image is reported as unprotected.
  parity build <image.opbs>              Build/rebuild the XOR parity sidecar (.opar).
  parity verify <image.opbs>             Recompute group parity and flag mismatches.
  parity repair <image.opbs> [--block N] Rebuild a corrupted block from its parity group
                                         (default: repair every block flagged by a verify).
  chain check --dir <directory> [--json] Check restore-chain integrity: every incremental's
                                         base image must still be present. Missing delta
                                         bases (silent deletes) are reported per chain and
                                         the command exits 1 when any chain is broken.
  tamper check --dir <directory> [--json] Compare the directory against the last-known-good
                                         manifest: missing images, size-changed images, and
                                         unexpected .opbs files are reported (ransomware /
                                         external modification detection). Exits 1 on drift.
  storage-health --dir <directory> [--json]
                                         Storage health dashboard: capacity, restore-chain
                                         integrity, verification/scrub/drill coverage, parity
                                         protection, tamper drift, SMART health of the backing
                                         drive, and a 0-100 reliability score. Exits 1 for an
                                         at-risk destination.
  anomalies check --dir <directory> [--json]
                                         Detect backup deviations: the latest run is compared
                                         against a robust baseline built from the analytics
                                         history (opbs-analytics.json) — size blow-ups/drops
                                         (type-aware for full vs delta), compression-ratio
                                         collapse, throughput collapse, and backups that stopped
                                         arriving. Exits 1 when an anomaly is found.
  perf --dir <directory> [--size MB] [--json]
                                          Non-destructive disk write/read performance test on a
                                          destination: writes a scratch file (default 256 MiB),
                                          fsyncs, reads it back, then deletes it. Reports
                                          sustained sequential write/read MiB/s and stores the
                                          result in opbs-perf.json for the storage-health score.
                                          Exits 1 when the test cannot run or is unreachable.
  vss status                              Report the VSS service state and start type (no
                                          elevation).
  vss writers                             List VSS writers and storage providers (elevated).
                                          Exits 1 when a writer is unstable or vssadmin fails.
  vss smoke-test <volume>                 Create + immediately delete a shadow copy on
                                          <volume> (e.g. C:\\ or C:) to prove VSS works
                                          end-to-end (elevated).
  vss start | vss stop                    Start or stop the Volume Shadow Copy service
                                          (elevated).
  vss repair [--yes]                      Re-register the core VSS DLLs and start the service
                                          if stopped (elevated). Requires --yes.
  schedule install-backup <name> --config <config.json> [--time HH:MM|--on-login] [--as-system] [--run-as-user]
  schedule install-verify <name> --dir <dir> [--scope newest|all] [--time HH:MM|--on-login] [--run-as-user]
  schedule install-drill <name> --dir <dir> --disk <targetDiskIndex> [--verify] [--time HH:MM|--on-login] [--run-as-user]
  schedule list                          List Windows scheduled tasks.
  schedule remove <name>                 Delete a scheduled task.
  prune <directory> [options]            Apply retention/GFS policy.
  health <diskIndex>                     Report SMART/reliability health (no elevation needed).
  media smart [--json]                   SMART health inventory of every physical disk:
                                         temperature, SSD wear, unreliable sectors, read errors.
                                         Exits 1 when any disk reports problems. The same check
                                         gates every backup: backups are refused when the drive
                                         they write to reports SMART problems.
  media check                            Verify the WinPE ADK tools are installed.
  media smoke [--node <node.exe>] [--dist <dir>] [--native <addon>]
                                         Stage the media payload headlessly and smoke-test it
                                         (boots the bundled Node + winpe-entry, no elevation).
  media create --iso <out.iso> [--arch amd64|arm64] [--adk <root>] [--node <node.exe>]
                                         [--restore-config <restore.json>] [--driver <dir,...>] [--script-only]
                                         Build an OPBS WinPE recovery ISO (elevated; --script-only writes
                                         the build script and exits so you can run it in an admin shell).
  media create --usb <drive> --yes [--arch ...] [--adk <root>] [--node <node.exe>]
                                         [--restore-config <restore.json>] [--driver <dir,...>] [--script-only]
                                         Build recovery media on a USB drive (destructive).
  browse <image> [--partition N] [--path DIR] [--passphrase p]
                                         List files/directories in an image (no elevation).
                                         Accepts .opbs, .mrimgx, and .mrimg (Reflect 7/8).
  extract <image> --partition N --path DIR --out DEST [--passphrase p]
                                         Extract a file/folder from an image (no elevation).
  mrimg info <image.mrimgx|image.mrimg>
                                         Show the structure of a Macrium Reflect image
                                         (both .mrimgx and .mrimg Reflect 7/8 containers).
  store put <s3://bucket/prefix|sftp://user@host/path> <file> [--region R]
                                         Upload a file to the object store (AWS_* / SFTP_* env vars).
  store get <s3://bucket/prefix|sftp://user@host/path> <file> [--region R]
                                         Download an object from the store.
  store list <s3://bucket/prefix|sftp://user@host/path> [--region R]
                                         List objects under a store prefix.
  store verify <s3://bucket/prefix|sftp://user@host/path> [--key K] [--passphrase p] [--region R]
                                         Download + verify S3 objects (per-block CRC).
  usn-changes <volume> [--count N]       List recent NTFS USN journal changes (elevation needed).
  mount <image> --partition N [--letter X:] [--label L] [--passphrase p] [--check]
                                         Mount an image partition as a read-only drive (WinFsp).
                                         Stays mounted until you press Ctrl+C (unmount). The
                                         volume is virtual: no extra disk space is used.
                                         --check only reports whether WinFsp is installed.
  new-config <output.json>               Write an example job configuration.

Global:
  --json        Machine-readable output.
  --elevated    Run the job in-process (use inside an elevated scheduled task).
  --passphrase P  Passphrase for encrypted images (verify).
  --keep-full N   prune: number of recent full chains to keep.
  --keep-deltas N prune: trailing deltas kept per chain.
  --days N        prune: never delete images newer than N days.
  --dry-run       prune: plan only, delete nothing.
`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

async function cmdDisks(ctx: CommandContext): Promise<number> {
  const disks = await diskEnumerator.getDisks();
  if (ctx.opts.json) {
    console.log(JSON.stringify(disks, null, 2));
    return 0;
  }
  for (const disk of disks) {
    console.log(`${disk.index}\t${disk.size} bytes\t${disk.model}\t${disk.serial}`);
  }
  return 0;
}

async function cmdPartitions(ctx: CommandContext): Promise<number> {
  const diskIndex = Number(ctx.argv[0]);
  if (!Number.isInteger(diskIndex) || diskIndex < 0) {
    console.error('Usage: partitions <diskIndex>');
    return 1;
  }
  const partitions = await diskEnumerator.getPartitions(diskIndex);
  if (ctx.opts.json) {
    console.log(JSON.stringify(partitions, null, 2));
    return 0;
  }
  for (const part of partitions) {
    console.log(
      `${part.partitionIndex}\t${part.size} bytes\t${part.fsType}\toffset ${part.offset}\t${part.label ?? ''}`
    );
  }
  return 0;
}

async function cmdList(ctx: CommandContext): Promise<number> {
  const { SettingsManager } = await import('../utils/settings-manager');
  const dir = ctx.argv[0] ?? new SettingsManager().getSettings().backupLocation;
  if (!dir) {
    console.error('No backup directory given and no backup location configured.');
    return 1;
  }
  const entries = scanBackupDirectory(dir);
  const chains = groupIntoChains(entries);
  if (ctx.opts.json) {
    console.log(JSON.stringify({ directory: dir, chains }, null, 2));
    return 0;
  }
  for (const entry of entries.sort((a, b) => b.timestamp - a.timestamp)) {
    const info = summarizeImage(entry.path);
    const tag = entry.incremental ? 'delta' : 'full';
    const enc = entry.encrypted ? ' [encrypted]' : '';
    const ver = entry.verified ? ' [verified]' : '';
    console.log(
      `${entry.name}\t${new Date(entry.timestamp).toISOString()}\t${tag}${enc}${ver}\t` +
        `${info.blocks} blocks\t${(entry.size / 1024 / 1024).toFixed(1)} MB`
    );
    if (entry.baseImagePath) {
      console.log(`  base: ${entry.baseImagePath}`);
    }
  }
  console.log(`\n${entries.length} image(s) across ${chains.length} chain(s)`);
  return 0;
}

function cmdAnalytics(ctx: CommandContext): Promise<number> {
  const dir = ctx.argv[0];
  if (!dir) {
    console.error('Usage: analytics <directory>');
    return Promise.resolve(1);
  }

  const summary = computeAnalytics(dir);

  if (ctx.opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return Promise.resolve(0);
  }

  console.log(`Analytics for ${dir}`);
  console.log(`  ${summary.imageCount} image(s) across ${summary.chainCount} chain(s)`);
  console.log(`  Total disk space captured: ${formatBytes(summary.totalDiskBytes)}`);
  console.log(`  Total image storage: ${formatBytes(summary.totalImageBytes)}`);
  console.log(`  Average compression ratio: ${summary.avgCompressionRatio.toFixed(1)}x`);

  if (summary.chains.length === 0) {
    console.log('\nNo chains to analyze.');
    return Promise.resolve(0);
  }

  console.log('\nPer-chain breakdown:');
  for (const chain of summary.chains) {
    const oldest = new Date(chain.oldestTimestamp).toLocaleDateString();
    const newest = new Date(chain.newestTimestamp).toLocaleDateString();
    console.log(`\n  Chain: ${chain.chainPath.length} image(s), ${oldest} to ${newest}`);
    console.log(`    Disk captured: ${formatBytes(chain.totalDiskBytes)}`);
    console.log(`    Image storage: ${formatBytes(chain.totalImageBytes)}`);
    console.log(`    Compression: ${chain.avgCompressionRatio.toFixed(1)}x`);
    console.log(`    Unique blocks: ${chain.uniqueBlocks} / ${chain.totalBlocksAcrossImages} total`);
    console.log(`    Chain efficiency: ${(chain.chainEfficiency * 100).toFixed(1)}%`);
    console.log(`    Full: ${chain.fullCount}, Delta: ${chain.deltaCount}`);
    console.log(`    Estimated restore time: ~${Math.ceil(chain.estimatedRestoreTimeSec / 60)} min`);
  }

  return Promise.resolve(0);
}

async function cmdBackup(ctx: CommandContext): Promise<number> {
  const configPath = ctx.argv[0];
  if (!configPath) {
    console.error('Usage: backup <config.json> [--elevated] [--zstd] [--threads N] [--used-blocks-only]');
    return 1;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (ctx.argv.includes('--zstd')) {
    config.compressionType = 'zstd';
  }
  if (ctx.argv.includes('--used-blocks-only')) {
    config.usedBlocksOnly = true;
  }
  const threadsFlag = flagValue(ctx.argv, '--threads');
  if (threadsFlag !== undefined) {
    const parsed = Number(threadsFlag);
    config.compressionThreads = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  if (ctx.argv.includes('--elevated')) {
    // In-process execution: used inside an elevated scheduled task, so the
    // job runs here without spawning the UAC helper relaunch.
    return await runJobInProcess(function () {
      return imagingEngine.buildJob(config);
    }, ctx);
  }

  const result = await imagingEngine.runBackup(config, (progress) => {
    if (!ctx.opts.json) {
      process.stdout.write(
        `\r[${progress.phase}] ${progress.percent.toFixed(0)}%  ` +
          `${progress.currentPartition || ''}  ${formatBytes(progress.bytesDone)} at ` +
          `${formatBytes(progress.speed)}/s     `
      );
    }
  });
  if (!ctx.opts.json) {
    process.stdout.write('\n');
    console.log(result.ok ? `Backup OK (${formatBytes(result.bytesWritten)})` : `Backup FAILED: ${result.error}`);
    if (result.warnings?.length) {
      for (const warning of result.warnings) {
        console.log(`warning: ${warning}`);
      }
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (typeof config.destinationPath === 'string') {
    await writeManifest(config.destinationPath).catch(() => undefined);
  }
  return result.ok ? 0 : 1;
}

function renderRestorePlan(plan: any): string {
  const lines: string[] = [];
  lines.push(`Image: ${plan.imagePath}`);
  lines.push(`Verify before write: ${plan.verifyBeforeWrite ? 'yes' : 'no'}`);
  if (Array.isArray(plan.applyDeltas) && plan.applyDeltas.length > 0) {
    lines.push(`Apply delta chain: ${plan.applyDeltas.length} image(s)`);
  }
  const targets: any[] = Array.isArray(plan.targets) ? plan.targets : [];
  lines.push(`Target partitions: ${targets.map((t) => `disk ${t.diskIndex} part ${t.partitionIndex} @${formatBytes(t.offset)}`).join(', ') || 'none'}`);
  if (plan.encryption?.algorithm) {
    lines.push(`Encryption: ${plan.encryption.algorithm}`);
  }
  if (plan.writeTable) {
    const entries: any[] = Array.isArray(plan.writeTable.entries) ? plan.writeTable.entries : [];
    lines.push(`Partition table: ${plan.writeTable.scheme} (${entries.length} entries, disk size ${formatBytes(plan.writeTable.diskSize)})`);
  } else {
    lines.push('Partition table: keep existing (no layout change)');
  }
  if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
    for (const warning of plan.warnings) {
      lines.push(`warning: ${warning}`);
    }
  }
  return lines.join('\n');
}

async function cmdRestore(ctx: CommandContext): Promise<number> {
  const configPath = ctx.argv[0];
  if (!configPath) {
    console.error('Usage: restore <config.json> [--preflight] [--elevated] [--threads N] [--layout P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout] [--no-write-table] [--acknowledge-same-disk]');
    return 1;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Accept GUI/WinPE-era aliases for parity with configs written by older
  // media and docs. The canonical keys are imagePath / targetDiskIndex.
  if (config.imagePath === undefined && config.sourceImagePath !== undefined) {
    config.imagePath = config.sourceImagePath;
  }
  if (config.targetDiskIndex === undefined && config.destinationDiskIndex !== undefined) {
    config.targetDiskIndex = config.destinationDiskIndex;
  }

  const threadsFlag = flagValue(ctx.argv, '--threads');
  if (threadsFlag !== undefined) {
    const parsed = Number(threadsFlag);
    config.compressionThreads = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  const layoutFlag = flagValue(ctx.argv, '--layout');
  if (layoutFlag !== undefined) {
    // e.g. --layout 0:4096:1073741824,1:8388608 -> targetLayout [{partitionIndex,offset,size?},...]
    config.targetLayout = layoutFlag
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const parts = pair.split(':').map((n) => Number(n));
        const partitionIndex = parts[0];
        const offset = parts[1];
        if (!Number.isInteger(partitionIndex) || partitionIndex < 0 || !Number.isInteger(offset) || offset < 0) {
          throw new Error(`Invalid --layout entry "${pair}"; expected P:OFF[:SIZE] with non-negative integers`);
        }
        if (parts.length > 2) {
          if (!Number.isInteger(parts[2]) || parts[2] <= 0) {
            throw new Error(`Invalid --layout size in "${pair}"; expected a positive integer of bytes`);
          }
          return { partitionIndex, offset, size: parts[2] };
        }
        return { partitionIndex, offset };
      });
  }

  if (ctx.argv.includes('--confirm-layout')) {
    config.acknowledgeLayout = true;
  }
  const tableSchemeFlag = flagValue(ctx.argv, '--table-scheme');
  if (tableSchemeFlag !== undefined) {
    if (!['gpt', 'mbr', 'auto'].includes(tableSchemeFlag)) {
      console.error('--table-scheme must be one of: gpt, mbr, auto');
      return 1;
    }
    config.tableScheme = tableSchemeFlag;
  }
  if (ctx.argv.includes('--no-write-table')) {
    config.writePartitionTable = false;
  }
  if (ctx.argv.includes('--acknowledge-same-disk')) {
    config.acknowledgeSameDisk = true;
  }

  // Dry-run: build the restore plan and validate the image, target disk and
  // layout gates without writing a single block.
  if (ctx.argv.includes('--preflight')) {
    try {
      const plan = await restoreEngine.buildJob(config);
      console.log(ctx.opts.json ? JSON.stringify(plan, null, 2) : renderRestorePlan(plan));
      return plan ? 0 : 1;
    } catch (error) {
      console.error(`Preflight FAILED: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }

  if (ctx.argv.includes('--elevated')) {
    return await runJobInProcess(function () {
      return restoreEngine.buildJob(config);
    }, ctx);
  }

  const result = await restoreEngine.runRestore(config, (progress) => {
    if (!ctx.opts.json) {
      process.stdout.write(
        `\r[${progress.phase}] ${progress.percent.toFixed(0)}%  ` +
          `${progress.currentPartition || ''}  ${formatBytes(progress.bytesDone)} at ` +
          `${formatBytes(progress.speed)}/s     `
      );
    }
  });
  if (!ctx.opts.json) {
    process.stdout.write('\n');
    console.log(result.ok ? `Restore OK (${formatBytes(result.bytesWritten)})` : `Restore FAILED: ${result.error}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return result.ok ? 0 : 1;
}

interface DrillOutput {
  ok: boolean;
  restored: boolean;
  validated: boolean;
  failures: string[];
  imagePath: string;
  fsValidation?: Array<{ partitionIndex: number; label: string; ok: boolean; error?: string }>;
  durationMs: number;
}

async function cmdDrill(ctx: CommandContext): Promise<number> {
  const jsonOutPath = flagValue(ctx.argv, '--json-out');
  const started = Date.now();

  let config: {
    kind?: string;
    imagePath: string;
    targetDiskIndex: number;
    targetPartitions: number[];
    verifyBeforeWrite?: boolean;
    applyDeltas?: boolean;
    compressionThreads?: number;
    validateAfterWrite?: boolean;
  };

  const dirFlag = flagValue(ctx.argv, '--dir');
  if (dirFlag) {
    // Inline mode: drill the newest unencrypted image in a directory.
    const diskFlag = flagValue(ctx.argv, '--disk');
    if (diskFlag === undefined) {
      console.error('Usage: drill --dir <directory> --disk <targetDiskIndex> [--verify] [--elevated] [--json-out FILE]');
      return 1;
    }
    const diskIndex = Number(diskFlag);
    if (!Number.isInteger(diskIndex) || diskIndex < 0) {
      console.error('--disk must be a non-negative disk index');
      return 1;
    }
    const eligible = scanBackupDirectory(dirFlag)
      .filter((e) => !e.encrypted)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (eligible.length === 0) {
      console.error(`No unencrypted images in ${dirFlag}; skipping drill`);
      return 1;
    }
    const imagePath = eligible[0].path;
    const summary = summarizeImage(imagePath);
    config = {
      kind: 'restore-drill',
      imagePath,
      targetDiskIndex: diskIndex,
      targetPartitions: summary.partitions.map((p) => p.index),
      verifyBeforeWrite: ctx.argv.includes('--verify'),
      applyDeltas: true
    };
  } else {
    const configPath = ctx.argv[0];
    if (!configPath) {
      console.error('Usage: drill [<config.json>|--dir <dir> --disk <targetDiskIndex>] [--elevated] [--json-out FILE]');
      return 1;
    }
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.imagePath || config.targetDiskIndex === undefined) {
      console.error('Drill config requires imagePath and targetDiskIndex.');
      return 1;
    }
  }

  config.validateAfterWrite = true;
  config.applyDeltas = config.applyDeltas ?? true;

  const finish = (result: {
    ok: boolean;
    error?: string;
    fsValidation?: Array<{ partitionIndex: number; label: string; ok: boolean; error?: string }>;
    drill?: { ok: boolean; failures?: string[] };
  }): number => {
    const restored = result.ok;
    const validated = restored && result.drill?.ok === true;
    const failures = result.drill?.failures ?? (result.ok ? [] : [result.error ?? 'restore failed']);
    const output: DrillOutput = {
      ok: restored && validated,
      restored,
      validated,
      failures,
      imagePath: config.imagePath,
      fsValidation: result.fsValidation,
      durationMs: Date.now() - started
    };
    if (jsonOutPath) {
      fs.writeFileSync(jsonOutPath, JSON.stringify(output, null, 2));
    }
    if (ctx.opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (restored && validated) {
      console.log(
        `Drill PASSED: ${path.basename(config.imagePath)} restored to disk ${config.targetDiskIndex} and validated ${result.fsValidation?.length ?? 0} partition(s)`
      );
    } else if (restored) {
      console.error(`Drill FAILED: filesystem validation error(s): ${failures.join('; ')}`);
    } else {
      console.error(`Drill FAILED: restore error: ${result.error}`);
    }
    return restored && validated ? 0 : 1;
  };

  if (ctx.argv.includes('--elevated')) {
    const job = await restoreEngine.buildJob(config);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-drill-inproc-'));
    const jobPath = path.join(dir, 'job.json');
    const resultPath = path.join(dir, 'result.json');
    const progressPath = path.join(dir, 'progress.json');
    const cancelPath = path.join(dir, 'cancel');
    try {
      fs.writeFileSync(jobPath, JSON.stringify(job));
      await dispatchHelperJob(jobPath, resultPath, progressPath, cancelPath);
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      return finish(result);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const result = await restoreEngine.runRestore(config, (progress) => {
    if (!ctx.opts.json) {
      process.stdout.write(
        `\r[${progress.phase}] ${progress.percent.toFixed(0)}%  ` +
          `${progress.currentPartition || ''}  ${formatBytes(progress.bytesDone)} at ` +
          `${formatBytes(progress.speed)}/s     `
      );
    }
  });
  return finish(result);
}

async function cmdClone(ctx: CommandContext): Promise<number> {
  const configPath = ctx.argv[0];
  if (!configPath) {
    console.error(
      'Usage: clone <config.json> [--elevated] [--used-blocks-only] [--layout P:OFF[:SIZE],...] [--table-scheme gpt|mbr|auto] [--confirm-layout] [--no-write-table] [--acknowledge-same-disk]'
    );
    return 1;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (ctx.argv.includes('--used-blocks-only')) {
    config.usedBlocksOnly = true;
  }
  const layoutFlag = flagValue(ctx.argv, '--layout');
  if (layoutFlag !== undefined) {
    config.targetLayout = layoutFlag
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const parts = pair.split(':').map((n) => Number(n));
        const partitionIndex = parts[0];
        const offset = parts[1];
        if (!Number.isInteger(partitionIndex) || partitionIndex < 0 || !Number.isInteger(offset) || offset < 0) {
          throw new Error(`Invalid --layout entry "${pair}"; expected P:OFF[:SIZE] with non-negative integers`);
        }
        if (parts.length > 2) {
          if (!Number.isInteger(parts[2]) || parts[2] <= 0) {
            throw new Error(`Invalid --layout size in "${pair}"; expected a positive integer of bytes`);
          }
          return { partitionIndex, offset, size: parts[2] };
        }
        return { partitionIndex, offset };
      });
  }
  if (ctx.argv.includes('--confirm-layout')) {
    config.acknowledgeLayout = true;
  }
  const tableSchemeFlag = flagValue(ctx.argv, '--table-scheme');
  if (tableSchemeFlag !== undefined) {
    if (!['gpt', 'mbr', 'auto'].includes(tableSchemeFlag)) {
      console.error('--table-scheme must be one of: gpt, mbr, auto');
      return 1;
    }
    config.tableScheme = tableSchemeFlag;
  }
  if (ctx.argv.includes('--no-write-table')) {
    config.writePartitionTable = false;
  }
  if (ctx.argv.includes('--acknowledge-same-disk')) {
    config.acknowledgeSameDisk = true;
  }

  if (ctx.argv.includes('--elevated')) {
    return await runJobInProcess(function () {
      return cloneEngine.buildJob(config);
    }, ctx);
  }

  const result = await cloneEngine.runClone(config, (progress) => {
    if (!ctx.opts.json) {
      process.stdout.write(
        `\r[${progress.phase}] ${progress.percent.toFixed(0)}%  ` +
          `${progress.currentPartition || ''}  ${formatBytes(progress.bytesDone)} at ` +
          `${formatBytes(progress.speed)}/s     `
      );
    }
  });
  if (!ctx.opts.json) {
    process.stdout.write('\n');
    console.log(
      result.ok
        ? `Clone OK (${formatBytes(result.bytesWritten)}${result.usedBlocksSkipped ? `, ${result.usedBlocksSkipped} free blocks skipped` : ''})`
        : `Clone FAILED: ${result.error}`
    );
    if (result.warnings?.length) {
      for (const warning of result.warnings) {
        console.log(`warning: ${warning}`);
      }
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return result.ok ? 0 : 1;
}

/** Execute a prebuilt job in this process (scheduled/elevated context). */
async function runJobInProcess(
  buildJob: () => Promise<unknown>,
  ctx: CommandContext
): Promise<number> {
  const job = await buildJob();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-scheduled-'));
  const jobPath = path.join(dir, 'job.json');
  const resultPath = path.join(dir, 'result.json');
  const progressPath = path.join(dir, 'progress.json');
  const cancelPath = path.join(dir, 'cancel');
  try {
    fs.writeFileSync(jobPath, JSON.stringify(job));
    await dispatchHelperJob(jobPath, resultPath, progressPath, cancelPath);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as JobResult;
    if (ctx.opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.ok ? `Job OK (${formatBytes(result.bytesWritten)})` : `Job FAILED: ${result.error}`);
    }
    return result.ok ? 0 : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function cmdVerify(ctx: CommandContext): Promise<number> {
  const dir = flagValue(ctx.argv, '--dir');
  const jsonOutPath = flagValue(ctx.argv, '--json-out');
  const scope = (flagValue(ctx.argv, '--scope') ?? 'newest') as 'newest' | 'all';
  const passphrase = flagValue(ctx.argv, '--passphrase');

  if (dir) {
    return await verifyDirectory(dir, scope, passphrase, ctx.opts.json, jsonOutPath);
  }

  const imagePath = ctx.argv[0];
  if (!imagePath) {
    console.error('Usage: verify <image.opbs> [--passphrase p]');
    return 1;
  }
  let key: Buffer | undefined;
  const info = readImageInfo(imagePath);
  if (passphrase && info.header.cipherId !== 0) {
    key = deriveImageKey(passphrase, info.header.salt, info.header.kdfIterations);
  }
  const result = await verifyImage(imagePath, key);
  if (ctx.opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`OK: ${result.blocksVerified} block(s) verified`);
  } else {
    console.error(`FAILED: ${result.error ?? `${result.blocksVerified} block(s) verified; no frame data in image`}`);
  }
  return result.ok ? 0 : 1;
}

interface VerifySummary {
  ok: boolean;
  directory: string;
  scope: 'newest' | 'all';
  checked: number;
  verified: number;
  failed: number;
  skippedEncrypted: number;
  images: Array<{
    name: string;
    ok: boolean;
    skippedEncrypted?: boolean;
    blocksVerified?: number;
    error?: string;
  }>;
}

async function verifyDirectory(
  dir: string,
  scope: 'newest' | 'all',
  passphrase: string | undefined,
  json: boolean,
  jsonOutPath?: string
): Promise<number> {
  const entries = selectImagesForVerify(scanBackupDirectory(dir), scope);
  const summary: VerifySummary = {
    ok: true,
    directory: dir,
    scope,
    checked: 0,
    verified: 0,
    failed: 0,
    skippedEncrypted: 0,
    images: []
  };

  for (const entry of entries) {
    summary.checked++;
    if (entry.encrypted) {
      if (!passphrase) {
        summary.skippedEncrypted++;
        summary.images.push({ name: entry.name, ok: true, skippedEncrypted: true });
        continue;
      }
      const info = readImageInfo(entry.path);
      const key = passphrase ? deriveImageKey(passphrase, info.header.salt, info.header.kdfIterations) : undefined;
      const verified = await verifyImage(entry.path, key);
      if (verified.ok) {
        summary.verified++;
        summary.images.push({ name: entry.name, ok: true, blocksVerified: verified.blocksVerified });
} else {
        summary.failed++;
        summary.ok = false;
        summary.images.push({ name: entry.name, ok: false, error: verified.error ?? 'no frame data in image' });
      }
      continue;
    }
    const verified = await verifyImage(entry.path);
    if (verified.ok) {
      summary.verified++;
      summary.images.push({ name: entry.name, ok: true, blocksVerified: verified.blocksVerified });
    } else {
      summary.failed++;
      summary.ok = false;
      summary.images.push({ name: entry.name, ok: false, error: verified.error ?? 'no frame data in image' });
    }
  }

  if (jsonOutPath) {
    fs.writeFileSync(jsonOutPath, JSON.stringify(summary, null, 2), 'utf-8');
  }
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const image of summary.images) {
      if (image.skippedEncrypted) {
        console.log(`  ~ ${image.name} (encrypted, skipped)`);
      } else if (image.ok) {
        console.log(`  + ${image.name} (${image.blocksVerified} blocks)`);
      } else {
        console.log(`  ! ${image.name}: ${image.error}`);
      }
    }
    console.log(
      `${summary.directory}: ${summary.verified} verified, ${summary.failed} failed, ${summary.skippedEncrypted} skipped (encrypted)`
    );
  }
  return summary.failed === 0 ? 0 : 1;
}

async function cmdScrub(ctx: CommandContext): Promise<number> {
  const dir = flagValue(ctx.argv, '--dir');
  if (!dir) {
    console.error('Usage: scrub --dir <directory> [--scope newest|all] [--repair] [--passphrase p] [--json] [--json-out FILE]');
    return 1;
  }
  const scope = (flagValue(ctx.argv, '--scope') ?? 'all') as 'newest' | 'all';
  const repair = ctx.argv.includes('--repair');
  const passphrase = flagValue(ctx.argv, '--passphrase');
  const jsonOutPath = flagValue(ctx.argv, '--json-out');

  const summary = scrubDirectory(dir, { scope, repair, passphrase });
  if (jsonOutPath) {
    fs.writeFileSync(jsonOutPath, JSON.stringify(summary, null, 2), 'utf-8');
  }
  if (ctx.opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.ok ? 0 : 1;
  }
  for (const image of summary.images) {
    if (image.stillFailed > 0) {
      console.log(`  ! ${image.name}: ${image.firstError ?? 'corrupt blocks remain'}`);
    } else if (image.repaired > 0) {
      console.log(`  + ${image.name}: repaired ${image.repaired} block(s)`);
    } else if (image.parityPresent && image.blocksChecked > 0) {
      console.log(`  + ${image.name} (${image.blocksChecked} blocks, parity protected)`);
    } else if (image.blocksChecked > 0) {
      console.log(`  + ${image.name} (${image.blocksChecked} blocks, no parity sidecar)`);
    } else {
      console.log(`  ~ ${image.name} (no block data)`);
    }
  }
  console.log(
    `${summary.directory}: ${summary.okCount} ok, ${summary.failed} failed, ` +
      `${summary.skippedEncrypted} skipped (encrypted), ${summary.repairedBlocks} block(s) repaired`
  );
  return summary.ok ? 0 : 1;
}

async function cmdParity(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  const imagePath = ctx.argv[1];
  if (!action || !imagePath) {
    console.error('Usage: parity build|verify|repair <image.opbs> [--block N]');
    return 1;
  }
  if (!fs.existsSync(imagePath)) {
    console.error(`Image does not exist: ${imagePath}`);
    return 1;
  }

  switch (action) {
    case 'build': {
      const report = buildParity(imagePath);
      console.log(
        `Built ${report.groups} parity group(s) covering ${report.blocksProtected} block(s) ` +
          `(${report.parityBytes} parity bytes) -> ${paritySidecarPath(imagePath)}`
      );
      return 0;
    }
    case 'verify': {
      const report = verifyParity(imagePath);
      if (report.ok) {
        console.log(`Parity OK (${report.groupsChecked} group(s) matched)`);
        return 0;
      }
      console.error(
        `Parity mismatch in ${report.mismatchedGroups.length} group(s) — ` +
          `corruption detected (image or sidecar); run 'parity repair' after confirming block damage`
      );
      return 1;
    }
    case 'repair': {
      const blockFlag = flagValue(ctx.argv, '--block');
      if (blockFlag) {
        const block = parseInt(blockFlag, 10);
        if (!Number.isInteger(block)) {
          console.error('--block must be an integer block index');
          return 1;
        }
        const report = repairParityBlock(imagePath, block);
        console.log(`Block ${block} repaired: ${report.message ?? 'frame rewritten'}`);
        return 0;
      }
      const scan = classifyImage(imagePath);
      const bad = scan.checks.filter((c) => !c.ok);
      if (bad.length === 0) {
        console.log('No corruption found; nothing to repair');
        return 0;
      }
      let failed = 0;
      for (const block of bad) {
        try {
          const report = repairParityBlock(imagePath, block.blockIndex);
          console.log(`Repaired block ${block.blockIndex}`);
          void report;
        } catch (error) {
          console.error(`Block ${block.blockIndex} NOT repaired: ${error instanceof Error ? error.message : error}`);
          failed++;
        }
      }
      return failed === 0 ? 0 : 1;
    }
    default:
      console.error('Usage: parity build|verify|repair <image.opbs> [--block N]');
      return 1;
  }
}

async function cmdChainCheck(ctx: CommandContext): Promise<number> {
  const dir = flagValue(ctx.argv, '--dir');
  if (!dir) {
    console.error('Usage: chain check --dir <directory> [--json]');
    return 1;
  }
  const report = buildChainHealthReport(dir);
  if (ctx.opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const chain of report.chains) {
      if (chain.orphaned) {
        console.log(`  ! ${chain.rootName}: MISSING base ${chain.missingBaseName ?? '(unset)'} (restore impossible)`);
      } else if (!chain.complete) {
        console.log(`  ! ${chain.rootName}: broken chain (${chain.itemCount} image(s))`);
      } else if (chain.itemCount > 1) {
        console.log(`  + ${chain.rootName}: chain ok (${chain.itemCount} image(s))`);
      } else {
        console.log(`  + ${chain.rootName}: ok`);
      }
    }
    for (const name of report.unparseableImages) {
      console.log(`  ? ${name}: not parseable as an image`);
    }
    console.log(
      `${report.directory}: ${report.completeChains}/${report.chainCount} chains ok, ` +
        `${report.missingBases.length} missing base(s), ${report.unparseableImages.length} unparseable`
    );
  }
  return report.brokenChains === 0 ? 0 : 1;
}

async function cmdTamperCheck(ctx: CommandContext): Promise<number> {
  const dir = flagValue(ctx.argv, '--dir');
  if (!dir) {
    console.error('Usage: tamper check --dir <directory> [--json]');
    return 1;
  }
  const report = detectTamper(dir);
  if (ctx.opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (!report.manifestPresent) {
      console.log(`${report.directory}: no manifest yet (run a backup to create one), nothing to compare against`);
      return 1;
    }
    for (const m of report.diff.missing) {
      console.log(`  ! deleted: ${m.name} (was ${m.manifestSize} bytes)`);
    }
    for (const s of report.diff.sizeChanged) {
      console.log(`  ! modified: ${s.name} (manifest ${s.manifestSize} → disk ${s.diskSize} bytes)`);
    }
    for (const u of report.diff.unexpected) {
      console.log(`  ! unexpected: ${u.name} (${u.size} bytes)`);
    }
    console.log(
      `${report.directory}: manifest ${report.manifestUpdatedAt ?? ''} — ` +
        `${report.diff.missing.length} missing, ${report.diff.sizeChanged.length} modified, ` +
        `${report.diff.unexpected.length} unexpected`
    );
    return report.ok ? 0 : 1;
  }
  return report.ok ? 0 : 1;
}

async function cmdStorageHealth(ctx: CommandContext): Promise<number> {
  const dir = flagValue(ctx.argv, '--dir');
  if (!dir) {
    console.error('Usage: storage-health --dir <directory> [--json]');
    return 1;
  }
  const report = await buildStorageHealthReport(dir, {
    keepFull: 0,
    keepDeltasPerFull: 0,
    retentionDays: 0,
    autoCleanup: false
  });
  if (ctx.opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.path}\n  reliability: ${report.score}/100 (${report.status})`);
    for (const warning of report.warnings) {
      console.log(`  ! ${warning}`);
    }
    console.log(
      `  ${report.imageCount} image(s), ${report.chainCount} chain(s) ` +
        `(${report.completeChains} complete, ${report.brokenChains} broken), ` +
        `${report.verifiedImages} verified, ${report.parityProtectedImages} parity-protected, ` +
        `free ${report.freeBytes != null ? Math.round(((report.freeBytes / Math.max(1, report.totalBytes ?? 1)) * 100)) : '?'}%`
    );
    if (report.smart.available) {
      console.log(`  SMART: ${report.smart.warnings.length === 0 ? 'healthy' : report.smart.warnings.join('; ')}`);
    } else if (report.smart.driveLetter) {
      console.log(`  SMART: unavailable for ${report.smart.driveLetter}:`);
    }
  }
  return report.status === 'at-risk' ? 1 : 0;
}

async function cmdAnomalies(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  if (action !== 'check') {
    console.error('Usage: anomalies check --dir <directory> [--json]');
    return 1;
  }
  const dir = flagValue(ctx.argv, '--dir');
  if (!dir) {
    console.error('Usage: anomalies check --dir <directory> [--json]');
    return 1;
  }
  const { detectAnomalies } = await import('../backup/anomaly-detect');
  const report = detectAnomalies(dir);
  if (ctx.opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  console.log(`${report.directory}`);
  console.log(
    `  baseline: ${report.historyCount} run(s) in history` +
      (report.baseline.medianRatio != null ? `, ratio ~${report.baseline.medianRatio.toFixed(2)}` : '') +
      (report.baseline.medianSpeedMBs != null ? `, speed ~${report.baseline.medianSpeedMBs.toFixed(1)} MB/s` : '') +
      (report.baseline.medianIntervalMs != null
        ? `, cadence ~${Math.max(1, Math.round(report.baseline.medianIntervalMs / (24 * 3600 * 1000)))} day(s)`
        : '')
  );
  if (report.anomalies.length === 0) {
    console.log('  no anomalies');
  }
  let failed = false;
  for (const anomaly of report.anomalies) {
    const tag = anomaly.severity === 'critical' ? 'CRITICAL' : anomaly.severity === 'warning' ? 'warning' : 'note';
    const icon = anomaly.severity === 'info' ? '  ' : '! ';
    console.log(`  ${icon}${tag}: ${anomaly.message}`);
    if (anomaly.severity !== 'info') failed = true;
  }
  return failed ? 1 : 0;
}

async function cmdPerf(ctx: CommandContext): Promise<number> {
  const dir = flagValue(ctx.argv, '--dir');
  if (!dir) {
    console.error('Usage: perf --dir <directory> [--size MB] [--json]');
    return 1;
  }
  const sizeMb = Number(flagValue(ctx.argv, '--size'));
  const result = runDiskPerfTest(dir, Number.isFinite(sizeMb) && sizeMb > 0 ? { sizeBytes: sizeMb * 1024 * 1024 } : {});
  if (ctx.opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    const { penalty, label } = assessWriteSpeed(result.seqWriteMBs);
    console.log(
      `${result.directory}\n  write: ${result.seqWriteMBs.toFixed(1)} MiB/s | read: ${result.seqReadMBs.toFixed(1)} MiB/s | ${result.bytes} bytes`
    );
    if (label !== 'good') {
      console.log(`  note: write speed is ${label} for a backup destination (${result.seqWriteMBs.toFixed(0)} MiB/s)`);
    }
    if (penalty !== 0) {
      console.log(`  note: this will subtract ${Math.abs(penalty)} point(s) from the storage-health score`);
    }
  } else {
    console.error(`${result.directory}: write test failed — ${result.error}`);
  }
  return result.ok ? 0 : 1;
}

async function launchVssCli(job: VssJob): Promise<VssJobResult> {
  const launcher = launchElevatedJob<VssJob, unknown, VssJobResult>(job);
  return launcher.promise;
}

function printVssWriters(result: VssJobResult): void {
  const failed = (result.writers ?? []).filter((w) => w.stateCode !== 1 || !/no error|no error/i.test(w.lastError));
  for (const w of result.writers ?? []) {
    const flag = w.stateCode === 1 ? 'stable' : w.state === 'Unknown' ? 'unknown' : 'problem';
    console.log(`  ${w.name}  [${flag}]  last error: ${w.lastError || '—'}`);
  }
  for (const p of result.providers ?? []) {
    console.log(`  provider: ${p.name}${p.version ? ` (v${p.version})` : ''}`);
  }
  if (result.errors?.length) {
    for (const e of result.errors) console.error(`  error: ${e}`);
  }
  if ((result.writers ?? []).length === 0 && (result.providers ?? []).length === 0) {
    console.log('  no writers or providers returned');
  }
  if (failed.length > 0) {
    console.error(`  ${failed.length} writer(s) are not stable`);
  }
}

async function cmdVss(ctx: CommandContext): Promise<number> {
  const sub = ctx.argv[0];
  switch (sub) {
    case 'status': {
      const state = await queryVssServiceState();
      if (ctx.opts.json) {
        console.log(JSON.stringify(state, null, 2));
        return 0;
      }
      console.log(`VSS service (${state.displayName}):`);
      console.log(`  state: ${state.state} (code ${state.stateCode}) | start type: ${state.startType}`);
      if (state.queryError) {
        console.error(`  error: ${state.queryError}`);
        return 1;
      }
      if (state.running) {
        console.log('  ready: yes — shadow copies can be created');
      } else {
        console.log(`  ready: no — start the service (vss start) or check why it is stopped`);
      }
      return 0;
    }
    case 'writers': {
      let result: VssJobResult;
      try {
        result = await launchVssCli({ type: 'vss', operation: 'writers' });
      } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printVssWriters(result);
      }
      const failed = (result.writers ?? []).some((w) => w.stateCode !== 1) || !result.ok;
      return failed ? 1 : 0;
    }
    case 'smoke-test': {
      const volume = normalizeVolumeRoot(ctx.argv[1] ?? '');
      if (!volume) {
        console.error('Usage: vss smoke-test <volume>  (e.g. "C:" or "C:\\")');
        return 1;
      }
      let result: VssJobResult;
      try {
        result = await launchVssCli({ type: 'vss', operation: 'smoke-test', volume });
      } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        console.log(`Snapshot OK on ${volume} (${result.durationMs ?? '?'} ms): ${result.devicePath ?? result.id ?? ''} — deleted.`);
      } else {
        console.error(`Snapshot test failed on ${volume}: ${result.error ?? result.deleteError ?? 'unknown error'}`);
      }
      return result.ok ? 0 : 1;
    }
    case 'start':
    case 'stop': {
      if (sub === 'stop') {
        // Stopping VSS affects other programs using shadow copies; require confirmation.
        if (!ctx.argv.includes('--yes')) {
          console.error('This stops the Volume Shadow Copy service for every program on the machine. Pass --yes to proceed.');
          return 1;
        }
      }
      let result: VssJobResult;
      try {
        result = await launchVssCli({ type: 'vss', operation: sub });
      } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        console.log(result.message ?? `${sub === 'start' ? 'Started' : 'Stopped'} the VSS service.`);
      } else {
        console.error(`${sub === 'start' ? 'Failed to start' : 'Failed to stop'} the VSS service: ${result.error ?? 'unknown error'}`);
      }
      return result.ok ? 0 : 1;
    }
    case 'repair': {
      if (!ctx.argv.includes('--yes')) {
        console.error('vss repair re-registers the core VSS DLLs and starts the service. Pass --yes to proceed.');
        return 1;
      }
      let result: VssJobResult;
      try {
        result = await launchVssCli({ type: 'vss', operation: 'repair' });
      } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      if (ctx.opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const r of result.results ?? []) {
          if (r.skipped) {
            console.log(`  ${r.dll}: not present — skipped`);
          } else if (r.ok) {
            console.log(`  ${r.dll}: re-registered`);
          } else {
            console.error(`  ${r.dll}: FAILED — ${r.error ?? 'unknown error'}`);
          }
        }
        if (result.service?.running) {
          console.log('  service: running');
        } else {
          console.error(`  service: not running${result.service?.startError ? ` — ${result.service.startError}` : ''}`);
        }
        if (result.error) console.error(`  error: ${result.error}`);
      }
      return result.ok ? 0 : 1;
    }
    default:
      console.error('Usage: vss <status|writers|smoke-test <volume>|start|stop|repair [--yes]>');
      return 1;
  }
}

async function cmdSchedule(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  switch (action) {
    case 'install-backup':
      return cmdScheduleInstallBackup(ctx);
    case 'install-verify':
      return cmdScheduleInstallVerify(ctx);
    case 'install-drill':
      return cmdScheduleInstallDrill(ctx);
    case 'remove': {
      const name = ctx.argv[1];
      if (!name) {
        console.error('Usage: schedule remove <name>');
        return 1;
      }
      await removeScheduledTask(name);
      console.log(`Removed scheduled task ${name}`);
      return 0;
    }
    case 'list': {
      const tasks = await listScheduledTasks();
      if (ctx.opts.json) {
        console.log(JSON.stringify(tasks, null, 2));
        return 0;
      }
      for (const task of tasks) {
        console.log(`${task.name}\t${task.status}\t${task.nextRun}\trun as ${task.runAs}`);
      }
      console.log(`${tasks.length} task(s)`);
      return 0;
    }
    default:
      console.error('Usage: schedule install-backup|install-verify|list|remove <name>');
      return 1;
  }
}

function scheduleOptionsOf(ctx: CommandContext): {
  time?: string;
  onLogin: boolean;
  asSystem: boolean;
  runLevel?: 'high' | 'user';
} {
  return {
    time: flagValue(ctx.argv, '--time'),
    onLogin: ctx.argv.includes('--on-login'),
    asSystem: ctx.argv.includes('--as-system'),
    runLevel: ctx.argv.includes('--run-as-user') ? 'user' : 'high'
  };
}

async function cmdScheduleInstallBackup(ctx: CommandContext): Promise<number> {
  const name = ctx.argv[1];
  const configPath = flagValue(ctx.argv, '--config');
  if (!name || !configPath) {
    console.error('Usage: schedule install-backup <name> --config <config.json> [--time HH:MM|--on-login] [--as-system]');
    return 1;
  }
  const opts = scheduleOptionsOf(ctx);
  const commandLine = `"${process.execPath}" --cli backup "${configPath}" --elevated`;
  await registerScheduledTask(name, commandLine, opts);
  console.log(`Registered task "${name}": ${commandLine}`);
  return 0;
}

async function cmdScheduleInstallVerify(ctx: CommandContext): Promise<number> {
  const name = ctx.argv[1];
  const dir = flagValue(ctx.argv, '--dir');
  if (!name || !dir) {
    console.error('Usage: schedule install-verify <name> --dir <directory> [--scope newest|all] [--time HH:MM|--on-login]');
    return 1;
  }
  const opts = scheduleOptionsOf(ctx);
  const scope = flagValue(ctx.argv, '--scope') ?? 'newest';
  const commandLine = `"${process.execPath}" --cli verify --dir "${dir}" --scope ${scope}`;
  await registerScheduledTask(name, commandLine, opts);
  console.log(`Registered task "${name}": ${commandLine}`);
  return 0;
}

async function cmdScheduleInstallDrill(ctx: CommandContext): Promise<number> {
  const name = ctx.argv[1];
  const dir = flagValue(ctx.argv, '--dir');
  const disk = flagValue(ctx.argv, '--disk');
  if (!name || !dir || disk === undefined) {
    console.error('Usage: schedule install-drill <name> --dir <directory> --disk <targetDiskIndex> [--verify] [--time HH:MM|--on-login]');
    return 1;
  }
  if (!Number.isInteger(Number(disk)) || Number(disk) < 0) {
    console.error('--disk must be a non-negative disk index');
    return 1;
  }
  const opts = scheduleOptionsOf(ctx);
  const verify = ctx.argv.includes('--verify') ? ' --verify' : '';
  const commandLine = `"${process.execPath}" --cli drill --dir "${dir}" --disk ${disk}${verify} --elevated --json`;
  await registerScheduledTask(name, commandLine, opts);
  console.log(`Registered task "${name}": ${commandLine}`);
  return 0;
}

async function cmdPrune(ctx: CommandContext): Promise<number> {
  const dir = ctx.argv[0];
  if (!dir) {
    console.error('Usage: prune <directory> [--keep-full N] [--keep-deltas N] [--days N] [--dry-run]');
    return 1;
  }
  const keepFull = Number(flagValue(ctx.argv, '--keep-full') ?? '3');
  const keepDeltas = Number(flagValue(ctx.argv, '--keep-deltas') ?? '3');
  const days = flagValue(ctx.argv, '--days') ? Number(flagValue(ctx.argv, '--days')) : undefined;
  const dryRun = ctx.argv.includes('--dry-run');
  const options = { keepFull, keepDeltasPerFull: keepDeltas, retentionDays: days, dryRun };

  let plan: RetentionPlan;
  if (dir.startsWith('s3://') || dir.startsWith('sftp://')) {
    const store = cloudStoreFromLocation(dir, flagValue(ctx.argv, '--region'));
    plan = dryRun ? await planRetentionS3(store, options) : await applyRetentionS3(store, options);
  } else {
    plan = dryRun ? planRetention(dir, options) : await applyRetention(dir, options);
  }
  if (ctx.opts.json) {
    console.log(JSON.stringify({ ...plan, keep: plan.keep, prune: plan.prune }, null, 2));
    return 0;
  }
  if (dryRun) {
    console.log(`[dry-run] would delete ${plan.prune.length} image(s):`);
  } else {
    console.log(`Deleted ${plan.prune.length} image(s):`);
  }
  for (const entry of plan.prune) {
    console.log(`  - ${entry.name} (${plan.reason[path.resolve(entry.path)] ?? 'policy'})`);
  }
  console.log(`Kept ${plan.keep.length} image(s).`);
  for (const reminder of plan.reminders ?? []) {
    console.log(`  ! ${reminder}`);
  }
  return 0;
}

async function cmdHealth(ctx: CommandContext): Promise<number> {
  const diskIndex = Number(ctx.argv[0]);
  if (!Number.isInteger(diskIndex) || diskIndex < 0) {
    console.error('Usage: health <diskIndex>');
    return 1;
  }
  const health = await checkDiskHealth(diskIndex);
  if (ctx.opts.json) {
    console.log(JSON.stringify(health, null, 2));
  } else if (health.ok) {
    console.log(`disk ${diskIndex} is healthy${health.data.model ? ` (${health.data.model})` : ''}`);
    if (health.warnings.length) {
      for (const warning of health.warnings) {
        console.log(`  ${warning}`);
      }
    }
  } else {
    console.error(`disk ${diskIndex} needs attention:`);
    for (const warning of health.warnings) {
      console.error(`  - ${warning}`);
    }
  }
  return health.ok ? 0 : 1;
}

async function cmdMedia(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];

  if (action === 'smart') {
    return cmdMediaSmart(ctx);
  }

  if (action === 'check') {
    const arch = peArchForProcess();
    const adk = locateAdk(arch, flagValue(ctx.argv, '--adk'));
    const node = resolveNodeExe(flagValue(ctx.argv, '--node'));
    const report = {
      ok: !!adk,
      arch,
      adkRoot: adk?.root ?? null,
      copype: adk?.copype ?? null,
      makeWinPEMedia: adk?.makeWinPEMedia ?? null,
      dism: adk?.dism ?? null,
      oscdimg: adk?.oscdimg ?? null,
      node,
      ready: !!adk && !!adk.dism && !!node
    };
    if (ctx.opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (adk) {
        console.log(`WinPE ADK found: ${adk.root}`);
        console.log(`  copype:           ${adk.copype}`);
        console.log(`  MakeWinPEMedia:   ${adk.makeWinPEMedia}`);
        console.log(`  DISM:             ${adk.dism}`);
        if (adk.oscdimg) {
          console.log(`  oscdimg:          ${adk.oscdimg}`);
        }
      } else {
        console.error(
          'WinPE ADK not found. Install the Windows ADK (Windows Preinstallation Environment component) ' +
            'or pass --adk <root>.'
        );
      }
      console.log(`Bundled Node:     ${node ?? '(not found)'}`);
    }
    return report.ready ? 0 : 1;
  }

  if (action === 'create') {
    const iso = flagValue(ctx.argv, '--iso');
    const usb = flagValue(ctx.argv, '--usb');
    const arch = (flagValue(ctx.argv, '--arch') ?? peArchForProcess()) as 'amd64' | 'arm64';
    const adkRoot = flagValue(ctx.argv, '--adk');
    const nodeExe = flagValue(ctx.argv, '--node');
    const distDir = flagValue(ctx.argv, '--dist');
    const nativeNode = flagValue(ctx.argv, '--native');
    const restoreConfig = flagValue(ctx.argv, '--restore-config');
    const drivers = (flagValue(ctx.argv, '--driver') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if ((iso && usb) || (!iso && !usb)) {
      console.error('Usage: media create --iso <out.iso> [options] | --usb <drive> --yes [options]');
      return 1;
    }
    const result = await createRecoveryMedia({
      arch,
      format: iso ? 'iso' : 'usb',
      output: iso ?? usb ?? '',
      adkRoot,
      nodeExe,
      distDir,
      nativeNode,
      restoreConfig,
      drivers,
      yesForUsb: !!iso || ctx.argv.includes('--yes'),
      scriptOnly: ctx.argv.includes('--script-only')
    });
    if (ctx.opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok && result.scriptPath) {
      console.log(
        `Build script written (no elevation attempted): ${result.scriptPath}\n` +
        `Run it from an already-elevated PowerShell to produce:\n` +
        `  powershell -NoProfile -ExecutionPolicy Bypass -File "${result.scriptPath}"\n` +
        `Result will appear at ${path.join(path.dirname(result.scriptPath), 'build', 'result.json')}.`
      );
    } else if (result.ok) {
      console.log(
        `Recovery media written: ${result.output}${result.sizeBytes ? ` (${formatBytes(result.sizeBytes)})` : ''}`
      );
    } else {
      console.error(`Recovery media failed: ${result.error}`);
    }
    return result.ok ? 0 : 1;
  }

  if (action === 'smoke') {
    const result = smokeMediaPayload({
      nodeExe: flagValue(ctx.argv, '--node'),
      distDir: flagValue(ctx.argv, '--dist'),
      nativeNode: flagValue(ctx.argv, '--native'),
      restoreConfig: flagValue(ctx.argv, '--restore-config')
    });
    if (ctx.opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const c of result.checks) {
        console.log(`  ${c.ok ? '[ok]' : '[FAIL]'} ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
      }
      if (result.ok) {
        console.log('WinPE payload smoke test passed.');
      } else {
        console.error(`WinPE payload smoke test failed: ${result.error ?? 'see checks above'}`);
        if (result.output) console.error(result.output.slice(0, 2000));
      }
    }
    return result.ok ? 0 : 1;
  }

  console.error('Usage: media check | media create --iso <out.iso> [options] | media create --usb <drive> --yes | media smoke [options]');
  return 1;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatIsoDate(unix: number): string {
  if (!unix) return '';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/** Print a human-readable overview of a Macrium Reflect image. */
function printMrimgInfo(info: import('../imaging/mrimg').MacriumImageInfo): void {
  const enc = info.encryption;
  console.log(`Macrium Reflect ${info.format === 'mrimg-v7' ? '7/8' : 'X'} image: ${info.imagePath}`);
  console.log(`  image ID: ${info.imageId || '(none)'}`);
  console.log(`  backup:   ${info.backupType || '?'} (${info.backupFormat || '?'}), created ${formatIsoDate(info.backupTime ?? 0) || '?'}`);
  console.log(`  system:   ${info.netbiosName || '?'}`);
  const disk = info.disks[0];
  if (disk && (disk.diskFormat || disk.diskSignature || disk.size)) {
    const sig = disk.diskSignature ? `, sig ${disk.diskSignature}` : '';
    const size = disk.size ? `, ${formatBytes(disk.size)}` : '';
    console.log(`  disk:     ${disk.diskFormat || '?'}${sig}${size}`);
  }
  console.log(`  compression: ${info.compression.level && info.compression.level !== 'none' ? `${info.compression.method || 'zstd'} @ ${info.compression.level}` : 'none'}`);
  console.log(`  encryption:  ${enc.enable ? `yes (${enc.aesType ?? '?'} variant, ${enc.keyIterations} iterations)` : 'no'}`);
  if (info.splitFile) console.log('  split-file:  yes (multi-part; browsing not yet supported)');
  if (info.deltaIndex) console.log('  delta index: yes (incremental chain; browsing not yet supported)');
  console.log(`  partitions: ${info.partitions.length}`);
  for (const p of info.partitions) {
    const gb = p.blockCount > 0 ? formatBytes(p.blockCount * p.blockSize) : formatBytes(p.geometry.length);
    console.log(`    partition ${p.partitionNumber} (disk ${p.diskIndex + 1}): ${p.fsType || '?'}${p.volumeLabel ? ` "${p.volumeLabel}"` : ''} ${gb}, block size ${p.blockSize} (${p.blockCount} blocks)`);
  }
}

async function cmdMediaSmart(ctx: CommandContext): Promise<number> {
  const { inventoryMediaHealth } = await import('../utils/media-health');
  const entries = await inventoryMediaHealth();
  if (ctx.opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return entries.some((e) => e.unhealthy) ? 1 : 0;
  }
  let anyUnhealthy = false;
  for (const entry of entries) {
    const letters = entry.driveLetters.length > 0 ? ` [${entry.driveLetters.join(', ')}:]` : '';
    if (entry.unhealthy) {
      anyUnhealthy = true;
      console.log(`! Disk ${entry.diskIndex} — ${entry.model}${letters}`);
      for (const warning of entry.health.warnings) {
        console.log(`    ${warning}`);
      }
    } else if (entry.health.data) {
      console.log(`ok  Disk ${entry.diskIndex} — ${entry.model}${letters} (${entry.health.data.mediaType ?? ''} ${entry.health.data.temperatureCelsius != null ? `${entry.health.data.temperatureCelsius.toFixed(0)}°C ` : ''}${entry.health.data.wear != null ? `${entry.health.data.wear.toFixed(0)}% wear ` : ''}${entry.health.data.healthStatus ?? 'Healthy'})`);
    } else {
      console.log(`?   Disk ${entry.diskIndex} — ${entry.model}${letters} (SMART data unavailable — may require elevation)`);
    }
  }
  if (entries.length === 0) {
    console.log('No physical disks discovered.');
  }
  return anyUnhealthy ? 1 : 0;
}

async function cmdMrimg(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  const file = ctx.argv[1];
  if (action !== 'info' || !file) {
    console.error('Usage: mrimg info <image.mrimgx>');
    return 1;
  }
  try {
    const format = detectMacriumFormat(file);
    if (!format) {
      console.error(`Not a Macrium Reflect image: ${file}`);
      return 1;
    }
    const info = readMacriumImage(file);
    if (ctx.opts.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      printMrimgInfo(info);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * Self-check used by the WinPE payload smoke test: proves the bundled native
 * addon loads (via the same native-loader path restore uses) and the runtime
 * codecs resolve, then prints a JSON report. Not intended for normal use.
 */
function cmdSmokeSelfcheck(ctx: CommandContext): number {
  try {
    const native = loadNative<{ crc32?: (buf: Buffer) => number }>();
    const crc = native.crc32?.(Buffer.from('OPBS smoke-check payload', 'utf-8')) ?? null;
    const codecs: Record<string, boolean> = {};
    for (const pkg of ['fzstd', 'zstdify']) {
      try {
        require.resolve(pkg);
        codecs[pkg] = true;
      } catch {
        codecs[pkg] = false;
      }
    }
    const report = {
      ok: typeof crc === 'number' && Object.values(codecs).every(Boolean),
      native: 'opbs_native.node',
      crc32: crc,
      codecs,
      node: process.version,
      cwd: process.cwd()
    };
    console.log(ctx.opts.json ? JSON.stringify(report, null, 2) : JSON.stringify(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
}

function parsePartitionIndex(argv: string[]): number | null {
  const raw = flagValue(argv, '--partition');
  const value = raw === undefined ? 0 : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

async function cmdBrowse(ctx: CommandContext): Promise<number> {
  const imagePath = ctx.argv[0];
  if (!imagePath) {
    console.error('Usage: browse <image> [--partition N] [--path DIR] [--passphrase p]');
    return 1;
  }
  const partitionIndex = parsePartitionIndex(ctx.argv);
  if (partitionIndex === null) {
    console.error('Invalid --partition value');
    return 1;
  }
  const relPath = flagValue(ctx.argv, '--path') ?? '';
  const passphrase = flagValue(ctx.argv, '--passphrase');

  try {
    let key: Buffer | undefined;
    if (!detectMacriumFormat(imagePath)) {
      const info = readImageInfo(imagePath);
      if (passphrase && info.header.cipherId !== 0) {
        key = deriveImageKey(passphrase, info.header.salt, info.header.kdfIterations);
      }
    }
    const session = openAnyBrowse(imagePath, partitionIndex, key);
    const entries = listDirectory(session, relPath);
    if (ctx.opts.json) {
      console.log(
        JSON.stringify(
          {
            imagePath,
            partitionIndex,
            path: relPath || '/',
            entries: entries.map((n) => ({
              name: n.name,
              type: n.isDirectory ? 'directory' : 'file',
              size: n.size,
              modified: formatTimestamp(n.modified)
            }))
          },
          null,
          2
        )
      );
    } else {
      console.log(`${relPath || '/'} (partition ${partitionIndex}):`);
      for (const entry of entries) {
        const suffix = entry.isDirectory ? '/' : '';
        const size = entry.isDirectory ? '          ' : `${entry.size}`.padStart(10, ' ');
        console.log(`  ${entry.name}${suffix}\t${size}\t${formatTimestamp(entry.modified)}`);
      }
      console.log(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function cmdExtract(ctx: CommandContext): Promise<number> {
  const imagePath = ctx.argv[0];
  const relPath = flagValue(ctx.argv, '--path');
  const outPath = flagValue(ctx.argv, '--out');
  if (!imagePath || !relPath || !outPath) {
    console.error('Usage: extract <image> --partition N --path DIR --out DEST [--passphrase p]');
    return 1;
  }
  const partitionIndex = parsePartitionIndex(ctx.argv);
  if (partitionIndex === null) {
    console.error('Invalid --partition value');
    return 1;
  }
  const passphrase = flagValue(ctx.argv, '--passphrase');

  try {
    let key: Buffer | undefined;
    if (!detectMacriumFormat(imagePath)) {
      const info = readImageInfo(imagePath);
      if (passphrase && info.header.cipherId !== 0) {
        key = deriveImageKey(passphrase, info.header.salt, info.header.kdfIterations);
      }
    }
    const session = openAnyBrowse(imagePath, partitionIndex, key);
    const rec = resolvePath(session, relPath);
    if (!rec) {
      console.error(`Path not found: ${relPath}`);
      return 1;
    }
    const count = extractPath(session, relPath, outPath);
    if (!ctx.opts.json) {
      console.log(`Extracted ${count} file(s) from ${relPath} to ${outPath}`);
    } else {
      console.log(JSON.stringify({ imagePath, partitionIndex, path: relPath, outPath, extracted: count, ok: true }, null, 2));
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function s3StoreFromLocation(uri: string, region?: string): S3Store {
  const { bucket, prefix } = parseS3Location(uri);
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? '';
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables are required');
  }
  return new S3Store({
    region: region ?? process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    bucket,
    prefix
  });
}

/** Object-store client for a `s3://` or `sftp://` location. */
function cloudStoreFromLocation(uri: string, region?: string): S3Store | SftpStore {
  if (uri.trim().startsWith('sftp://')) {
    const config = resolveSftpConfig(undefined, uri);
    if (!config.username) {
      throw new Error(`sftp:// location requires a username (sftp://user@host/path) or SFTP_USER`);
    }
    if (!config.password && !config.privateKey) {
      throw new Error('SFTP credentials are required (SFTP_PASSWORD or SFTP_PRIVATE_KEY)');
    }
    return new SftpStore({ config });
  }
  return s3StoreFromLocation(uri, region);
}

async function cmdStore(ctx: CommandContext): Promise<number> {
  const action = ctx.argv[0];
  const uri = ctx.argv[1];
  const file = ctx.argv[2];
  const region = flagValue(ctx.argv, '--region');
  const store = uri && (uri.startsWith('s3://') || uri.startsWith('sftp://')) ? cloudStoreFromLocation(uri, region) : undefined;

  if (action === 'put' && store && file) {
    const key = file.includes('/') ? path.basename(file) : file;
    if (store instanceof SftpStore) {
      await store.uploadFile(file, key);
    } else {
      const data = fs.readFileSync(file);
      await store.put(key, data);
    }
    if (!ctx.opts.json) console.log(`Uploaded ${file} to ${store.resolveKey(key)}`);
    else console.log(JSON.stringify({ ok: true, key: store.resolveKey(key) }, null, 2));
    return 0;
  }

  if (action === 'get' && store && file) {
    const data = await store.get(path.basename(file));
    fs.writeFileSync(file, data);
    if (!ctx.opts.json) console.log(`Downloaded to ${file} (${data.length} bytes)`);
    else console.log(JSON.stringify({ ok: true, bytes: data.length }, null, 2));
    return 0;
  }

  if (action === 'list' && store) {
    const keys = await store.list();
    if (ctx.opts.json) {
      console.log(JSON.stringify({ ok: true, keys }, null, 2));
    } else {
      for (const key of keys) console.log(key);
      console.log(`${keys.length} object(s)`);
    }
    return 0;
  }

  if (action === 'verify' && store) {
    const key = flagValue(ctx.argv, '--key');
    const passphrase = flagValue(ctx.argv, '--passphrase');
    const objects = key ? [key] : await store.list();
    if (objects.length === 0) {
      console.error('No objects found to verify');
      return 1;
    }
    const tmp = path.join(os.tmpdir(), `opbs-store-verify-${Date.now()}.opbs`);
    let ok = 0;
    let failed = 0;
    try {
      for (const objKey of objects) {
        const data = await store.get(objKey);
        fs.writeFileSync(tmp, data);
        const v = await verifyImage(tmp, passphrase ? deriveImageKey(passphrase, readImageInfo(tmp).header.salt, readImageInfo(tmp).header.kdfIterations) : undefined);
        if (v.ok) {
          ok++;
        } else {
          failed++;
          if (!ctx.opts.json) console.error(`FAILED ${objKey}: ${v.error ?? 'unknown'}`);
        }
      }
      if (ctx.opts.json) console.log(JSON.stringify({ ok: true, verified: ok, failed }, null, 2));
      else console.log(`${ok} verified, ${failed} failed`);
      return failed === 0 ? 0 : 1;
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  console.error('Usage: store put <s3://bucket/prefix|sftp://user@host/path> <file> [--region R] | store get <uri> <file> [--region R] | store list <uri> [--region R] | store verify <uri> [--key K] [--passphrase p]');
  return 1;
}

async function cmdUsn(ctx: CommandContext): Promise<number> {
  const volume = ctx.argv[0];
  if (!volume) {
    console.error('Usage: usn-changes <volume> [--count N]');
    return 1;
  }
  const count = Number(flagValue(ctx.argv, '--count') ?? 200);
  try {
    const native = loadNative<NativeImagingApi>();
    const changes = native.queryUsnJournal?.(volume) ?? [];
    const limited = changes.slice(0, count);
    if (ctx.opts.json) {
      console.log(
        JSON.stringify(
          { volume, count: limited.length, changes: limited.map((c) => ({ usn: c.usn.toString(), fileName: c.fileName, reason: c.reason })) },
          null,
          2
        )
      );
    } else {
      for (const c of limited) {
        console.log(`${c.fileName}\t${c.usn.toString()}\treason=${c.reason}`);
      }
      console.log(`${limited.length} change(s)`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function cmdMount(ctx: CommandContext): Promise<number> {
  if (ctx.argv.includes('--check')) {
    console.log(winfspAvailable() ? 'WinFsp: installed' : 'WinFsp: not installed (https://winfsp.dev)');
    return winfspAvailable() ? 0 : 1;
  }

  const imagePath = ctx.argv[0];
  if (!imagePath) {
    console.error('Usage: mount <image> --partition N [--letter X:] [--label L] [--passphrase p] [--check]');
    return 1;
  }
  const partitionIndex = parsePartitionIndex(ctx.argv);
  if (partitionIndex === null) {
    console.error('Invalid --partition value');
    return 1;
  }
  const letter = flagValue(ctx.argv, '--letter');
  const label = flagValue(ctx.argv, '--label');
  const passphrase = flagValue(ctx.argv, '--passphrase');
  if (letter && !/^[A-Za-z]:$/.test(letter)) {
    console.error('--letter must look like "X:"');
    return 1;
  }

  if (!winfspAvailable()) {
    console.error('WinFsp is not installed. Install the WinFsp runtime (https://winfsp.dev) and try again.');
    return 1;
  }

  const job = {
    type: 'mount',
    imagePath,
    partitionIndex,
    driveLetter: letter,
    label,
    passphrase
  };

  try {
    const launcher = launchElevatedJob<typeof job, Record<string, unknown>, { ok?: boolean }>(job);
    let mountedInfo: string | null = null;
    launcher.onProgress((p) => {
      if (p && p.state === 'mounted') {
        mountedInfo = `${p.mountPoint as string} (id ${String(p.id)})`;
        if (ctx.opts.json) {
          console.log(JSON.stringify({ ok: true, state: 'mounted', ...p }));
        } else {
          console.log(`Mounted at ${mountedInfo}. Press Ctrl+C to unmount.`);
        }
      }
    });
    const onInterrupt = (): void => {
      launcher.cancel();
    };
    process.once('SIGINT' as string, onInterrupt);
    const result = await launcher.promise;
    if (ctx.opts.json) {
      console.log(JSON.stringify({ ok: result?.ok !== false, state: 'unmounted' }));
    } else {
      console.log('Unmounted.');
    }
    return result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function cmdNewConfig(ctx: CommandContext): Promise<number> {
  const output = ctx.argv[0];
  if (!output) {
    console.error('Usage: new-config <output.json>');
    return Promise.resolve(1);
  }
  const example = {
    kind: 'backup',
    sourceDiskIndex: 0,
    sourcePartitions: [2],
    destinationPath: 'D:\\OPBS',
    compressionLevel: 3,
    compressionType: 'zstd',
    compressionThreads: 4,
    verificationEnabled: true,
    baseImagePath: undefined,
    passphrase: undefined
  };
  fs.writeFileSync(output, JSON.stringify(example, null, 2));
  console.log(`Example configuration written to ${output}`);

  console.log('\nRestore example (change "kind" to "restore"):');
  const restoreExample = {
    kind: 'restore',
    imagePath: 'D:\\OPBS\\img_0_1746300000000.opbs',
    targetDiskIndex: 1,
    targetPartitions: [2],
    verifyBeforeWrite: true,
    passphrase: undefined,
    applyDeltas: true
  };
  fs.writeFileSync(path.join(path.dirname(output), 'restore-example.json'), JSON.stringify(restoreExample, null, 2));
  console.log(`Restore example written to ${path.join(path.dirname(output), 'restore-example.json')}`);

  console.log('\nDrill example (restore to a scratch disk and validate):');
  const drillExample = {
    kind: 'restore-drill',
    imagePath: 'D:\\OPBS\\img_0_1746300000000.opbs',
    targetDiskIndex: 1,
    targetPartitions: [2],
    verifyBeforeWrite: true,
    applyDeltas: true,
    validateAfterWrite: true
  };
  fs.writeFileSync(path.join(path.dirname(output), 'drill-example.json'), JSON.stringify(drillExample, null, 2));
  console.log(`Drill example written to ${path.join(path.dirname(output), 'drill-example.json')}`);
  return Promise.resolve(0);
}