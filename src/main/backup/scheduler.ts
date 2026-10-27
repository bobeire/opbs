import type { ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupManager, BackupConfig } from '../backup/manager';
import { ScheduledBackup, ScheduledVerification, ScheduledRestoreDrill, ScheduledMigrateDrill, ScheduledScrub, SettingsManager } from '../utils/settings-manager';
import { applyRetention, findNewestImage, pickDrillImage, resolveScheduledRetention, scanBackupDirectory, type BackupImageEntry } from './retention';
import { cloudImageEntries } from './retention-s3';
import { isCloudImageLocation, materializeImageFromCloud, type StagedCloudImage } from '../imaging/cloud-restore';
import { cloudStoreFromLocation } from '../utils/cloud-store';
import { cloudStoreOptionsFrom } from '../utils/cloud-profiles';
import { summarizeImage } from '../imaging/restore-engine';
import { recordDrillResult } from '../utils/drill-history';
import { recordMigrateDrillResult } from '../utils/migrate-drill-history';
import { buildMigrateArgs } from '../imaging/migrate/cli-runner';
import { tryNotify } from '../utils/notify';
import { ConsecutiveFailureTracker } from '../utils/failure-tracker';
import { logger } from '../utils/logger';
import { compactAfterBackup } from '../imaging/compact-engine';

/**
 * Lazily loads node-cron and electron so the WinPE/CLI payload (which bundles
 * only fzstd/zstdify + the native addon) can require this module graph without
 * crashing: node-cron and the Electron APIs are only needed in the main app.
 */
function getCron(): { schedule: (expr: string, fn: () => void) => ScheduledTask; validate: (expr: string) => boolean } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node-cron') as { schedule: (expr: string, fn: () => void) => ScheduledTask; validate: (expr: string) => boolean };
}

function electronApp(): { isPackaged: boolean; getAppPath: () => string } | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as { app?: { isPackaged: boolean; getAppPath: () => string } };
  return electron.app ?? null;
}

const VERIFY_TASK_ID = 'scheduled-verify';
const SCRUB_TASK_ID = 'idle-scrub';
const DRILL_TASK_ID = 'scheduled-drill';
const MIGRATE_DRILL_TASK_ID = 'scheduled-migrate-drill';

interface RetryState {
  /** Number of retries already attempted after the original failure. */
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ActivityEvent {
  kind: 'success' | 'failure';
  title: string;
  body: string;
  backupName: string;
  bytesWritten: number;
  destinationPath: string;
  error?: string;
  timestamp: string;
}

function broadcastActivity(event: ActivityEvent): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron');
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send('activity', event);
  }
}

export class BackupScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private backupManager: BackupManager;
  private settingsManager: SettingsManager;
  private verifyFailures = new ConsecutiveFailureTracker();
  private drillFailures = new ConsecutiveFailureTracker();
  private migrateDrillFailures = new ConsecutiveFailureTracker();
  private scrubFailures = new ConsecutiveFailureTracker();
  private retries: Map<string, RetryState> = new Map();

  constructor(backupManager: BackupManager, settingsManager: SettingsManager) {
    this.backupManager = backupManager;
    this.settingsManager = settingsManager;
  }

  startAll(): void {
    const settings = this.settingsManager.getSettings();

    settings.scheduledBackups.forEach((backup) => {
      if (backup.enabled) {
        this.scheduleBackup(backup);
      }
    });

    if (settings.scheduledVerification.enabled && settings.scheduledVerification.destinationPath) {
      this.scheduleVerification(settings.scheduledVerification);
    }

    if (settings.scheduledDrill.enabled && settings.scheduledDrill.destinationPath) {
      this.scheduleDrill(settings.scheduledDrill);
    }

    if (
      settings.scheduledMigrateDrill?.enabled &&
      settings.scheduledMigrateDrill.destinationPath &&
      settings.scheduledMigrateDrill.profile
    ) {
      this.scheduleMigrateDrill(settings.scheduledMigrateDrill);
    }

    if (settings.scrubWhileIdle && settings.backupLocation) {
      this.scheduleScrub(settings.scrubIntervalHours);
    }

    if (settings.scheduledScrub.enabled && settings.scheduledScrub.destinationPath) {
      this.scheduleConfiguredScrub(settings.scheduledScrub);
    }

    logger.info(`Scheduler started with ${this.tasks.size} tasks`);

    // Catch-up: check for missed schedules while the app was closed.
    // If a backup's lastRun is older than when it should have last fired,
    // run it now (once, with a short delay to let the app settle).
    this.checkMissedSchedules(settings.scheduledBackups);
  }

  stopAll(): void {
    this.tasks.forEach((task) => task.stop());
    this.tasks.clear();
    this.clearRetries();
    logger.info('Scheduler stopped');
  }

  /**
   * Check for schedules that should have fired while the app was closed.
   * If lastRun is older than the most recent scheduled fire time, trigger
   * the backup now. Runs once at startup with a 30-second delay to let
   * the app (and disk) settle.
   */
  private checkMissedSchedules(backups: ScheduledBackup[]): void {
    // Lazy require: cron-parser is only needed when a schedule fires, so the
    // main process starts without loading it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cronParser = require('cron-parser');
    const now = Date.now();
    for (const backup of backups) {
      if (!backup.enabled) continue;
      try {
        const interval = cronParser.parseExpression(backup.cronExpression);
        const lastScheduled = interval.prev().getTime();
        const lastRun = backup.lastRun ? new Date(backup.lastRun).getTime() : 0;
        // If the last scheduled fire is more recent than lastRun, the
        // schedule was missed. Run it after a short delay.
        if (lastScheduled > lastRun && now - lastScheduled < 24 * 60 * 60 * 1000) {
          logger.info(`Catch-up: "${backup.name}" missed its ${new Date(lastScheduled).toLocaleString()} run — scheduling now`);
          setTimeout(() => {
            void this.runBackup(backup);
          }, 30_000);
        }
      } catch {
        /* unparseable cron expression — skip */
      }
    }
  }

  /** Cancel pending retry timers so a stopped scheduler cannot fire late. */
  private clearRetries(): void {
    this.retries.forEach((state) => {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    });
    this.retries.clear();
  }

  /**
   * Live cron validation for the UI. Reuses node-cron's own validator so
   * what the scheduler accepts is exactly what the form permits.
   */
  validate(expression: string): boolean {
    return getCron().validate(expression);
  }

  scheduleBackup(config: ScheduledBackup): boolean {
    this.cancelBackup(config.id);
    
    if (!getCron().validate(config.cronExpression)) {
      logger.error(`Invalid cron expression for backup ${config.name}: ${config.cronExpression}`);
      return false;
    }
    
    const task = getCron().schedule(config.cronExpression, async () => {
      await this.runBackup(config);
    });
    
    this.tasks.set(config.id, task);
    logger.info(`Scheduled backup ${config.name} (${config.id}) at ${config.cronExpression}`);
    return true;
  }

  cancelBackup(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
      logger.info(`Cancelled scheduled task ${id}`);
    }
    const retry = this.retries.get(id);
    if (retry) {
      if (retry.timer) {
        clearTimeout(retry.timer);
      }
      this.retries.delete(id);
    }
  }

  scheduleVerification(config: ScheduledVerification): boolean {
    const existing = this.tasks.get(VERIFY_TASK_ID);
    if (existing) {
      existing.stop();
      this.tasks.delete(VERIFY_TASK_ID);
    }

    if (!getCron().validate(config.cronExpression)) {
      logger.error(`Invalid cron expression for verification: ${config.cronExpression}`);
      return false;
    }

    const task = getCron().schedule(config.cronExpression, () => {
      void this.runScheduledVerification(config);
    });
    this.tasks.set(VERIFY_TASK_ID, task);
    logger.info(`Scheduled verification at ${config.cronExpression} (scope: ${config.scope})`);
    return true;
  }

  /** Scrub the newest images on a low-frequency interval (idle background churn). */
  scheduleScrub(intervalHours: number): boolean {
    const existing = this.tasks.get(SCRUB_TASK_ID);
    if (existing) {
      existing.stop();
      this.tasks.delete(SCRUB_TASK_ID);
    }
    const everyMinutes = Math.max(30, Math.floor((intervalHours || 24) * 60));
    const task = getCron().schedule(`*/${everyMinutes} * * * *`, () => {
      const settings = this.settingsManager.getSettings();
      if (!settings.backupLocation) return;
      void this.runScrub(settings.backupLocation, 'newest', {
        label: 'Idle scrub',
        notifyOnFailure: true,
        alertAfter: 2
      });
    });
    this.tasks.set(SCRUB_TASK_ID, task);
    logger.info(`Idle scrub scheduled every ${everyMinutes} minutes (with parity repair)`);
    return true;
  }

  /** Scheduled scrub with its own cron expression, scope and destination. */
  scheduleConfiguredScrub(config: ScheduledScrub): boolean {
    const existing = this.tasks.get(SCRUB_TASK_ID);
    if (existing) {
      existing.stop();
      this.tasks.delete(SCRUB_TASK_ID);
    }

    if (!getCron().validate(config.cronExpression)) {
      logger.error(`Invalid cron expression for scrub: ${config.cronExpression}`);
      return false;
    }

    const task = getCron().schedule(config.cronExpression, () => {
      void this.runScrub(config.destinationPath, config.scope, {
        label: 'Scheduled scrub',
        notifyOnFailure: config.notifyOnFailure,
        alertAfter: config.alertAfter ?? 2
      });
    });
    this.tasks.set(SCRUB_TASK_ID, task);
    logger.info(`Scheduled scrub at ${config.cronExpression} (scope: ${config.scope}, repair enabled)`);
    return true;
  }

  /** Periodic restore drill: prove that the newest image restores + validates. */
  scheduleDrill(config: ScheduledRestoreDrill): boolean {
    const existing = this.tasks.get(DRILL_TASK_ID);
    if (existing) {
      existing.stop();
      this.tasks.delete(DRILL_TASK_ID);
    }

    if (!getCron().validate(config.cronExpression)) {
      logger.error(`Invalid cron expression for restore drill: ${config.cronExpression}`);
      return false;
    }

    const task = getCron().schedule(config.cronExpression, () => {
      void this.runDrill(config);
    });
    this.tasks.set(DRILL_TASK_ID, task);
    logger.info(`Restore drill scheduled at ${config.cronExpression} (target disk ${config.targetDiskIndex})`);
    return true;
  }

  /**
   * Run a restore drill in a detached child (`--cli drill <config> --elevated`).
   * Restores the newest drillable image (with deltas) to the configured
   * scratch disk, then reads the written filesystems back and validates them.
   * Encrypted images drill too when a passphrase is configured; the key is
   * handed to the child inside the short-lived drill config, never on argv.
   */
  private async runDrill(config: ScheduledRestoreDrill): Promise<void> {
    const dir = config.destinationPath;
    let staged: StagedCloudImage | undefined;
    let entries: BackupImageEntry[];
    let cloudStore: ReturnType<typeof cloudStoreFromLocation> | undefined;
    if (isCloudImageLocation(dir)) {
      // Cloud destinations: read each image's header from the store (the same
      // metadata walk `prune` uses), then stage the picked chain locally —
      // the drill child restores from plain paths like any other drill.
      try {
        cloudStore = cloudStoreFromLocation(dir, cloudStoreOptionsFrom(this.settingsManager.getSettings()));
        entries = (await cloudImageEntries(cloudStore)).map((entry) => ({
          ...entry,
          path: `${dir.replace(/\/+$/, '')}/${entry.path}`
        }));
      } catch (error) {
        logger.error(`Restore drill could not list cloud images at ${dir}:`, error);
        return;
      }
    } else {
      entries = scanBackupDirectory(dir);
    }
    const picked = pickDrillImage(entries, config.passphrase);
    if (!picked) {
      logger.warn(
        entries.some((entry) => entry.encrypted) && !config.passphrase
          ? `Restore drill: images in ${dir} are encrypted and no drill passphrase is configured; skipping`
          : `Restore drill: no images in ${dir}; skipping`
      );
      return;
    }
    const drillSource = picked.path;
    if (cloudStore) {
      try {
        logger.info(`Restore drill: staging ${drillSource}…`);
        staged = await materializeImageFromCloud(drillSource, { store: cloudStore });
        logger.info(
          `Restore drill: staged ${staged.plan.files.length} file(s), ${(staged.plan.totalBytes / 1024 ** 3).toFixed(1)} GiB`
        );
      } catch (error) {
        logger.error(`Restore drill could not stage ${drillSource}:`, error);
        return;
      }
    }
    const imagePath = staged ? staged.imagePath : drillSource;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-drill-'));
    const configPath = path.join(tmpDir, 'drill.json');
    const outPath = path.join(tmpDir, 'result.json');
    try {
      const summary = summarizeImage(imagePath);
      const drillConfig = {
        kind: 'restore-drill',
        imagePath,
        targetDiskIndex: config.targetDiskIndex,
        targetPartitions: summary.partitions.map((p) => p.index),
        verifyBeforeWrite: config.verifyBeforeWrite !== false,
        applyDeltas: true,
        compressionThreads: 0,
        ...(picked.encrypted && config.passphrase ? { passphrase: config.passphrase } : {})
      };
      fs.writeFileSync(configPath, JSON.stringify(drillConfig));

      const args: string[] = [];
      const app = electronApp();
      if (app?.isPackaged) {
        args.push('--cli', 'drill', configPath, '--elevated', '--json', '--json-out', outPath);
      } else {
        args.push(
          app ? app.getAppPath() : process.cwd(),
          '--cli',
          'drill',
          configPath,
          '--elevated',
          '--json',
          '--json-out',
          outPath
        );
      }

      const child = spawn(process.execPath, args, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      child.on('error', (error) => {
        logger.error(`Restore drill could not start:`, error);
      });
      child.on('close', async () => {
        try {
          if (!fs.existsSync(outPath)) {
            logger.error('Restore drill produced no result');
            return;
          }
          const result = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
            ok: boolean;
            restored: boolean;
            validated: boolean;
            failures: string[];
            imagePath: string;
            fsValidation?: Array<{ partitionIndex: number; label: string; ok: boolean; error?: string }>;
            durationMs: number;
          };

          // Report against the ORIGINAL image (path or cloud URI), never the
          // staged temp path — the temp dir is removed just below.
          if (!result.ok || !result.validated) {
            const reasons =
              result.failures?.join('; ') || (result.ok ? 'filesystem validation failed' : 'restore failed');
            logger.warn(`Restore drill FAILED for ${drillSource}: ${reasons}`);
            recordDrillResult(drillSource, { ok: false, failures: result.failures ?? [], targetDiskIndex: config.targetDiskIndex, durationMs: result.durationMs });

            this.drillFailures.record(false);
            if (config.notifyOnFailure && this.drillFailures.shouldAlert(config.alertAfter ?? 2)) {
              await this.notify('failure', path.basename(drillSource), dir, 0, reasons);
              this.drillFailures.reset();
            }
          } else {
            logger.info(`Restore drill PASSED for ${drillSource} (${result.fsValidation?.length ?? 0} partition(s) validated)`);
            recordDrillResult(drillSource, {
              ok: true,
              targetDiskIndex: config.targetDiskIndex,
              partitionsValidated: result.fsValidation?.length ?? 0,
              durationMs: result.durationMs
            });
            this.drillFailures.record(true);
            await this.notify('success', path.basename(drillSource), dir, 0);
          }
        } catch (error) {
          logger.error(`Restore drill result handling failed:`, error);
        } finally {
          try {
            fs.rmSync(configPath, { force: true });
            fs.rmSync(outPath, { force: true });
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
          // Only safe here: the child has exited, so nothing reads the staged
          // chain anymore.
          staged?.cleanup();
        }
      });
    } catch (error) {
      logger.error(`Restore drill setup failed for ${dir}:`, error);
      staged?.cleanup();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  /** Periodic migration drill: prove the newest image still yields a complete plan. */
  scheduleMigrateDrill(config: ScheduledMigrateDrill): boolean {
    const existing = this.tasks.get(MIGRATE_DRILL_TASK_ID);
    if (existing) {
      existing.stop();
      this.tasks.delete(MIGRATE_DRILL_TASK_ID);
    }

    if (!getCron().validate(config.cronExpression)) {
      logger.error(`Invalid cron expression for migration drill: ${config.cronExpression}`);
      return false;
    }

    const task = getCron().schedule(config.cronExpression, () => {
      void this.runMigrateDrill(config);
    });
    this.tasks.set(MIGRATE_DRILL_TASK_ID, task);
    logger.info(`Migration drill scheduled at ${config.cronExpression} (profile ${config.profile})`);
    return true;
  }

  /**
   * Run a migration drill in a detached child (`--cli migrate plan --json-out`):
   * build a dry-run plan against the newest image's largest partition for the
   * configured profile. Nothing is ever written — the drill passes when the
   * plan builds cleanly (JSON produced, no refusals). Results land in
   * `opbs-migrate-drill-history.json` next to the image.
   */
  private async runMigrateDrill(config: ScheduledMigrateDrill): Promise<void> {
    const dir = config.destinationPath;
    let found: string | undefined;
    try {
      found = findNewestImage(dir);
    } catch (error) {
      logger.error(`Migration drill could not scan ${dir}:`, error);
      return;
    }
    if (!found) {
      logger.warn(`Migration drill: no images in ${dir}; skipping`);
      return;
    }
    const imagePath = found;
    let partitionIndex = 0;
    try {
      const partitions = summarizeImage(imagePath).partitions;
      if (partitions.length > 0) {
        // The Windows volume is the largest partition in an OPBS disk image.
        partitionIndex = partitions.reduce((best, p, i) => (p.size > partitions[best].size ? i : best), 0);
      }
    } catch (error) {
      logger.error(`Migration drill could not read ${imagePath}:`, error);
      return;
    }

    const started = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opbs-migrate-drill-'));
    const outPath = path.join(tmpDir, 'plan.json');
    const args = buildMigrateArgs({
      action: 'plan',
      source: { imagePath, partitionIndex },
      profile: config.profile
    });
    args.push('--json-out', outPath);
    if (config.passphrase) {
      // Same convention as the wizard runner: the secret travels in a
      // short-lived file, never on argv (other processes read argv).
      try {
        const passFile = path.join(tmpDir, 'passphrase.txt');
        fs.writeFileSync(passFile, config.passphrase, { encoding: 'utf-8', mode: 0o600 });
        args.push(`--passphrase-file=${passFile}`);
      } catch (error) {
        logger.warn(`Migration drill could not stage the passphrase file: ${error}`);
      }
    }

    const app = electronApp();
    if (!app?.isPackaged) args.unshift(app ? app.getAppPath() : process.cwd());

    const child = spawn(process.execPath, args, {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    child.on('error', (error) => {
      logger.error(`Migration drill could not start:`, error);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    child.on('close', async () => {
      try {
        let plan: {
          planHash?: string;
          totalItems?: number;
          totalBytes?: number;
          stores?: unknown[];
          refusals?: Array<{ reason: string; detail: string }>;
        } | null = null;
        try {
          plan = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        } catch {
          plan = null;
        }
        const refusals = plan?.refusals ?? [];
        const ok = !!plan && refusals.length === 0;
        const errorDetail = ok
          ? undefined
          : !plan
            ? 'migrate plan produced no result (child exited without JSON)'
            : refusals.map((r) => `[${r.reason}] ${r.detail}`).join('; ');
        recordMigrateDrillResult(imagePath, {
          ok,
          profile: config.profile,
          ...(plan?.planHash ? { planHash: plan.planHash } : {}),
          plannedFiles: plan?.totalItems,
          plannedBytes: plan?.totalBytes,
          storesMatched: plan?.stores?.length ?? 0,
          refusals: refusals.length,
          durationMs: Date.now() - started,
          ...(errorDetail ? { error: errorDetail } : {})
        });
        if (ok) {
          logger.info(
            `Migration drill PASSED for ${path.basename(imagePath)} ` +
              `(${plan?.totalItems} file(s) planned, ${plan?.stores?.length ?? 0} store(s) matched)`
          );
        } else {
          logger.warn(`Migration drill FAILED for ${path.basename(imagePath)}: ${errorDetail}`);
        }

        this.migrateDrillFailures.record(ok);
        if (!ok && config.notifyOnFailure && this.migrateDrillFailures.shouldAlert(config.alertAfter ?? 2)) {
          await tryNotify(
            {
              title: 'OPBS migration drill FAILED',
              body: `Migration plan drill for ${path.basename(imagePath)} failed: ${errorDetail}`,
              severity: 'error'
            },
            this.settingsManager.getSettings().notifications.webhookUrl || ''
          );
          this.migrateDrillFailures.reset();
        }
      } catch (error) {
        logger.error(`Migration drill result handling failed:`, error);
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });
  }

  /**
   * Run verification in a detached child process (`--cli verify --dir ...`).
   * This keeps the UI responsive for large images and works even if the app
   * closes before the child finishes. No elevation or UAC is required.
   */
  private async runScheduledVerification(config: ScheduledVerification): Promise<void> {
    await this.runVerify(config.destinationPath, config.scope, {
      label: 'Scheduled verification',
      notifyOnFailure: config.notifyOnFailure,
      alertAfter: config.alertAfter ?? 2,
      prune: true
    });
  }

  /** Shared verify runner used by scheduled verification and idle scrub. */
  private runVerify(
    destinationPath: string,
    scope: 'newest' | 'all',
    opts: { label: string; notifyOnFailure: boolean; alertAfter: number; prune: boolean }
  ): Promise<void> {
    const outPath = path.join(os.tmpdir(), `opbs-verify-${Date.now()}.json`);

    const args: string[] = [];
    const app = electronApp();
    if (app?.isPackaged) {
      args.push('--cli', 'verify', '--dir', destinationPath, '--scope', scope, '--json', '--json-out', outPath);
    } else {
      args.push(app ? app.getAppPath() : process.cwd(), '--cli', 'verify', '--dir', destinationPath, '--scope', scope, '--json', '--json-out', outPath);
    }

    return new Promise<void>((resolve) => {
      const child = spawn(process.execPath, args, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      child.on('error', (error) => {
        logger.error(`${opts.label} could not start:`, error);
        resolve();
      });

      child.on('close', async () => {
        try {
          if (!fs.existsSync(outPath)) {
            logger.error(`${opts.label} produced no result`);
            return;
          }
          const result = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
            ok: boolean;
            verified: number;
            failed: number;
            skippedEncrypted: number;
          };
          logger.info(
            `${opts.label} finished: ${result.verified} ok, ${result.failed} failed, ${result.skippedEncrypted} skipped (encrypted)`
          );

          // Alert only after `alertAfter` consecutive failures so transient blips
          // don't spam, but a persistent problem is surfaced.
          if (result.failed > 0) {
            this.verifyFailures.record(false);
            if (opts.notifyOnFailure && this.verifyFailures.shouldAlert(opts.alertAfter)) {
              const settings = this.settingsManager.getSettings();
              const body = `${result.failed} image(s) failed verification in ${destinationPath}. Restore may be impossible.`;
              broadcastActivity({
                kind: 'failure',
                title: 'OPBS verification FAILED',
                body,
                backupName: opts.label,
                bytesWritten: 0,
                destinationPath,
                error: body,
                timestamp: new Date().toISOString()
              });
              await tryNotify(
                {
                  title: 'OPBS verification FAILED',
                  body,
                  severity: 'error'
                },
                settings.notifications.webhookUrl || ''
              );
              this.verifyFailures.reset();
            }
          } else {
            this.verifyFailures.record(true);
          }

          // Self-healing: prune images that exceed retention when auto-cleanup is
          // enabled, so stale/old chains don't accumulate.
          if (opts.prune) {
            const settings = this.settingsManager.getSettings();
            if (settings.autoCleanup) {
              try {
                const plan = await applyRetention(destinationPath, {
                  keepFull: settings.keepFull,
                  keepDeltasPerFull: settings.keepDeltasPerFull,
                  retentionDays: settings.retentionDays
                });
                if (plan.prune.length > 0) {
                  logger.info(`${opts.label} pruned ${plan.prune.length} old image(s) from ${destinationPath}`);
                }
              } catch (error) {
                logger.error(`${opts.label} retention prune failed:`, error);
              }
            }
          }
        } catch (error) {
          logger.error(`${opts.label} result handling failed:`, error);
        } finally {
          try {
            fs.rmSync(outPath, { force: true });
          } catch {
            /* best-effort */
          }
          resolve();
        }
      });
    });
  }

  /**
   * Self-healing scrub in a detached child (`--cli scrub --dir ... --repair`):
   * read back every block, rebuild corrupted blocks from `.opar` parity, and
   * alert only after `alertAfter` consecutive runs that still fail.
   */
  runScrub(
    destinationPath: string,
    scope: 'newest' | 'all',
    opts: { label: string; notifyOnFailure: boolean; alertAfter: number }
  ): Promise<void> {
    const outPath = path.join(os.tmpdir(), `opbs-scrub-${Date.now()}.json`);

    const args: string[] = [];
    const app = electronApp();
    if (app?.isPackaged) {
      args.push('--cli', 'scrub', '--dir', destinationPath, '--scope', scope, '--repair', '--json', '--json-out', outPath);
    } else {
      args.push(
        app ? app.getAppPath() : process.cwd(),
        '--cli', 'scrub', '--dir', destinationPath, '--scope', scope, '--repair', '--json', '--json-out', outPath
      );
    }

    return new Promise<void>((resolve) => {
      const child = spawn(process.execPath, args, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      child.on('error', (error) => {
        logger.error(`${opts.label} could not start:`, error);
        resolve();
      });

      child.on('close', async () => {
        try {
          if (!fs.existsSync(outPath)) {
            logger.error(`${opts.label} produced no result`);
            return;
          }
          const result = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as {
            ok: boolean;
            checked: number;
            failed: number;
            skippedEncrypted: number;
            repairedBlocks: number;
          };
          if (result.repairedBlocks > 0) {
            logger.info(
              `${opts.label} self-healed ${result.repairedBlocks} block(s) from parity in ${destinationPath}`
            );
          }
          logger.info(
            `${opts.label} finished: ${result.checked} checked, ${result.failed} still failing, ` +
              `${result.repairedBlocks} repaired, ${result.skippedEncrypted} skipped (encrypted)`
          );

          if (result.failed > 0) {
            this.scrubFailures.record(false);
            if (opts.notifyOnFailure && this.scrubFailures.shouldAlert(opts.alertAfter)) {
              const settings = this.settingsManager.getSettings();
              const body = `${result.failed} image(s) still failed scrub in ${destinationPath} ` +
                `after ${result.repairedBlocks} parity repair(s). Restore may be impossible.`;
              broadcastActivity({
                kind: 'failure',
                title: 'OPBS scrub FAILED',
                body,
                backupName: opts.label,
                bytesWritten: 0,
                destinationPath,
                error: body,
                timestamp: new Date().toISOString()
              });
              await tryNotify(
                {
                  title: 'OPBS scrub FAILED',
                  body,
                  severity: 'error'
                },
                settings.notifications.webhookUrl || ''
              );
              this.scrubFailures.reset();
            }
          } else {
            this.scrubFailures.record(true);
          }
        } catch (error) {
          logger.error(`${opts.label} result handling failed:`, error);
        } finally {
          try {
            fs.rmSync(outPath, { force: true });
          } catch {
            /* best-effort */
          }
          resolve();
        }
      });
    });
  }

  resyncFromSettings(): void {
    this.stopAll();
    this.startAll();
  }

  private async runBackup(config: ScheduledBackup): Promise<void> {
    logger.info(`Running scheduled backup: ${config.name}`);

    const settings = this.settingsManager.getSettings();
    let baseImagePath: string | undefined;
    if (config.incremental) {
      baseImagePath = findNewestImage(config.destinationPath);
      if (baseImagePath) {
        logger.info(`Incremental scheduled backup targeting base ${baseImagePath}`);
      } else {
        logger.info('No existing image found; scheduled incremental backup falls back to a full backup');
      }
    }

    const backupConfig: BackupConfig = {
      sourceDiskIndex: config.sourceDiskIndex,
      sourcePartitions: config.sourcePartitions,
      destinationPath: config.destinationPath,
      compressionLevel: config.compressionLevel,
      compressionType: config.compressionType,
      compressionThreads: config.compressionThreads,
      verificationEnabled: config.verificationEnabled,
      ...(config.usedBlocksOnly ? { usedBlocksOnly: true } : {}),
      ...(config.useUsnJournal ? { useUsnJournal: true } : {}),
      ...(config.usnFullScanThreshold !== undefined
        ? { usnFullScanThreshold: config.usnFullScanThreshold }
        : {}),
      ...(baseImagePath ? { baseImagePath } : {}),
      ...(config.passphrase ? { passphrase: config.passphrase } : {})
    };

    try {
      const result = await this.backupManager.startBackup(backupConfig);

      // Auto-compact the just-backed-up chain before retention when the chain
      // reached the configured delta count: retention then sees a single-image
      // chain. Refusals (encrypted without passphrase, repository, …) are
      // logged and never fail the scheduled run.
      if (settings.compactAfterDeltas > 0) {
        try {
          const compacted = await compactAfterBackup({
            imagePath: result.imagePath,
            threshold: settings.compactAfterDeltas,
            passphrase: config.passphrase
          });
          if (compacted?.ok) {
            logger.info(
              `Auto-compact: chain flattened to ${compacted.outputPath} ` +
                `(${compacted.plan.members.length} member(s), remove-source)`
            );
          } else if (compacted) {
            logger.warn(`Auto-compact skipped for ${result.imagePath}: ${compacted.error}`);
          }
        } catch (error) {
          logger.warn(
            `Auto-compact failed for ${result.imagePath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Retention/GFS pruning after a successful run: either the global
      // auto-cleanup setting or a per-schedule retention policy.
      const retention = resolveScheduledRetention(config, settings);
      if (retention.active) {
        const plan = await applyRetention(config.destinationPath, retention.options);
        if (plan.prune.length > 0) {
          logger.info(`Retention pruned ${plan.prune.length} old image(s) from ${config.destinationPath}`);
        }
      }

      // Update last run time
      this.settingsManager.updateScheduledBackup(config.id, {
        lastRun: new Date().toISOString()
      });

      logger.info(`Scheduled backup ${config.name} completed (${result.bytesWritten} bytes)`);
      this.retries.delete(config.id);
      await this.notify('success', config.name, config.destinationPath, result.bytesWritten);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Scheduled backup ${config.name} failed`, error);

      // Exponential retry with backoff. Each failure schedules another attempt
      // (delay doubles per attempt); only the final failure alerts.
      const maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 2));
      const baseDelayMs = Math.max(1, config.retryDelayMinutes ?? 5) * 60_000;
      const state = this.retries.get(config.id) ?? { attempt: 0 };
      if (state.attempt < maxRetries) {
        state.attempt += 1;
        const delayMs = baseDelayMs * 2 ** (state.attempt - 1);
        logger.warn(
          `${config.name} failed (${message}); retry ${state.attempt}/${maxRetries} in ${(delayMs / 60000).toFixed(1)} min`
        );
        broadcastActivity({
          kind: 'failure',
          title: 'OPBS scheduled backup retrying',
          body: `${config.name} failed and will be retried (${state.attempt}/${maxRetries}) in ${(delayMs / 60000).toFixed(1)} min: ${message}`,
          backupName: config.name,
          bytesWritten: 0,
          destinationPath: config.destinationPath,
          error: message,
          timestamp: new Date().toISOString()
        });
        state.timer = setTimeout(() => {
          if (state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
          }
          void this.runBackup(config);
        }, delayMs);
        this.retries.set(config.id, state);
        return;
      }
      this.retries.delete(config.id);
      await this.notify('failure', config.name, config.destinationPath, 0, message);
    }
  }

  private async notify(
    kind: 'success' | 'failure',
    backupName: string,
    destinationPath: string,
    bytesWritten: number,
    error?: string
  ): Promise<void> {
    // Always surface scheduled activity in the app UI independent of the
    // OS/webhook notification preferences.
    const title = kind === 'success' ? 'OPBS completed' : 'OPBS failed';
    const body =
      kind === 'success'
        ? `${backupName} finished writing ${(bytesWritten / 1024 / 1024).toFixed(1)} MB to ${destinationPath}`
        : `${backupName} failed: ${error}`;
    broadcastActivity({
      kind,
      title,
      body,
      backupName,
      bytesWritten,
      destinationPath,
      error,
      timestamp: new Date().toISOString()
    });

    const settings = this.settingsManager.getSettings();
    const notif = settings.notifications;
    if (!notif.enabled) {
      return;
    }
    if (kind === 'failure' && !notif.notifyOnFailure) {
      return;
    }
    if (kind === 'success' && !notif.notifyOnSuccess) {
      return;
    }

    await tryNotify({ title, body, severity: kind === 'success' ? 'success' : 'error' }, notif.webhookUrl || '');
  }
}
