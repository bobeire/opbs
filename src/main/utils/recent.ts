import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { normalizeBackupLocation, isNonFilesystemLocation } from './location';
import { logger } from './logger';

const MAX_DESTINATIONS = 12;

interface RecentFile {
  destinations: Array<{ path: string; lastBackupAt: number }>;
}

function recentFilePath(): string {
  return path.join(app.getPath('userData'), 'recent-backups.json');
}

function loadRecent(): RecentFile {
  try {
    const raw = fs.readFileSync(recentFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as RecentFile;
    if (!Array.isArray(parsed?.destinations)) return { destinations: [] };
    return parsed;
  } catch {
    return { destinations: [] };
  }
}

function saveRecent(data: RecentFile): void {
  try {
    fs.mkdirSync(path.dirname(recentFilePath()), { recursive: true });
    fs.writeFileSync(recentFilePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to save recent backups list', err);
  }
}

/** Record a destination that a backup was written to (most recent first). */
export function recordBackupDestination(destinationPath: string): void {
  if (!destinationPath) return;
  // S3/SFTP destinations are streams, not browseable directories.
  if (isNonFilesystemLocation(destinationPath)) return;
  const normalized = normalizeBackupLocation(destinationPath);
  if (!normalized) return;

  const data = loadRecent();
  let list = data.destinations.filter((d) => d.path.toLowerCase() !== normalized.toLowerCase());
  list = [{ path: normalized, lastBackupAt: Date.now() }, ...list].slice(0, MAX_DESTINATIONS);
  saveRecent({ destinations: list });
}

/** Add a directory the user asked to scan, even if no backup ran yet. */
export function addRecentDestination(directory: string): string[] {
  if (!directory) return getRecentDestinations();
  if (isNonFilesystemLocation(directory)) return getRecentDestinations();
  const normalized = normalizeBackupLocation(directory.trim());
  if (!normalized) return getRecentDestinations();
  const data = loadRecent();
  let list = data.destinations.filter((d) => d.path.toLowerCase() !== normalized.toLowerCase());
  list = [{ path: normalized, lastBackupAt: Date.now() }, ...list].slice(0, MAX_DESTINATIONS);
  saveRecent({ destinations: list });
  return list.map((d) => d.path);
}

/** Ordered list of known backup destinations, most recent first. */
export function getRecentDestinations(): string[] {
  try {
    const data = loadRecent();
    const existing: string[] = [];
    for (const d of data.destinations) {
      if (!d.path) continue;
      if (isNonFilesystemLocation(d.path)) continue;
      if (existing.some((p) => p.toLowerCase() === d.path.toLowerCase())) continue;
      existing.push(d.path);
    }
    return existing;
  } catch {
    return [];
  }
}