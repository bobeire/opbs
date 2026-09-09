import * as fs from 'fs';
import * as path from 'path';
import { resolveImageChain } from '../restore-engine';
import { PartitionReader, partitionReaderForChain } from '../image-browse';
import { parseBootSector, readFileRecords, buildTree, readFileData, readStreamData, readDirectoryIndex, NtfsFile, NtfsLayout, NtfsNode } from './ntfs';
import { detectMacriumFormat, readMacriumImage, openMacriumPartitionReader, MacriumUnsupportedError } from '../mrimg';

/**
 * High-level file browsing/extraction over a backup image (OPBS `.opbs` chain
 * or a Macrium Reflect `.mrimgx`).
 *
 * Resolves the image, opens a partition reader over it, then parses NTFS on
 * the fly so users can list directories and extract individual files without
 * restoring the whole disk.
 */

export interface BrowseSession {
  imagePath: string;
  chain: string[];
  partitionIndex: number;
  reader: PartitionReader;
  layout: NtfsLayout;
  records: Map<number, NtfsFile>;
  children: Map<number, NtfsNode[]>;
  rootRecord: number;
}

/** Open a browse session for a partition in an image chain. */
export function openBrowse(
  imagePath: string,
  partitionIndex: number,
  key?: Buffer
): BrowseSession {
  const chain = resolveImageChain(imagePath);
  const { reader } = partitionReaderForChain(chain, partitionIndex, key);
  return openBrowseFromReader(imagePath, partitionIndex, reader);
}

/**
 * Open a browse session over an already-built `PartitionReader` (the shared
 * NTFS parse step behind both .opbs and Macrium images).
 */
export function openBrowseFromReader(
  imagePath: string,
  partitionIndex: number,
  reader: PartitionReader
): BrowseSession {
  const layout = parseBootSector(reader);
  const fileRecords = readFileRecords(reader, layout);
  const records = new Map<number, NtfsFile>();
  for (const rec of fileRecords) {
    records.set(rec.recordNumber, rec);
  }
  const children = buildTree(fileRecords);
  return { imagePath, chain: [imagePath], partitionIndex, reader, layout, records, children, rootRecord: 5 };
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

function splitPath(relPath: string): string[] {
  return relPath.replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean);
}

/** Resolve a case-insensitive path (relative to the volume root) to a file record. */
export function resolvePath(session: BrowseSession, relPath: string): NtfsFile | null {
  const segs = splitPath(relPath);
  if (segs.length === 0) {
    return session.records.get(session.rootRecord) ?? null;
  }
  let parentRecord = session.rootRecord;
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

/** List the direct children of a directory path (empty = volume root). */
export function listDirectory(session: BrowseSession, relPath = ''): NtfsNode[] {
  const target = relPath.trim().length > 0 ? resolvePath(session, relPath) : session.records.get(session.rootRecord);
  if (!target) throw new Error(`Directory not found: ${relPath}`);

  // Prefer the "$I30" index when present (efficient for large directories);
  // otherwise fall back to the pre-built tree from parent references.
  const indexEntries = readDirectoryIndex(session.reader, session.layout, target);
  if (indexEntries.length > 0) {
    const nodes: NtfsNode[] = [];
    for (const e of indexEntries) {
      const rec = session.records.get(e.fileReference);
      if (rec && rec.inUse && rec.name) {
        nodes.push({
          recordNumber: rec.recordNumber,
          name: e.name,
          parentRecord: target.recordNumber,
          isDirectory: rec.isDirectory,
          size: rec.size,
          modified: rec.modified,
          isEncrypted: rec.isEncrypted
        });
      }
    }
    return nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return session.children.get(target.recordNumber) ?? [];
}

/** Read the bytes of a file path. */
export function readPath(session: BrowseSession, relPath: string): Buffer {
  const rec = resolvePath(session, relPath);
  if (!rec) throw new Error(`File not found: ${relPath}`);
  if (rec.isDirectory) throw new Error(`Is a directory: ${relPath}`);
  return readFileData(session.reader, session.layout, rec);
}

/** Write a file's alternate data streams (ADS) as `file:stream` on NTFS. */
function writeAlternateStreams(session: BrowseSession, rec: NtfsFile, dest: string): void {
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
  const rec = resolvePath(session, relPath);
  if (!rec) throw new Error(`Path not found: ${relPath}`);
  let extracted = 0;
  if (rec.isDirectory) {
    const dir = path.join(outPath, rec.name?.name ?? '');
    fs.mkdirSync(dir, { recursive: true });
    extracted += extractDirectory(session, rec.recordNumber, dir);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, readFileData(session.reader, session.layout, rec));
    writeAlternateStreams(session, rec, outPath);
    extracted = 1;
  }
  return extracted;
}

function extractDirectory(session: BrowseSession, recordNumber: number, outDir: string): number {
  let count = 0;
  for (const node of session.children.get(recordNumber) ?? []) {
    const rec = session.records.get(node.recordNumber)!;
    const dest = path.join(outDir, node.name);
    if (rec.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      count += extractDirectory(session, rec.recordNumber, dest);
    } else {
      fs.writeFileSync(dest, readFileData(session.reader, session.layout, rec));
      writeAlternateStreams(session, rec, dest);
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
