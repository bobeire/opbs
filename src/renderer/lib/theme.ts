/** Theme modes offered in Settings → Appearance. */
export type ThemeMode = 'system' | 'light' | 'dark';

const CACHE_KEY = 'opbs-theme';
let systemQuery: MediaQueryList | null = null;

function systemResolved(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function setResolved(resolved: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    // Mirrored so the next launch paints the right palette before React
    // mounts (the saved mode itself arrives over IPC a moment later).
    localStorage.setItem(CACHE_KEY, resolved);
  } catch {
    /* private-mode storage failures are non-fatal */
  }
}

function onSystemChange(): void {
  setResolved(systemResolved());
}

/**
 * Apply a saved theme mode. `system` follows the OS (Windows) theme and
 * stays live via the `prefers-color-scheme` media query — Electron exposes
 * the native theme that way. Missing/unknown values fall back to dark, the
 * app's default, which is also what the CSS ships before this ever runs.
 */
export function applyTheme(mode?: string): void {
  if (systemQuery) {
    systemQuery.removeEventListener('change', onSystemChange);
    systemQuery = null;
  }
  if (mode === 'system') {
    setResolved(systemResolved());
    systemQuery = window.matchMedia('(prefers-color-scheme: light)');
    systemQuery.addEventListener('change', onSystemChange);
    return;
  }
  setResolved(mode === 'light' ? 'light' : 'dark');
}

/** Synchronous first-paint: apply the cached resolution before React mounts. */
export function initTheme(): void {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached === 'light' || cached === 'dark') {
      document.documentElement.setAttribute('data-theme', cached);
    }
  } catch {
    /* ignore */
  }
}
