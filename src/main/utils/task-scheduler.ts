import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

// Resolve schtasks.exe via System32: PATH may not include System32 in some
// shells (e.g. spawned from a dev build), which breaks execFile resolution.
const schtasksExe = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'schtasks.exe')
  : 'schtasks';

const powershellExe = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

export interface ScheduledTaskOptions {
  /** 24h HH:MM start time for daily tasks (ignored with onLogin). */
  time?: string;
  onLogin?: boolean;
  /** Schedule type: daily (default), weekly, or monthly. */
  scheduleType?: 'daily' | 'weekly' | 'monthly';
  /** For weekly: day-of-week names (e.g. ['MON','WED','FRI']).
   *  For monthly: day-of-month number (e.g. 15). */
  scheduleDays?: string[] | number;
  /** Run as SYSTEM: no UAC prompt, runs without an interactive logon. */
  asSystem?: boolean;
  /** Run level for user tasks. Defaults to 'high' (runs elevated, no prompt).
   *  'user' creates a non-elevated task that can be registered without admin. */
  runLevel?: 'high' | 'user';
  overwrite?: boolean;
}

export const UNATTENDED_TASK_PREFIX = 'OPBS Backup';

export interface ScheduledTaskInfo {
  name: string;
  nextRun: string;
  status: string;
  runAs: string;
}

/**
 * Build the schtasks.exe arguments for creating a task that launches
 * `commandLine` (a single quoted command-with-args string).
 */
export function buildSchTasksArgs(
  name: string,
  commandLine: string,
  options: ScheduledTaskOptions = {}
): string[] {
  const args = [
    '/Create',
    '/TN',
    name,
    '/TR',
    `"${commandLine}"`,
    ...(options.overwrite === false ? [] : ['/F'])
  ];

  if (options.onLogin) {
    args.push('/SC', 'ONLOGON');
  } else {
    const st = options.scheduleType ?? 'daily';
    const time = options.time ?? '02:00';
    if (st === 'weekly') {
      args.push('/SC', 'WEEKLY', '/ST', time);
      if (options.scheduleDays && Array.isArray(options.scheduleDays)) {
        args.push('/D', options.scheduleDays.join(','));
      }
    } else if (st === 'monthly') {
      args.push('/SC', 'MONTHLY', '/ST', time);
      if (options.scheduleDays !== undefined && typeof options.scheduleDays === 'number') {
        args.push('/D', String(options.scheduleDays));
      }
    } else {
      args.push('/SC', 'DAILY', '/ST', time);
    }
  }

  if (options.asSystem) {
    args.push('/RU', 'SYSTEM');
  } else if (options.runLevel === 'user') {
    // Task runs as the logged-on user without elevation; fine for verify
    // tasks that only read files. Registerable without admin rights.
  } else {
    // Highest available run level: the task itself runs elevated, so the
    // CLI helper no longer needs an interactive UAC prompt.
    args.push('/RL', 'HIGHEST');
  }

  return args;
}

function runSchTasks(args: string[]): Promise<string> {
  return execFileAsync(schtasksExe, args, { windowsHide: true, timeout: 25_000 }).then((r) => r.stdout);
}

function runSchTasksElevated(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write args to a response file to avoid PowerShell quoting hell.
    const argFile = path.join(os.tmpdir(), `opbs-schtasks-${Date.now()}.args`);
    fs.writeFileSync(argFile, args.join('\r\n'));
    const script = `
      $args = Get-Content '${argFile.replace(/'/g, "''")}'
      $p = Start-Process -FilePath '${schtasksExe}' -ArgumentList $args `
      + `-Verb RunAs -WindowStyle Hidden -Wait -PassThru
      Remove-Item '${argFile.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
      exit $p.ExitCode`;
    const child = spawn(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try { fs.unlinkSync(argFile); } catch { /* already cleaned */ }
      if (code === 0) {
        resolve('');
      } else {
        reject(new Error(`Elevated schtasks exited with code ${code}`));
      }
    });
  });
}

async function runSchTasksWithElevatedFallback(args: string[]): Promise<string> {
  try {
    return await runSchTasks(args);
  } catch (error) {
    logger.info('Direct schtasks call failed, retrying elevated:', error);
    await runSchTasksElevated(args);
    return 'Created elevated task';
  }
}

/**
 * Register a scheduled task. Registration itself may need elevation once (the
 * UAC prompt appears at install time, not at every task run). At run time the
 * task is already elevated, so the CLI helper runs without a UAC prompt.
 */
export async function registerScheduledTask(
  name: string,
  commandLine: string,
  options: ScheduledTaskOptions = {}
): Promise<string> {
  const args = buildSchTasksArgs(name, commandLine, options);
  const output = await runSchTasksWithElevatedFallback(args);
  logger.info(`Registered scheduled task ${name}`);
  return output;
}

export async function removeScheduledTask(name: string): Promise<string> {
  const args = ['/Delete', '/TN', name, '/F'];
  const output = await runSchTasksWithElevatedFallback(args);
  logger.info(`Removed scheduled task ${name}`);
  return output;
}

export interface ScheduledTaskStatus {
  name: string;
  status: string;
  lastRun: string;
  lastResult: string;
  nextRun: string;
  taskToRun: string;
}

export async function getTaskStatus(name: string): Promise<ScheduledTaskStatus | null> {
  try {
    const { stdout } = await execFileAsync(
      schtasksExe,
      ['/Query', '/TN', name, '/FO', 'LIST', '/V'],
      { windowsHide: true, timeout: 25_000 }
    );
    const fields: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        fields[key] = val;
      }
    }
    return {
      name: fields['TaskName'] ?? name,
      status: fields['Status'] ?? 'Unknown',
      lastRun: fields['Last Run Time'] ?? 'N/A',
      lastResult: fields['Last Result'] ?? 'N/A',
      nextRun: fields['Next Run Time'] ?? 'N/A',
      taskToRun: fields['Task To Run'] ?? ''
    };
  } catch {
    return null;
  }
}

export async function listScheduledTasks(): Promise<ScheduledTaskInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      schtasksExe,
      ['/Query', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 25_000 }
    );
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.map(parseCsvLine).filter((t): t is ScheduledTaskInfo => t !== null);
  } catch (error) {
    logger.warn(`Failed to list scheduled tasks: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// OPBS Helper task: a persistent Windows scheduled task that runs the helper
// binary elevated (as the current user, /RL HIGHEST) without a UAC prompt.
// Registered once on first backup; triggered via schtasks /run for each job.
// ---------------------------------------------------------------------------

const HELPER_TASK_NAME = 'OPBS Helper';

/**
 * Check whether the OPBS Helper task is already registered.
 */
export async function isHelperTaskRegistered(): Promise<boolean> {
  try {
    await runSchTasks(['/Query', '/TN', HELPER_TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the OPBS Helper task if it doesn't already exist.  The task is
 * dormant (/SC ONCE at midnight, never auto-fires) and is only triggered
 * on-demand via `triggerHelperTask`.  Registration may trigger a one-time UAC
 * prompt (acceptable — it happens once per machine, not per backup).
 */
export async function ensureHelperTaskRegistered(exePath: string, appPath?: string): Promise<void> {
  if (await isHelperTaskRegistered()) {
    return;
  }
  // The command line will be overwritten by changeHelperTaskCommand before
  // each run, but schtasks requires /TR at creation time — use a placeholder.
  const placeholderArgs = appPath
    ? `"${appPath}" --opbs-helper "" "" "" ""`
    : `--opbs-helper "" "" "" ""`;
  const commandLine = `"${exePath}" ${placeholderArgs}`;
  await registerScheduledTask(HELPER_TASK_NAME, commandLine, {
    onLogin: false,
    time: '00:00',
    runLevel: 'high',
    overwrite: true
  });
  logger.info(`Registered helper task: ${commandLine}`);
}

/**
 * Overwrite the helper task's command line so it picks up the right temp-file
 * paths for the current job, then trigger the task.  No UAC prompt.
 */
export async function triggerHelperTask(
  exePath: string,
  jobPath: string,
  resultPath: string,
  progressPath: string,
  cancelPath: string,
  appPath?: string,
  pipeName?: string
): Promise<void> {
  const helperArgs = `--opbs-helper "${jobPath}" "${resultPath}" "${progressPath}" "${cancelPath}"${pipeName ? ` --pipe "${pipeName}"` : ''}`;
  const args = appPath
    ? `"${appPath}" ${helperArgs}`
    : helperArgs;
  const commandLine = `"${exePath}" ${args}`;

  // Overwrite the task's action with the current job paths.
  await runSchTasks([
    '/Change',
    '/TN', HELPER_TASK_NAME,
    '/TR', commandLine
  ]);

  // Trigger the task — runs elevated, no UAC.
  await runSchTasks(['/Run', '/TN', HELPER_TASK_NAME]);
}

// ---------------------------------------------------------------------------
// Unattended backup tasks: per-schedule Windows Task Scheduler entries that
// run `opbs --cli backup <config.json> --elevated` on a cron-like cadence.
// ---------------------------------------------------------------------------

function getUnattendedTaskDir(): string {
  const dir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'opbs', 'tasks'
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function taskNameForSchedule(scheduleId: string): string {
  return `${UNATTENDED_TASK_PREFIX} ${scheduleId}`;
}

/**
 * Write a job-config JSON for the given schedule and register a Windows
 * scheduled task.  When `incremental` is true the config is written WITHOUT
 * a `baseImagePath` — the CLI resolves the newest image at run time via
 * `findNewestImage()` so each run picks up the latest full+delta chain.
 */
export async function registerUnattendedBackupTask(
  scheduleId: string,
  schedule: {
    cronExpression: string;
    sourceDiskIndex: number;
    sourcePartitions: number[];
    destinationPath: string;
    compressionLevel: number;
    compressionType?: string;
    compressionThreads?: number;
    verificationEnabled: boolean;
    incremental: boolean;
    passphrase?: string;
  }
): Promise<void> {
  const taskDir = getUnattendedTaskDir();
  const configPath = path.join(taskDir, `${scheduleId}.json`);

  // Build the config the CLI backup command will read.
  const config: Record<string, unknown> = {
    sourceDiskIndex: schedule.sourceDiskIndex,
    sourcePartitions: schedule.sourcePartitions,
    destinationPath: schedule.destinationPath,
    compressionLevel: schedule.compressionLevel,
    compressionType: schedule.compressionType ?? 'zstd',
    compressionThreads: schedule.compressionThreads ?? 1,
    verificationEnabled: schedule.verificationEnabled,
    incremental: schedule.incremental,
    // For incremental: omit baseImagePath — the CLI resolves it dynamically
    // via findNewestImage() so each run picks the latest chain.
  };
  if (schedule.passphrase) {
    config.passphrase = schedule.passphrase;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Determine schedule type + days from the cron expression.
  const cronParts = schedule.cronExpression.split(/\s+/);
  const time = `${cronParts[1].padStart(2, '0')}:${cronParts[0].padStart(2, '0')}`;
  let scheduleType: 'daily' | 'weekly' | 'monthly' = 'daily';
  let scheduleDays: string[] | number | undefined;

  if (cronParts[4] && cronParts[4] !== '*') {
    // Day-of-week field is set → weekly
    scheduleType = 'weekly';
    const dowMap = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    scheduleDays = cronParts[4].split(',').map((d) => dowMap[parseInt(d, 10)] ?? d);
  } else if (cronParts[2] && cronParts[2] !== '*') {
    // Day-of-month field is set → monthly
    scheduleType = 'monthly';
    scheduleDays = parseInt(cronParts[2], 10);
  }

  const exe = process.execPath;
  const appArg = app && !app.isPackaged ? `"${app.getAppPath()}" ` : '';
  const commandLine = `"${exe}" ${appArg}--cli backup "${configPath}" --elevated`;

  await registerScheduledTask(taskNameForSchedule(scheduleId), commandLine, {
    time,
    scheduleType,
    scheduleDays,
    runLevel: 'high',
    overwrite: true
  });

  logger.info(`Registered unattended backup task for schedule ${scheduleId}: ${commandLine}`);
}

export async function unregisterUnattendedBackupTask(scheduleId: string): Promise<void> {
  const name = taskNameForSchedule(scheduleId);
  try {
    await removeScheduledTask(name);
  } catch {
    // Task may not exist — that's fine.
  }
  // Clean up the job-config file.
  const configPath = path.join(getUnattendedTaskDir(), `${scheduleId}.json`);
  try {
    fs.unlinkSync(configPath);
  } catch {
    /* already gone */
  }
  logger.info(`Unregistered unattended backup task for schedule ${scheduleId}`);
}

export async function listUnattendedBackupTasks(): Promise<string[]> {
  const tasks = await listScheduledTasks();
  return tasks
    .filter((t) => t.name.startsWith(UNATTENDED_TASK_PREFIX))
    .map((t) => t.name.slice(UNATTENDED_TASK_PREFIX.length + 1));
}

function parseCsvLine(line: string): ScheduledTaskInfo | null {
  // Default non-verbose CSV has 3 columns (name, next run, status); run-as
  // identity is unavailable without verbose mode, so it defaults to ''.
  const fields = line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
  if (fields.length < 3) {
    return null;
  }
  return {
    name: fields[0],
    nextRun: fields[1],
    status: fields[2],
    runAs: fields[4] ?? ''
  };
}