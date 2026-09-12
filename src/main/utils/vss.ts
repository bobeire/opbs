import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Volume Shadow Copy (VSS) maintenance support.
 *
 * The real work (creating/deleting shadow copies, re-registering the VSS DLLs,
 * starting/stopping the vss service) needs elevation, so it runs inside the
 * elevated helper (see src/main/helper/vss-job.ts). Everything in this module
 * is either pure parsing, or a cheap unelevated service-state query that the
 * dashboard/CLI can run without a UAC prompt.
 */

/**
 * Resolve a System32 executable (e.g. sc.exe) to an absolute path so the
 * commands work even when PATH is minimal (bash shells, scheduled tasks).
 */
export function resolveSystem32Exe(name: string): string {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const full = path.join(system32, name);
  try {
    fs.accessSync(full);
    return full;
  } catch {
    return name;
  }
}

export const VSS_SERVICE = 'vss';
export const VSS_DISPLAY_NAME = 'Volume Shadow Copy';
export const CORE_VSS_DLLS = ['vssapi.dll', 'vss_ps.dll', 'vsscore.dll', 'vsstrace.dll'] as const;

export type VssJobOperation = 'writers' | 'smoke-test' | 'repair' | 'start' | 'stop';

export interface VssJob {
  type: 'vss';
  operation: VssJobOperation;
  volume?: string;
}

export interface VssRepairResult {
  dll: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface VssJobResult {
  operation: VssJobOperation;
  ok: boolean;
  error?: string;
  volume?: string;
  id?: string;
  devicePath?: string;
  durationMs?: number;
  deleted?: boolean;
  deleteError?: string;
  writers?: VssWriter[];
  providers?: VssProvider[];
  errors?: string[];
  results?: VssRepairResult[];
  service?: { running: boolean; state?: string; startError?: string };
  already?: string;
  message?: string;
}

export interface ScQueryInfo {
  serviceName: string;
  state: string;
  stateCode: number;
}

export interface ScQcInfo {
  serviceName: string;
  startType: string;
}

export interface VssServiceState {
  service: string;
  displayName: string;
  state: string;
  stateCode: number;
  startType: string;
  running: boolean;
  queryError?: string;
}

/**
 * Parse `sc query vss` output. Example:
 *   SERVICE_NAME: vss
 *           TYPE               : 20  WIN32_SHARE_PROCESS
 *           STATE              : 4  RUNNING
 *           WIN32_EXIT_CODE    : 0  (0x0)
 */
export function parseScQuery(raw: string): ScQueryInfo {
  const serviceName = (raw.match(/SERVICE_NAME\s*:\s*(.+)/)?.[1] ?? VSS_SERVICE).trim();
  const stateMatch = raw.match(/STATE\s*:\s*(\d+)\s+(\w+)/);
  return {
    serviceName,
    stateCode: stateMatch ? Number(stateMatch[1]) : 0,
    state: stateMatch ? stateMatch[2] : 'UNKNOWN'
  };
}

/**
 * Parse `sc qc vss` output (config query). Example:
 *   SERVICE_NAME: vss
 *           TYPE               : 20  WIN32_SHARE_PROCESS
 *           START_TYPE         : 2   AUTO_START
 */
export function parseScQc(raw: string): ScQcInfo {
  const serviceName = (raw.match(/SERVICE_NAME\s*:\s*(.+)/)?.[1] ?? VSS_SERVICE).trim();
  const typeMatch = raw.match(/START_TYPE\s*:\s*(\d+)\s+(\w+)/);
  return {
    serviceName,
    startType: typeMatch ? typeMatch[2] : 'UNKNOWN'
  };
}

/**
 * Query the VSS service state without elevation (`sc query` / `sc qc` are
 * readable by any user).
 */
export async function queryVssServiceState(): Promise<VssServiceState> {
  let state = 'UNKNOWN';
  let stateCode = 0;
  let startType = 'UNKNOWN';

  try {
    const raw = await runScQuery();
    const parsed = parseScQuery(raw);
    state = parsed.state;
    stateCode = parsed.stateCode;
  } catch (error) {
    return {
      service: VSS_SERVICE,
      displayName: VSS_DISPLAY_NAME,
      state,
      stateCode,
      startType,
      running: false,
      queryError: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const raw = await runScQc();
    startType = parseScQc(raw).startType;
  } catch {
    /* config query is best effort */
  }

  return {
    service: VSS_SERVICE,
    displayName: VSS_DISPLAY_NAME,
    state,
    stateCode,
    startType,
    running: state === 'RUNNING'
  };
}

function runScQuery(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(resolveSystem32Exe('sc.exe'), ['query', VSS_SERVICE], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) {
        reject(new Error(String(error.stderr ?? error.message ?? error).trim() || 'sc query failed'));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function runScQc(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(resolveSystem32Exe('sc.exe'), ['qc', VSS_SERVICE], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) {
        reject(new Error(String(error.stderr ?? error.message ?? error).trim() || 'sc qc failed'));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * Parse `vssadmin list writers` (elevated) into structured entries. Example:
 *   Writer name: 'System Writer'
 *           Writer Id: {e8132975-6f93-4464-a53e-1050253ae220}
 *           Writer Instance Id: {e8132975-0000-0000-0000-000000000000}
 *           State: [1] Stable
 *           Last error: No error
 */
export interface VssWriter {
  name: string;
  id?: string;
  instanceId?: string;
  state: string;
  stateCode: number;
  lastError: string;
}

export function parseVssadminWriters(raw: string): VssWriter[] {
  const blocks = String(raw ?? '').split(/^\s*Writer name:\s*/m).slice(1);
  const writers: VssWriter[] = [];
  for (const block of blocks) {
    const name = (block.match(/^'(.+)'/m) ?? [])[1]?.trim() ?? '(unnamed writer)';
    const id = block.match(/Writer Id:\s*(.+)$/m)?.[1]?.trim();
    const instanceId = block.match(/Writer Instance Id:\s*(.+)$/m)?.[1]?.trim();
    const stateMatch = block.match(/State:\s*\[(\d+)\]\s*(.+)$/m);
    const lastError = block.match(/Last error:\s*(.+)$/m)?.[1]?.trim() ?? '';
    writers.push({
      name,
      id,
      instanceId,
      stateCode: stateMatch ? Number(stateMatch[1]) : 0,
      state: stateMatch ? stateMatch[2].trim() : 'Unknown',
      lastError
    });
  }
  return writers;
}

/**
 * Parse `vssadmin list providers` (elevated). Example:
 *   Provider name: 'Microsoft Software Shadow Copy provider 1.0'
 *           Provider Type:    System
 *           Provider Id: {b5946137-7b9f-4925-af80-51abd60b20d5}
 *           Version: 1.0.0.7
 */
export interface VssProvider {
  name: string;
  type?: string;
  id?: string;
  version?: string;
}

export function parseVssadminProviders(raw: string): VssProvider[] {
  const blocks = String(raw ?? '').split(/^\s*Provider name:\s*/m).slice(1);
  const providers: VssProvider[] = [];
  for (const block of blocks) {
    const name = (block.match(/^'(.+)'/m) ?? [])[1]?.trim() ?? '(unnamed provider)';
    const type = block.match(/Provider Type:\s*(.+)$/m)?.[1]?.trim();
    const id = block.match(/Provider Id:\s*(.+)$/m)?.[1]?.trim();
    const version = block.match(/Version:\s*(.+)$/m)?.[1]?.trim();
    providers.push({ name, type, id, version });
  }
  return providers;
}

/**
 * Normalize a volume specifier to a volume root path for the native VSS
 * addon: "C", "C:", "c:\" all become "C:\". Volume GUID paths are left as-is.
 */
export function normalizeVolumeRoot(volume: string): string {
  const v = String(volume ?? '').trim();
  if (!v) return '';
  if (/^[A-Za-z]:$/.test(v)) return `${v.toUpperCase()}\\`;
  if (/^[A-Za-z]:\\$/.test(v)) return v.toUpperCase();
  if (/^\\\\\?\\Volume\{.*\}\\?$/.test(v)) {
    return v.endsWith('\\') ? v : `${v}\\`;
  }
  if (v.length === 1 && /^[A-Za-z]$/.test(v)) return `${v.toUpperCase()}:\\`;
  return v.endsWith('\\') ? v : `${v}\\`;
}

/**
 * Enumerate the mounted drive letters (any volume the current user can
 * access) as volume roots, system drive first. Cheap and unelevated —
 * `fs.accessSync` on the drive root.
 */
export function enumerateVolumes(): string[] {
  const vols: string[] = [];
  const systemRoot = `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\`;
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const ordered = [systemRoot, ...letters.map((l) => `${l}:\\`)];
  for (const candidate of ordered) {
    if (!candidate || vols.includes(candidate)) continue;
    try {
      fs.accessSync(candidate);
      vols.push(candidate);
    } catch {
      /* not mounted */
    }
  }
  return vols;
}