import type { ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupManager, BackupConfig } from '../backup/manager';
import { ScheduledBackup, ScheduledVerification, ScheduledRestoreDrill, ScheduledScrub, SettingsManager } from '../utils/settings-manager';
import { applyRetention, findNewestImage, scanBackupDirectory } from './retention';
import { summarizeImage } from '../imaging/restore-engine';
import { recordDrillResult } from '../utils/drill-history';
import { tryNotify } from '../utils/notify';
import { ConsecutiveFailureTracker } from '../utils/failure-tracker';
import { logger } from '../utils/logger';

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

    if (settings.scrubWhileIdle && settings.backupLocation) {
      this.scheduleScrub(settings.scrubIntervalHours);
    }

    if (settings.scheduledScrub.enabled && settings.scheduledScrub.destinationPath) {
      this.scheduleConfiguredScrub(settings.scheduledScrub);
    }

    logger.info(`Scheduler started with ${this.tasks.size} tasks`);
  }

  stopAll(): void {
    this.tasks.forEach((task) => task.stop());
    this.tasks.clear();
    this.clearRetries();
    logger.info('Scheduler stopped');
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

  /** Newest unencrypted image in a directory (a delta drills as its full chain). */
  private pickDrillImage(dir: string): string | undefined {
    const entries = scanBackupDirectory(dir).filter((entry) => !entry.encrypted);
    if (entries.length === 0) {
      return undefined;
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries[0].path;
  }

  /**
   * Run a restore drill in a detached child (`--cli drill <config> --elevated`).
   * Restores the newest unencrypted image (with deltas) to the configured
   * scratch disk, then reads the written filesystems back and validates them.
   * Encrypted images are skipped — a drill cannot supply a passphrase.
   */
  private async runDrill(config: ScheduledRestoreDrill): Promise<void> {
    const dir = config.destinationPath;
    const imagePath = this.pickDrillImage(dir);
    if (!imagePath) {
      logger.warn(`Restore drill: no unencrypted images in ${dir}; skipping`);
      return;
    }

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
        compressionThreads: 0
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

          if (!result.ok || !result.validated) {
            const reasons =
              result.failures?.join('; ') || (result.ok ? 'filesystem validation failed' : 'restore failed');
            logger.warn(`Restore drill FAILED for ${result.imagePath}: ${reasons}`);
            recordDrillResult(result.imagePath, { ok: false, failures: result.failures ?? [], targetDiskIndex: config.targetDiskIndex, durationMs: result.durationMs });

            this.drillFailures.record(false);
            if (config.notifyOnFailure && this.drillFailures.shouldAlert(config.alertAfter ?? 2)) {
              await this.notify('failure', path.basename(result.imagePath), dir, 0, reasons);
              this.drillFailures.reset();
            }
          } else {
            logger.info(`Restore drill PASSED for ${result.imagePath} (${result.fsValidation?.length ?? 0} partition(s) validated)`);
            recordDrillResult(result.imagePath, {
              ok: true,
              targetDiskIndex: config.targetDiskIndex,
              partitionsValidated: result.fsValidation?.length ?? 0,
              durationMs: result.durationMs
            });
            this.drillFailures.record(true);
            await this.notify('success', path.basename(result.imagePath), dir, 0);
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
        }
      });
    } catch (error) {
      logger.error(`Restore drill setup failed for ${dir}:`, error);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
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
      ...(baseImagePath ? { baseImagePath } : {}),
      ...(config.passphrase ? { passphrase: config.passphrase } : {})
    };

    try {
      const result = await this.backupManager.startBackup(backupConfig);

      // Retention/GFS pruning after a successful run when enabled.
      if (settings.autoCleanup) {
        const plan = await applyRetention(config.destinationPath, {
          keepFull: settings.keepFull,
          keepDeltasPerFull: settings.keepDeltasPerFull,
          retentionDays: settings.retentionDays
        });
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
