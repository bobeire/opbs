export {};

declare global {
  interface Window {
    electronAPI: {
      getDisks: () => Promise<any[]>;
      getPartitions: (diskIndex: number) => Promise<any[]>;
      startBackup: (config: any) => Promise<void>;
      cancelBackup: () => Promise<void>;
      startRestore: (config: any) => Promise<void>;
      cancelRestore: () => Promise<void>;
      getImageInfo: (imagePath: string) => Promise<any>;
      getSettings: () => Promise<any>;
      updateSettings: (updates: any) => Promise<any>;
      addScheduledBackup: (config: any) => Promise<any>;
      updateScheduledBackup: (id: string, updates: any) => Promise<any>;
      deleteScheduledBackup: (id: string) => Promise<boolean>;
      selectDirectory: () => Promise<string | undefined>;
      selectFile: (options?: any) => Promise<string | undefined>;
      selectSaveFile: (options?: any) => Promise<string | undefined>;
      planRetention: (directory: string, options?: any) => Promise<any>;
      applyRetention: (directory: string, options?: any) => Promise<any>;
      listImages: (directory: string) => Promise<any>;
      checkDiskHealth: (diskIndex: number) => Promise<any>;
      browsePartitions: (imagePath: string) => Promise<{ encrypted: boolean; partitions: any[] }>;
      browseList: (imagePath: string, partitionIndex: number, relPath: string, passphrase?: string) => Promise<any[]>;
      browseExtract: (imagePath: string, partitionIndex: number, relPath: string, outPath: string, passphrase?: string) => Promise<any>;
      browseClose: () => Promise<void>;
      mediaCheck: () => Promise<any>;
      mediaCreate: (options: any) => Promise<any>;
      verifyS3: () => Promise<any>;
      verifySftp: () => Promise<any>;
      onBackupProgress: (callback: (progress: any) => void) => () => void;
      onRestoreProgress: (callback: (progress: any) => void) => () => void;
    };
  }
}