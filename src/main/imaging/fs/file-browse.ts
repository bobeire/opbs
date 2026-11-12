import * as fs from 'fs';
import * as path from 'path';
import { PartitionReader, partitionReaderForChain } from '../image-browse';
import { baseVolumePath, resolveImageChain } from '../image-format';
import { GPT_EFI_SYSTEM_GUID } from '../partition-table';
import { logger } from '../../utils/logger';
import { parseBootSector, readFileRecords, buildTree, readFileData, readStreamData, readDirectoryIndex, forEachNtfsFileChunk, EfsEncryptedError, NtfsFile, NtfsLayout, NtfsNode } from './ntfs';
import { parseFat32BootSector, listFat32Directory, readFileData as readFat32FileData, forEachFat32FileChunk, Fat32Layout, Fat32Entry, detectFatType } from './fat32';
import { parseExfatBootSector, listExfatDirectory, readExfatFileData, forEachExfatFileChunk, detectExfat, ExfatLayout, ExfatEntry } from './exfat';
import { detectMacriumFormat, readMacriumImage, openMacriumPartitionReader, MacriumUnsupportedError, MacriumPasswordError, MacriumUnlock } from '../mrimg';

/**
 * High-level file browsing/extraction over a backup image (OPBS `.opbs` chain
 * or a Macrium Reflect `.mrimgx`).
 *
 * Supports NTFS, FAT32 and exFAT filesystems. The filesystem is auto-detected
 * from the boot sector.
 */

/** Generic browse node returned by listDirectory — works for all filesystems. */
export interface BrowseNode {
  name: string;
  isDirectory: boolean;
  size: number;
  modified?: number;
  /** Internal identifier — MFT record number for NTFS, start cluster for FAT. */
  id: number;
  /** Parent's internal identifier. */
  parentId: number;
  /** True for EFS-encrypted files (NTFS only); extraction then needs a local key. */
  isEncrypted?: boolean;
}

export interface NtfsBrowseSession {
  filesystem: 'ntfs';
  imagePath: string;
  chain: string[];
  partitionIndex: number;
  reader: PartitionReader;
  layout: NtfsLayout;
  records: Map<number, NtfsFile>;
  children: Map<number, NtfsNode[]>;
  rootId: number;
}

export interface Fat32BrowseSession {
  filesystem: 'fat32';
  imagePath: string;
  chain: string[];
  partitionIndex: number;
  reader: PartitionReader;
  layout: Fat32Layout;
  /** Cached directory listings keyed by start cluster. */
  directories: Map<number, Fat32Entry[]>;
  rootCluster: number;
}

export interface ExfatBrowseSession {
  filesystem: 'exfat';
  imagePath: string;
  chain: string[];
  partitionIndex: number;
  reader: PartitionReader;
  layout: ExfatLayout;
  /** Cached directory listings keyed by start cluster. */
  directories: Map<number, ExfatEntry[]>;
  rootCluster: number;
}

export type BrowseSession = NtfsBrowseSession | Fat32BrowseSession | ExfatBrowseSession;

/**
 * The `.opbs` reader wants a raw passphrase; a Macrium unlock can also be
 * already-derived key material, which only the Macrium reader understands.
 */
function opbsPassphrase(unlock?: MacriumUnlock): string | undefined {
  return typeof unlock === 'string' ? unlock : undefined;
}

/** Open a browse session for a partition in an image chain. */
export function openBrowse(
  imagePath: string,
  partitionIndex: number,
  passphrase?: MacriumUnlock
): BrowseSession {
  // Normalise a multi-volume path (`.001`, `.002`, ...) to the base image so
  // chain resolution and volume mapping start from volume 0.
  const basePath = baseVolumePath(imagePath);
  const chain = resolveImageChain(basePath);
  const { reader } = partitionReaderForChain(chain, partitionIndex, opbsPassphrase(passphrase));
  return openBrowseFromReader(basePath, partitionIndex, reader);
}

/**
 * Open a browse session over an already-built `PartitionReader`.
 * Auto-detects the filesystem (NTFS or FAT32) from the boot sector.
 */
export function openBrowseFromReader(
  imagePath: string,
  partitionIndex: number,
  reader: PartitionReader
): BrowseSession {
  const bpb = reader.read(0, 512);
  // Check the NTFS OEM id FIRST. NTFS's extended BPB reuses bytes at 0x24
  // (physical drive number — typically 0x80 on real volumes) that satisfy
  // detectFatType()'s FAT32 heuristic (rootEntryCount === 0 &&
  // sectorsPerFat16 === 0 && sectorsPerFat32 > 0). The FAT32 parser then
  // walks garbage offsets and silently returns an empty listing instead of
  // throwing. detectPartitionFilesystem() already checks NTFS first for
  // exactly this reason.
  const oem = bpb.toString('ascii', 3, 11);
  if (oem === 'NTFS    ') {
    return openNtfsBrowse(imagePath, partitionIndex, reader);
  }
  const fatType = detectFatType(bpb);
  if (fatType === 'FAT32') {
    return openFat32Browse(imagePath, partitionIndex, reader);
  }
  if (detectExfat(bpb)) {
    return openExfatBrowse(imagePath, partitionIndex, reader);
  }
  // Default: NTFS (throws with a clear error on unrecognised filesystems).
  return openNtfsBrowse(imagePath, partitionIndex, reader);
}

function openNtfsBrowse(
  imagePath: string,
  partitionIndex: number,
  reader: PartitionReader
): NtfsBrowseSession {
  const layout = parseBootSector(reader);
  const fileRecords = readFileRecords(reader, layout);
  const records = new Map<number, NtfsFile>();
  for (const rec of fileRecords) {
    records.set(rec.recordNumber, rec);
  }
  const children = buildTree(fileRecords);
  logger.info(
    `openNtfsBrowse: partition ${partitionIndex} loaded ${records.size} MFT records ` +
      `(root ${records.has(5) ? 'present' : 'MISSING'})`
  );
  if (!records.has(5)) {
    throw new Error(
      `Cannot browse partition ${partitionIndex}: the NTFS root directory record could not be read ` +
        `(${records.size} MFT records loaded). See the Logs page for details.`
    );
  }
  return { filesystem: 'ntfs', imagePath, chain: [imagePath], partitionIndex, reader, layout, records, children, rootId: 5 };
}

function openFat32Browse(
  imagePath: string,
  partitionIndex: number,
  reader: PartitionReader
): Fat32BrowseSession {
  const layout = parseFat32BootSector(reader);
  const directories = new Map<number, Fat32Entry[]>();
  // Pre-cache the root directory.
  directories.set(layout.rootDirCluster, listFat32Directory(reader, layout, layout.rootDirCluster));
  return { filesystem: 'fat32', imagePath, chain: [imagePath], partitionIndex, reader, layout, directories, rootCluster: layout.rootDirCluster };
}

function openExfatBrowse(
  imagePath: string,
  partitionIndex: number,
  reader: PartitionReader
): ExfatBrowseSession {
  const layout = parseExfatBootSector(reader);
  const directories = new Map<number, ExfatEntry[]>();
  // Pre-cache the root directory.
  directories.set(layout.rootDirCluster, listExfatDirectory(reader, layout, layout.rootDirCluster));
  return { filesystem: 'exfat', imagePath, chain: [imagePath], partitionIndex, reader, layout, directories, rootCluster: layout.rootDirCluster };
}

/**
 * Open a browse session for whatever image flavor the path holds: a `.opbs`
 * image chain, a `.mrimgx` Reflect X image, or a `.mrimg` Reflect 7/8 image.
 */
export function openAnyBrowse(imagePath: string, partitionIndex: number, passphrase?: MacriumUnlock): BrowseSession {
  const format = detectMacriumFormat(imagePath);
  if (format) {
    const info = readMacriumImage(imagePath, passphrase);
    const reader = openMacriumPartitionReader(info, partitionIndex);
    return openBrowseFromReader(imagePath, partitionIndex, reader);
  }
  return openBrowse(imagePath, partitionIndex, passphrase);
}

/**
 * Detect a partition's filesystem type by reading just its boot sector.
 * Cheap relative to a full browse-session parse. Returns the filesystem name
 * and whether the built-in browser can read it (NTFS or FAT32).
 */
/**
 * A filesystem OEM id is a short printable identifier ("NTFS    ", "MSDOS5.0").
 * Anything else is bytes that happen to sit where an OEM id would be, and
 * rendering them as a name produces mojibake. Returns null when the bytes are
 * not a plausible identifier.
 */
export function sanitizeOemId(raw: string): string | null {
  const trimmed = (raw ?? '').replace(/\0+$/, '').trim();
  if (trimmed.length === 0 || trimmed.length > 11) return null;
  return /^[A-Za-z0-9 ._-]+$/.test(trimmed) ? trimmed : null;
}

export function detectPartitionFilesystem(
  imagePath: string,
  partitionIndex: number,
  passphrase?: MacriumUnlock
): { fsType: string; browsable: boolean; reason?: string } {
  try {
    const format = detectMacriumFormat(imagePath);
    let reader: PartitionReader;
    if (format) {
      const info = readMacriumImage(imagePath, passphrase);
      reader = openMacriumPartitionReader(info, partitionIndex);
    } else {
      const basePath = baseVolumePath(imagePath);
      const chain = resolveImageChain(basePath);
      reader = partitionReaderForChain(chain, partitionIndex, opbsPassphrase(passphrase)).reader;
    }
    if (reader.size === 0) return { fsType: 'Empty', browsable: false };
    const bpb = reader.read(0, 512);
    const oem = bpb.toString('ascii', 3, 11);
    logger.info(`detectPartitionFilesystem: partition ${partitionIndex} size=${reader.size} OEM="${oem}"`);
    if (oem === 'NTFS    ') return { fsType: 'NTFS', browsable: true };
    const fatType = detectFatType(bpb);
    if (fatType === 'FAT32') return { fsType: 'FAT32', browsable: true };
    if (fatType === 'FAT16') return { fsType: 'FAT16', browsable: false };
    if (fatType === 'FAT12') return { fsType: 'FAT12', browsable: false };
    if (detectExfat(bpb)) return { fsType: 'exFAT', browsable: true };
    // Not every partition has a filesystem. A Microsoft Reserved partition (or
    // any raw/reserved region) has no boot sector, so bytes 3..10 are just
    // whatever the partition table left there — printing them as an OEM id
    // produced "(??????PcFP)" on a real machine (field report 2026-11-03).
    // Only accept a plausible identifier.
    return { fsType: sanitizeOemId(oem) ?? 'None', browsable: false };
  } catch (e) {
    if (e instanceof MacriumPasswordError) {
      // Wrong/missing passphrase for a password-protected Macrium image: keep
      // the exact reason so the UI can prompt for the passphrase.
      logger.info(`detectPartitionFilesystem: partition ${partitionIndex} locked: ${e.message}`);
      return { fsType: 'Encrypted', browsable: false, reason: e.message };
    }
    if (e instanceof MacriumUnsupportedError) {
      // A recognised-but-refused container (encrypted/split/delta): keep the
      // exact verdict instead of collapsing it into "Unknown", so callers can
      // explain why the partition cannot be browsed.
      logger.info(`detectPartitionFilesystem: partition ${partitionIndex} unsupported: ${e.message}`);
      return { fsType: 'Unsupported', browsable: false, reason: e.message };
    }
    logger.warn(`detectPartitionFilesystem: partition ${partitionIndex} failed: ${e instanceof Error ? e.message : e}`);
    return { fsType: 'Unknown', browsable: false };
  }
}

/**
 * Probe whether an image partition is an EFI System Partition: a FAT32 volume
 * whose root contains the spec-required `\EFI` directory. Reads only the boot
 * sector plus the root directory cluster — cheap enough to run while planning
 * a restore. Never throws; failures (encrypted image without a key, corrupt
 * data) mean "not an ESP".
 */
export function probeEspPartition(imagePath: string, partitionIndex: number, passphrase?: MacriumUnlock): boolean {
  try {
    const { fsType } = detectPartitionFilesystem(imagePath, partitionIndex, passphrase);
    if (fsType !== 'FAT32') {
      return false;
    }
    const session = openAnyBrowse(imagePath, partitionIndex, passphrase);
    if (session.filesystem !== 'fat32') {
      return false;
    }
    return listDirectory(session, '').some((n) => n.isDirectory && n.name.toUpperCase() === 'EFI');
  } catch (e) {
    logger.warn(`probeEspPartition: partition ${partitionIndex} failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export type EspProbe = (imagePath: string, partitionIndex: number, passphrase?: MacriumUnlock) => boolean;

/**
 * Infer GPT type GUIDs for the partitions a restore will lay down: every EFI
 * System Partition gets `GPT_EFI_SYSTEM_GUID` so a restored disk boots in a
 * VM out of the box; everything else keeps the plan's basic-data default.
 * Callers merge explicit `tableTypeGuids` over the result so config wins.
 */
export function inferTableTypeGuids(
  imagePath: string,
  partitionIndexes: number[],
  passphrase?: MacriumUnlock,
  probe: EspProbe = probeEspPartition
): Record<number, string> {
  const typeGuids: Record<number, string> = {};
  for (const idx of partitionIndexes) {
    if (probe(imagePath, idx, passphrase)) {
      typeGuids[idx] = GPT_EFI_SYSTEM_GUID;
    }
  }
  return typeGuids;
}

/**
 * MBR partition type byte for a detected filesystem: FAT32→0x0C (FAT32 LBA),
 * FAT16→0x06, FAT12→0x01, everything else (NTFS/exFAT/ReFS/unknown)→0x07.
 */
export function mbrTypeForFs(fsType: string): number {
  if (fsType === 'FAT32') return 0x0c;
  if (fsType === 'FAT16') return 0x06;
  if (fsType === 'FAT12') return 0x01;
  return 0x07;
}

/**
 * Infer MBR partition type bytes for the partitions a restore will lay down,
 * keyed by image partition index. Callers layer ESP→0xEF over the result when
 * a partition is an EFI System Partition, and merge explicit config values
 * over both.
 */
export function inferMbrTypes(
  imagePath: string,
  partitionIndexes: number[],
  passphrase?: MacriumUnlock
): Record<number, number> {
  const mbrTypes: Record<number, number> = {};
  for (const idx of partitionIndexes) {
    const { fsType } = detectPartitionFilesystem(imagePath, idx, passphrase);
    mbrTypes[idx] = mbrTypeForFs(fsType);
  }
  return mbrTypes;
}

function splitPath(relPath: string): string[] {
  return relPath.replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// NTFS path resolution
// ---------------------------------------------------------------------------

/** Resolve a case-insensitive path (relative to the volume root) to a file record. */
function resolveNtfsPath(session: NtfsBrowseSession, relPath: string): NtfsFile | null {
  const segs = splitPath(relPath);
  if (segs.length === 0) {
    return session.records.get(session.rootId) ?? null;
  }
  let parentRecord = session.rootId;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const segLower = seg.toLowerCase();
    const match = findNtfsChild(session, parentRecord, seg, segLower);
    if (!match) return null;
    if (i === segs.length - 1) {
      return session.records.get(match.recordNumber) ?? null;
    }
    if (!match.isDirectory) return null;
    parentRecord = match.recordNumber;
  }
  return session.records.get(parentRecord) ?? null;
}

/**
 * Find a child of `parentRecord` by name. Tries the parent/child tree first
 * (Win32 names from $FILE_NAME), then the $I30 index (which may key the same
 * file under a DOS 8.3 name such as DUMPST~1.TMP).
 */
function findNtfsChild(
  session: NtfsBrowseSession,
  parentRecord: number,
  seg: string,
  segLower: string
): { recordNumber: number; isDirectory: boolean } | null {
  const kids = session.children.get(parentRecord) ?? [];
  const fromTree = kids.find((n) => n.name === seg || n.name.toLowerCase() === segLower);
  if (fromTree) return fromTree;

  const parent = session.records.get(parentRecord);
  if (!parent) return null;
  const indexEntries = readDirectoryIndex(session.reader, session.layout, parent);
  for (const e of indexEntries) {
    if (e.name !== seg && e.name.toLowerCase() !== segLower) continue;
    const rec = session.records.get(e.fileReference);
    if (rec && rec.inUse && rec.name) return { recordNumber: rec.recordNumber, isDirectory: rec.isDirectory };
  }
  // Also accept a Win32 name when the index only carried the DOS key (or vice versa).
  for (const e of indexEntries) {
    const rec = session.records.get(e.fileReference);
    if (!rec?.inUse || !rec.name) continue;
    const recName = rec.name.name;
    if (recName === seg || recName.toLowerCase() === segLower || e.name === seg || e.name.toLowerCase() === segLower) {
      return { recordNumber: rec.recordNumber, isDirectory: rec.isDirectory };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// FAT32 path resolution
// ---------------------------------------------------------------------------

function resolveFat32Path(session: Fat32BrowseSession, relPath: string): Fat32Entry | null {
  const segs = splitPath(relPath);
  let cluster = session.rootCluster;
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listFat32Directory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  if (segs.length === 0) {
    // Return a synthetic root entry.
    return { name: '', isDirectory: true, size: 0, startCluster: session.rootCluster };
  }
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const match = entries.find((e) => e.name === seg || e.name.toLowerCase() === seg.toLowerCase());
    if (!match) return null;
    if (i === segs.length - 1) return match;
    if (!match.isDirectory) return null;
    cluster = match.startCluster;
    entries = session.directories.get(cluster);
    if (!entries) {
      entries = listFat32Directory(session.reader, session.layout, cluster);
      session.directories.set(cluster, entries);
    }
  }
  return null;
}

/** Resolve a relative path to an exFAT entry. */
function resolveExfatPath(session: ExfatBrowseSession, relPath: string): ExfatEntry | null {
  const segs = splitPath(relPath);
  let cluster = session.rootCluster;
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listExfatDirectory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  if (segs.length === 0) {
    return { name: '', isDirectory: true, size: 0, startCluster: session.rootCluster };
  }
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const match = entries.find((e) => e.name === seg || e.name.toLowerCase() === seg.toLowerCase());
    if (!match) return null;
    if (i === segs.length - 1) return match;
    if (!match.isDirectory) return null;
    cluster = match.startCluster;
    entries = session.directories.get(cluster);
    if (!entries) {
      entries = listExfatDirectory(session.reader, session.layout, cluster);
      session.directories.set(cluster, entries);
    }
  }
  return null;
}

/** Resolve a relative path to a browse node (filesystem-agnostic). */
export function resolvePath(session: BrowseSession, relPath: string): BrowseNode | null {
  if (session.filesystem === 'ntfs') {
    const rec = resolveNtfsPath(session, relPath);
    if (!rec) return null;
    const recName = typeof rec.name === 'string' ? rec.name : rec.name?.name ?? '';
    const recParent = typeof rec.name === 'object' ? rec.name?.parentRecord ?? 0 : 0;
    return {
      name: recName,
      isDirectory: rec.isDirectory,
      size: rec.size,
      modified: rec.modified,
      id: rec.recordNumber,
      parentId: recParent,
      isEncrypted: rec.isEncrypted
    };
  }
  if (session.filesystem === 'exfat') {
    const entry = resolveExfatPath(session, relPath);
    if (!entry) return null;
    return {
      name: entry.name,
      isDirectory: entry.isDirectory,
      size: entry.size,
      modified: entry.modified,
      id: entry.startCluster,
      parentId: 0
    };
  }
  // FAT32
  const entry = resolveFat32Path(session, relPath);
  if (!entry) return null;
  return {
    name: entry.name,
    isDirectory: entry.isDirectory,
    size: entry.size,
    modified: entry.modified,
    id: entry.startCluster,
    parentId: 0
  };
}

/** Resolve a relative path to an NtfsFile (NTFS only). Returns null for FAT32 sessions or missing files. */
export function resolveNtfsFile(session: BrowseSession, relPath: string): NtfsFile | null {
  if (session.filesystem !== 'ntfs') return null;
  return resolveNtfsPath(session, relPath);
}

// ---------------------------------------------------------------------------
// Public API — dispatches on session.filesystem
// ---------------------------------------------------------------------------

/** List the direct children of a directory path (empty = volume root). */
export function listDirectory(session: BrowseSession, relPath = ''): BrowseNode[] {
  if (session.filesystem === 'fat32') {
    return listFat32(session, relPath);
  }
  if (session.filesystem === 'exfat') {
    return listExfat(session, relPath);
  }
  return listNtfs(session, relPath);
}

function listNtfs(session: NtfsBrowseSession, relPath: string): BrowseNode[] {
  const target = relPath.trim().length > 0 ? resolveNtfsPath(session, relPath) : session.records.get(session.rootId);
  if (!target) throw new Error(`Directory not found: ${relPath}`);
  const indexEntries = readDirectoryIndex(session.reader, session.layout, target);
  if (indexEntries.length > 0) {
    const nodes: BrowseNode[] = [];
    const seen = new Set<number>();
    let missing = 0;
    let dosOnly = 0;
    for (const e of indexEntries) {
      const rec = session.records.get(e.fileReference);
      if (rec && rec.inUse && rec.name) {
        if (seen.has(rec.recordNumber)) continue;
        seen.add(rec.recordNumber);
        // Prefer the Win32 name from the MFT; fall back to the index key
        // (which may be a DOS 8.3 name such as DUMPST~1.TMP).
        const useIndexName = e.namespace === 2 && rec.name.namespace !== 2;
        if (useIndexName) dosOnly++;
        nodes.push({
          name: useIndexName ? e.name : (rec.name.name || e.name),
          isDirectory: rec.isDirectory,
          size: rec.size,
          modified: rec.modified,
          id: rec.recordNumber,
          parentId: target.recordNumber,
          isEncrypted: rec.isEncrypted
        });
      } else {
        missing++;
      }
    }
    if (nodes.length === 0) {
      // Index entries exist but none resolved against the MFT cache — almost
      // always a truncated readFileRecords() pass. Fall back to the
      // parent/child tree instead of silently reporting an empty folder.
      logger.warn(
        `listNtfs: ${indexEntries.length} index entries in "${relPath || '/'}" but none resolved ` +
          `(${missing} missing from the MFT cache of ${session.records.size} records); falling back to the directory tree`
      );
    } else {
      if (missing > 0 || dosOnly > 0) {
        logger.warn(
          `listNtfs: "${relPath || '/'}" resolved ${nodes.length}/${indexEntries.length} index entries ` +
            `(${missing} missing from the MFT cache of ${session.records.size} records, ${dosOnly} DOS-name keys)`
        );
      }
      return nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
  }
  return (session.children.get(target.recordNumber) ?? []).map((n) => ({
    name: n.name,
    isDirectory: n.isDirectory,
    size: n.size,
    modified: n.modified,
    id: n.recordNumber,
    parentId: n.parentRecord,
    isEncrypted: n.isEncrypted
  }));
}

function listFat32(session: Fat32BrowseSession, relPath: string): BrowseNode[] {
  const target = relPath.trim().length > 0 ? resolveFat32Path(session, relPath) : null;
  if (relPath.trim().length > 0 && !target) {
    throw new Error(`Directory not found: ${relPath}`);
  }
  const cluster = target?.startCluster ?? session.rootCluster;
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listFat32Directory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  return entries
    .filter((e) => e.name !== '.' && e.name !== '..')
    .map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
      size: e.size,
      modified: e.modified,
      id: e.startCluster,
      parentId: cluster
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function listExfat(session: ExfatBrowseSession, relPath: string): BrowseNode[] {
  const target = relPath.trim().length > 0 ? resolveExfatPath(session, relPath) : null;
  if (relPath.trim().length > 0 && !target) {
    throw new Error(`Directory not found: ${relPath}`);
  }
  const cluster = target?.startCluster ?? session.rootCluster;
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listExfatDirectory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  return entries
    .filter((e) => e.name !== '.' && e.name !== '..')
    .map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
      size: e.size,
      modified: e.modified,
      id: e.startCluster,
      parentId: cluster
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Read the bytes of a file path. */
export function readPath(session: BrowseSession, relPath: string): Buffer {
  if (session.filesystem === 'fat32') {
    const entry = resolveFat32Path(session, relPath);
    if (!entry) throw new Error(`File not found: ${relPath}`);
    if (entry.isDirectory) throw new Error(`Is a directory: ${relPath}`);
    return readFat32FileData(session.reader, session.layout, entry.startCluster, entry.size);
  }
  if (session.filesystem === 'exfat') {
    const entry = resolveExfatPath(session, relPath);
    if (!entry) throw new Error(`File not found: ${relPath}`);
    if (entry.isDirectory) throw new Error(`Is a directory: ${relPath}`);
    return readExfatFileData(session.reader, session.layout, entry.startCluster, entry.size, {
      noFatChain: entry.noFatChain,
      validDataLength: entry.validDataLength
    });
  }
  const rec = resolveNtfsPath(session, relPath);
  if (!rec) throw new Error(`File not found: ${relPath}`);
  if (rec.isDirectory) throw new Error(`Is a directory: ${relPath}`);
  return readFileData(session.reader, session.layout, rec);
}

/** Write a file's alternate data streams (ADS) as `file:stream` on NTFS. */
function writeAlternateStreams(session: NtfsBrowseSession, rec: NtfsFile, dest: string): void {
  // Alternate streams of an encrypted file are ciphertext as well, and $EFS
  // metadata exists only for the unnamed stream.
  if (rec.isEncrypted) return;
  for (const stream of rec.streams.values()) {
    if (stream.name === '$DATA' || stream.name === '') continue;
    try {
      const data = readStreamData(session.reader, session.layout, stream);
      fs.writeFileSync(`${dest}:${stream.name}`, data);
    } catch {
      // ADS requires an NTFS destination; skip non-NTFS targets.
    }
  }
}

/** One item an extraction could not recover as it was, or had to rename. */
export interface ExtractProblem {
  /** Path inside the image. */
  path: string;
  kind: 'skipped' | 'renamed';
  reason: string;
}

/** Live figures from an extraction, for a progress display. */
export interface ExtractProgress {
  /** Files written so far, including the one whose data is being written. */
  files: number;
  /** Bytes written so far. */
  bytes: number;
  /** The item being worked on, as a path inside the image. */
  current: string;
}

/** Optional callbacks for a long-running extraction. */
export interface ExtractHooks {
  /** Polled between files and between the pieces of a file; return true to stop. */
  isCancelled?: () => boolean;
  /** Called as pieces are written and files finish. The caller decides how often to act on it. */
  onProgress?: (progress: ExtractProgress) => void;
  /** Called as a file is skipped or renamed. */
  onProblem?: (problem: ExtractProblem) => void;
}

/** Thrown out of an extraction that was cancelled. `files` is how many were written before it stopped. */
export class ExtractCancelledError extends Error {
  files = 0;

  constructor() {
    super('Extraction cancelled.');
    this.name = 'ExtractCancelledError';
  }
}

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A name that is safe to create on the host, whatever the image says it is. Names come
 * from the image, which may be untrusted (someone else's backup, a damaged disk, a crafted
 * file), so a separator or `..` must not be able to leave the destination folder, and a
 * character or device name Windows rejects must not be able to abort the whole extraction.
 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  safe = safe.replace(/[. ]+$/, ''); // Windows silently drops trailing dots and spaces
  if (safe === '') safe = '_'; // also covers '.' and '..'
  if (RESERVED_DEVICE_NAMES.test(safe)) safe = `_${safe}`;
  return safe.length > 255 ? safe.slice(0, 255) : safe;
}

/** Hands out names that cannot collide in one folder, ignoring case as Windows does. */
class DirectoryNames {
  private readonly taken = new Set<string>();

  claim(wanted: string): string {
    let name = wanted;
    const ext = path.extname(wanted);
    const stem = ext ? wanted.slice(0, -ext.length) : wanted;
    for (let n = 2; this.taken.has(name.toLowerCase()); n++) {
      name = `${stem} (${n})${ext}`;
    }
    this.taken.add(name.toLowerCase());
    return name;
  }
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** State of one extraction: the count, and (optionally) a list to collect problems in. */
class Extraction {
  count = 0;
  bytes = 0;
  current = '';
  /** True while a file's data is being written, so progress can count it before it is finished. */
  private inFlight = false;

  /**
   * With a list, a file that cannot be extracted is recorded there and the run carries on.
   * Without one, the first failure propagates, as it always did.
   */
  constructor(
    readonly problems?: ExtractProblem[],
    readonly hooks?: ExtractHooks
  ) {}

  /** Stop at the next safe point if the caller asked to. Never swallowed by per-file error handling. */
  throwIfCancelled(): void {
    if (this.hooks?.isCancelled?.()) throw new ExtractCancelledError();
  }

  /** Account for bytes just written, and tell the caller. */
  wrote(bytes: number): void {
    this.bytes += bytes;
    this.report();
  }

  report(): void {
    this.hooks?.onProgress?.({
      files: this.count + (this.inFlight ? 1 : 0),
      bytes: this.bytes,
      current: this.current
    });
  }

  /** Mark the file whose data is about to be written, so progress shows it while it is written. */
  beginItem(): void {
    this.inFlight = true;
  }

  endItem(): void {
    this.inFlight = false;
  }

  note(problem: ExtractProblem): void {
    this.problems?.push(problem);
    this.hooks?.onProblem?.(problem);
  }

  /** Pick the on-disk name for a child, recording a rename, and refuse anything outside `outDir`. */
  place(outDir: string, names: DirectoryNames, rawName: string, shown: string): string {
    const name = names.claim(safeFileName(rawName));
    if (name !== rawName) {
      this.note({
        path: shown,
        kind: 'renamed',
        reason: `Saved as "${name}": the name is not valid on Windows or is already used in this folder.`
      });
    }
    const dest = path.join(outDir, name);
    const rel = path.relative(outDir, dest);
    // `..` is only a parent reference as a whole path segment: `..hidden` and `.._x` are ordinary names.
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Refusing to write outside the destination folder: ${rawName}`);
    }
    return dest;
  }

  /** Run one item. `work` returns false when it did not produce a file, so it is not counted. */
  attempt(shown: string, work: () => boolean | void): void {
    this.throwIfCancelled();
    this.current = shown;
    if (!this.problems) {
      if (work() !== false) this.count++;
      this.report();
      return;
    }
    try {
      if (work() !== false) this.count++;
    } catch (err) {
      // Stopping on request is not a file that failed: let it out of the loop.
      if (err instanceof ExtractCancelledError) throw err;
      this.problems.push({ path: shown, kind: 'skipped', reason: describeError(err) });
    }
    this.report();
  }
}

/**
 * Write a file a piece at a time, so its size is not limited by what one Buffer can hold
 * (4 GiB under the Node that Electron 28 ships) and it is not held in memory whole. A partly
 * written file is removed on failure: it would otherwise look like a complete, shorter one.
 */
function writeStreamed(dest: string, produce: (emit: (chunk: Buffer) => void) => void, ex?: Extraction): void {
  const fd = fs.openSync(dest, 'w');
  let finished = false;
  ex?.beginItem();
  try {
    produce((chunk) => {
      // Checked before each piece, so cancelling a multi-gigabyte file stops within one piece and the
      // partly written file is removed below rather than left looking complete.
      ex?.throwIfCancelled();
      let written = 0;
      while (written < chunk.length) {
        written += fs.writeSync(fd, chunk, written, chunk.length - written);
      }
      ex?.wrote(chunk.length);
    });
    finished = true;
  } finally {
    ex?.endItem();
    fs.closeSync(fd);
    if (!finished) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // already gone
      }
    }
  }
}

/** Give an extracted file or folder its original modified time, as the image records it. */
function applyTimes(dest: string, unixSeconds: number | undefined): void {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return;
  try {
    fs.utimesSync(dest, unixSeconds, unixSeconds);
  } catch {
    // best effort: a destination that cannot hold the time still holds the data
  }
}

const ntfsToUnixSeconds = (t100ns: number | undefined): number | undefined =>
  t100ns ? t100ns / 1e7 - 11644473600 : undefined;

/**
 * Extract a file (or a directory recursively) to `outPath` on the host.
 *
 * Pass `problems` to extract a folder without one bad file ending the run: files that cannot
 * be recovered are listed there (with the reason) and the rest are still written, and names
 * that had to change to be valid on Windows are noted too. Extracting a single file always
 * throws on failure, so its exact reason reaches the caller.
 *
 * `hooks` lets a caller watch a long extraction and stop it. `isCancelled` is polled between files
 * and between the pieces of a file; when it returns true the extraction throws `ExtractCancelledError`
 * (with the number of files already written) and removes the file it was part-way through.
 */
export function extractPath(
  session: BrowseSession,
  relPath: string,
  outPath: string,
  problems?: ExtractProblem[],
  hooks?: ExtractHooks
): number {
  const ex = new Extraction(problems, hooks);
  ex.current = relPath;
  try {
    if (session.filesystem === 'fat32') {
      extractFat32(session, relPath, outPath, ex);
    } else if (session.filesystem === 'exfat') {
      extractExfat(session, relPath, outPath, ex);
    } else {
      extractNtfs(session, relPath, outPath, ex);
    }
  } catch (err) {
    if (err instanceof ExtractCancelledError) err.files = ex.count;
    throw err;
  }
  return ex.count;
}

const joinShown = (dir: string, name: string): string => (dir === '' || dir === '/' ? `/${name}` : `${dir}/${name}`);

function copyNtfsFile(session: NtfsBrowseSession, rec: NtfsFile, dest: string, ex: Extraction): void {
  writeStreamed(dest, (emit) => forEachNtfsFileChunk(session.reader, session.layout, rec, emit), ex);
  writeAlternateStreams(session, rec, dest);
  applyTimes(dest, ntfsToUnixSeconds(rec.modified));
}

function extractNtfs(session: NtfsBrowseSession, relPath: string, outPath: string, ex: Extraction): void {
  const rec = resolveNtfsPath(session, relPath);
  if (!rec) throw new Error(`Path not found: ${relPath}`);
  if (rec.isDirectory) {
    const isRoot = rec.recordNumber === session.rootId;
    const dir = isRoot ? outPath : path.join(outPath, safeFileName(rec.name?.name ?? ''));
    fs.mkdirSync(dir, { recursive: true });
    extractNtfsDir(session, rec.recordNumber, dir, relPath, ex, new Set());
    applyTimes(dir, ntfsToUnixSeconds(rec.modified));
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    copyNtfsFile(session, rec, outPath, ex);
    ex.count = 1;
  }
}

function extractNtfsDir(
  session: NtfsBrowseSession,
  recordNumber: number,
  outDir: string,
  shownDir: string,
  ex: Extraction,
  ancestors: Set<number>
): void {
  const here = new Set(ancestors).add(recordNumber);
  const names = new DirectoryNames();
  for (const node of session.children.get(recordNumber) ?? []) {
    // The root record lists itself as a child (its $FILE_NAME parent is 5);
    // extracting it would recurse into the same directory forever.
    if (node.recordNumber === recordNumber) continue;
    const shown = joinShown(shownDir, node.name);
    ex.attempt(shown, () => {
      // A damaged directory index can point back at a folder already being extracted.
      if (here.has(node.recordNumber)) throw new Error('This folder loops back to one of its parent folders.');
      const rec = session.records.get(node.recordNumber);
      if (!rec) throw new Error('Its file record could not be read.');
      const dest = ex.place(outDir, names, node.name, shown);
      if (rec.isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        extractNtfsDir(session, rec.recordNumber, dest, shown, ex, here);
        applyTimes(dest, ntfsToUnixSeconds(rec.modified));
        return false;
      }
      try {
        copyNtfsFile(session, rec, dest, ex);
      } catch (err) {
        // An EFS file whose key cannot be unwrapped locally is skipped rather
        // than aborting the extraction of everything around it.
        if (err instanceof EfsEncryptedError) {
          ex.note({ path: shown, kind: 'skipped', reason: 'Encrypted with EFS, and its key is not available on this computer.' });
          return false;
        }
        throw err;
      }
      return true;
    });
  }
}

function copyFat32File(session: Fat32BrowseSession, entry: Fat32Entry, dest: string, ex: Extraction): void {
  writeStreamed(
    dest,
    (emit) => forEachFat32FileChunk(session.reader, session.layout, entry.startCluster, entry.size, emit),
    ex
  );
  applyTimes(dest, entry.modified);
}

function extractFat32(session: Fat32BrowseSession, relPath: string, outPath: string, ex: Extraction): void {
  const entry = resolveFat32Path(session, relPath);
  if (!entry) throw new Error(`Path not found: ${relPath}`);
  if (entry.isDirectory) {
    const dir = entry.name === '' ? outPath : path.join(outPath, safeFileName(entry.name));
    fs.mkdirSync(dir, { recursive: true });
    extractFat32Dir(session, entry.startCluster, dir, relPath, ex, new Set());
    applyTimes(dir, entry.modified);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    copyFat32File(session, entry, outPath, ex);
    ex.count = 1;
  }
}

function extractFat32Dir(
  session: Fat32BrowseSession,
  cluster: number,
  outDir: string,
  shownDir: string,
  ex: Extraction,
  ancestors: Set<number>
): void {
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listFat32Directory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  const here = new Set(ancestors).add(cluster);
  const names = new DirectoryNames();
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const shown = joinShown(shownDir, entry.name);
    ex.attempt(shown, () => {
      if (entry.isDirectory && here.has(entry.startCluster)) {
        throw new Error('This folder loops back to one of its parent folders.');
      }
      const dest = ex.place(outDir, names, entry.name, shown);
      if (entry.isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        extractFat32Dir(session, entry.startCluster, dest, shown, ex, here);
        applyTimes(dest, entry.modified);
        return false;
      }
      copyFat32File(session, entry, dest, ex);
      return true;
    });
  }
}

function copyExfatFile(session: ExfatBrowseSession, entry: ExfatEntry, dest: string, ex: Extraction): void {
  writeStreamed(
    dest,
    (emit) =>
      forEachExfatFileChunk(session.reader, session.layout, entry.startCluster, entry.size, emit, {
        noFatChain: entry.noFatChain,
        validDataLength: entry.validDataLength
      }),
    ex
  );
  applyTimes(dest, entry.modified);
}

function extractExfat(session: ExfatBrowseSession, relPath: string, outPath: string, ex: Extraction): void {
  const entry = resolveExfatPath(session, relPath);
  if (!entry) throw new Error(`Path not found: ${relPath}`);
  if (entry.isDirectory) {
    const dir = entry.name === '' ? outPath : path.join(outPath, safeFileName(entry.name));
    fs.mkdirSync(dir, { recursive: true });
    extractExfatDir(session, entry.startCluster, dir, relPath, ex, new Set());
    applyTimes(dir, entry.modified);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    copyExfatFile(session, entry, outPath, ex);
    ex.count = 1;
  }
}

function extractExfatDir(
  session: ExfatBrowseSession,
  cluster: number,
  outDir: string,
  shownDir: string,
  ex: Extraction,
  ancestors: Set<number>
): void {
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listExfatDirectory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  const here = new Set(ancestors).add(cluster);
  const names = new DirectoryNames();
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const shown = joinShown(shownDir, entry.name);
    ex.attempt(shown, () => {
      if (entry.isDirectory && here.has(entry.startCluster)) {
        throw new Error('This folder loops back to one of its parent folders.');
      }
      const dest = ex.place(outDir, names, entry.name, shown);
      if (entry.isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        extractExfatDir(session, entry.startCluster, dest, shown, ex, here);
        applyTimes(dest, entry.modified);
        return false;
      }
      copyExfatFile(session, entry, dest, ex);
      return true;
    });
  }
}

/** Format an NTFS 100ns timestamp (since 1601) as an ISO string. */
export function formatTimestamp(t100ns?: number): string {
  if (!t100ns) return '';
  const ms = t100ns / 10000 - 11644473600000;
  return new Date(ms).toISOString();
}
