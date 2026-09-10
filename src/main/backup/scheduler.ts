import type { ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupManager, BackupConfig } from '../backup/manager';
import { ScheduledBackup, ScheduledVerification, SettingsManager } from '../utils/settings-manager';
import { applyRetention, findNewestImage } from './retention';
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

    if (settings.scrubWhileIdle && settings.backupLocation) {
      this.scheduleScrub(settings.scrubIntervalHours);
    }

    logger.info(`Scheduler started with ${this.tasks.size} tasks`);
  }

  stopAll(): void {
    this.tasks.forEach((task) => task.stop());
    this.tasks.clear();
    logger.info('Scheduler stopped');
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
      void this.runVerify(settings.backupLocation, 'newest', {
        label: 'Idle scrub',
        notifyOnFailure: true,
        alertAfter: 2,
        prune: true
      });
    });
    this.tasks.set(SCRUB_TASK_ID, task);
    logger.info(`Idle scrub scheduled every ${everyMinutes} minutes`);
    return true;
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
      await this.notify('success', config.name, config.destinationPath, result.bytesWritten);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Scheduled backup ${config.name} failed`, error);
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
