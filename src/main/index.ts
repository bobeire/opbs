import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu, Notification } from 'electron';
import path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { DiskEnumerator } from './utils/disk-enumerator';
import { BackupManager } from './backup/manager';
import { RestoreManager } from './restore/manager';
import { BackupScheduler } from './backup/scheduler';
import { SettingsManager } from './utils/settings-manager';
import { logger } from './utils/logger';
import { initAutoUpdater, checkForUpdates, quitAndInstall } from './utils/auto-updater';
import { discoverNetworkMachines, enumerateShares, testNetworkDestination } from './utils/network';
import { ImagingEngine } from './imaging/backup-engine';
import { RestoreEngine } from './imaging/restore-engine';
import { CloneEngine } from './imaging/clone-engine';
import { CloneManager } from './clone/manager';
import { dispatchHelperJob } from './helper/job-runner';
import { launchElevatedJob } from './helper/launcher';
import { loadNative } from './utils/native-loader';
import type { VssJob, VssJobResult } from './utils/vss';
import { winfspAvailable, winfspLoadNote } from './imaging/mount-manager';
import { applyRetention, planRetention, scanBackupDirectory, groupIntoChains, writeManifest } from './backup/retention';
import { checkDiskHealth } from './utils/disk-health';
import { runCli } from './cli';
import { readImageInfo, verifyImage, CIPHER_NONE, deriveImageKey, clearImageInfoCache } from './imaging/image-format';
import { openAnyBrowse as fsOpenBrowseAny, listDirectory, extractPath, detectPartitionFilesystem, BrowseSession } from './imaging/fs/file-browse';
import { detectMacriumFormat, readMacriumImage, closeImageFds, clearMacriumInfoCache } from './imaging/mrimg';
import { locateAdk, peArchForProcess } from './utils/adk';
import { createRecoveryMedia, resolveNodeExe, MediaCreateOptions } from './utils/winpe-media';
import { installAdkExe } from './utils/adk-install';
import { installNodeRuntime } from './utils/node-install';
import { installWinfsp } from './utils/winfsp-install';
import { S3Store, resolveS3Config } from './utils/s3';
import { SftpStore, resolveSftpConfig } from './utils/sftp';
import { FtpStore, resolveFtpConfig } from './utils/ftp';
import { getRecentDestinations, addRecentDestination } from './utils/recent';
import { destinationHealth } from './utils/destination-health';
import { normalizeBackupLocation } from './utils/location';
import { initErrorReporter, setErrorReporting } from './utils/error-reporter';
import { resolveImageChain } from './imaging/restore-engine';
import { registerFileAssociations, unregisterFileAssociations, parseFileActionArgs, FileAction } from './utils/file-associations';
import { readDrillHistory } from './utils/drill-history';

const HELPER_FLAG = '--opbs-helper';

let mainWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;

const diskEnumerator = new DiskEnumerator();
const imagingEngine = new ImagingEngine(diskEnumerator);
const backupManager = new BackupManager(imagingEngine);
const restoreManager = new RestoreManager(new RestoreEngine(diskEnumerator));
const cloneManager = new CloneManager(new CloneEngine(diskEnumerator));
const settingsManager = new SettingsManager();
const scheduler = new BackupScheduler(backupManager, settingsManager);

// Read-only image mounts: job launcher per mount id (cancel = unmount).
const mountLaunchers = new Map<string, { cancel(): void }>();

// Explorer file-handler action (context-menu verb on an image): delivered to
// the renderer once it has loaded, or run headless for verify.
let pendingFileAction: FileAction | null = null;

function notify(title: string, body: string): void {
  try {
    new Notification({ title, body }).show();
  } catch {
    // Notifications are best-effort (e.g. headless CLI mode).
  }
}

async function runHeadlessVerify(imagePath: string): Promise<void> {
  try {
    const result = await verifyImage(imagePath, undefined);
    notify(
      'OPBS Verification',
      result.ok
        ? `Verified: ${result.blocksVerified} block(s) checked OK.`
        : `Verification failed: ${result.error ?? 'no frame data in the image'}.`
    );
  } catch (error) {
    notify('OPBS Verification', `Verification failed: ${error instanceof Error ? error.message : error}`);
  }
}

function deliverFileAction(action: FileAction): void {
  const imagePath = action.imagePath;
  if (action.verb === 'verify') {
    try {
      const info = readImageInfo(imagePath);
      if (info.header.cipherId !== CIPHER_NONE) {
        notify('OPBS Verification', 'This image is encrypted. Open it in OPBS to verify with a passphrase.');
        mainWindow?.webContents.send('open-image', { verb: 'browse', imagePath });
        return;
      }
    } catch (error) {
      notify('OPBS Verification', `Could not read the image: ${error instanceof Error ? error.message : error}`);
    }
    void runHeadlessVerify(imagePath);
    return;
  }
  mainWindow?.webContents.send('open-image', { verb: action.verb, imagePath });
}

function queueFileAction(action: FileAction): void {
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    deliverFileAction(action);
    return;
  }
  pendingFileAction = action;
}

function browseCacheKey(imagePath: string, partitionIndex: number, keyHex?: string): string {
  return `${imagePath}#${partitionIndex}${keyHex ? '#' + keyHex : ''}`;
}

function imageFileSignature(imagePath: string): string {
  try {
    const st = fs.statSync(imagePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

interface BrowseCacheEntry {
  session: BrowseSession;
  /** size:mtime of the image chain head when the session was opened. */
  signature: string;
}

const browseSessions = new Map<string, BrowseCacheEntry>();

function openBrowseSession(imagePath: string, partitionIndex: number, passphrase?: string): BrowseSession {
  let key: Buffer | undefined;
  if (!detectMacriumFormat(imagePath)) {
    const info = readImageInfo(imagePath);
    const header = info.header;
    key =
      header.cipherId !== CIPHER_NONE
        ? deriveImageKey(passphrase ?? '', header.salt, header.kdfIterations)
        : undefined;
    const partition = info.partitions.find((p) => p.partitionIndex === partitionIndex);
    if (partition && partition.size === 0) {
      throw new Error(`Partition ${partitionIndex} is empty (0 bytes) and cannot be browsed.`);
    }
  }
  const cacheKey = browseCacheKey(imagePath, partitionIndex, key?.toString('hex'));
  const signature = imageFileSignature(imagePath);
  const cached = browseSessions.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.session;
  }
  if (cached) {
    logger.info(
      `browse: image changed (${cached.signature} -> ${signature || 'missing'}), reopening ${imagePath}#${partitionIndex}`
    );
    browseSessions.delete(cacheKey);
  }
  const session = fsOpenBrowseAny(imagePath, partitionIndex, key);
  browseSessions.set(cacheKey, { session, signature: imageFileSignature(imagePath) });
  return session;
}

function s3ProfileFromSettings() {
  const s3 = settingsManager.getSettings().cloud?.s3;
  if (!s3) return undefined;
  return {
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket: s3.bucket,
    prefix: s3.prefix,
    endpoint: s3.endpoint || undefined,
    forcePathStyle: s3.forcePathStyle
  };
}

function sftpProfileFromSettings() {
  const sftp = settingsManager.getSettings().cloud?.sftp;
  if (!sftp) return undefined;
  return {
    host: sftp.host,
    port: sftp.port,
    username: sftp.username,
    password: sftp.password || undefined,
    privateKey: sftp.privateKey || undefined,
    remotePath: sftp.remotePath
  };
}

function ftpProfileFromSettings() {
  const ftp = settingsManager.getSettings().cloud?.ftp;
  if (!ftp) return undefined;
  return {
    host: ftp.host,
    port: ftp.port,
    username: ftp.username,
    password: ftp.password || undefined,
    remotePath: ftp.remotePath,
    secure: ftp.secure
  };
}

function runAsHelper(args: string[], pipeName?: string): void {
  const [jobPath, resultPath, progressPath, cancelPath] = args;

  app.disableHardwareAcceleration();

  app.whenReady().then(async () => {
    logger.info('Elevated helper mode started');

    // Connect to the parent's pipe server (if available).
    let pipeClient: import('./utils/pipe-ipc').PipeClient | null = null;
    if (pipeName) {
      try {
        const { PipeClient } = await import('./utils/pipe-ipc');
        pipeClient = new PipeClient(pipeName);
        await pipeClient.connect();
        pipeClient.send({ type: 'started' });
        logger.info(`Connected to parent pipe ${pipeName}`);
      } catch (pipeError) {
        logger.warn(`Could not connect to pipe ${pipeName}, using file-based IPC: ${pipeError}`);
        pipeClient = null;
      }
    }

    try {
      await dispatchHelperJob(jobPath, resultPath, progressPath, cancelPath, undefined, pipeClient ?? undefined);
      // Send result through pipe before exiting.
      if (pipeClient?.isConnected && fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          pipeClient.send({ type: 'result', ...result });
        } catch { /* best-effort */ }
      }
      try { loadNative<{ closeAllHandles(): void }>().closeAllHandles(); } catch { /* best-effort */ }
      pipeClient?.close();
      app.exit(0);
    } catch (error) {
      logger.error('Helper job failed', error);
      try { loadNative<{ closeAllHandles(): void }>().closeAllHandles(); } catch { /* best-effort */ }
      const errorResult = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cancelled: false,
        warnings: []
      };
      // Send error through pipe.
      if (pipeClient?.isConnected) {
        try { pipeClient.send({ type: 'result', ...errorResult }); } catch { /* best-effort */ }
      }
      // Also write result.json as fallback.
      try {
        if (!fs.existsSync(resultPath)) {
          fs.writeFileSync(resultPath, JSON.stringify(errorResult));
        }
      } catch (writeError) {
        logger.error('Failed to write helper failure result', writeError);
      }
      pipeClient?.close();
      app.exit(1);
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'OPBS — Open Pickle Backup System',
    icon: path.join(__dirname, '../resources/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingFileAction) {
      deliverFileAction(pendingFileAction);
      pendingFileAction = null;
    }
  });
}

function showAboutDialog(): void {
  if (aboutWindow) { aboutWindow.focus(); return; }
  const iconPath = path.join(__dirname, '../resources/icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  const version = app.getVersion();
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>About OPBS</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background: #1e1e2e; color: #cdd6f4;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         height: 100vh; user-select: none; overflow: hidden; }
  .icon { width: 72px; height: 72px; margin-bottom: 12px; }
  .title { font-size: 22px; font-weight: 700; color: #f5c2e7; }
  .subtitle { font-size: 13px; color: #a6adc8; margin-top: 2px; }
  .version { font-size: 12px; color: #6c7086; margin-top: 10px; }
  .desc { font-size: 13px; color: #bac2de; text-align: center; margin: 14px 32px 0;
          line-height: 1.5; }
  a { color: #89b4fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .link { font-size: 12px; margin-top: 16px; }
  .copy { font-size: 10px; color: #585b70; margin-top: 12px; }
</style>
</head>
<body>
  <img class="icon" src="${iconPath.replace(/\\/g, '\\\\')}" />
  <div class="title">OPBS</div>
  <div class="subtitle">Open Pickle Backup System</div>
  <div class="version">Version ${version}</div>
  <div class="desc">Disk imaging and backup tool with Macrium&nbsp;Reflect compatibility,
    scheduled backups, cloud storage support, and read-only image browsing.</div>
  <div class="link"><a href="https://opbs.rhitcs.com">opbs.rhitcs.com</a></div>
  <div class="copy">&copy; ${new Date().getFullYear()} RHITCS</div>
</body>
</html>`;
  aboutWindow = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'About OPBS',
    icon,
    parent: mainWindow ?? undefined,
    modal: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  aboutWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    shell.openExternal(url);
  });
  const tmpFile = path.join(app.getPath('temp'), 'opbs-about.html');
  fs.writeFileSync(tmpFile, html, 'utf-8');
  aboutWindow.loadFile(tmpFile);
  aboutWindow.on('ready-to-show', () => aboutWindow?.show());
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Backup', click: () => mainWindow?.webContents.send('nav', 'backup') },
        { label: 'Restore', click: () => mainWindow?.webContents.send('nav', 'restore') },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'About OPBS', click: () => showAboutDialog() },
        {
          label: 'Website',
          click: () => void shell.openExternal('https://opbs.rhitcs.com')
        },
        {
          label: 'Check for Updates',
          click: () => void checkForUpdates()
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function main(): void {
  // Headless CLI mode: run the requested command and exit without a window.
  const cliIndex = process.argv.indexOf('--cli');
  if (cliIndex !== -1) {
    const cliArgs = process.argv.slice(cliIndex + 1);
    app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      const code = await runCli(cliArgs);
      app.exit(code);
    });
    return;
  }

  const helperIndex = process.argv.indexOf(HELPER_FLAG);
  if (helperIndex !== -1) {
    const jobPath = process.argv[helperIndex + 1] ?? '';
    let resultPath = process.argv[helperIndex + 2] ?? '';
    let progressPath = process.argv[helperIndex + 3] ?? '';
    let cancelPath = process.argv[helperIndex + 4] ?? '';
    const pipeFlagIndex = process.argv.indexOf('--pipe', helperIndex);
    let pipeName: string | undefined = pipeFlagIndex !== -1 ? process.argv[pipeFlagIndex + 1] : undefined;

    // Compact form (used by the scheduled task, whose /TR is capped at 261
    // chars): only the job path is passed. The remaining paths and the pipe
    // name live in a sibling io.json written by the launcher.
    if (jobPath && !resultPath) {
      try {
        const ioPath = path.join(path.dirname(jobPath), 'io.json');
        const io = JSON.parse(fs.readFileSync(ioPath, 'utf-8')) as {
          resultPath?: string;
          progressPath?: string;
          cancelPath?: string;
          pipeName?: string;
        };
        resultPath = io.resultPath ?? path.join(path.dirname(jobPath), 'result.json');
        progressPath = io.progressPath ?? path.join(path.dirname(jobPath), 'progress.json');
        cancelPath = io.cancelPath ?? path.join(path.dirname(jobPath), 'cancel');
        pipeName = pipeName ?? io.pipeName;
      } catch {
        const dir = path.dirname(jobPath);
        resultPath = path.join(dir, 'result.json');
        progressPath = path.join(dir, 'progress.json');
        cancelPath = path.join(dir, 'cancel');
      }
    }
    runAsHelper([jobPath, resultPath, progressPath, cancelPath], pipeName);
    return;
  }

  // Headless association management (installer showApp/repair or manual tests).
  if (process.argv.includes('--register-file-associations')) {
    app.whenReady().then(() => {
      const result = registerFileAssociations();
      console.log(result.ok ? 'OK: file associations registered' : `FAILED: ${result.failures.join('; ')}`);
      app.exit(result.ok ? 0 : 1);
    });
    return;
  }
  if (process.argv.includes('--unregister-file-associations')) {
    app.whenReady().then(() => {
      const result = unregisterFileAssociations();
      console.log(result.ok ? 'OK: file associations removed' : `FAILED: ${result.failures.join('; ')}`);
      app.exit(result.ok ? 0 : 1);
    });
    return;
  }

  const startupFileAction = parseFileActionArgs(process.argv);

  // One window per app instance; a second launch (e.g. another context-menu
  // click) focuses the existing window and hands it the file action.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, argv) => {
    const action = parseFileActionArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (action) {
      queueFileAction(action);
    }
  });

  app.whenReady().then(() => {
    initErrorReporter(() => settingsManager.getSettings().errorReporting);
    if (app.isPackaged && settingsManager.getSettings().fileAssociations) {
      const result = registerFileAssociations();
      if (!result.ok) {
        logger.warn(`File association registration failed: ${result.failures.join('; ')}`);
      }
    }
    createWindow();
    buildAppMenu();
    setupIpcHandlers();
    setupBackupEvents();
    setupRestoreEvents();
    setupCloneEvents();
    scheduler.startAll();
    if (startupFileAction) {
      queueFileAction(startupFileAction);
    }
    if (mainWindow) {
      initAutoUpdater(mainWindow);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    scheduler.stopAll();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

main();

function setupBackupEvents(): void {
  backupManager.on('progress', (progress) => {
    mainWindow?.webContents.send('backup-progress', progress);
  });
}

function setupRestoreEvents(): void {
  restoreManager.on('progress', (progress) => {
    mainWindow?.webContents.send('restore-progress', progress);
  });
}

function setupCloneEvents(): void {
  cloneManager.on('progress', (progress) => {
    mainWindow?.webContents.send('clone-progress', progress);
  });
}

function setupIpcHandlers(): void {
  // About dialog
  ipcMain.handle('show-about', async () => {
    showAboutDialog();
  });

  // Disk information
  ipcMain.handle('get-disks', async () => {
    return diskEnumerator.getDisks();
  });

  ipcMain.handle('get-partitions', async (_, diskIndex: number) => {
    return diskEnumerator.getPartitions(diskIndex);
  });

  // Backup operations
  ipcMain.handle('start-backup', async (_, config) => {
    const merged =
      config?.destinationPath?.startsWith('s3://')
        ? { ...config, s3Profile: s3ProfileFromSettings() }
        : config?.destinationPath?.startsWith('sftp://')
          ? { ...config, sftpProfile: sftpProfileFromSettings() }
          : config?.destinationPath?.startsWith('ftp://')
            ? { ...config, ftpProfile: ftpProfileFromSettings() }
            : config;
    // A new backup rewrites an image path that may already have a browse
    // session / image-info cache pointing at the old content.
    browseSessions.clear();
    clearImageInfoCache();
    return backupManager.startBackup(merged);
  });

  ipcMain.handle('cancel-backup', async () => {
    return backupManager.cancelBackup();
  });

  ipcMain.handle('is-backup-running', async () => {
    return backupManager.running;
  });

  ipcMain.handle('is-helper-task-registered', async () => {
    const { isHelperTaskRegistered, isRunAsAdmin } = await import('./utils/task-scheduler');
    const exe = process.execPath;
    return (await isHelperTaskRegistered()) || isRunAsAdmin(exe);
  });

  ipcMain.handle('register-helper-task', async () => {
    const { ensureHelperTaskRegistered, ensureRunAsAdmin, isRunAsAdmin } = await import('./utils/task-scheduler');
    const exe = process.execPath;
    const appPath = app.isPackaged ? undefined : app.getAppPath();
    // Try schtasks first (task scheduler approach).
    try {
      await ensureHelperTaskRegistered(exe, appPath);
      return true;
    } catch (taskErr) {
      logger.warn('schtasks registration failed, falling back to RunAsAdmin registry:', taskErr);
    }
    // Fallback: set RunAsAdmin in the registry compatibility layer.
    await ensureRunAsAdmin(exe);
    return true;
  });

  ipcMain.handle('register-unattended-backup-task', async (_, scheduleId: string, schedule: any) => {
    const { registerUnattendedBackupTask } = await import('./utils/task-scheduler');
    await registerUnattendedBackupTask(scheduleId, schedule);
    // Mark the schedule as unattended in settings.
    settingsManager.updateScheduledBackup(scheduleId, { unattended: true } as any);
    return true;
  });

  ipcMain.handle('unregister-unattended-backup-task', async (_, scheduleId: string) => {
    const { unregisterUnattendedBackupTask } = await import('./utils/task-scheduler');
    await unregisterUnattendedBackupTask(scheduleId);
    settingsManager.updateScheduledBackup(scheduleId, { unattended: false } as any);
    return true;
  });

  ipcMain.handle('list-unattended-backup-tasks', async () => {
    const { listUnattendedBackupTasks } = await import('./utils/task-scheduler');
    return listUnattendedBackupTasks();
  });

  ipcMain.handle('get-task-status', async (_, taskName: string) => {
    const { getTaskStatus } = await import('./utils/task-scheduler');
    return getTaskStatus(taskName);
  });

  // Restore operations
  ipcMain.handle('start-restore', async (_, config) => {
    return restoreManager.startRestore(config);
  });

  ipcMain.handle('cancel-restore', async () => {
    return restoreManager.cancelRestore();
  });

  ipcMain.handle('get-image-info', async (_, imagePath: string) => {
    return restoreManager.getImageSummary(imagePath);
  });

  ipcMain.handle('restore-preflight', async (_, config) => {
    return restoreManager.preflight(config);
  });

  // Partition copy (disk-to-disk clone)
  ipcMain.handle('start-clone', async (_, config) => {
    return cloneManager.startClone(config);
  });

  ipcMain.handle('cancel-clone', async () => {
    return cloneManager.cancelClone();
  });

  ipcMain.handle('clone-preflight', async (_, config) => {
    return cloneManager.preflight(config);
  });

  // Settings
  ipcMain.handle('get-settings', async () => {
    return settingsManager.getSettings();
  });

  ipcMain.handle('update-settings', async (_, updates) => {
    const result = settingsManager.updateSettings(updates);
    if (result.logLevel) {
      logger.setLevel(result.logLevel as any);
    }
    if (result.errorReporting) {
      setErrorReporting(result.errorReporting);
    }
    if (typeof updates.fileAssociations === 'boolean') {
      const outcome = updates.fileAssociations
        ? registerFileAssociations()
        : unregisterFileAssociations();
      if (!outcome.ok) {
        logger.warn(`Failed to apply file associations setting: ${outcome.failures.join('; ')}`);
      }
    }
    scheduler.resyncFromSettings();
    return result;
  });

  // Scheduled backups
  ipcMain.handle('add-scheduled-backup', async (_, config) => {
    const normalized = {
      ...config,
      destinationPath: normalizeBackupLocation(config?.destinationPath ?? '')
    };
    const result = settingsManager.addScheduledBackup(normalized);
    if (result.enabled) {
      scheduler.scheduleBackup(result);
    }
    return result;
  });

  ipcMain.handle('update-scheduled-backup', async (_, id, updates) => {
    const normalized =
      updates && updates.destinationPath != null
        ? { ...updates, destinationPath: normalizeBackupLocation(String(updates.destinationPath)) }
        : updates;
    const result = settingsManager.updateScheduledBackup(id, normalized);
    if (result) {
      scheduler.resyncFromSettings();
    }
    return result;
  });

  ipcMain.handle('delete-scheduled-backup', async (_, id) => {
    scheduler.cancelBackup(id);
    return settingsManager.deleteScheduledBackup(id);
  });

  ipcMain.handle('validate-cron', async (_, expression: string) => {
    return scheduler.validate(typeof expression === 'string' ? expression : '');
  });

  // Backup profiles
  ipcMain.handle('add-backup-profile', async (_, config) => {
    return settingsManager.addBackupProfile(config);
  });

  ipcMain.handle('update-backup-profile', async (_, id, updates) => {
    return settingsManager.updateBackupProfile(id, updates);
  });

  ipcMain.handle('delete-backup-profile', async (_, id) => {
    return settingsManager.deleteBackupProfile(id);
  });

  // File dialogs
  ipcMain.handle('select-directory', async (_, options) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('select-file', async (_, options) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: options?.filters || []
    });
    return result.filePaths[0];
  });

  // Logging
  ipcMain.handle('get-logs', async () => {
    const logDir = logger.getLogDir();
    if (!fs.existsSync(logDir)) return [];
    const now = Date.now();
    return fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const p = path.join(logDir, f);
        const stat = fs.statSync(p);
        return { name: f, path: p, size: stat.size, modified: stat.mtimeMs, ageDays: (now - stat.mtimeMs) / 86400000 };
      })
      .sort((a, b) => b.modified - a.modified);
  });

  ipcMain.handle('read-log-file', async (_, filePath: string) => {
    const logDir = logger.getLogDir();
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(logDir + path.sep) && resolved !== path.join(logDir, path.basename(filePath))) {
      return { ok: false, error: 'Invalid log file path' };
    }
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      return { ok: true, content: lines.slice(-2000).join('\n') };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Settings export/import
  ipcMain.handle('export-settings', async () => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export OPBS settings',
      defaultPath: `opbs-settings-${new Date().toISOString().split('T')[0]}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(settingsManager.getSettings(), null, 2), 'utf-8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('import-settings', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import OPBS settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const importPath = result.filePaths[0];
    try {
      const data = fs.readFileSync(importPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, error: 'Invalid settings file format' };
      }
      const merged = settingsManager.updateSettings(parsed);
      logger.setLevel(merged.logLevel as any);
      scheduler.resyncFromSettings();
      return { ok: true, settings: merged };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Auto-update
  ipcMain.handle('check-for-updates', async () => {
    return { ok: await checkForUpdates() };
  });

  ipcMain.handle('install-update', async () => {
    quitAndInstall();
    return { ok: true };
  });

  // Network destination discovery
  ipcMain.handle('network-discover', async () => {
    const machines = await discoverNetworkMachines();
    return { machines };
  });

  ipcMain.handle('network-shares', async (_, host: string) => {
    const shares = await enumerateShares(String(host ?? ''));
    return { shares };
  });

  ipcMain.handle('network-test', async (_, uncPath: string, create?: boolean) => {
    return testNetworkDestination(String(uncPath ?? ''), create !== false);
  });

  // Retention / GFS
  ipcMain.handle('plan-retention', async (_, directory: string, options) => {
    return planRetention(directory, options);
  });

  ipcMain.handle('apply-retention', async (_, directory: string, options) => {
    return applyRetention(directory, options);
  });

  ipcMain.handle('list-images', async (_, directory: string) => {
    const entries = scanBackupDirectory(directory);
    return { entries, chains: groupIntoChains(entries) };
  });

  // Recent backups across known destinations
  ipcMain.handle('list-recent-backups', async () => {
    const out: Array<{
      id: string;
      name: string;
      path: string;
      destPath: string;
      size: number;
      date: number;
      incremental: boolean;
      encrypted: boolean;
      verified: boolean;
      drillTestedAt?: number;
      chain: string[];
    }> = [];
    for (const dir of getRecentDestinations()) {
      let entries;
      try {
        entries = scanBackupDirectory(dir);
      } catch {
        continue; // destination offline (e.g. network share) - skip
      }
      const drillHistory = readDrillHistory(dir);
      const chains = groupIntoChains(entries);
      for (const e of entries) {
        const chain = chains
          .find((c) => c.items.some((i) => i.path === e.path))
          ?.items.map((i) => i.path);
        const lastDrill = drillHistory[path.resolve(e.path)];
        out.push({
          id: e.path,
          name: e.name,
          path: e.path,
          destPath: dir,
          size: e.size,
          date: e.timestamp,
          incremental: e.incremental,
          encrypted: e.encrypted,
          verified: e.verified,
          drillTestedAt: lastDrill?.ok ? lastDrill.at : undefined,
          chain: Array.isArray(chain) && chain.length ? chain : [e.path]
        });
      }
    }
    out.sort((a, b) => b.date - a.date);
    return { entries: out, destinations: getRecentDestinations() };
  });

  // Aggregated backup analytics across all known destinations
  ipcMain.handle('get-backup-analytics', async () => {
    const { computeAnalytics } = await import('./utils/backup-analytics');
    const destinations = getRecentDestinations();
    const perDestination = [];
    for (const dir of destinations) {
      try {
        const summary = computeAnalytics(dir);
        perDestination.push(summary);
      } catch {
        // destination offline — skip
      }
    }
    let totalDiskBytes = 0;
    let totalImageBytes = 0;
    for (const dest of perDestination) {
      totalDiskBytes += dest.totalDiskBytes;
      totalImageBytes += dest.totalImageBytes;
    }
    return {
      destinations: perDestination,
      totals: {
        totalDiskBytes,
        totalImageBytes,
        avgCompressionRatio: totalImageBytes > 0 ? totalDiskBytes / totalImageBytes : 1
      }
    };
  });

  // Self-healing: kick off a scrub (read back + parity repair) in the background.
  ipcMain.handle('start-scrub', async (_, directory: string, scope?: string) => {
    if (!directory) {
      return { started: false, error: 'No directory given' };
    }
    void scheduler.runScrub(directory, (scope === 'newest' ? 'newest' : 'all'), {
      label: 'Manual scrub',
      notifyOnFailure: true,
      alertAfter: 2
    });
    return { started: true };
  });

  // Latest scrub history per known destination.
  ipcMain.handle('get-scrub-status', async () => {
    const { readScrubHistory } = await import('./imaging/scrub');
    const destinations = getRecentDestinations();
    const out = [];
    for (const dir of destinations) {
      try {
        const history = readScrubHistory(dir);
        const latest = history[0] ?? null;
        out.push({
          directory: dir,
          latest,
          lastOk: latest ? latest.ok : null,
          lastScrubAt: latest ? latest.at : 0,
          totalRepaired: history.reduce((sum, h) => sum + (h.repaired ?? 0), 0),
          corruptImages: history.filter((h) => !h.ok).length
        });
      } catch {
        // destination offline — skip
      }
    }
    return out;
  });

  // Ransomware/tamper resistance: chain integrity (missing delta bases) and
  // manifest-vs-disk drift across every known local destination.
  ipcMain.handle('get-backup-integrity', async () => {
    const { buildChainHealthReport } = await import('./backup/chain-health');
    const { detectTamper } = await import('./utils/tamper');
    const destinations = getRecentDestinations();
    const out = [];
    for (const dir of destinations) {
      if (dir.startsWith('s3://') || dir.startsWith('sftp://') || dir.startsWith('ftp://')) {
        continue; // chain integrity is scanned locally
      }
      try {
        out.push({
          directory: dir,
          chain: buildChainHealthReport(dir),
          tamper: detectTamper(dir)
        });
      } catch {
        // destination offline — skip
      }
    }
    return out;
  });

ipcMain.handle('add-recent-destination', async (_, directory: string) => {
    return { destinations: addRecentDestination(directory) };
  });

  // Storage health dashboard across all known local destinations.
  ipcMain.handle('get-storage-health', async () => {
    const { buildStorageHealthReport } = await import('./utils/storage-health');
    const settings = settingsManager.getSettings();
    const destinations = getRecentDestinations();
    const results = [];
    for (const dir of destinations) {
      if (dir.startsWith('s3://') || dir.startsWith('sftp://') || dir.startsWith('ftp://')) {
        continue; // no local disk to measure
      }
      try {
        results.push(
          await buildStorageHealthReport(dir, {
            keepFull: settings.keepFull,
            keepDeltasPerFull: settings.keepDeltasPerFull,
            retentionDays: settings.retentionDays,
            autoCleanup: settings.autoCleanup
          })
        );
      } catch {
        // destination offline — skip
      }
    }
    return results;
  });

  ipcMain.handle('destination-health', async (_, destinations: string[]) => {
    const settings = settingsManager.getSettings();
    const list = Array.isArray(destinations) ? destinations : [];
    const results = [];
    for (const dir of list) {
      results.push(
        await destinationHealth(dir, {
          keepFull: settings.keepFull,
          keepDeltasPerFull: settings.keepDeltasPerFull,
          retentionDays: settings.retentionDays,
          autoCleanup: settings.autoCleanup
        })
      );
    }
    return results;
  });

  ipcMain.handle('open-path', async (_, filePath: string) => {
    const target = String(filePath ?? '');
    try {
      shell.showItemInFolder(target);
      return { ok: true };
    } catch {
      try {
        const dir = path.dirname(target);
        await shell.openPath(dir);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  ipcMain.handle('copy-image', async (_, imagePath: string, destDir: string) => {
    const src = String(imagePath ?? '');
    const dest = String(destDir ?? '');
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'Image not found' };
    if (!dest || !fs.existsSync(dest)) return { ok: false, error: 'Destination does not exist' };
    try {
      const chain = resolveImageChain(src);
      fs.mkdirSync(dest, { recursive: true });
      const copied: string[] = [];
      let copiedBytes = 0;
      for (const item of chain) {
        if (!fs.existsSync(item)) continue;
        const target = path.join(dest, path.basename(item));
        fs.copyFileSync(item, target);
        copied.push(target);
        copiedBytes += fs.statSync(item).size;
      }
      return { ok: true, copied, bytes: copiedBytes, destPath: dest };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('upload-to-cloud', async (_, imagePath: string) => {
    const src = String(imagePath ?? '');
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'Image not found' };
    try {
      const chain = resolveImageChain(src);
      const profileS3 = s3ProfileFromSettings();
      const profileSftp = sftpProfileFromSettings();
      const profileFtp = ftpProfileFromSettings();
      const useS3 = !!(profileS3?.accessKeyId && profileS3.bucket);
      const useSftp = !!(profileSftp?.host && profileSftp.username);
      const useFtp = !!(profileFtp?.host && profileFtp.username);
      if (!useS3 && !useSftp && !useFtp) {
        return {
          ok: false,
          error: 'No cloud profile configured. Set S3, SFTP or FTP credentials in Settings.'
        };
      }
      const uploaded: string[] = [];
      if (useS3) {
        const uri = `s3://${profileS3.bucket}${profileS3.prefix ? '/' + profileS3.prefix : ''}`;
        const config = resolveS3Config(profileS3, uri);
        const store = new S3Store(config);
        for (const item of chain) {
          if (!fs.existsSync(item)) continue;
          await store.put(path.basename(item), fs.readFileSync(item));
          uploaded.push(`${config.prefix}/${path.basename(item)}`.replace(/^\/+/, ''));
        }
      }
      if (useSftp) {
        const store = new SftpStore({ config: resolveSftpConfig(profileSftp, `sftp://${profileSftp.host}`) });
        for (const item of chain) {
          if (!fs.existsSync(item)) continue;
          await store.put(path.basename(item), fs.readFileSync(item));
          uploaded.push(path.basename(item));
        }
      }
      if (useFtp) {
        const store = new FtpStore({ config: resolveFtpConfig(profileFtp, `ftp://${profileFtp.host}`) });
        for (const item of chain) {
          if (!fs.existsSync(item)) continue;
          const key = path.basename(item);
          // put() streams from an in-memory buffer for consistency with S3/SFTP
          // paths; images are large, so hand the path to uploadFile instead.
          await store.uploadFile(item, key);
          uploaded.push(key);
        }
      }
      return { ok: true, uploaded };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Disk health
  ipcMain.handle('check-disk-health', async (_, diskIndex: number) => {
    return checkDiskHealth(diskIndex);
  });

  // SMART health inventory across every physical disk (not just destinations).
  ipcMain.handle('get-media-health', async () => {
    const { inventoryMediaHealth } = await import('./utils/media-health');
    return inventoryMediaHealth();
  });

  // Disk tools
  ipcMain.handle('get-mbr-info', async (_, diskIndex: number) => {
    const { getMbrInfo } = await import('./utils/disk-tools');
    return getMbrInfo(diskIndex);
  });

  ipcMain.handle('get-mbr-raw', async (_, diskIndex: number) => {
    const { getMbrRaw } = await import('./utils/disk-tools');
    return getMbrRaw(diskIndex);
  });

  ipcMain.handle('bootrec-fix-mbr', async () => {
    const { bootRecFixMbr } = await import('./utils/disk-tools');
    return bootRecFixMbr();
  });

  ipcMain.handle('bootrec-rebuild-bcd', async () => {
    const { bootRecRebuildBcd } = await import('./utils/disk-tools');
    return bootRecRebuildBcd();
  });

  ipcMain.handle('chkdsk-scan', async (_, volume: string) => {
    const { chkdskScan } = await import('./utils/disk-tools');
    return chkdskScan(volume);
  });

  ipcMain.handle('chkdsk-fix', async (_, volume: string) => {
    const { chkdskFix } = await import('./utils/disk-tools');
    return chkdskFix(volume);
  });

  ipcMain.handle('chkdsk-bad-sectors', async (_, volume: string) => {
    const { chkdskBadSectors } = await import('./utils/disk-tools');
    return chkdskBadSectors(volume);
  });

  ipcMain.handle('get-trim-status', async () => {
    const { getTrimStatus } = await import('./utils/disk-tools');
    return getTrimStatus();
  });

  ipcMain.handle('retrim-volume', async (_, volume: string) => {
    const { retrimVolume } = await import('./utils/disk-tools');
    return retrimVolume(volume);
  });

  ipcMain.handle('get-smart-all-disks', async () => {
    const { getSmartAllDisks } = await import('./utils/disk-tools');
    return getSmartAllDisks();
  });

  // Anomaly detection across all known local destinations.
  ipcMain.handle('get-backup-anomalies', async () => {
    const { detectAnomalies } = await import('./backup/anomaly-detect');
    const destinations = getRecentDestinations();
    const results = [];
    for (const dir of destinations) {
      if (dir.startsWith('s3://') || dir.startsWith('sftp://') || dir.startsWith('ftp://')) {
        continue;
      }
      try {
        results.push(detectAnomalies(dir));
      } catch {
        // no analytics history — skip
      }
    }
    return results;
  });

  // Non-destructive disk write/read performance test for a destination.
  ipcMain.handle('run-disk-perf', async (_, directory: string) => {
    const { runDiskPerfTest } = await import('./utils/disk-perf');
    return runDiskPerfTest(String(directory ?? ''));
  });

  // VSS (Volume Shadow Copy) maintenance.
  // The deep checks (writers/providers, snapshot smoke test, repair,
  // start/stop) need elevation and relaunch this app through the UAC prompt,
  // dispatching to the elevated helper's `vss` job handler.
  ipcMain.handle('get-vss-status', async () => {
    const { queryVssServiceState } = await import('./utils/vss');
    return queryVssServiceState();
  });
  ipcMain.handle('get-vss-volumes', async () => {
    const { enumerateVolumes } = await import('./utils/vss');
    return enumerateVolumes();
  });
  ipcMain.handle('inspect-vss', async () => {
    return launchElevatedJob<VssJob, unknown, VssJobResult>({ type: 'vss', operation: 'writers' }).promise;
  });
  ipcMain.handle('vss-smoke-test', async (_, volume: string) => {
    const { normalizeVolumeRoot } = await import('./utils/vss');
    return launchElevatedJob<VssJob, unknown, VssJobResult>({
      type: 'vss',
      operation: 'smoke-test',
      volume: normalizeVolumeRoot(String(volume ?? ''))
    }).promise;
  });
  ipcMain.handle('vss-repair', async () => {
    return launchElevatedJob<VssJob, unknown, VssJobResult>({ type: 'vss', operation: 'repair' }).promise;
  });
  ipcMain.handle('vss-service-control', async (_, action: string) => {
    const operation = action === 'stop' ? 'stop' : 'start';
    return launchElevatedJob<VssJob, unknown, VssJobResult>({ type: 'vss', operation }).promise;
  });

  // File browsing over a backup image
  ipcMain.handle('browse-partitions', async (_, imagePath: string) => {
    const format = detectMacriumFormat(imagePath);
    if (format) {
      const info = readMacriumImage(imagePath);
      return {
        encrypted: info.encryption.enable,
        imageFormat: format === 'mrimgx' ? 'mrimgx' : 'mrimg',
        partitions: info.partitions.map((p, i) => {
          const { fsType, browsable } = detectPartitionFilesystem(imagePath, i);
          return {
            partitionIndex: i,
            diskIndex: p.diskIndex,
            size: p.blockCount * p.blockSize,
            offsetOnDisk: p.dataStart,
            blockCount: p.blockCount,
            fsType,
            browsable
          };
        })
      };
    }
    const info = readImageInfo(imagePath);
    return {
      encrypted: info.header.cipherId !== CIPHER_NONE,
      imageFormat: 'opbs',
      partitions: info.partitions
        .filter((p) => p.size > 0)
        .map((p) => {
          const { fsType, browsable } = detectPartitionFilesystem(imagePath, p.partitionIndex);
          return {
            partitionIndex: p.partitionIndex,
            size: p.size,
            offsetOnDisk: p.offsetOnDisk,
            blockCount: p.blockCount,
            fsType,
            browsable
          };
        })
    };
  });

  ipcMain.handle('browse-list', async (_, imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) => {
    try {
      const session = openBrowseSession(imagePath, partitionIndex, passphrase);
      return listDirectory(session, relPath ?? '');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`browse-list failed: ${imagePath}#${partitionIndex} path="${relPath}": ${msg}`, error);
      if (msg.includes('Not an NTFS') || msg.includes('Not a FAT32') || msg.includes('Not an exFAT')) {
        throw new Error('This partition uses an unsupported filesystem. NTFS, FAT32 and exFAT partitions can be browsed.');
      }
      if (msg.includes('chain too long') || msg.includes('chain cycle') || msg.includes('chain spans')) {
        throw new Error(
          'This folder could not be read: the directory allocation chain on this volume is corrupt or unusually long. See the Logs page for details.',
          { cause: error }
        );
      }
      throw error;
    }
  });

  ipcMain.handle('browse-extract', async (_, imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) => {
    try {
      const session = openBrowseSession(imagePath, partitionIndex, passphrase);
      const files = extractPath(session, relPath, outPath);
      return { ok: true, files, outPath };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `browse-extract failed: ${imagePath}#${partitionIndex} path="${relPath}" -> "${outPath}": ${msg}`,
        error
      );
      throw error;
    }
  });

  ipcMain.handle('browse-close', async () => {
    browseSessions.clear();
    closeImageFds();
    clearMacriumInfoCache();
    clearImageInfoCache();
  });

  // Read-only WinFsp mounts of image partitions (elevated helper)
  ipcMain.handle('winfsp-status', async () => {
    const available = winfspAvailable();
    return { available, note: available ? '' : winfspLoadNote() };
  });

  ipcMain.handle('mount-image', async (_, config) => {
    if (!winfspAvailable()) {
      const note = winfspLoadNote();
      const detail = note && note !== 'not attempted' ? ` (${note})` : '';
      const error = `WinFsp is not installed. Install the WinFsp runtime (https://winfsp.dev) and try again.${detail}`;
      logger.warn(`mount-image rejected: ${error}`);
      return { ok: false, error };
    }
    const id = `mount-${crypto.randomUUID()}`;
    const job = {
      type: 'mount',
      imagePath: config.imagePath,
      partitionIndex: config.partitionIndex,
      driveLetter: config.driveLetter,
      label: config.label,
      passphrase: config.passphrase
    };
    logger.info(`mount-image: launching helper for ${job.imagePath}#${job.partitionIndex} (${id})`);
    const launcher = launchElevatedJob<typeof job, any, any>(job);
    mountLaunchers.set(id, { cancel: launcher.cancel });

    // Resolve only once the mount is live (or has failed). Returning early
    // raced the progress event: the renderer set mountIdRef after the invoke
    // settled, so a fast mount-status could be dropped and leave "Mounting…".
    return await new Promise<{ ok: boolean; id: string; mountPoint?: string; error?: string }>((resolve) => {
      let settled = false;
      const finish = (value: { ok: boolean; id: string; mountPoint?: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timeout = setTimeout(() => {
        logger.warn(`mount-image timed out waiting for mount status (${id})`);
        launcher.cancel();
        finish({ ok: false, id, error: 'Mount timed out before the helper reported a status.' });
      }, 10 * 60 * 1000);

      launcher.onProgress((p) => {
        if (mainWindow) {
          // Mount UUID must win: the helper progress payload includes a native
          // numeric handle id that would otherwise clobber it on spread.
          const payload = { ...p, id };
          logger.info(`mount-status → renderer: state=${String(p?.state)} id=${id} mountPoint=${String((p as { mountPoint?: string })?.mountPoint ?? '')}`);
          mainWindow.webContents.send('mount-status', payload);
        } else {
          logger.warn(`mount-status dropped (no window): state=${String(p?.state)} id=${id}`);
        }
        if (p && (p as { state?: string }).state === 'mounted') {
          clearTimeout(timeout);
          finish({
            ok: true,
            id,
            mountPoint: String((p as { mountPoint?: string }).mountPoint ?? '')
          });
        }
      });

      launcher.promise
        .then((result) => {
          mountLaunchers.delete(id);
          clearTimeout(timeout);
          const ok = result?.ok !== false;
          if (!ok) {
            logger.warn(`mount-image failed: ${result?.error ?? 'unknown error'} (${id})`);
          }
          if (mainWindow) {
            mainWindow.webContents.send('mount-status', {
              id,
              state: 'unmounted',
              ok,
              error: ok ? undefined : result?.error
            });
          }
          finish({
            ok,
            id,
            error: ok ? undefined : (result as { error?: string } | null)?.error ?? 'Mount failed'
          });
        })
        .catch((error: unknown) => {
          mountLaunchers.delete(id);
          clearTimeout(timeout);
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`mount-image failed: ${message} (${id})`);
          if (mainWindow) {
            mainWindow.webContents.send('mount-status', {
              id,
              state: 'unmounted',
              ok: false,
              error: message
            });
          }
          finish({ ok: false, id, error: message });
        });
    });
  });

  ipcMain.handle('unmount-image', async (_, id: string) => {
    const launcher = mountLaunchers.get(id);
    if (!launcher) return { ok: false, error: `No such mount: ${id}` };
    launcher.cancel();
    return { ok: true };
  });

  // Select a file to save (browse extraction target)
  ipcMain.handle('select-save-file', async (_, options) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: typeof options?.name === 'string' && options.name ? options.name : undefined,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
      filters: options?.filters || []
    });
    return result.canceled ? undefined : result.filePath;
  });

  // WinPE recovery media
  ipcMain.handle('media-check', async () => {
    const arch = peArchForProcess();
    const adk = locateAdk(arch);
    const node = resolveNodeExe();
    return {
      ok: !!adk,
      arch,
      adkRoot: adk?.root ?? null,
      copype: adk?.copype ?? null,
      makeWinPEMedia: adk?.makeWinPEMedia ?? null,
      dism: adk?.dism ?? null,
      oscdimg: adk?.oscdimg ?? null,
      node,
      ready: !!adk && !!adk.dism && !!node
    };
  });

  ipcMain.handle('media-create', async (_, options: MediaCreateOptions) => {
    return createRecoveryMedia(options);
  });

  // Drives offered by the USB target picker (label/size/bus, system drives excluded)
  ipcMain.handle('media-drives', async () => {
    const { listMediaDrives } = await import('./utils/media-drives');
    return listMediaDrives();
  });

  // Silent Windows ADK install (bootstraps downloaded, installed via one UAC prompt)
  ipcMain.handle('adk-install', async (_, options?: { adkSetup?: string; adkWinPe?: string; installPath?: string }) => {
    return installAdkExe(options ?? {});
  });

  // Silent per-user Node.js runtime install (portable zip, no UAC, no admin)
  ipcMain.handle('node-install', async () => {
    return installNodeRuntime();
  });

  // Silent WinFsp runtime install, then re-check availability
  ipcMain.handle('winfsp-install', async () => {
    const result = await installWinfsp();
    let available: boolean;
    try {
      available = winfspAvailable();
    } catch {
      available = false;
    }
    return { ...result, available };
  });

  // Cloud S3 connection check using the saved cloud profile
  ipcMain.handle('verify-s3', async () => {
    const profile = s3ProfileFromSettings();
    const uri = `s3://${profile?.bucket ?? ''}${profile?.prefix ? '/' + profile.prefix : ''}`;
    try {
      if (!profile?.accessKeyId || !profile.secretAccessKey) {
        throw new Error('S3 access keys are not configured');
      }
      if (!profile.bucket) {
        throw new Error('S3 bucket is not configured');
      }
      const config = resolveS3Config(profile, uri);
      const store = new S3Store(config);
      const keys = await store.listWithMeta(config.prefix);
      return { ok: true, keys };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  });

  // Cloud SFTP connection check using the saved cloud profile
  ipcMain.handle('verify-sftp', async () => {
    const profile = sftpProfileFromSettings();
    try {
      if (!profile?.host) {
        throw new Error('SFTP host is not configured');
      }
      if (!profile.username) {
        throw new Error('SFTP username is not configured');
      }
      if (!profile.password && !profile.privateKey) {
        throw new Error('SFTP password or private key is not configured');
      }
      const uri = `sftp://${profile.host}${profile.remotePath ? '/' + profile.remotePath : ''}`;
      const config = resolveSftpConfig(profile, uri);
      const store = new SftpStore({ config });
      const keys = await store.list();
      return { ok: true, count: keys.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  });

  // Cloud FTP/FTPS connection check using the saved cloud profile
  ipcMain.handle('verify-ftp', async () => {
    const profile = ftpProfileFromSettings();
    try {
      if (!profile?.host) {
        throw new Error('FTP host is not configured');
      }
      if (!profile.username) {
        throw new Error('FTP username is not configured');
      }
      if (!profile.password) {
        throw new Error('FTP password is not configured');
      }
      const uri = `ftp://${profile.host}${profile.remotePath ? '/' + profile.remotePath : ''}`;
      const config = resolveFtpConfig(profile, uri);
      const store = new FtpStore({ config });
      const keys = await store.list();
      return { ok: true, count: keys.length, secure: config.secure };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  });
}
