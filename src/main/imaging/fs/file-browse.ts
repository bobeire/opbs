import * as fs from 'fs';
import * as path from 'path';
import { resolveImageChain } from '../restore-engine';
import { PartitionReader, partitionReaderForChain } from '../image-browse';
import { baseVolumePath } from '../image-format';
import { logger } from '../../utils/logger';
import { parseBootSector, readFileRecords, buildTree, readFileData, readStreamData, readDirectoryIndex, NtfsFile, NtfsLayout, NtfsNode } from './ntfs';
import { parseFat32BootSector, listFat32Directory, readFileData as readFat32FileData, Fat32Layout, Fat32Entry, clusterToOffset, readFatChain, readClusterChain, detectFatType } from './fat32';
import { parseExfatBootSector, listExfatDirectory, readExfatFileData, detectExfat, ExfatLayout, ExfatEntry } from './exfat';
import { detectMacriumFormat, readMacriumImage, openMacriumPartitionReader, MacriumUnsupportedError } from '../mrimg';

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
  /** True for EFS-encrypted files (NTFS only); the renderer locks extraction. */
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

/** Open a browse session for a partition in an image chain. */
export function openBrowse(
  imagePath: string,
  partitionIndex: number,
  key?: Buffer
): BrowseSession {
  // Normalise a multi-volume path (`.001`, `.002`, ...) to the base image so
  // chain resolution and volume mapping start from volume 0.
  const basePath = baseVolumePath(imagePath);
  const chain = resolveImageChain(basePath);
  const { reader } = partitionReaderForChain(chain, partitionIndex, key);
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
export function openAnyBrowse(imagePath: string, partitionIndex: number, key?: Buffer): BrowseSession {
  const format = detectMacriumFormat(imagePath);
  if (format) {
    const info = readMacriumImage(imagePath);
    const reader = openMacriumPartitionReader(info, partitionIndex);
    return openBrowseFromReader(imagePath, partitionIndex, reader);
  }
  return openBrowse(imagePath, partitionIndex, key);
}

/**
 * Detect a partition's filesystem type by reading just its boot sector.
 * Cheap relative to a full browse-session parse. Returns the filesystem name
 * and whether the built-in browser can read it (NTFS or FAT32).
 */
export function detectPartitionFilesystem(
  imagePath: string,
  partitionIndex: number,
  key?: Buffer
): { fsType: string; browsable: boolean } {
  try {
    const format = detectMacriumFormat(imagePath);
    let reader: PartitionReader;
    if (format) {
      const info = readMacriumImage(imagePath);
      reader = openMacriumPartitionReader(info, partitionIndex);
    } else {
      const basePath = baseVolumePath(imagePath);
      const chain = resolveImageChain(basePath);
      reader = partitionReaderForChain(chain, partitionIndex, key).reader;
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
    return { fsType: oem.trim() || 'Unknown', browsable: false };
  } catch (e) {
    logger.warn(`detectPartitionFilesystem: partition ${partitionIndex} failed: ${e instanceof Error ? e.message : e}`);
    return { fsType: 'Unknown', browsable: false };
  }
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
    const kids = session.children.get(parentRecord) ?? [];
    const match = kids.find((n) => n.name === seg || n.name.toLowerCase() === seg.toLowerCase());
    if (!match) return null;
    if (i === segs.length - 1) {
      return session.records.get(match.recordNumber) ?? null;
    }
    if (!match.isDirectory) return null;
    parentRecord = match.recordNumber;
  }
  return session.records.get(parentRecord) ?? null;
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
  const segs = splitPath(relPath);
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
    let missing = 0;
    for (const e of indexEntries) {
      const rec = session.records.get(e.fileReference);
      if (rec && rec.inUse && rec.name) {
        nodes.push({
          name: e.name,
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
      if (missing > 0) {
        logger.warn(
          `listNtfs: "${relPath || '/'}" resolved ${nodes.length}/${indexEntries.length} index entries ` +
            `(${missing} missing from the MFT cache of ${session.records.size} records)`
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
    return readExfatFileData(session.reader, session.layout, entry.startCluster, entry.size);
  }
  const rec = resolveNtfsPath(session, relPath);
  if (!rec) throw new Error(`File not found: ${relPath}`);
  if (rec.isDirectory) throw new Error(`Is a directory: ${relPath}`);
  return readFileData(session.reader, session.layout, rec);
}

/** Write a file's alternate data streams (ADS) as `file:stream` on NTFS. */
function writeAlternateStreams(session: NtfsBrowseSession, rec: NtfsFile, dest: string): void {
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

/** Extract a file (or a directory recursively) to `outPath` on the host. */
export function extractPath(session: BrowseSession, relPath: string, outPath: string): number {
  if (session.filesystem === 'fat32') {
    return extractFat32(session, relPath, outPath);
  }
  if (session.filesystem === 'exfat') {
    return extractExfat(session, relPath, outPath);
  }
  return extractNtfs(session, relPath, outPath);
}

function extractNtfs(session: NtfsBrowseSession, relPath: string, outPath: string): number {
  const rec = resolveNtfsPath(session, relPath);
  if (!rec) throw new Error(`Path not found: ${relPath}`);
  let extracted = 0;
  if (rec.isDirectory) {
    const dir = path.join(outPath, rec.name?.name ?? '');
    fs.mkdirSync(dir, { recursive: true });
    extracted += extractNtfsDir(session, rec.recordNumber, dir);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, readFileData(session.reader, session.layout, rec));
    writeAlternateStreams(session, rec, outPath);
    extracted = 1;
  }
  return extracted;
}

function extractNtfsDir(session: NtfsBrowseSession, recordNumber: number, outDir: string): number {
  let count = 0;
  for (const node of session.children.get(recordNumber) ?? []) {
    const rec = session.records.get(node.recordNumber)!;
    const dest = path.join(outDir, node.name);
    if (rec.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      count += extractNtfsDir(session, rec.recordNumber, dest);
    } else {
      fs.writeFileSync(dest, readFileData(session.reader, session.layout, rec));
      writeAlternateStreams(session, rec, dest);
      count++;
    }
  }
  return count;
}

function extractFat32(session: Fat32BrowseSession, relPath: string, outPath: string): number {
  const entry = resolveFat32Path(session, relPath);
  if (!entry) throw new Error(`Path not found: ${relPath}`);
  let extracted = 0;
  if (entry.isDirectory) {
    const dir = path.join(outPath, entry.name);
    fs.mkdirSync(dir, { recursive: true });
    extracted += extractFat32Dir(session, entry.startCluster, dir);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, readFat32FileData(session.reader, session.layout, entry.startCluster, entry.size));
    extracted = 1;
  }
  return extracted;
}

function extractFat32Dir(session: Fat32BrowseSession, cluster: number, outDir: string): number {
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listFat32Directory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const dest = path.join(outDir, entry.name);
    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      count += extractFat32Dir(session, entry.startCluster, dest);
    } else {
      fs.writeFileSync(dest, readFat32FileData(session.reader, session.layout, entry.startCluster, entry.size));
      count++;
    }
  }
  return count;
}

function extractExfat(session: ExfatBrowseSession, relPath: string, outPath: string): number {
  const entry = resolveExfatPath(session, relPath);
  if (!entry) throw new Error(`Path not found: ${relPath}`);
  let extracted = 0;
  if (entry.isDirectory) {
    const dir = path.join(outPath, entry.name);
    fs.mkdirSync(dir, { recursive: true });
    extracted += extractExfatDir(session, entry.startCluster, dir);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, readExfatFileData(session.reader, session.layout, entry.startCluster, entry.size));
    extracted = 1;
  }
  return extracted;
}

function extractExfatDir(session: ExfatBrowseSession, cluster: number, outDir: string): number {
  let entries = session.directories.get(cluster);
  if (!entries) {
    entries = listExfatDirectory(session.reader, session.layout, cluster);
    session.directories.set(cluster, entries);
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const dest = path.join(outDir, entry.name);
    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      count += extractExfatDir(session, entry.startCluster, dest);
    } else {
      fs.writeFileSync(dest, readExfatFileData(session.reader, session.layout, entry.startCluster, entry.size));
      count++;
    }
  }
  return count;
}

/** Format an NTFS 100ns timestamp (since 1601) as an ISO string. */
export function formatTimestamp(t100ns?: number): string {
  if (!t100ns) return '';
  const ms = t100ns / 10000 - 11644473600000;
  return new Date(ms).toISOString();
}
