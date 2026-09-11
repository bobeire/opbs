import { spawnSync } from 'child_process';
import path from 'path';
import * as fs from 'fs';

/** The Windows registry command lives in System32; fall back to PATH resolution. */
function regExe(): string {
  const windir = process.env.windir ?? 'C:\\Windows';
  const viaSystem32 = path.join(windir, 'System32', 'reg.exe');
  if (fs.existsSync(viaSystem32)) {
    return viaSystem32;
  }
  return 'reg';
}

/** Verb names used as Windows shell verbs for the `.opbs` association. */
export const FILE_VERBS = ['open', 'browse', 'mount', 'restore', 'verify'] as const;
export type FileVerb = (typeof FILE_VERBS)[number];

/** Display text for the Explorer context menu. */
const VERB_LABELS: Record<FileVerb, string> = {
  open: 'Browse with OPBS',
  browse: 'Browse files with OPBS',
  mount: 'Mount with OPBS',
  restore: 'Restore with OPBS',
  verify: 'Verify with OPBS'
};

const IMAGE_EXTENSIONS = ['.opbs', '.mrimg', '.mrimgx'];

/** Registry ProgId + class under HKCU\\Software\\Classes. */
const PROGID = 'Opbs.Image.1';
const EXT_KEY = '.opbs';
const APP_ID = 'OPBS.exe';

/** A single `reg add` write: a key, optional default value, optional named values. */
export interface RegEntry {
  key: string;
  default?: string;
  values?: Array<[string, string]>;
}

/**
 * Build the registry entries that make OPBS the handler for `.opbs` files and
 * add the shell context verbs. Writer-safe for tests: no registry access here.
 */
export function collectAssociationEntries(
  execPath: string,
  options: { appId?: string; productName?: string } = {}
): RegEntry[] {
  const appId = options.appId ?? APP_ID;
  const productName = options.productName ?? 'OPBS';
  const exe = `"${execPath}"`;
  const entries: RegEntry[] = [
    { key: EXT_KEY, default: PROGID },
    { key: PROGID, default: `${productName} Disk Image` },
    { key: `${PROGID}\\DefaultIcon`, default: `${exe},0` },
    { key: `${PROGID}\\shell`, default: 'open' }
  ];
  for (const verb of FILE_VERBS) {
    entries.push({ key: `${PROGID}\\shell\\${verb}`, default: VERB_LABELS[verb] });
    entries.push({
      key: `${PROGID}\\shell\\${verb}\\command`,
      default: `${exe} --file-verb ${verb} "%1"`
    });
  }
  // Let OPBS appear in the "Open with…" dialog as well.
  const appKey = `Applications\\${appId}`;
  entries.push({ key: appKey, default: productName });
  entries.push({
    key: `${appKey}\\shell\\open\\command`,
    default: `${exe} --file-verb open "%1"`
  });
  return entries;
}

/** Turn an entry into `reg add` argv. Supports default (/ve) and named (/v) values. */
export function regAddArgs(entry: RegEntry): string[][] {
  const base = ['add', `HKCU\\Software\\Classes\\${entry.key}`, '/f'];
  if (entry.default !== undefined) {
    return [[...base, '/ve', '/d', entry.default]];
  }
  if (entry.values) {
    return entry.values.map(([name, data]) => [...base, '/v', name, '/d', data]);
  }
  return [base];
}

export interface AssociatorResult {
  ok: boolean;
  failures: string[];
}

function execReg(args: string[]): { status: number | null; error?: string } {
  const res = spawnSync(regExe(), args, { encoding: 'utf8', windowsHide: true });
  return { status: res.status, error: res.error?.message };
}

/** Apply the association entries to the user registry. Returns the failing keys. */
export function applyAssociationEntries(
  entries: RegEntry[],
  run: (args: string[]) => { status: number | null; error?: string } = execReg
): AssociatorResult {
  const failures: string[] = [];
  for (const entry of entries) {
    for (const args of regAddArgs(entry)) {
      const { status, error } = run(args);
      if (status !== 0) {
        failures.push(`${entry.key} (${error ?? `exit ${status ?? 'unknown'}`})`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/** High-level registration used by the app: also used to write tests. */
export function registerFileAssociations(
  execPath = process.execPath,
  options: { appId?: string; productName?: string } = {}
): AssociatorResult {
  return applyAssociationEntries(collectAssociationEntries(execPath, options));
}

/** Remove the user-level association and verbs. */
export function unregisterFileAssociations(
  run: (args: string[]) => { status: number | null; error?: string } = execReg,
  appId = APP_ID
): AssociatorResult {
  const failures: string[] = [];
  for (const key of [EXT_KEY, PROGID, `Applications\\${appId}`]) {
    const { status, error } = run(['delete', `HKCU\\Software\\Classes\\${key}`, '/f']);
    if (status !== 0 && status !== null) {
      failures.push(`${key} (${error ?? `exit ${status}`})`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export interface FileAction {
  verb: FileVerb;
  imagePath: string;
}

/**
 * Parse a launching argv (first element is the exe) for a file-handler action:
 * either `--file-verb <verb> "<path>"` or a bare image path argument (the
 * default double-click/open form the shell uses).
 */
export function parseFileActionArgs(argv: string[]): FileAction | null {
  const args = argv.slice(1);
  const verbIdx = args.indexOf('--file-verb');
  if (verbIdx !== -1) {
    const verb = args[verbIdx + 1] as FileVerb | undefined;
    const imagePath = args[verbIdx + 2];
    if (!verb || !(FILE_VERBS as readonly string[]).includes(verb) || !imagePath) {
      return null;
    }
    return { verb, imagePath };
  }
  const candidate = args[args.length - 1];
  if (!candidate || !path.isAbsolute(candidate)) {
    return null;
  }
  const lower = candidate.toLowerCase();
  if (!IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return null;
  }
  return { verb: 'open', imagePath: candidate };
}