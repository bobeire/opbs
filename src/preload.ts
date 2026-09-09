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

  // Disk health
  checkDiskHealth: (diskIndex: number) => ipcRenderer.invoke('check-disk-health', diskIndex),

  // Browse backup images (file-level)
  browsePartitions: (imagePath: string) => ipcRenderer.invoke('browse-partitions', imagePath),
  browseList: (imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-list', imagePath, partitionIndex, relPath, passphrase),
  browseExtract: (imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) =>
    ipcRenderer.invoke('browse-extract', imagePath, partitionIndex, relPath, outPath, passphrase),
  browseClose: () => ipcRenderer.invoke('browse-close'),

  // File dialogs
  selectSaveFile: (options?: any) => ipcRenderer.invoke('select-save-file', options),

  // WinPE recovery media
  mediaCheck: () => ipcRenderer.invoke('media-check'),
  mediaCreate: (options: any) => ipcRenderer.invoke('media-create', options),

  // Cloud S3
  verifyS3: () => ipcRenderer.invoke('verify-s3'),

  // Cloud SFTP
  verifySftp: () => ipcRenderer.invoke('verify-sftp'),

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
