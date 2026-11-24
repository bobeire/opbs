# Interface modes: Standard and Advanced

## Purpose

OPBS has one window with many power-user tools in its sidebar. This document specifies a **Standard** view that reduces the navigation surface for new users, while existing installs keep the current **Advanced** view.

This is a renderer-only presentation setting. It does not change backup, restore, verification, CLI, scheduling, or engine behavior.

## Mode model

| Mode | Default | Sidebar | Home page | Tools still reachable |
| --- | --- | --- | --- | --- |
| `advanced` | Existing installs and upgraded settings files | Current full sidebar, unchanged | Current Dashboard, unchanged | All current pages and labels |
| `standard` | Fresh installs with no previous `settings.json` | Reduced sidebar | Small `StandardHome` page | Backup, Restore, Browse Files, Recovery Media, Settings |

The mode is persisted as top-level `interfaceMode` in `settings.json`:

```json
{ "interfaceMode": "standard" }
```

Rules:

1. A fresh install with no `settings.json` uses the `standard` default.
2. Missing, `null`, unknown, or incorrectly typed values in an existing settings file or imported settings export normalize to `advanced`.
3. An existing install without the field keeps the exact current Advanced experience.
4. A damaged settings file also falls back to Advanced; its contents are preserved for repair and are not overwritten silently.
5. Switching modes is available in **Settings → Appearance → Interface view**, followed by **Save Settings**.
6. The Standard sidebar always includes a visible **Advanced view** switch. Selecting it persists `advanced` immediately, with no dialog.

There is no startup modal, onboarding prompt, automatic downgrade, or forced restart in this phase. A mode change takes effect in the current window as soon as it is saved.

## Navigation

### Standard sidebar

The Standard sidebar contains only:

- Home
- New Backup
- Restore
- Browse Files
- Recovery Media
- Settings
- Advanced view (switch, immediate)

The Advanced-only pages remain implemented and unchanged; they are simply not linked from the Standard sidebar:

- Migrate
- Partition Copy
- Disk Tools
- Repositories
- Schedules
- Config Builder
- Volume Shadow Copy
- Network
- Logs

File-association and `--open-page` startup navigation continue to work. If one of those external entry points opens a shared page such as Restore or Browse Files, Standard view displays that page normally and the Standard sidebar remains available to return Home. No startup modal blocks that route.

### Standard home

The Standard home page is intentionally smaller than the Advanced Dashboard. It shows:

- A short introduction.
- Four action cards: **Back up now**, **Restore files**, **Browse an image**, and **Recovery media**.
- A plain backup-list summary derived from `listRecentBackups()` and `destinationHealth()`: latest listed image, destination count, and unavailable-list state.
- A pointer to the sidebar switch for Advanced view.

It does not show performance benchmarks, anomaly analysis, storage/media health tables, scrubs, compaction, integrity tables, or other power-user controls. It does not change the wizards themselves.

The startup splash uses the same loaded signal as the Advanced Dashboard: `StandardHome` reports loaded after its initial queries settle, and the App still applies the existing minimum-delay and eight-second cap.

## Safety behavior

- The current Advanced sidebar, page labels, and page order remain byte-for-byte unchanged in behavior.
- Standard view hides administrative/destructive entry points from normal navigation; it does not add new permission checks or alter engine safeguards.
- The **Advanced view** switch has no dialog; it persists the mode and updates the shell immediately. Only the presentation changes.
- Settings radio changes require **Save Settings**, so a user can inspect the choice before applying it.
- No stability, speed, repair, support, or success claim is made by the new UI copy.

## Files and boundaries

Implementation is limited to:

- `src/main/utils/settings-manager.ts`: type, first-run default, and normalization of `interfaceMode`.
- `src/main/index.ts`: settings import normalizes an absent/invalid mode to Advanced.
- `src/renderer/lib/interface-mode.ts`: renderer-side mode type and normalizer.
- `src/renderer/App.tsx`: mode state, shell/sidebar branch, Standard home branch, and immediate switch handler.
- `src/renderer/components/StandardHome.tsx`: new Standard home page.
- `src/renderer/components/Settings.tsx`: Interface view radio and save notification.
- `src/renderer/styles/globals.css`: Standard-only styles.
- `test/unit/interface-mode.test.ts`: normalizer and settings persistence/backfill tests.

No CLI wording, engine behavior, IPC contracts beyond the existing settings API, winget manifests, or release metadata are changed.

## Acceptance criteria

1. A fresh install launches in Standard view; a pre-feature `settings.json` launches in Advanced view with the existing full sidebar and Dashboard.
2. Choosing Standard and saving replaces only the shell/home experience; Backup and Restore still use the existing wizards.
3. The Standard sidebar has no links to Advanced-only pages.
4. The visible **Advanced view** switch persists the choice and restores the full sidebar immediately, with no dialog.
5. Unknown persisted values never produce a blank or broken shell.
6. Unit tests cover default, persistence, backfill, and invalid-value normalization.
7. Typechecks, lint, and the test suite excluding the known Electron-launch flake (`test/integration/gui-click.test.ts`) pass.

## Verification status

This document specifies intended behavior. It is not itself a claim that the behavior has been runtime-verified in the packaged GUI. Any release notes for this change must distinguish unit/typecheck/lint results from user-reported or independently observed GUI verification.
