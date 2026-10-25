/**
 * Main-window geometry persistence: validate a saved state against the
 * current display work areas before restoring it, so a window saved on a
 * monitor that no longer exists (or a moved/resized desktop) can never come
 * back off-screen or microscopic.
 */

/** Keep in sync with the BrowserWindow min sizes in createWindow(). */
export const WINDOW_MIN_WIDTH = 900;
export const WINDOW_MIN_HEIGHT = 600;

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixels of the window that must sit on some work area to be reachable. */
const VISIBLE_MARGIN = 80;

/**
 * Return a usable window state, or null when the saved values are garbage
 * or land the window entirely outside every current display (caller falls
 * back to the default size in that case).
 */
export function sanitizeWindowState(saved: unknown, workAreas: Rect[]): WindowState | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  const nums = [s.x, s.y, s.width, s.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (workAreas.length === 0) return null;

  const width = Math.max(WINDOW_MIN_WIDTH, Math.round(s.width as number));
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.round(s.height as number));
  const x = Math.round(s.x as number);
  const y = Math.round(s.y as number);

  const reachable = workAreas.some((wa) => {
    const overlapX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const overlapY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    return overlapX >= Math.min(VISIBLE_MARGIN, width) && overlapY >= Math.min(VISIBLE_MARGIN, height);
  });
  if (!reachable) return null;

  return { x, y, width, height, maximized: s.maximized === true };
}
