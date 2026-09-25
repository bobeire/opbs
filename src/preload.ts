import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Disk information
  getDisks: () => ipcRenderer.invoke('get-disks'),
  getPartitions: (diskIndex: number) => ipcRenderer.invoke('get-partitions', diskIndex),

  // Backup operations
  startBackup: (config: any) => ipcRenderer.invoke('start-backup', config),
  cancelBackup: () => ipcRenderer.invoke('cancel-backup'),
  isBackupRunning: () => ipcRenderer.invoke('is-backup-running'),
  isHelperTaskRegistered: () => ipcRenderer.invoke('is-helper-task-registered'),
  registerHelperTask: () => ipcRenderer.invoke('register-helper-task'),
  registerUnattendedBackupTask: (scheduleId: string, schedule: any) => ipcRenderer.invoke('register-unattended-backup-task', scheduleId, schedule),
  unregisterUnattendedBackupTask: (scheduleId: string) => ipcRenderer.invoke('unregister-unattended-backup-task', scheduleId),
  listUnattendedBackupTasks: () => ipcRenderer.invoke('list-unattended-backup-tasks'),
  getTaskStatus: (taskName: string) => ipcRenderer.invoke('get-task-status', taskName),

  // Restore operations
  startRestore: (config: any) => ipcRenderer.invoke('start-restore', config),
  cancelRestore: () => ipcRenderer.invoke('cancel-restore'),
  restorePreflight: (config: any) => ipcRenderer.invoke('restore-preflight', config),
  getImageInfo: (imagePath: string) => ipcRenderer.invoke('get-image-info', imagePath),

  // Partition copy (disk-to-disk clone)
  startClone: (config: any) => ipcRenderer.invoke('start-clone', config),
  cancelClone: () => ipcRenderer.invoke('cancel-clone'),
  clonePreflight: (config: any) => ipcRenderer.invoke('clone-preflight', config),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates: any) => ipcRenderer.invoke('update-settings', updates),
  addScheduledBackup: (config: any) => ipcRenderer.invoke('add-scheduled-backup', config),
  updateScheduledBackup: (id: string, updates: any) => ipcRenderer.invoke('update-scheduled-backup', id, updates),
  deleteScheduledBackup: (id: string) => ipcRenderer.invoke('delete-scheduled-backup', id),
  validateCron: (expression: string) => ipcRenderer.invoke('validate-cron', expression),
  addBackupProfile: (config: any) => ipcRenderer.invoke('add-backup-profile', config),
  updateBackupProfile: (id: string, updates: any) => ipcRenderer.invoke('update-backup-profile', id, updates),
  deleteBackupProfile: (id: string) => ipcRenderer.invoke('delete-backup-profile', id),

  // File dialogs
  selectDirectory: (options?: any) => ipcRenderer.invoke('select-directory', options),
  selectFile: (options?: any) => ipcRenderer.invoke('select-file', options),

  // Retention & images
  planRetention: (directory: string, options: any) => ipcRenderer.invoke('plan-retention', directory, options),
  applyRetention: (directory: string, options: any) => ipcRenderer.invoke('apply-retention', directory, options),
  listImages: (directory: string) => ipcRenderer.invoke('list-images', directory),

  // Recent backups & backup actions
  listRecentBackups: () => ipcRenderer.invoke('list-recent-backups'),
  addRecentDestination: (directory: string) => ipcRenderer.invoke('add-recent-destination', directory),
  destinationHealth: (destinations: string[]) => ipcRenderer.invoke('destination-health', destinations),
  getBackupAnalytics: () => ipcRenderer.invoke('get-backup-analytics'),
  startScrub: (directory: string, scope?: string) => ipcRenderer.invoke('start-scrub', directory, scope),
  getScrubStatus: () => ipcRenderer.invoke('get-scrub-status'),
  getBackupIntegrity: () => ipcRenderer.invoke('get-backup-integrity'),
  getStorageHealth: () => ipcRenderer.invoke('get-storage-health'),
  openPath: (filePath: string) => ipcRenderer.invoke('open-path', filePath),
  copyImage: (imagePath: string, destDir: string) => ipcRenderer.invoke('copy-image', imagePath, destDir),
  uploadToCloud: (imagePath: string) => ipcRenderer.invoke('upload-to-cloud', imagePath),

  // Disk health
  checkDiskHealth: (diskIndex: number) => ipcRenderer.invoke('check-disk-health', diskIndex),
  getMediaHealth: () => ipcRenderer.invoke('get-media-health'),
  getBackupAnomalies: () => ipcRenderer.invoke('get-backup-anomalies'),
  runDiskPerf: (directory: string) => ipcRenderer.invoke('run-disk-perf', directory),

  // VSS (Volume Shadow Copy) maintenance
  getVssStatus: () => ipcRenderer.invoke('get-vss-status'),
  getVssVolumes: () => ipcRenderer.invoke('get-vss-volumes'),
  inspectVss: () => ipcRenderer.invoke('inspect-vss'),
  vssSmokeTest: (volume: string) => ipcRenderer.invoke('vss-smoke-test', volume),
  vssRepair: () => ipcRenderer.invoke('vss-repair'),
  vssServiceControl: (action: 'start' | 'stop') => ipcRenderer.invoke('vss-service-control', action),

  // Browse backup images (file-level)
  browsePartitions: (imagePath: string) => ipcRenderer.invoke('browse-partitions', imagePath),
  browseList: (imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-list', imagePath, partitionIndex, relPath, passphrase),
  browseExtract: (imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-extract', imagePath, partitionIndex, relPath, outPath, passphrase),
  browseClose: () => ipcRenderer.invoke('browse-close'),

  // Read-only mount of an image partition (WinFsp, elevated helper)
  winfspStatus: () => ipcRenderer.invoke('winfsp-status'),
  winfspInstall: () => ipcRenderer.invoke('winfsp-install'),
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
  mediaDrives: () => ipcRenderer.invoke('media-drives'),
  adkInstall: (options: any) => ipcRenderer.invoke('adk-install', options),
  nodeInstall: () => ipcRenderer.invoke('node-install'),

  // Cloud S3
  verifyS3: () => ipcRenderer.invoke('verify-s3'),

  // Cloud SFTP
  verifySftp: () => ipcRenderer.invoke('verify-sftp'),

  // Cloud FTP/FTPS
  verifyFtp: () => ipcRenderer.invoke('verify-ftp'),

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

  // File-handler verbs (Explorer context menu)
  onOpenImage: (callback: (payload: { verb: string; imagePath: string }) => void) => {
    const handler = (_event: any, payload: { verb: string; imagePath: string }) => callback(payload);
    ipcRenderer.on('open-image', handler);
    return () => {
      ipcRenderer.removeListener('open-image', handler);
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
  },
  onCloneProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('clone-progress', handler);
    return () => {
      ipcRenderer.removeListener('clone-progress', handler);
    };
  },

  // Disk tools
  getMbrInfo: (diskIndex: number) => ipcRenderer.invoke('get-mbr-info', diskIndex),
  getMbrRaw: (diskIndex: number) => ipcRenderer.invoke('get-mbr-raw', diskIndex),
  bootRecFixMbr: () => ipcRenderer.invoke('bootrec-fix-mbr'),
  bootRecRebuildBcd: () => ipcRenderer.invoke('bootrec-rebuild-bcd'),
  chkdskScan: (volume: string) => ipcRenderer.invoke('chkdsk-scan', volume),
  chkdskFix: (volume: string) => ipcRenderer.invoke('chkdsk-fix', volume),
  chkdskBadSectors: (volume: string) => ipcRenderer.invoke('chkdsk-bad-sectors', volume),
  getTrimStatus: () => ipcRenderer.invoke('get-trim-status'),
  retrimVolume: (volume: string) => ipcRenderer.invoke('retrim-volume', volume),
  getSmartAllDisks: () => ipcRenderer.invoke('get-smart-all-disks')
});
