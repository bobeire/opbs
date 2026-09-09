import { test, expect } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as path from 'path';

const APP_ROOT = path.resolve(__dirname, '../..');

interface NavTarget {
  label: string;
  heading: RegExp;
}

// Ordered sidebar navigation in src/renderer/App.tsx. Each entry maps the clickable
// nav button (accessible name) to a marker expected on the rendered page.
const NAV: NavTarget[] = [
  { label: /Dashboard/, heading: /Dashboard/i },
  { label: /New Backup/, heading: /New Backup/i },
  { label: /Restore/, heading: /Restore/i },
  { label: /Browse Files/, heading: /Browse/i },
  { label: /Recovery Media/, heading: /Recovery Media|Media/i },
  { label: /Settings/, heading: /Settings/i }
];

const PAGE_ERRORS: string[] = [];

test(
  'launches the app and click-tests every sidebar view without errors',
  async () => {
    const app: ElectronApplication = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Spawned shells resolve cmd.exe via PATH; this bash environment
      // strips System32, so re-add it for playwright's launcher.
      PATH: [process.env.PATH, 'C:\\Windows\\System32', 'C:\\Windows'].filter(Boolean).join(';')
    }
  });

  try {
    const win: Page = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    win.on('pageerror', (error) => PAGE_ERRORS.push(String(error)));

    expect(await win.title()).toContain('OPBS');

    for (const target of NAV) {
      const navButton = win.locator('.nav-item', { hasText: target.label });
      await navButton.click();
      // The clicked nav item is the active one and a page with a matching heading renders.
      const activeNav = win.locator('.nav-item.active');
      await activeNav.waitFor({ state: 'visible' });
      expect((await activeNav.textContent()) ?? '').toMatch(target.label);
      const content = win.locator('.main-content');
      await content.waitFor({ state: 'visible' });
      expect((await content.textContent()) ?? '').toMatch(target.heading);
    }

    // Every view navigated without a single renderer-side uncaught error.
    expect(PAGE_ERRORS).toEqual([]);
  } finally {
    await app.close();
  }
  },
  120000
);