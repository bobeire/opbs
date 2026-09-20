/**
 * Backup-location URI handling.
 *
 * OPBS stores images under a `destinationPath` (or `backupLocation`) that is
 * normally a local filesystem directory. This module normalises URI-style
 * locations into the filesystem path the engines use, and classifies locations
 * that are not a plain filesystem (S3/SFTP) so a streaming backend can be
 * attached later.
 */

/** Normalise a backup location into a filesystem path (Windows-oriented). */
export function normalizeBackupLocation(location: string): string {
  const trimmed = (location || '').trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('file://')) {
    const url = new URL(trimmed);
    const p = decodeURIComponent(url.pathname);
    if (url.hostname) {
      // file://server/share/path -> UNC \\server\share\path
      return `\\\\${url.hostname}${p.replace(/\//g, '\\')}`;
    }
    // file:///C:/path -> C:\path
    const pathPart = /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
    return pathPart.replace(/\//g, '\\');
  }

  if (trimmed.startsWith('smb://') || trimmed.startsWith('smb3://')) {
    const url = new URL(trimmed);
    const p = decodeURIComponent(url.pathname);
    return `\\\\${url.hostname}${p.replace(/\//g, '\\')}`;
  }

  // Already a UNC path or plain local path: normalise separators.
  return trimmed.replace(/\//g, '\\');
}

/** True when a location is not a filesystem path (S3/SFTP/FTP) and needs a
 *  streaming backend rather than direct fs access. */
export function isNonFilesystemLocation(location: string): boolean {
  const l = (location || '').trim().toLowerCase();
  return l.startsWith('s3://') || l.startsWith('sftp://') || l.startsWith('ftp://') || l.startsWith('ftps://');
}

/**
 * Detect the filesystem type of a given path. Returns the FS type string
 * (e.g. 'FAT32', 'NTFS', 'exFAT') or null if detection fails.
 */
export function detectFilesystemType(filePath: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const match = filePath.match(/^([A-Za-z]):/);
    if (!match) return null;
    const drive = match[1];
    // Try fsutil first (built-in, reliable in elevated contexts).
    try {
      const out = execFileSync(
        'fsutil',
        ['fsinfo', 'volumeinfo', `${drive}:`],
        { windowsHide: true, timeout: 10000, encoding: 'utf-8' }
      );
      // Look for "File System Name : NTFS" or "File System Name : FAT32"
      const m = out.match(/File System Name\s*:\s*(\S+)/i);
      if (m) return m[1];
    } catch {
      // fsutil failed; try wmic.
    }
    try {
      const out = execFileSync(
        'wmic',
        ['logicaldisk', 'where', `DeviceID='${drive}:'`, 'get', 'FileSystem', '/value'],
        { windowsHide: true, timeout: 10000, encoding: 'utf-8' }
      );
      const m = out.match(/FileSystem=(\S+)/);
      if (m) return m[1];
    } catch {
      // wmic failed.
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * If the destination filesystem is FAT32, return the max volume size for
 * multi-volume splitting (3.9 GB — slightly under the 4 GB FAT32 limit).
 * Returns 0 for filesystems with no per-file size limit.
 */
export function getMaxVolumeSizeForFs(fsType: string | null): number {
  if (fsType === 'FAT32') return Math.floor(3.9 * 1024 * 1024 * 1024); // 3.9 GB
  return 0;
}

/** True when a location points at a network share (UNC or SMB). */
export function isNetworkLocation(location: string): boolean {
  const t = (location || '').trim();
  return t.startsWith('\\\\') || t.startsWith('smb://') || t.startsWith('smb3://');
}
