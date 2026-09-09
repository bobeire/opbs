import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
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
  /** Run as SYSTEM: no UAC prompt, runs without an interactive logon. */
  asSystem?: boolean;
  /** Run level for user tasks. Defaults to 'high' (runs elevated, no prompt).
   *  'user' creates a non-elevated task that can be registered without admin. */
  runLevel?: 'high' | 'user';
  overwrite?: boolean;
}

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
    args.push('/SC', 'DAILY', '/ST', options.time ?? '02:00');
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
    const psArgv = args
      .map((a) => `'${a.replace(/'/g, "''")}'`)
      .join(', ');
    const script =
      `$p = Start-Process -FilePath '${schtasksExe}' -ArgumentList @(${psArgv}) ` +
      `-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
    const child = spawn(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('close', (code) => {
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