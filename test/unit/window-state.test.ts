import { describe, it, expect } from 'vitest';
import {
  sanitizeWindowState,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT
} from '../../src/main/utils/window-state';

// A typical 1920x1080 display with a 40px taskbar.
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

describe('sanitizeWindowState', () => {
  it('keeps a valid state as-is', () => {
    const result = sanitizeWindowState(
      { x: 100, y: 80, width: 1400, height: 900, maximized: true },
      [WORK_AREA]
    );
    expect(result).toEqual({ x: 100, y: 80, width: 1400, height: 900, maximized: true });
  });

  it('clamps smaller-than-minimum sizes up to the window minimums', () => {
    const result = sanitizeWindowState(
      { x: 10, y: 10, width: 400, height: 300, maximized: false },
      [WORK_AREA]
    );
    expect(result).toEqual({
      x: 10,
      y: 10,
      width: WINDOW_MIN_WIDTH,
      height: WINDOW_MIN_HEIGHT,
      maximized: false
    });
  });

  it('rejects a window that sits entirely outside every display', () => {
    expect(
      sanitizeWindowState({ x: 5000, y: 5000, width: 1200, height: 800, maximized: false }, [
        WORK_AREA
      ])
    ).toBeNull();
    expect(
      sanitizeWindowState({ x: -3000, y: 100, width: 1200, height: 800, maximized: false }, [
        WORK_AREA
      ])
    ).toBeNull();
  });

  it('accepts a window that is only partially visible (title bar reachable)', () => {
    // x=1840 leaves exactly the 80px grab strip on the 1920-wide work area.
    const result = sanitizeWindowState(
      { x: 1840, y: -20, width: 1200, height: 800, maximized: false },
      [WORK_AREA]
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBe(1840);
  });

  it('rejects a window with only a sliver (under the grab margin) visible', () => {
    expect(
      sanitizeWindowState({ x: 1860, y: -20, width: 1200, height: 800, maximized: false }, [
        WORK_AREA
      ])
    ).toBeNull();
  });

  it('rounds fractional geometry from scaled displays', () => {
    const result = sanitizeWindowState(
      { x: 100.6, y: 80.4, width: 1200.5, height: 800.7, maximized: false },
      [WORK_AREA]
    );
    expect(result).toEqual({ x: 101, y: 80, width: 1201, height: 801, maximized: false });
  });

  it('rejects garbage instead of restoring it', () => {
    expect(sanitizeWindowState(null, [WORK_AREA])).toBeNull();
    expect(sanitizeWindowState(undefined, [WORK_AREA])).toBeNull();
    expect(sanitizeWindowState('1200x800', [WORK_AREA])).toBeNull();
    expect(
      sanitizeWindowState({ x: NaN, y: 0, width: 1200, height: 800 }, [WORK_AREA])
    ).toBeNull();
    expect(
      sanitizeWindowState({ x: 10, y: 10, width: 'wide', height: 800 }, [WORK_AREA])
    ).toBeNull();
    expect(sanitizeWindowState({ x: 10, y: 10, width: 1200, height: 800 }, [])).toBeNull();
  });

  it('treats a missing or non-true maximized flag as not maximized', () => {
    expect(
      sanitizeWindowState({ x: 10, y: 10, width: 1200, height: 800 }, [WORK_AREA])!.maximized
    ).toBe(false);
    expect(
      sanitizeWindowState(
        { x: 10, y: 10, width: 1200, height: 800, maximized: 'yes' },
        [WORK_AREA]
      )!.maximized
    ).toBe(false);
  });
});
