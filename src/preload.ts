import { contextBridge, ipcRenderer } from 'electron';

/** Payload of the 'cloud-download-progress' event (mirrors CloudDownloadProgress in main). */
type CloudDownloadProgress = {
  file: string;
  fileIndex: number;
  fileCount: number;
  fileBytesDone: number;
  fileBytesTotal: number;
  bytesDone: number;
  bytesTotal: number;
};

contextBridge.exposeInMainWorld('electronAPI', {
  // Disk information
  getDisks: () => ipcRenderer.invoke('get-disks'),
  getPartitions: (diskIndex: number) => ipcRenderer.invoke('get-partitions', diskIndex),

  // Backup operations
  startBackup: (config: unknown) => ipcRenderer.invoke('start-backup', config),
  cancelBackup: () => ipcRenderer.invoke('cancel-backup'),
  isBackupRunning: () => ipcRenderer.invoke('is-backup-running'),
  isHelperTaskRegistered: () => ipcRenderer.invoke('is-helper-task-registered'),
  registerHelperTask: () => ipcRenderer.invoke('register-helper-task'),
  registerUnattendedBackupTask: (scheduleId: string, schedule: unknown) => ipcRenderer.invoke('register-unattended-backup-task', scheduleId, schedule),
  unregisterUnattendedBackupTask: (scheduleId: string) => ipcRenderer.invoke('unregister-unattended-backup-task', scheduleId),
  listUnattendedBackupTasks: () => ipcRenderer.invoke('list-unattended-backup-tasks'),
  getTaskStatus: (taskName: string) => ipcRenderer.invoke('get-task-status', taskName),

  // Restore operations
  startRestore: (config: unknown) => ipcRenderer.invoke('start-restore', config),
  cancelRestore: () => ipcRenderer.invoke('cancel-restore'),
  restorePreflight: (config: unknown) => ipcRenderer.invoke('restore-preflight', config),
  getImageInfo: (imagePath: string, passphrase?: string) => ipcRenderer.invoke('get-image-info', imagePath, passphrase),
  fetchCloudImage: (uri: string) => ipcRenderer.invoke('fetch-cloud-image', uri),
  releaseStagedImage: (imagePath: string) => ipcRenderer.invoke('release-staged-image', imagePath),

  // Partition copy (disk-to-disk clone)
  startClone: (config: unknown) => ipcRenderer.invoke('start-clone', config),
  cancelClone: () => ipcRenderer.invoke('cancel-clone'),
  clonePreflight: (config: unknown) => ipcRenderer.invoke('clone-preflight', config),

  // User-state migration (wizard)
  migratePlan: (payload: unknown) => ipcRenderer.invoke('migrate-plan', payload),
  migrateRun: (payload: unknown) => ipcRenderer.invoke('migrate-run', payload),
  migrateCancel: () => ipcRenderer.invoke('migrate-cancel'),
  migrateProfiles: (source: unknown) => ipcRenderer.invoke('migrate-profiles', source),
  migrateDrillStatus: (dir: string) => ipcRenderer.invoke('migrate-drill-status', dir),
  onMigrateProgress: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on('migrate-progress', handler);
    return () => {
      ipcRenderer.removeListener('migrate-progress', handler);
    };
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates: unknown) => ipcRenderer.invoke('update-settings', updates),
  addScheduledBackup: (config: unknown) => ipcRenderer.invoke('add-scheduled-backup', config),
  updateScheduledBackup: (id: string, updates: unknown) => ipcRenderer.invoke('update-scheduled-backup', id, updates),
  deleteScheduledBackup: (id: string) => ipcRenderer.invoke('delete-scheduled-backup', id),
  validateCron: (expression: string) => ipcRenderer.invoke('validate-cron', expression),
  addBackupProfile: (config: unknown) => ipcRenderer.invoke('add-backup-profile', config),
  updateBackupProfile: (id: string, updates: unknown) => ipcRenderer.invoke('update-backup-profile', id, updates),
  deleteBackupProfile: (id: string) => ipcRenderer.invoke('delete-backup-profile', id),

  // File dialogs
  selectDirectory: (options?: unknown) => ipcRenderer.invoke('select-directory', options),
  pathIsDirectory: (targetPath: string) => ipcRenderer.invoke('path-is-directory', targetPath),
  selectFile: (options?: unknown) => ipcRenderer.invoke('select-file', options),

  // Retention & images
  planRetention: (directory: string, options: unknown) => ipcRenderer.invoke('plan-retention', directory, options),
  applyRetention: (directory: string, options: unknown) => ipcRenderer.invoke('apply-retention', directory, options),
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
  browsePartitions: (imagePath: string, passphrase?: string) => ipcRenderer.invoke('browse-partitions', imagePath, passphrase),
  browseList: (imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-list', imagePath, partitionIndex, relPath, passphrase),
  browseExtract: (imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-extract', imagePath, partitionIndex, relPath, outPath, passphrase),
  browseClose: () => ipcRenderer.invoke('browse-close'),

  // Read-only mount of an image partition (WinFsp, elevated helper)
  winfspStatus: () => ipcRenderer.invoke('winfsp-status'),
  winfspInstall: () => ipcRenderer.invoke('winfsp-install'),
  mountImage: (config: unknown) => ipcRenderer.invoke('mount-image', config),
  unmountImage: (id: string) => ipcRenderer.invoke('unmount-image', id),
  onMountStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('mount-status', handler);
    return () => {
      ipcRenderer.removeListener('mount-status', handler);
    };
  },

  // File dialogs
  selectSaveFile: (options?: unknown) => ipcRenderer.invoke('select-save-file', options),

  // Config builder (read/write config JSON files)
  saveTextFile: (filePath: string, content: string) => ipcRenderer.invoke('save-text-file', filePath, content),
  loadTextFile: (filePath: string) => ipcRenderer.invoke('load-text-file', filePath),

  // About dialog
  showAbout: () => ipcRenderer.invoke('show-about'),

  // WinPE recovery media
  mediaCheck: () => ipcRenderer.invoke('media-check'),
  mediaCreate: (options: unknown) => ipcRenderer.invoke('media-create', options),
  mediaDrives: () => ipcRenderer.invoke('media-drives'),

  // Recovery reboot: stage a restore that runs after reboot in WinRE
  recoveryStage: (config: unknown) => ipcRenderer.invoke('recovery-stage', config),
  recoveryCleanup: () => ipcRenderer.invoke('recovery-cleanup'),
  recoveryStatus: () => ipcRenderer.invoke('recovery-status'),
  recoveryReboot: () => ipcRenderer.invoke('recovery-reboot'),
  adkInstall: (options: unknown) => ipcRenderer.invoke('adk-install', options),
  nodeInstall: () => ipcRenderer.invoke('node-install'),

  // BitLocker status (elevates only when explicitly asked)
  bitlockerStatus: (options?: { elevate?: boolean; refresh?: boolean }) => ipcRenderer.invoke('bitlocker-status', options),
  bitlockerUnlock: (letter: string, recoveryPassword: string) =>
    ipcRenderer.invoke('bitlocker-unlock', { letter, recoveryPassword }),
  bitlockerKeysRead: (imagePath: string, passphrase: string) =>
    ipcRenderer.invoke('bitlocker-keys-read', { imagePath, passphrase }),

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
  getVersion: () => ipcRenderer.invoke('get-version'),

  // `--open-page` startup navigation (consumed once)
  takeStartupNav: () => ipcRenderer.invoke('take-startup-nav'),

  // Network destination discovery
  networkDiscover: () => ipcRenderer.invoke('network-discover'),
  networkShares: (host: string) => ipcRenderer.invoke('network-shares', host),
  networkTest: (uncPath: string, create?: boolean) => ipcRenderer.invoke('network-test', uncPath, create),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => {
      ipcRenderer.removeListener('update-status', handler);
    };
  },

  onNav: (callback: (page: string) => void) => {
    const handler = (_event: unknown, page: string) => callback(page);
    ipcRenderer.on('nav', handler);
    return () => {
      ipcRenderer.removeListener('nav', handler);
    };
  },

  // File-handler verbs (Explorer context menu)
  onOpenImage: (callback: (payload: { verb: string; imagePath: string }) => void) => {
    const handler = (_event: unknown, payload: { verb: string; imagePath: string }) => callback(payload);
    ipcRenderer.on('open-image', handler);
    return () => {
      ipcRenderer.removeListener('open-image', handler);
    };
  },

  // Events
  onActivity: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, activity: unknown) => callback(activity);
    ipcRenderer.on('activity', handler);
    return () => {
      ipcRenderer.removeListener('activity', handler);
    };
  },

  // Events
  onBackupProgress: (callback: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on('backup-progress', handler);
    return () => {
      ipcRenderer.removeListener('backup-progress', handler);
    };
  },
  onRestoreProgress: (callback: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on('restore-progress', handler);
    return () => {
      ipcRenderer.removeListener('restore-progress', handler);
    };
  },
  onCloudDownloadProgress: (callback: (progress: CloudDownloadProgress) => void) => {
    const handler = (_event: unknown, progress: CloudDownloadProgress) => callback(progress);
    ipcRenderer.on('cloud-download-progress', handler);
    return () => {
      ipcRenderer.removeListener('cloud-download-progress', handler);
    };
  },
  onCloneProgress: (callback: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on('clone-progress', handler);
    return () => {
      ipcRenderer.removeListener('clone-progress', handler);
    };
  },
  onMediaProgress: (callback: (progress: { message: string }) => void) => {
    const handler = (_event: unknown, progress: { message: string }) => callback(progress);
    ipcRenderer.on('media-progress', handler);
    return () => {
      ipcRenderer.removeListener('media-progress', handler);
    };
  },
  onRecoveryProgress: (callback: (progress: { message: string }) => void) => {
    const handler = (_event: unknown, progress: { message: string }) => callback(progress);
    ipcRenderer.on('recovery-progress', handler);
    return () => {
      ipcRenderer.removeListener('recovery-progress', handler);
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
  getSmartAllDisks: () => ipcRenderer.invoke('get-smart-all-disks'),

  // Immutable repositories
  repoOpen: (dir: string) => ipcRenderer.invoke('repo-open', dir),
  repoInit: (options: { dir: string; lockDays?: number; passphrase?: string; remote?: { uri: string; lockMode?: 'GOVERNANCE' | 'COMPLIANCE' } }) =>
    ipcRenderer.invoke('repo-init', options),
  repoVerify: (options: { dir: string; fast?: boolean; passphrase?: string; anchorTarget?: string }) =>
    ipcRenderer.invoke('repo-verify', options),
  repoAnchor: (options: { dir: string; target: string }) => ipcRenderer.invoke('repo-anchor', options),
  repoPrune: (options: { dir: string; dryRun?: boolean; passphrase?: string }) =>
    ipcRenderer.invoke('repo-prune', options),
  repoUnlock: (options: { dir: string; target: string; passphrase?: string }) =>
    ipcRenderer.invoke('repo-unlock', options),
  onRepoProgress: (callback: (progress: { message: string }) => void) => {
    const handler = (_event: unknown, progress: { message: string }) => callback(progress);
    ipcRenderer.on('repo-progress', handler);
    return () => {
      ipcRenderer.removeListener('repo-progress', handler);
    };
  },
  // Chain compaction
  compactChain: (
    imagePath: string,
    options?: {
      removeSource?: boolean;
      dryRun?: boolean;
      passphrase?: string;
      repoKey?: { passphrase?: string; keyfile?: string };
    }
  ) => ipcRenderer.invoke('compact-chain', imagePath, options),
  cancelCompact: () => ipcRenderer.invoke('cancel-compact'),
  onCompactProgress: (callback: (progress: {
    phase: 'composing' | 'copying' | 'verifying' | 'finalizing';
    percent: number;
    blocksDone: number;
    blocksTotal: number;
    bytesDone: number;
    totalBytes: number;
    createdAt: number;
  }) => void) => {
    const handler = (_event: unknown, progress: Parameters<typeof callback>[0]) => callback(progress);
    ipcRenderer.on('compact-progress', handler);
    return () => {
      ipcRenderer.removeListener('compact-progress', handler);
    };
  }
});
