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
      restorePreflight: (config: any) => Promise<{
        ok: boolean;
        error?: string;
        requiredBytes?: number;
        targetDiskBytes?: number;
        targetDiskModel?: string;
        targetDiskPartitionCount?: number;
        targets?: Array<{ partitionIndex: number; offset: number; size: number }>;
        writeTableScheme?: string | null;
        warnings?: string[];
        sameDisk?: boolean;
        encrypted?: boolean;
        passphraseRequired?: boolean;
      }>;
      getImageInfo: (imagePath: string) => Promise<any>;
      getSettings: () => Promise<any>;
      updateSettings: (updates: any) => Promise<any>;
      addScheduledBackup: (config: any) => Promise<any>;
      updateScheduledBackup: (id: string, updates: any) => Promise<any>;
      deleteScheduledBackup: (id: string) => Promise<boolean>;
      validateCron: (expression: string) => Promise<boolean>;
      addBackupProfile: (config: any) => Promise<any>;
      updateBackupProfile: (id: string, updates: any) => Promise<any>;
      deleteBackupProfile: (id: string) => Promise<boolean>;
      selectDirectory: () => Promise<string | undefined>;
      selectFile: (options?: any) => Promise<string | undefined>;
      selectSaveFile: (options?: any) => Promise<string | undefined>;
      planRetention: (directory: string, options?: any) => Promise<any>;
      applyRetention: (directory: string, options?: any) => Promise<any>;
      listImages: (directory: string) => Promise<any>;
      listRecentBackups: () => Promise<{ entries: any[]; destinations: string[] }>;
      addRecentDestination: (directory: string) => Promise<{ destinations: string[] }>;
      getBackupAnalytics: () => Promise<{
        destinations: Array<{
          directory: string;
          imageCount: number;
          chainCount: number;
          totalDiskBytes: number;
          totalImageBytes: number;
          avgCompressionRatio: number;
          chains: any[];
        }>;
        totals: { totalDiskBytes: number; totalImageBytes: number; avgCompressionRatio: number };
      }>;
      startScrub: (directory: string, scope?: string) => Promise<{ started: boolean; error?: string }>;
      getScrubStatus: () => Promise<
        Array<{
          directory: string;
          latest: any;
          lastOk: boolean | null;
          lastScrubAt: number;
          totalRepaired: number;
          corruptImages: number;
        }>
      >;
      destinationHealth: (destinations: string[]) => Promise<{
        path: string;
        reachable: boolean;
        error?: string;
        freeBytes?: number;
        totalBytes?: number;
        imageCount: number;
        chainCount: number;
        newestDate?: number;
        oldestDate?: number;
        plannedPrune: number;
      }[]>;
      getBackupIntegrity: () => Promise<
        Array<{
          directory: string;
          chain: {
            chainCount: number;
            completeChains: number;
            brokenChains: number;
            chains: Array<{
              rootName: string;
              rootPath: string;
              orphaned: boolean;
              complete: boolean;
              itemCount: number;
              oldestTimestamp: number;
              newestTimestamp: number;
              missingBaseName?: string;
              fullImageName?: string;
            }>;
            missingBases: Array<{ imageName: string; basePath: string }>;
            unparseableImages: string[];
          };
          tamper: {
            manifestPresent: boolean;
            manifestUpdatedAt?: string;
            ok: boolean;
            diff: {
              missing: Array<{ name: string; manifestSize: number }>;
              sizeChanged: Array<{ name: string; manifestSize: number; diskSize: number }>;
              unexpected: Array<{ name: string; size: number }>;
            };
          };
        }>
      >;
      getBackupAnomalies: () => Promise<
        Array<{
          directory: string;
          historyCount: number;
          baseline: {
            medianIntervalMs?: number;
            medianRatio?: number;
            medianSpeedMBs?: number;
            medianBytesFull?: number;
            medianBytesDelta?: number;
          };
          anomalies: Array<{
            kind: 'size' | 'ratio' | 'speed' | 'gap' | 'info';
            severity: 'critical' | 'warning' | 'info';
            message: string;
            metric?: number;
            baseline?: number;
          }>;
          ok: boolean;
        }>
      >;
      getStorageHealth: () => Promise<
        Array<{
          path: string;
          reachable: boolean;
          error?: string;
          freeBytes?: number;
          totalBytes?: number;
          imageCount: number;
          chainCount: number;
          completeChains: number;
          brokenChains: number;
          verifiedImages: number;
          parityProtectedImages: number;
          newestDate?: number;
          oldestDate?: number;
          tamperDrift: boolean;
          tamperManifestPresent: boolean;
          imagesScrubbed: number;
          lastScrubAt?: number;
          lastScrubOk: boolean | null;
          lastDrillAt?: number;
          hasDrill: boolean;
          smart: {
            diskIndex?: number;
            driveLetter?: string;
            available: boolean;
            warnings: string[];
          };
          score: number;
          status: 'good' | 'degraded' | 'at-risk';
          warnings: string[];
        }>
      >;
      openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
      copyImage: (imagePath: string, destDir: string) => Promise<{ ok: boolean; copied?: string[]; bytes?: number; destPath?: string; error?: string }>;
      uploadToCloud: (imagePath: string) => Promise<{ ok: boolean; uploaded?: string[]; error?: string }>;
      checkDiskHealth: (diskIndex: number) => Promise<any>;
      getMediaHealth: () => Promise<
        Array<{
          diskIndex: number;
          model: string;
          serial: string;
          size: number;
          driveLetters: string[];
          health: {
            data?: {
              model?: string;
              healthStatus?: string;
              mediaType?: string;
              powerOnHours?: number;
              temperatureCelsius?: number;
              wear?: number;
              readErrors?: number;
              writeErrors?: number;
              unreliableSectors?: number;
            } | null;
            reliable: boolean;
            warnings: string[];
          };
          unhealthy: boolean;
        }>
      >;
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
      winfspStatus: () => Promise<{ available: boolean }>;
      mountImage: (config: any) => Promise<{ ok: boolean; id?: string; error?: string }>;
      unmountImage: (id: string) => Promise<{ ok: boolean; error?: string }>;
      onMountStatus: (callback: (status: any) => void) => () => void;
      showAbout: () => Promise<void>;
      getLogs: () => Promise<{ name: string; path: string; size: number; modified: number; ageDays: number }[]>;
      readLogFile: (filePath: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
      exportSettings: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      importSettings: () => Promise<{ ok: boolean; canceled?: boolean; settings?: any; error?: string }>;
      checkForUpdates: () => Promise<{ ok: boolean }>;
      installUpdate: () => Promise<{ ok: boolean }>;
      networkDiscover: () => Promise<{ machines: { name: string; addresses: string[]; services: string[] }[] }>;
      networkShares: (host: string) => Promise<{ shares: { unc: string; name: string; kind: string; reachable: boolean; writable: boolean; remark?: string }[] }>;
      networkTest: (uncPath: string, create?: boolean) => Promise<{ path: string; ok: boolean; writable?: boolean; reachable?: boolean; created?: boolean; error?: string }>;
      onUpdateStatus: (callback: (status: any) => void) => () => void;
      onNav: (callback: (page: string) => void) => () => void;
      onOpenImage: (callback: (payload: { verb: string; imagePath: string }) => void) => () => void;
      onActivity: (callback: (event: any) => void) => () => void;
    };
  }
}