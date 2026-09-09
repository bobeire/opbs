import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { SftpProfileSettings } from './sftp';

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
  scheduledBackups: ScheduledBackup[];
  /** Idle background scrub: proactively re-verify the newest images. */
  scrubWhileIdle: boolean;
  scrubIntervalHours: number;
  /** Cloud destination credentials (used for s3:// backup destinations). */
  cloud: CloudSettings;
}

export interface CloudSettings {
  s3: S3ProfileSettings;
  sftp: SftpProfileSettings;
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
  scheduledBackups: [],
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
        return { ...DEFAULT_SETTINGS, ...parsed };
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
}
