import * as fs from 'fs';
import * as path from 'path';

/** Path and glob helpers shared by the scanner, restore and mirror modes. */

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function windowsAbs(value: string): boolean {
  // Reject drive-relative forms too: `C:evil` depends on the process's current
  // directory on that drive and is not a safe manifest-relative path.
  return /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

/** Validate and canonicalize a manifest-relative path. */
export function normalizeRelativePath(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid empty or NUL-containing path');
  if (windowsAbs(value)) throw new Error(`Absolute paths are not allowed in snapshots: ${value}`);
  const parts = toPosix(value)
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0) throw new Error(`Invalid relative path: ${value}`);
  if (parts.some((part) => part === '..')) {
    throw new Error(`Parent traversal is not allowed in snapshots: ${value}`);
  }
  return parts.join('/');
}

/** A safe single path segment used to prefix each configured source. */
export function safeSegment(value: string, fallback = 'root'): string {
  const base = toPosix(path.basename(value)).replace(/[<>:"|?*]/g, '_');
  const segment = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return segment || fallback;
}

function normalizeForCompare(value: string): string {
  const abs = path.resolve(value);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function isInside(base: string, candidate: string): boolean {
  const separator = process.platform === 'win32' ? '\\' : '/';
  return candidate === base || candidate.startsWith(base + separator);
}

/** True when two configured paths are the same directory or nested. */
export function pathsOverlap(a: string, b: string): boolean {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  return isInside(left, right) || isInside(right, left);
}

/** Resolve a relative manifest path and prove it stays inside `target`. */
export function resolveWithinTarget(target: string, relative: string): string {
  const safe = normalizeRelativePath(relative);
  const base = normalizeForCompare(target);
  const candidate = path.resolve(target, ...safe.split('/'));
  const comparable = normalizeForCompare(candidate);
  if (!isInside(base, comparable)) {
    throw new Error(`Path escapes the target directory: ${relative}`);
  }
  return candidate;
}

function lstatExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lexical checks are not enough: a symlinked parent already inside the target
 * can redirect a write outside it. Check the nearest existing ancestor's real
 * path immediately before every write.
 */
export function assertRealPathInside(targetReal: string, candidate: string): void {
  let ancestor = path.dirname(candidate);
  while (!lstatExists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Could not resolve target ancestor for ${candidate}`);
    ancestor = parent;
  }
  const real = fs.realpathSync.native(ancestor);
  if (!isInside(normalizeForCompare(targetReal), normalizeForCompare(real))) {
    throw new Error(`Symlink redirects path outside the target: ${candidate}`);
  }
  if (lstatExists(candidate)) {
    const realCandidate = fs.realpathSync.native(candidate);
    if (!isInside(normalizeForCompare(targetReal), normalizeForCompare(realCandidate))) {
      throw new Error(`Symlink redirects path outside the target: ${candidate}`);
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Small, predictable glob matcher (no dependency, no path access). */
export function globToRegExp(pattern: string): RegExp {
  const value = toPosix(pattern).replace(/^\.\//, '');
  let source = '^';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '*') {
      if (value[i + 1] === '*') {
        i++;
        if (value[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = value.indexOf(']', i + 1);
      if (close === -1) {
        source += '\\[';
      } else {
        let body = value.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        source += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  source += '$';
  return new RegExp(source, 'i');
}

/** Excluding a directory also excludes everything below it. */
export function matchesAnyGlob(relative: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    if (
      re.test(relative) ||
      re.test(`${relative}/`) ||
      re.test(`${relative}/**`)
    ) {
      return true;
    }
  }
  return false;
}

/** Move a path, falling back to copy+unlink when the staging volume differs. */
export function movePath(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}
