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
  const t = (location || '').trim().toLowerCase();
  return t.startsWith('s3://') || t.startsWith('sftp://') || t.startsWith('ftp://');
}

/** True when a location points at a network share (UNC or SMB). */
export function isNetworkLocation(location: string): boolean {
  const t = (location || '').trim();
  return t.startsWith('\\\\') || t.startsWith('smb://') || t.startsWith('smb3://');
}
