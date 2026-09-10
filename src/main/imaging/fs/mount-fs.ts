import { readFileRange, NtfsFile, NtfsNode } from './ntfs';
import { listDirectory, resolvePath, BrowseSession } from './file-browse';

/**
 * Read-only filesystem backend for the WinFsp mount bridge. For every NTFS
 * path WinFsp asks about, we resolve the path against an already-parsed browse
 * session (built at mount time) and reply with stat data, a byte range, or a
 * directory listing.
 *
 * All work is synchronous: the browse session is parsed eagerly and file data
 * is decompressed on demand inside each call. This matches the existing GUI
 * browse sessions and keeps the bridge inline on the Node main thread (the
 * WinFsp TSF callback dispatches here synchronously).
 */

export interface MountEntry {
  name: string;
  attributes: number;
  size: number;
  /** NTFS 100ns timestamps; returned as decimal strings to avoid MAX_SAFE_INTEGER loss. */
  creationTime: string;
  lastAccessTime: string;
  lastWriteTime: string;
  changeTime: string;
  indexNumber: string;
}

/** Standard NTFS file attributes. */
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_ARCHIVE = 0x20;

/** NTSTATUS codes returned as unsigned 32-bit integers (JS cannot represent
 *  signed NTSTATUS, but the C++ side treats them as int32 via NT_SUCCESS()). */
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_NOT_A_DIRECTORY = 0xc0000103;
const STATUS_IS_A_DIRECTORY = 0xc00000ba;
const STATUS_ACCESS_DENIED = 0xc0000022;

/** Decimal string helper for FILETIME / size values that may exceed 2^53. */
function ts(v?: number): string {
  return String(v ?? 0);
}

function displayName(rec: NtfsFile | NtfsNode, name?: string): string {
  if (name) return name;
  const n = rec.name;
  if (typeof n === 'string') return n;
  return n?.name ?? '';
}

function toEntry(rec: NtfsFile | NtfsNode, name?: string): MountEntry {
  return {
    name: displayName(rec, name),
    attributes: rec.isDirectory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE,
    size: rec.size ?? 0,
    creationTime: ts('created' in rec ? rec.created : undefined),
    lastAccessTime: ts(rec.modified),
    lastWriteTime: ts(rec.modified),
    changeTime: ts(rec.modified),
    indexNumber: ts(rec.recordNumber)
  };
}

function toRelative(ntPath: string): string {
  return ntPath.replace(/^\\+/, '');
}

export type BridgeRequest = { op: string; path: string; offset?: number; length?: number; marker?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BridgeReply = Record<string, any>;

export function handleBridgeRequest(session: BrowseSession, req: BridgeRequest): BridgeReply {
  const rel = toRelative(req.path);

  if (req.op === 'stat') {
    const rec = resolvePath(session, rel);
    if (!rec) return { status: STATUS_OBJECT_NAME_NOT_FOUND };
    return { status: 0, ...toEntry(rec) };
  }

  if (req.op === 'read') {
    const rec = resolvePath(session, rel);
    if (!rec) return { status: STATUS_OBJECT_NAME_NOT_FOUND };
    if (rec.isDirectory) return { status: STATUS_NOT_A_DIRECTORY };
    const data = readFileRange(session.reader, session.layout, rec, req.offset ?? 0, req.length ?? 0);
    return { status: 0, data: data.toString('base64') };
  }

  if (req.op === 'readDir') {
    const rec = resolvePath(session, rel);
    if (!rec) return { status: STATUS_OBJECT_NAME_NOT_FOUND };
    if (!rec.isDirectory) return { status: STATUS_IS_A_DIRECTORY };
    const entries = listDirectory(session, rel).map((node) => {
      const child = session.records.get(node.recordNumber);
      return toEntry(child ?? node, node.name);
    });
    return { status: 0, entries };
  }

  return { status: STATUS_ACCESS_DENIED };
}