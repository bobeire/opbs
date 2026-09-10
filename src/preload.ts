import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Disk information
  getDisks: () => ipcRenderer.invoke('get-disks'),
  getPartitions: (diskIndex: number) => ipcRenderer.invoke('get-partitions', diskIndex),

  // Backup operations
  startBackup: (config: any) => ipcRenderer.invoke('start-backup', config),
  cancelBackup: () => ipcRenderer.invoke('cancel-backup'),

  // Restore operations
  startRestore: (config: any) => ipcRenderer.invoke('start-restore', config),
  cancelRestore: () => ipcRenderer.invoke('cancel-restore'),
  getImageInfo: (imagePath: string) => ipcRenderer.invoke('get-image-info', imagePath),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates: any) => ipcRenderer.invoke('update-settings', updates),
  addScheduledBackup: (config: any) => ipcRenderer.invoke('add-scheduled-backup', config),
  updateScheduledBackup: (id: string, updates: any) => ipcRenderer.invoke('update-scheduled-backup', id, updates),
  deleteScheduledBackup: (id: string) => ipcRenderer.invoke('delete-scheduled-backup', id),

  // File dialogs
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFile: (options?: any) => ipcRenderer.invoke('select-file', options),

  // Retention & images
  planRetention: (directory: string, options: any) => ipcRenderer.invoke('plan-retention', directory, options),
  applyRetention: (directory: string, options: any) => ipcRenderer.invoke('apply-retention', directory, options),
  listImages: (directory: string) => ipcRenderer.invoke('list-images', directory),

  // Recent backups & backup actions
  listRecentBackups: () => ipcRenderer.invoke('list-recent-backups'),
  addRecentDestination: (directory: string) => ipcRenderer.invoke('add-recent-destination', directory),
  openPath: (filePath: string) => ipcRenderer.invoke('open-path', filePath),
  copyImage: (imagePath: string, destDir: string) => ipcRenderer.invoke('copy-image', imagePath, destDir),
  uploadToCloud: (imagePath: string) => ipcRenderer.invoke('upload-to-cloud', imagePath),

  // Disk health
  checkDiskHealth: (diskIndex: number) => ipcRenderer.invoke('check-disk-health', diskIndex),

  // Browse backup images (file-level)
  browsePartitions: (imagePath: string) => ipcRenderer.invoke('browse-partitions', imagePath),
  browseList: (imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-list', imagePath, partitionIndex, relPath, passphrase),
  browseExtract: (imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-extract', imagePath, partitionIndex, relPath, outPath, passphrase),
  browseClose: () => ipcRenderer.invoke('browse-close'),

  // Read-only mount of an image partition (WinFsp, elevated helper)
  winfspStatus: () => ipcRenderer.invoke('winfsp-status'),
  mountImage: (config: any) => ipcRenderer.invoke('mount-image', config),
  unmountImage: (id: string) => ipcRenderer.invoke('unmount-image', id),
  onMountStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('mount-status', handler);
    return () => {
      ipcRenderer.removeListener('mount-status', handler);
    };
  },

  // File dialogs
  selectSaveFile: (options?: any) => ipcRenderer.invoke('select-save-file', options),

  // About dialog
  showAbout: () => ipcRenderer.invoke('show-about'),

  // WinPE recovery media
  mediaCheck: () => ipcRenderer.invoke('media-check'),
  mediaCreate: (options: any) => ipcRenderer.invoke('media-create', options),

  // Cloud S3
  verifyS3: () => ipcRenderer.invoke('verify-s3'),

  // Cloud SFTP
  verifySftp: () => ipcRenderer.invoke('verify-sftp'),

  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  readLogFile: (filePath: string) => ipcRenderer.invoke('read-log-file', filePath),

  // Settings export/import
  exportSettings: () => ipcRenderer.invoke('export-settings'),
  importSettings: () => ipcRenderer.invoke('import-settings'),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Network destination discovery
  networkDiscover: () => ipcRenderer.invoke('network-discover'),
  networkShares: (host: string) => ipcRenderer.invoke('network-shares', host),
  networkTest: (uncPath: string, create?: boolean) => ipcRenderer.invoke('network-test', uncPath, create),
  onUpdateStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => {
      ipcRenderer.removeListener('update-status', handler);
    };
  },

  onNav: (callback: (page: string) => void) => {
    const handler = (_event: any, page: string) => callback(page);
    ipcRenderer.on('nav', handler);
    return () => {
      ipcRenderer.removeListener('nav', handler);
    };
  },

  // Events
  onActivity: (callback: (event: any) => void) => {
    const handler = (_event: any, activity: any) => callback(activity);
    ipcRenderer.on('activity', handler);
    return () => {
      ipcRenderer.removeListener('activity', handler);
    };
  },

  // Events
  onBackupProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('backup-progress', handler);
    return () => {
      ipcRenderer.removeListener('backup-progress', handler);
    };
  },
  onRestoreProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('restore-progress', handler);
    return () => {
      ipcRenderer.removeListener('restore-progress', handler);
    };
  }
});
