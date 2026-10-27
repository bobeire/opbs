import { test, expect } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const APP_ROOT = path.resolve(__dirname, '../..');

interface NavTarget {
  label: RegExp;
  heading: RegExp;
}

// Ordered sidebar navigation in src/renderer/App.tsx. Each entry maps the clickable
// nav button (accessible name) to a marker expected on the rendered page.
const NAV: NavTarget[] = [
  { label: /Dashboard/, heading: /Dashboard/i },
  { label: /New Backup/, heading: /New Backup/i },
  { label: /Restore/, heading: /Restore/i },
  { label: /Browse Files/, heading: /Browse/i },
  { label: /Repositories/, heading: /Repositories/i },
  { label: /Recovery Media/, heading: /Recovery Media|Media/i },
  { label: /Settings/, heading: /Settings/i }
];

const PAGE_ERRORS: string[] = [];
const CSP_VIOLATIONS: string[] = [];

// Keep CI logs bounded: app stdout/stderr (chromium spam included) is folded
// into the death-certificate dump on failure, and can be large.
const PROC_OUT_CAP = 512 * 1024;
function bounded(chunks: string[]): string {
  let text = chunks.join('');
  if (text.length > PROC_OUT_CAP) text = `…(${text.length - PROC_OUT_CAP} chars truncated)…${text.slice(-PROC_OUT_CAP)}`;
  return text;
}
function tail(text: string, budget = 8000): string {
  return text.length > budget ? `…(${text.length - budget} chars truncated)…${text.slice(-budget)}` : text;
}

/**
 * Ask the running app to record its own dying words: window/renderer
 * lifecycle events, quit paths, main-process exceptions, and a 1s heartbeat.
 *
 * Each event goes to (a) an in-memory list on globalThis — readable through
 * evaluate while the app lives — and (b) the app's stdout as `[gcert]` lines.
 * Playwright pipes the app's stdio to the test process, so (b) survives even
 * a hard main-process death; playwright alone can only say "target closed",
 * which cannot distinguish a renderer crash from a clean quit from an
 * external kill. (Module loading is unavailable inside evaluate — no
 * `require`, no `process.mainModule` — hence stdout rather than a file.)
 *
 * uncaughtException/unhandledRejection listeners normally *suppress* Node's
 * default fatal handling, so both re-raise after recording: the app still
 * dies exactly as it would without this instrumentation (record → rethrow →
 * second strike exits 1, mirroring Node's default).
 */
async function installDeathCert(app: ElectronApplication): Promise<void> {
  try {
    await app.evaluate(async ({ app: eapp }) => {
      const events: string[] = [];
      const t0 = Date.now();
      const rec = (msg: string): void => {
        const line = `+${Date.now() - t0}ms ${msg}`;
        events.push(line);
        try {
          console.log(`[gcert] ${line}`);
        } catch {
          /* ignore */
        }
      };

      // Stash for the test's catch block (readable while the app is alive).
      (globalThis as unknown as { __guiClickCert?: string[] }).__guiClickCert = events;

      // Structural window type: playwright hands evaluate a *patched*
      // BrowserWindow facade (its static getAllBrowserWindows is missing),
      // so stay duck-typed and never touch statics.
      interface CertWin {
        isDestroyed(): boolean;
        on(event: string, listener: (...args: any[]) => void): void;
        webContents: {
          isLoading(): boolean;
          on(event: string, listener: (...args: any[]) => void): void;
        };
      }
      const watched: Array<() => string> = [];
      const attach = (win: CertWin): void => {
        watched.push(() => (win.isDestroyed() ? 'destroyed' : `loading=${String(win.webContents.isLoading())}`));
        const wc = win.webContents;
        wc.on('did-start-loading', () => rec('wc: did-start-loading'));
        wc.on('did-fail-load', (_e2: unknown, code: unknown, desc: unknown, url: unknown, isMainFrame: unknown) =>
          rec(
            `wc: did-fail-load code=${String(code)} desc=${String(desc)} url=${String(url)} mainFrame=${String(isMainFrame)}`
          )
        );
        wc.on('did-finish-load', () => rec('wc: did-finish-load'));
        wc.on('render-process-gone', (_e2: unknown, details: unknown) =>
          rec(`wc: render-process-gone ${JSON.stringify(details)}`)
        );
        win.on('closed', () => rec('event: window closed'));
      };

      try {
        rec(`death certificate installed (pid=${process.pid})`);

        // --- app lifecycle (registration first: nothing below may skip it) ---
        eapp.on('window-all-closed', () => rec('event: window-all-closed'));
        eapp.on('before-quit', () => rec('event: before-quit'));
        eapp.on('quit', (_e: unknown, code: unknown) => rec(`event: quit code=${String(code)}`));
        eapp.on('second-instance', () => rec('event: second-instance'));
        eapp.on('render-process-gone', (_e: unknown, details: unknown) =>
          rec(`event: render-process-gone ${JSON.stringify(details)}`)
        );
        eapp.on('child-process-gone', (_e: unknown, details: unknown) =>
          rec(`event: child-process-gone ${JSON.stringify(details)}`)
        );
        eapp.on('browser-window-created', (_e: unknown, win: CertWin) => {
          rec('event: browser-window-created');
          attach(win);
        });

        // --- main-process fatality (record, then crash exactly as Node would) ---
        let sawFatal = false;
        const fatal = (kind: string, err: unknown): void => {
          const stack = (err as Error)?.stack || String(err);
          rec(`process: ${kind} ${stack.split('\n').slice(0, 8).join(' | ')}`);
          try {
            process.stderr.write(`${kind}: ${stack}\n`);
          } catch {
            /* ignore */
          }
          if (sawFatal) {
            // Second strike: emulate Node's default death after recording.
            process.exit(1);
          }
          sawFatal = true;
          setTimeout(() => {
            throw err;
          }, 0);
        };
        process.on('exit', (code) => rec(`process: exit code=${String(code)}`));
        process.on('uncaughtException', (err) => fatal('uncaughtException', err));
        process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

        // --- heartbeat: blocked event loop = ticks stop; death = stream stops ---
        const heartbeat = setInterval(() => {
          const states = watched.map((state) => {
            try {
              return state();
            } catch {
              return 'unavailable';
            }
          });
          rec(`heartbeat windows=${states.length} ${states.join(' ')}`);
        }, 1000);
        setTimeout(() => clearInterval(heartbeat), 240_000);
        rec('install complete');
      } catch (error) {
        rec(`FATAL during install: ${(error as Error)?.stack || String(error)}`);
      }
    });
  } catch (error) {
    console.log(`[gui-click] could not install death certificate: ${String(error).split('\n')[0]}`);
  }
}

test(
  'launches the app and click-tests every sidebar view without errors',
  {
    timeout: 300000,
    // GitHub's Windows runner intermittently kills the Electron window
    // during startup (firstWindow resolves, then the page closes before
    // domcontentloaded). The same build passes locally every time, so this
    // is environment flake, not app behaviour — retry on CI only; local runs
    // stay strict. The death certificate (installDeathCert) records why the
    // app dies so CI failures are diagnosable instead of "target closed".
    retry: process.env.CI ? 2 : 0
  },
  async () => {
    // Retries re-run this body; reset shared collectors so a prior failed
    // attempt's captured errors can't fail an otherwise clean run.
    PAGE_ERRORS.length = 0;
    CSP_VIOLATIONS.length = 0;
    // electron#45251 / #52307: a dist with an empty or locale-mismatched
    // locales/ dir crashes Windows renderers (reproduced locally: removing
    // the packs makes render-process-gone fire with reason=crashed). Print
    // the state of the dist we are about to launch so a CI failure says
    // immediately whether the install is intact.
    const localesDir = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'locales');
    const packs = fs.existsSync(localesDir) ? fs.readdirSync(localesDir).filter((f) => f.endsWith('.pak')) : [];
    console.log(
      `[gui-click] electron locales: ${packs.length} pack(s), en-US=${packs.includes('en-US.pak') ? 'present' : 'MISSING'}`
    );

    console.log('[gui-click] launching electron…');
    const app: ElectronApplication = await electron.launch(
    {
    args: [
      APP_ROOT,
      // Runner display stack crash loop (death certificate, 842275d): the
      // GPU process dies with 0xC0000005 every ~4s until Chromium logs
      // "GPU process isn't usable. Goodbye." and the whole app exits —
      // the renderer never reaches domcontentloaded. --disable-gpu was
      // verified delivered (app.commandLine.hasSwitch) yet the 0xC0000005
      // persists, so also drop both sandbox layers: renderer + GPU are the
      // only sandboxed processes here, and they are exactly the two that
      // die (simultaneously, same exception) while the unsandboxed main
      // process lives. Flags are CI-only; local runs keep the default path.
      ...(process.env.CI ? ['--disable-gpu', '--no-sandbox', '--disable-gpu-sandbox'] : [])
    ],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Spawned shells resolve cmd.exe via PATH; this bash environment
      // strips System32, so re-add it for playwright's launcher.
      PATH: [process.env.PATH, 'C:\\Windows\\System32', 'C:\\Windows'].filter(Boolean).join(';'),
      // Chromium's own log on CI: if the crash survives the sandbox flags,
      // gpu/sandbox/fatal lines explain it (capped by PROC_OUT_CAP above).
      ...(process.env.CI ? { ELECTRON_ENABLE_LOGGING: '1' } : {})
    },
    timeout: 60_000
  });

  // Test-side death certificate plumbing, declared outside try so the catch
  // can dump it no matter where the body fails. Playwright pipes the app's
  // stdout/stderr into these streams (verified), including `[gcert]` mirrors
  // and any crash stack Node itself prints.
  const procOut: string[] = [];
  const pushOut = (d: unknown): void => {
    procOut.push(String(d));
    // Trim in place so a spammy crash dump can't grow without bound.
    let total = 0;
    for (const chunk of procOut) total += chunk.length;
    while (total > PROC_OUT_CAP * 2 && procOut.length > 1) {
      total -= procOut.shift()?.length ?? 0;
    }
  };
  const proc = app.process();
  proc.stdout?.on('data', pushOut);
  proc.stderr?.on('data', pushOut);
  proc.on('exit', (code, signal) => pushOut(`[cert] app process exited code=${String(code)} signal=${String(signal)}`));
  app.on('close', () => pushOut('[cert] playwright observed app close'));

  try {
    console.log('[gui-click] electron launched, waiting for first window…');
    await installDeathCert(app);
    const tWindow = Date.now();
    const win: Page = await app.firstWindow();
    console.log(`[gui-click] first window resolved after ${Date.now() - tWindow}ms`);
    // Collect CSP rejections from the built renderer (production builds ship a
    // Content-Security-Policy meta tag); anything "Refused to …" means the
    // policy is blocking a resource the app actually needs.
    win.on('console', (message) => {
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) CSP_VIOLATIONS.push(text);
    });
    await win.waitForLoadState('domcontentloaded');
    console.log('[gui-click] window ready, starting navigation…');

    // First run on a machine without the Windows ADK shows the install
    // preflight; it resolves a beat after first paint and would otherwise
    // intercept the sidebar clicks below.
    const adkModal = win.locator('.modal-overlay');
    try {
      await adkModal.waitFor({ state: 'visible', timeout: 5000 });
      await adkModal.getByRole('button', { name: 'Later' }).click();
      await adkModal.waitFor({ state: 'hidden' });
      console.log('[gui-click] ADK preflight dismissed');
    } catch {
      console.log('[gui-click] no ADK preflight shown');
    }
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

    // Every view navigated without a single renderer-side uncaught error,
    // and without tripping the renderer's content-security policy.
    expect(PAGE_ERRORS).toEqual([]);
    expect(CSP_VIOLATIONS).toEqual([]);
    const certLines = await app.evaluate(
      () => ((globalThis as unknown as { __guiClickCert?: string[] }).__guiClickCert ?? []).length
    );
    console.log(`[gui-click] passed with the app alive; death certificate has ${certLines} line(s)`);
  } catch (err) {
    // Give the app a moment to finish dying so the exit code lands in procOut.
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const to = setTimeout(resolve, 2500);
        proc.once('exit', () => {
          clearTimeout(to);
          resolve();
        });
      });
    }
    console.log('[gui-click] FAILED — dumping the app death certificate…');
    try {
      const inMemory = await app.evaluate(
        () => ((globalThis as unknown as { __guiClickCert?: string[] }).__guiClickCert ?? []).join('\n')
      );
      console.log(tail(`[gui-click] main-process events (live):\n${inMemory || '(none)'}`));
    } catch (error) {
      console.log(`[gui-click] main process unreachable (already dead): ${String(error).split('\n')[0]}`);
    }
    // Generous budget: CI adds ELECTRON_ENABLE_LOGGING lines around the
    // [gcert] mirror, and the crash sequence must survive the trim.
    console.log(tail(`[gui-click] app stdout/stderr/exit:\n${bounded(procOut)}`, 24000));
    throw err;
  } finally {
    await app.close().catch(() => undefined);
  }
  }
);
