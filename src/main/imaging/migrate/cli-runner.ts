import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Source selector accepted by the `migrate` CLI (live machine or image partition). */
export interface MigrateCliSource {
  live?: boolean;
  liveRoot?: string;
  imagePath?: string;
  partitionIndex?: number;
  /** Passed to the child as a short-lived `--passphrase-file`, never on argv. */
  passphrase?: string;
}

export interface MigrateCliRequest {
  action: 'plan' | 'run';
  source: MigrateCliSource;
  profile: string;
  target?: string;
  folders?: string[];
  appsDbPath?: string;
  planHash?: string;
  execute?: boolean;
  registry?: boolean;
  noOwner?: boolean;
  merge?: boolean;
  resume?: boolean;
  noVerify?: boolean;
}

/**
 * Build the argv for a `migrate plan|run` child process.
 *
 * Conventions the CLI's parser requires:
 *  - the image path is positional and must be the first non-flag token
 *    after the verb;
 *  - `--passphrase` is never used (its value is not in the positional
 *    exclusion list); the runner hands secrets over via `--passphrase-file`
 *    instead, so nothing sensitive lands in a process list;
 *  - `--folder` must be spaced (the CLI reads it with strict equality);
 *    all other value flags use the spaced form the parser's exclusion list
 *    covers.
 */
export function buildMigrateArgs(req: MigrateCliRequest): string[] {
  const args: string[] = ['--cli', 'migrate', req.action];
  if (req.source.live) {
    args.push('--live');
    if (req.source.liveRoot) args.push('--live-root', req.source.liveRoot);
  } else if (req.source.imagePath) {
    args.push(req.source.imagePath);
    args.push('--partition', String(req.source.partitionIndex ?? 0));
  }
  args.push('--profile', req.profile);
  if (req.target) args.push('--target', req.target);
  for (const folder of req.folders ?? []) args.push('--folder', folder);
  if (req.appsDbPath) args.push('--apps-db', req.appsDbPath);
  if (req.action === 'run') {
    if (req.execute) args.push('--execute');
    if (req.planHash) args.push('--plan-hash', req.planHash);
    if (req.registry) args.push('--registry');
    if (req.noOwner) args.push('--no-owner');
    if (req.merge) args.push('--merge');
    if (req.resume) args.push('--resume');
    if (req.noVerify) args.push('--no-verify');
  }
  args.push('--json');
  return args;
}

export interface MigrateCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
}

let currentChild: ChildProcess | null = null;
const cancelledChildren = new WeakSet<ChildProcess>();

/** True while a plan/run child spawned by this module is still alive. */
export function isMigrateCliBusy(): boolean {
  return currentChild !== null;
}

/** Kill the running plan/run child (Windows: TerminateProcess). */
export function cancelMigrateCli(): boolean {
  const child = currentChild;
  if (!child) return false;
  cancelledChildren.add(child);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  return true;
}

function appArgvPrefix(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { isPackaged: boolean; getAppPath: () => string } };
    const app = electron.app;
    if (app?.isPackaged) return [];
    return [app?.getAppPath() ?? process.cwd()];
  } catch {
    return [process.cwd()];
  }
}

function attachLineStream(
  stream: NodeJS.ReadableStream | null,
  sink: string[],
  onLine?: (line: string) => void
): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  let partial = '';
  stream.on('data', (chunk: string) => {
    sink.push(chunk);
    if (!onLine) return;
    const parts = (partial + chunk).split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const line of parts) {
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    if (onLine && partial) onLine(partial);
  });
}

/**
 * Run `migrate plan|run` in a child process (executePlan is synchronous — it
 * must never block the Electron main loop) and collect its output.
 *
 * The passphrase, when present, is handed to the child through a short-lived
 * temp file (`--passphrase-file`) deleted as soon as the child exits.
 */
export function runMigrateCli(
  req: MigrateCliRequest,
  opts: {
    /** CLI writes its JSON result here (clean parse, unlike stdout). */
    jsonOutPath?: string;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  } = {}
): Promise<MigrateCliResult> {
  if (currentChild) {
    return Promise.reject(new Error('Another migrate operation is already running'));
  }
  const args = buildMigrateArgs(req);
  let passFile: string | null = null;
  if (req.source.passphrase && !req.source.live) {
    passFile = path.join(os.tmpdir(), `opbs-migrate-pass-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(passFile, req.source.passphrase, { encoding: 'utf-8', mode: 0o600 });
    args.push(`--passphrase-file=${passFile}`);
  }
  if (opts.jsonOutPath) args.push('--json-out', opts.jsonOutPath);

  const child = spawn(process.execPath, [...appArgvPrefix(), ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  currentChild = child;

  const stdout: string[] = [];
  const stderr: string[] = [];
  attachLineStream(child.stdout, stdout, opts.onStdoutLine);
  attachLineStream(child.stderr, stderr, opts.onStderrLine);

  const cleanup = (): void => {
    if (currentChild === child) currentChild = null;
    if (passFile) {
      try {
        fs.rmSync(passFile, { force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  return new Promise<MigrateCliResult>((resolve, reject) => {
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      const cancelled = cancelledChildren.has(child);
      cleanup();
      resolve({ exitCode: code, stdout: stdout.join(''), stderr: stderr.join(''), cancelled });
    });
  });
}
