import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { logger } from './logger';

const GITHUB_OWNER = 'bobeire';
const GITHUB_REPO = 'opbs';

let updaterWindow: BrowserWindow | null = null;
let checking = false;

function send(status: string, payload?: unknown): void {
  updaterWindow?.webContents.send('update-status', { status, ...(payload ?? {}) });
}

function enabled(): boolean {
  // app.getName() returns the package.json `name` ("opbs"), not the
  // electron-builder productName, so compare case-insensitively.
  return app.isPackaged && app.getName().toLowerCase() === 'opbs';
}

export function initAutoUpdater(window: BrowserWindow): void {
  updaterWindow = window;

  if (!enabled()) {
    logger.info('Auto-update disabled (dev mode)');
    return;
  }

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO
  });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for updates…');
    send('checking');
  });
  autoUpdater.on('update-available', (info) => {
    logger.info('Update available', info.version);
    send('available', { version: info.version });
    // Auto-download the update.
    void autoUpdater.downloadUpdate().catch((err) => {
      logger.error('Update download failed', err);
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    logger.info('No update available', info?.version);
    send('not-available');
  });
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('Update downloaded', info.version);
    send('downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    logger.error('Auto-update error', err);
    send('error', { message: err instanceof Error ? err.message : String(err) });
  });

  void autoUpdater.checkForUpdates().catch((err) => {
    logger.warn('Initial update check failed', err);
  });
}

export async function checkForUpdates(): Promise<boolean> {
  if (checking) return false;
  if (!enabled()) return false;
  checking = true;
  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (err) {
    logger.error('Manual update check failed', err);
    return false;
  } finally {
    checking = false;
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}