import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from 'electron';
import path from 'path';
import * as crypto from 'crypto';
import { DiskEnumerator } from './utils/disk-enumerator';
import { BackupManager } from './backup/manager';
import { RestoreManager } from './restore/manager';
import { BackupScheduler } from './backup/scheduler';
import { SettingsManager } from './utils/settings-manager';
import { logger } from './utils/logger';
import { ImagingEngine } from './imaging/backup-engine';
import { RestoreEngine } from './imaging/restore-engine';
import { dispatchHelperJob } from './helper/job-runner';
import { launchElevatedJob } from './helper/launcher';
import { winfspAvailable } from './imaging/mount-manager';
import { applyRetention, planRetention, scanBackupDirectory, groupIntoChains, writeManifest } from './backup/retention';
import { checkDiskHealth } from './utils/disk-health';
import { runCli } from './cli';
import { readImageInfo, CIPHER_NONE, deriveImageKey } from './imaging/image-format';
import { openAnyBrowse as fsOpenBrowseAny, listDirectory, extractPath, BrowseSession } from './imaging/fs/file-browse';
import { detectMacriumFormat, readMacriumImage } from './imaging/mrimg';
import { locateAdk, peArchForProcess } from './utils/adk';
import { createRecoveryMedia, resolveNodeExe, MediaCreateOptions } from './utils/winpe-media';
import { S3Store, resolveS3Config } from './utils/s3';
import { SftpStore, resolveSftpConfig } from './utils/sftp';

const HELPER_FLAG = '--opbs-helper';

let mainWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;

const diskEnumerator = new DiskEnumerator();
const imagingEngine = new ImagingEngine(diskEnumerator);
const backupManager = new BackupManager(imagingEngine);
const restoreManager = new RestoreManager(new RestoreEngine(diskEnumerator));
const settingsManager = new SettingsManager();
const scheduler = new BackupScheduler(backupManager, settingsManager);

// Read-only image mounts: job launcher per mount id (cancel = unmount).
const mountLaunchers = new Map<string, { cancel(): void }>();

// Cached file browsing sessions (parsing the MFT is expensive; reuse per image).
const browseSessions = new Map<string, BrowseSession>();

function browseCacheKey(imagePath: string, partitionIndex: number, keyHex?: string): string {
  return `${imagePath}#${partitionIndex}${keyHex ? '#' + keyHex : ''}`;
}

function openBrowseSession(imagePath: string, partitionIndex: number, passphrase?: string): BrowseSession {
  let key: Buffer | undefined;
  if (!detectMacriumFormat(imagePath)) {
    const info = readImageInfo(imagePath);
    const header = info.header;
    key =
      header.cipherId !== CIPHER_NONE
        ? deriveImageKey(passphrase ?? '', header.salt, header.kdfIterations)
        : undefined;
  }
  const cacheKey = browseCacheKey(imagePath, partitionIndex, key?.toString('hex'));
  let session = browseSessions.get(cacheKey);
  if (!session) {
    session = fsOpenBrowseAny(imagePath, partitionIndex, key);
    browseSessions.set(cacheKey, session);
  }
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

function runAsHelper(args: string[]): void {
  const [jobPath, resultPath, progressPath, cancelPath] = args;

  app.disableHardwareAcceleration();

  app.whenReady().then(async () => {
    logger.info('Elevated helper mode started');
    try {
      await dispatchHelperJob(jobPath, resultPath, progressPath, cancelPath);
      app.exit(0);
    } catch (error) {
      logger.error('Helper job failed', error);
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
    runAsHelper(process.argv.slice(helperIndex + 1, helperIndex + 5));
    return;
  }

  app.whenReady().then(() => {
    createWindow();
    setupIpcHandlers();
    setupBackupEvents();
    setupRestoreEvents();
    scheduler.startAll();

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

function setupIpcHandlers(): void {
  // About dialog
  ipcMain.handle('show-about', async () => {
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
    const fs = await import('fs');
    fs.writeFileSync(tmpFile, html, 'utf-8');
    aboutWindow.loadFile(tmpFile);
    aboutWindow.on('ready-to-show', () => aboutWindow?.show());
    aboutWindow.on('closed', () => { aboutWindow = null; });
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
          : config;
    return backupManager.startBackup(merged);
  });

  ipcMain.handle('cancel-backup', async () => {
    return backupManager.cancelBackup();
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

  // Settings
  ipcMain.handle('get-settings', async () => {
    return settingsManager.getSettings();
  });

  ipcMain.handle('update-settings', async (_, updates) => {
    const result = settingsManager.updateSettings(updates);
    scheduler.resyncFromSettings();
    return result;
  });

  // Scheduled backups
  ipcMain.handle('add-scheduled-backup', async (_, config) => {
    const result = settingsManager.addScheduledBackup(config);
    if (result.enabled) {
      scheduler.scheduleBackup(result);
    }
    return result;
  });

  ipcMain.handle('update-scheduled-backup', async (_, id, updates) => {
    const result = settingsManager.updateScheduledBackup(id, updates);
    if (result) {
      scheduler.resyncFromSettings();
    }
    return result;
  });

  ipcMain.handle('delete-scheduled-backup', async (_, id) => {
    scheduler.cancelBackup(id);
    return settingsManager.deleteScheduledBackup(id);
  });

  // File dialogs
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    });
    return result.filePaths[0];
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
    // TODO: Return recent log entries
    return [];
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

  // Disk health
  ipcMain.handle('check-disk-health', async (_, diskIndex: number) => {
    return checkDiskHealth(diskIndex);
  });

  // File browsing over a backup image
  ipcMain.handle('browse-partitions', async (_, imagePath: string) => {
    const format = detectMacriumFormat(imagePath);
    if (format) {
      const info = readMacriumImage(imagePath);
      return {
        encrypted: info.encryption.enable,
        imageFormat: format === 'mrimgx' ? 'mrimgx' : 'mrimg',
        partitions: info.partitions.map((p, i) => ({
          partitionIndex: i,
          diskIndex: p.diskIndex,
          size: p.blockCount * p.blockSize,
          offsetOnDisk: p.dataStart,
          blockCount: p.blockCount
        }))
      };
    }
    const info = readImageInfo(imagePath);
    return {
      encrypted: info.header.cipherId !== CIPHER_NONE,
      imageFormat: 'opbs',
      partitions: info.partitions.map((p) => ({
        partitionIndex: p.partitionIndex,
        size: p.size,
        offsetOnDisk: p.offsetOnDisk,
        blockCount: p.blockCount
      }))
    };
  });

  ipcMain.handle('browse-list', async (_, imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) => {
    const session = openBrowseSession(imagePath, partitionIndex, passphrase);
    return listDirectory(session, relPath ?? '');
  });

  ipcMain.handle('browse-extract', async (_, imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) => {
    const session = openBrowseSession(imagePath, partitionIndex, passphrase);
    const files = extractPath(session, relPath, outPath);
    return { ok: true, files, outPath };
  });

  ipcMain.handle('browse-close', async () => {
    browseSessions.clear();
  });

  // Read-only WinFsp mounts of image partitions (elevated helper)
  ipcMain.handle('winfsp-status', async () => {
    return { available: winfspAvailable() };
  });

  ipcMain.handle('mount-image', async (_, config) => {
    if (!winfspAvailable()) {
      return {
        ok: false,
        error: 'WinFsp is not installed. Install the WinFsp runtime (https://winfsp.dev) and try again.'
      };
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
    const launcher = launchElevatedJob<typeof job, any, any>(job);
    launcher.onProgress((p) => {
      if (mainWindow) {
        mainWindow.webContents.send('mount-status', { id, ...p });
      }
    });
    launcher.promise
      .then((result) => {
        mountLaunchers.delete(id);
        if (mainWindow) {
          mainWindow.webContents.send('mount-status', { id, state: 'unmounted', ok: result?.ok !== false });
        }
      })
      .catch(() => {
        mountLaunchers.delete(id);
        if (mainWindow) {
          mainWindow.webContents.send('mount-status', { id, state: 'unmounted', ok: false });
        }
      });
    mountLaunchers.set(id, { cancel: launcher.cancel });
    return { ok: true, id };
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
}
