import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadNative } from '../utils/native-loader';
import {
  CORE_VSS_DLLS,
  VSS_SERVICE,
  normalizeVolumeRoot,
  parseScQuery,
  parseVssadminProviders,
  parseVssadminWriters,
  resolveSystem32Exe,
  VssJob,
  VssJobResult,
  VssProvider,
  VssRepairResult,
  VssWriter
} from '../utils/vss';

/**
 * Elevated VSS maintenance operations. This module only ever runs inside the
 * elevated helper process (relaunched through the UAC prompt by
 * launchElevatedJob), which is how it can create/delete shadow copies,
 * re-register the VSS DLLs and start/stop the vss service.
 */

const CMD_TIMEOUT_MS = 60000;

interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function run(cmd: string, args: string[]): CmdResult {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: CMD_TIMEOUT_MS });
    return { ok: true, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };
    const stderr = String(err?.stderr ?? '');
    return {
      ok: false,
      stdout: String(err?.stdout ?? ''),
      stderr,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function serviceState(): { state: string; running: boolean } {
  const query = run(resolveSystem32Exe('sc.exe'), ['query', VSS_SERVICE]);
  if (!query.ok) {
    return { state: 'UNKNOWN', running: false };
  }
  const parsed = parseScQuery(query.stdout);
  return { state: parsed.state, running: parsed.state === 'RUNNING' };
}

function runVssWriters(): VssJobResult {
  const writersResult = run(resolveSystem32Exe('vssadmin.exe'), ['list', 'writers']);
  const providersResult = run(resolveSystem32Exe('vssadmin.exe'), ['list', 'providers']);
  const writers: VssWriter[] = writersResult.ok ? parseVssadminWriters(writersResult.stdout) : [];
  const providers: VssProvider[] = providersResult.ok ? parseVssadminProviders(providersResult.stdout) : [];
  const errors: string[] = [];
  if (!writersResult.ok) {
    errors.push(`vssadmin list writers: ${writersResult.stderr.trim() || writersResult.error || 'failed'}`);
  }
  if (!providersResult.ok) {
    errors.push(`vssadmin list providers: ${providersResult.stderr.trim() || providersResult.error || 'failed'}`);
  }
  return {
    operation: 'writers',
    ok: errors.length === 0,
    writers,
    providers,
    errors
  };
}

function runVssSmokeTest(volume: string): VssJobResult {
  const root = normalizeVolumeRoot(volume);
  if (!root) {
    return { operation: 'smoke-test', ok: false, error: 'No volume specified for the snapshot test.' };
  }
  const native = loadNative<{ createSnapshot(v: string): { id: string; devicePath: string }; deleteSnapshot(id: string): boolean }>();
  const started = Date.now();
  let snap: { id: string; devicePath: string };
  try {
    snap = native.createSnapshot(root);
  } catch (error) {
    return {
      operation: 'smoke-test',
      ok: false,
      volume: root,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  let deleted = false;
  let deleteError: string | undefined;
  try {
    deleted = !!native.deleteSnapshot(snap.id);
  } catch (error) {
    deleteError = error instanceof Error ? error.message : String(error);
  }
  return {
    operation: 'smoke-test',
    ok: deleted && !deleteError,
    volume: root,
    id: snap.id,
    devicePath: snap.devicePath,
    durationMs: Date.now() - started,
    deleted,
    deleteError,
    error: deleteError ? `Snapshot created but could not be deleted: ${deleteError}` : undefined
  };
}

function runVssRepair(): VssJobResult {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const results: VssRepairResult[] = [];
  for (const dll of CORE_VSS_DLLS) {
    const full = path.join(system32, dll);
    if (!fs.existsSync(full)) {
      results.push({ dll, ok: true, skipped: true });
      continue;
    }
    const result = run(resolveSystem32Exe('regsvr32.exe'), ['/s', full]);
    results.push({ dll, ok: result.ok, error: result.ok ? undefined : result.stderr.trim() || result.error });
  }

  let running = serviceState().running;
  let startError: string | undefined;
  if (!running) {
    const net = run(resolveSystem32Exe('net.exe'), ['start', VSS_SERVICE]);
    if (net.ok) {
      running = serviceState().running;
    } else {
      startError = net.stderr.trim() || net.error;
    }
  }

  return {
    operation: 'repair',
    ok: results.every((r) => r.ok) && running && !startError,
    results,
    error: startError ? `VSS service did not start: ${startError}` : undefined,
    service: { running, startError }
  };
}

function runVssServiceControl(action: 'start' | 'stop'): VssJobResult {
  const { state, running } = serviceState();
  const wantRunning = action === 'start';
  if ((wantRunning && running) || (!wantRunning && !running)) {
    return {
      operation: action,
      ok: true,
      already: running ? 'running' : 'stopped',
      message: `VSS service is already ${running ? 'running' : 'stopped'} (state: ${state}).`
    };
  }
  const net = run(resolveSystem32Exe('net.exe'), [action, VSS_SERVICE]);
  if (net.ok) {
    const after = serviceState();
    return {
      operation: action,
      ok: true,
      already: undefined,
      message: net.stdout.trim() || `${action} sent to the VSS service`,
      service: { running: after.running, state: after.state }
    };
  }
  return {
    operation: action,
    ok: false,
    error: net.stderr.trim() || net.error || `Failed to ${action} the VSS service`
  };
}

export async function runVssJob(job: VssJob): Promise<VssJobResult> {
  switch (job.operation) {
    case 'writers':
      return runVssWriters();
    case 'smoke-test':
      return runVssSmokeTest(job.volume ?? '');
    case 'repair':
      return runVssRepair();
    case 'start':
    case 'stop':
      return runVssServiceControl(job.operation);
    default:
      return {
        operation: job.operation,
        ok: false,
        error: `Unknown VSS operation: ${String(job.operation)}`
      };
  }
}