/**
 * One-off screenshot capture for the guide pages.
 *
 * Run with: node tools/capture-screenshots.mjs
 *
 * It launches the real app through Playwright (the same harness as
 * test/integration/gui-click.test.ts), walks the sidebar views, and writes
 * PNGs to docs/images/. Re-run after the UI changes and the guide picks the
 * new images up automatically — the files have stable names.
 */
import { _electron as electron } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');

// Sidebar label -> output file. Order is the order they are captured in.
const VIEWS = [
  { label: 'Dashboard', file: 'dashboard.png' },
  { label: 'New Backup', file: 'new-backup.png' },
  { label: 'Restore', file: 'restore.png' },
  { label: 'Browse Files', file: 'browse-files.png' },
  { label: 'Recovery Media', file: 'recovery-media.png' },
  { label: 'Repositories', file: 'repositories.png' }
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('launching app…');

  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    timeout: 60_000
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  // Let the first paint settle; the app fetches disk state on start.
  await page.waitForTimeout(2500);

  for (const view of VIEWS) {
    try {
      // The nav buttons carry an emoji icon before the label, so match on
      // contained text rather than the accessible name.
      const button = page.locator('button.nav-item', { hasText: view.label }).first();
      await button.click({ timeout: 8000 });
      await page.waitForTimeout(1200);
      const file = path.join(OUT, view.file);
      await page.screenshot({ path: file });
      console.log('captured', path.relative(ROOT, file));
    } catch (error) {
      console.log('skipped', view.label, '-', error instanceof Error ? error.message.split('\n')[0] : error);
    }
  }

  await app.close();
  console.log('done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
