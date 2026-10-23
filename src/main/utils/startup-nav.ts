/**
 * `--open-page <page>` startup flag: lets a shortcut launch OPBS directly on
 * a sidebar page (e.g. `OPBS.exe --open-page browse`) instead of the
 * Dashboard. Works for the portable exe too — nothing installed.
 *
 * The allowlist mirrors the renderer's onNav whitelist (App.tsx), so the flag
 * can only jump between ordinary pages; anything else is ignored rather than
 * passed through to the renderer.
 */
export const OPEN_PAGE_ALLOWLIST = [
  'browse',
  'backup',
  'restore',
  'schedules',
  'vss',
  'copy',
  'disks',
  'repositories'
] as const;

export type OpenPage = (typeof OPEN_PAGE_ALLOWLIST)[number];

/** Parse a launching argv for `--open-page <allowlisted page>`. */
export function parseOpenPageArg(argv: string[]): OpenPage | null {
  const idx = argv.indexOf('--open-page');
  if (idx === -1) return null;
  const page = argv[idx + 1];
  if (!page || (OPEN_PAGE_ALLOWLIST as readonly string[]).includes(page) === false) {
    return null;
  }
  return page as OpenPage;
}
