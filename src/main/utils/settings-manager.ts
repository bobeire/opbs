import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { SftpProfileSettings } from './sftp';
import { FtpProfileSettings } from './ftp';
import { ErrorReportingConfig } from './error-reporter';

export interface AppSettings {
  defaultCompression: number;
  defaultVerification: boolean;
  backupLocation: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  autoCleanup: boolean;
  retentionDays: number;
  keepFull: number;
  keepDeltasPerFull: number;
  notifications: NotificationSettings;
  scheduledVerification: ScheduledVerification;
  /** Restore drills: periodically restore the newest image in a directory to a
   *  scratch disk and validate the filesystems so "restores work" is proven,
   *  not assumed. */
  scheduledDrill: ScheduledRestoreDrill;
  scheduledBackups: ScheduledBackup[];
  /** Reusable named backup configurations loaded into the backup wizard. */
  backupProfiles: BackupProfile[];
  /** Idle background scrub: proactively re-verify the newest images. */
  scrubWhileIdle: boolean;
  /** Scheduled self-healing scrub: read back + repair from `.opar` parity. */
  scheduledScrub: ScheduledScrub;
  /** Anonymous crash/error reporting (opt-in). */
  errorReporting: ErrorReportingConfig;
  /** Register OPBS as the Windows handler/context menu for `.opbs` images. */
  fileAssociations: boolean;
  scrubIntervalHours: number;
  /** Cloud destination credentials (used for s3:// backup destinations). */
  cloud: CloudSettings;
}

export interface CloudSettings {
  s3: S3ProfileSettings;
  sftp: SftpProfileSettings;
  ftp: FtpProfileSettings;
}

export interface S3ProfileSettings {
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  webhookUrl: string;
  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
}

export interface ScheduledVerification {
  enabled: boolean;
  cronExpression: string;
  scope: 'newest' | 'all';
  destinationPath: string;
  notifyOnFailure: boolean;
  /** Alert (webhook/toast) only after this many consecutive failures. */
  alertAfter?: number;
}

export interface ScheduledRestoreDrill {
  enabled: boolean;
  cronExpression: string;
  /** Directory scanned for the image to drill (the newest unencrypted one). */
  destinationPath: string;
  /** Scratch disk the image is restored onto (its data is destructively overwritten). */
  targetDiskIndex: number;
  notifyOnFailure: boolean;
  /** Verify every chain image before writing (default true). */
  verifyBeforeWrite?: boolean;
  /** Alert (webhook/toast) only after this many consecutive failures. */
  alertAfter?: number;
}

export interface ScheduledScrub {
  enabled: boolean;
  cronExpression: string;
  destinationPath: string;
  scope: 'newest' | 'all';
  /** Rebuild corrupted blocks from `.opar` parity when available. */
  repair: boolean;
  notifyOnFailure: boolean;
  /** Alert (webhook/toast) only after this many consecutive failing scrubs. */
  alertAfter?: number;
}

export interface ScheduledBackup {
  id: string;
  name: string;
  cronExpression: string;
  sourceDiskIndex: number;
  sourcePartitions: number[];
  destinationPath: string;
  compressionLevel: number;
  compressionType?: 'deflate' | 'zstd';
  compressionThreads?: number;
  verificationEnabled: boolean;
  incremental: boolean;
  passphrase?: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  /** Number of automatic retries after a failed run before alerting (default 2). */
  maxRetries?: number;
  /** Base delay between retries in minutes; doubles each attempt (default 5). */
  retryDelayMinutes?: number;
  /** Per-schedule retention toggle; overrides the global auto-cleanup setting. */
  retentionApplied?: boolean;
  /** Number of most recent full chains kept when this schedule prunes. */
  retentionKeepFull?: number;
  /** Max trailing deltas kept per retained chain for this schedule. */
  retentionKeepDeltasPerFull?: number;
  /** Never delete images newer than this many days for this schedule. */
  retentionDays?: number;
}

export interface BackupProfile {
  id: string;
  name: string;
  sourceDiskIndex: number;
  sourcePartitions: number[];
  destinationPath: string;
  compressionLevel: number;
  compressionType?: 'deflate' | 'zstd';
  compressionThreads?: number;
  verificationEnabled: boolean;
  incremental: boolean;
  passphrase?: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultCompression: 3,
  defaultVerification: true,
  backupLocation: '',
  logLevel: 'info',
  autoCleanup: false,
  retentionDays: 30,
  keepFull: 3,
  keepDeltasPerFull: 3,
  notifications: {
    enabled: true,
    webhookUrl: '',
    notifyOnFailure: true,
    notifyOnSuccess: false
  },
  scheduledVerification: {
    enabled: false,
    cronExpression: '0 2 * * *',
    scope: 'newest',
    destinationPath: '',
    notifyOnFailure: true,
    alertAfter: 2
  },
  scheduledDrill: {
    enabled: false,
    cronExpression: '0 3 * * 0',
    destinationPath: '',
    targetDiskIndex: 0,
    notifyOnFailure: true,
    verifyBeforeWrite: true,
    alertAfter: 2
  },
  scheduledScrub: {
    enabled: false,
    cronExpression: '0 4 * * 1',
    destinationPath: '',
    scope: 'all',
    repair: true,
    notifyOnFailure: true,
    alertAfter: 2
  },
  scheduledBackups: [],
  backupProfiles: [],
  errorReporting: {
    enabled: false,
    endpoint: ''
  },
  fileAssociations: true,
  scrubWhileIdle: false,
  scrubIntervalHours: 24,
  cloud: {
    s3: {
      region: 'us-east-1',
      endpoint: '',
      bucket: '',
      prefix: '',
      accessKeyId: '',
      secretAccessKey: '',
      forcePathStyle: false
    },
    sftp: {
      host: '',
      port: 22,
      username: '',
      password: '',
      privateKey: '',
      remotePath: ''
    },
    ftp: {
      host: '',
      port: 21,
      username: '',
      password: '',
      remotePath: '',
      secure: 'explicit'
    }
  }
};

export class SettingsManager {
  private settingsFile: string;
  private settings: AppSettings;

  constructor() {
    const configDir = app.getPath('userData');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    this.settingsFile = path.join(configDir, 'settings.json');
    this.settings = this.load();
  }

  private load(): AppSettings {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const data = fs.readFileSync(this.settingsFile, 'utf-8');
        const parsed = JSON.parse(data);
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          cloud: {
            ...DEFAULT_SETTINGS.cloud,
            ...(parsed?.cloud || {}),
            s3: { ...DEFAULT_SETTINGS.cloud.s3, ...(parsed?.cloud?.s3 || {}) },
            sftp: { ...DEFAULT_SETTINGS.cloud.sftp, ...(parsed?.cloud?.sftp || {}) },
            ftp: { ...DEFAULT_SETTINGS.cloud.ftp, ...(parsed?.cloud?.ftp || {}) }
          }
        };
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
    
    return { ...DEFAULT_SETTINGS };
  }

  save(): void {
    try {
      fs.writeFileSync(
        this.settingsFile,
        JSON.stringify(this.settings, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  updateSettings(updates: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...updates };
    this.save();
    return this.getSettings();
  }

  addScheduledBackup(config: Omit<ScheduledBackup, 'id' | 'enabled' | 'lastRun' | 'nextRun'>): ScheduledBackup {
    const newBackup: ScheduledBackup = {
      ...config,
      id: Date.now().toString(),
      enabled: true,
      lastRun: undefined,
      nextRun: undefined
    };
    
    this.settings.scheduledBackups.push(newBackup);
    this.save();
    return newBackup;
  }

  updateScheduledBackup(id: string, updates: Partial<ScheduledBackup>): ScheduledBackup | null {
    const index = this.settings.scheduledBackups.findIndex(b => b.id === id);
    if (index === -1) {
      return null;
    }
    
    this.settings.scheduledBackups[index] = {
      ...this.settings.scheduledBackups[index],
      ...updates,
      id
    };
    this.save();
    return this.settings.scheduledBackups[index];
  }

  deleteScheduledBackup(id: string): boolean {
    const index = this.settings.scheduledBackups.findIndex(b => b.id === id);
    if (index === -1) {
      return false;
    }
    
    this.settings.scheduledBackups.splice(index, 1);
    this.save();
    return true;
  }

  addBackupProfile(config: Omit<BackupProfile, 'id'>): BackupProfile | null {
    if (!config.name?.trim()) {
      return null;
    }
    const profile: BackupProfile = {
      ...config,
      name: config.name.trim(),
      id: Date.now().toString()
    };
    this.settings.backupProfiles.push(profile);
    this.save();
    return profile;
  }

  updateBackupProfile(id: string, updates: Partial<BackupProfile>): BackupProfile | null {
    const index = this.settings.backupProfiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return null;
    }
    this.settings.backupProfiles[index] = {
      ...this.settings.backupProfiles[index],
      ...updates,
      id
    };
    this.save();
    return this.settings.backupProfiles[index];
  }

  deleteBackupProfile(id: string): boolean {
    const index = this.settings.backupProfiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return false;
    }
    this.settings.backupProfiles.splice(index, 1);
    this.save();
    return true;
  }
}
