import { useState, useEffect } from 'react';

interface NotificationSettings {
  enabled: boolean;
  webhookUrl: string;
  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
}

interface ScheduledVerification {
  enabled: boolean;
  cronExpression: string;
  scope: 'newest' | 'all';
  destinationPath: string;
  notifyOnFailure: boolean;
  alertAfter?: number;
}

interface ScheduledRestoreDrill {
  enabled: boolean;
  cronExpression: string;
  destinationPath: string;
  targetDiskIndex: number;
  notifyOnFailure: boolean;
  verifyBeforeWrite?: boolean;
  alertAfter?: number;
}

interface ScheduledScrub {
  enabled: boolean;
  cronExpression: string;
  destinationPath: string;
  scope: 'newest' | 'all';
  repair: boolean;
  notifyOnFailure: boolean;
  alertAfter?: number;
}

interface S3Profile {
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

interface SftpProfile {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  remotePath: string;
}

interface FtpProfile {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  secure: 'plain' | 'explicit' | 'implicit';
}

interface CloudSettings {
  s3: S3Profile;
  sftp: SftpProfile;
  ftp: FtpProfile;
}

interface DiskInfo {
  index: number;
  model: string;
  size: number;
  partitions: PartitionInfo[];
}

interface PartitionInfo {
  diskIndex: number;
  partitionIndex: number;
  driveLetter: string | null;
  label: string;
  fsType: string;
  size: number;
  usedSpace: number;
  isSystem: boolean;
  isBoot: boolean;
}

interface Settings {
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
  scheduledDrill: ScheduledRestoreDrill;
  scheduledScrub: ScheduledScrub;
  cloud: CloudSettings;
  errorReporting: { enabled: boolean; endpoint: string };
  fileAssociations: boolean;
}

const DEFAULT_SETTINGS: Settings = {
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
  },
  errorReporting: {
    enabled: false,
    endpoint: ''
  },
  fileAssociations: true
};

function Settings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);
  const [s3Checking, setS3Checking] = useState(false);
  const [s3Result, setS3Result] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);
  const [sftpChecking, setSftpChecking] = useState(false);
  const [sftpResult, setSftpResult] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);
  const [ftpChecking, setFtpChecking] = useState(false);
  const [ftpResult, setFtpResult] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);
  const [exportResult, setExportResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [importResult, setImportResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [helperTaskRegistered, setHelperTaskRegistered] = useState(false);
  const [helperTaskLoading, setHelperTaskLoading] = useState(false);
  const [helperTaskError, setHelperTaskError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.electronAPI.getSettings().then((loaded) => {
      if (alive) setSettings(mergeSettings(loaded));
    });
    window.electronAPI.getDisks().then((diskList) => {
      if (alive) setDisks(diskList ?? []);
    });
    window.electronAPI.isHelperTaskRegistered().then((registered) => {
      if (alive) setHelperTaskRegistered(registered);
    });
    return () => {
      alive = false;
    };
  }, []);

  const registerHelperTask = async () => {
    setHelperTaskLoading(true);
    setHelperTaskError(null);
    try {
      await window.electronAPI.registerHelperTask();
      setHelperTaskRegistered(true);
    } catch (e: any) {
      setHelperTaskError(e?.message ?? 'Registration failed');
    } finally {
      setHelperTaskLoading(false);
    }
  };

  const mergeSettings = (loaded: any): Settings => ({
    ...DEFAULT_SETTINGS,
    ...loaded,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(loaded?.notifications || {}) },
    scheduledVerification: { ...DEFAULT_SETTINGS.scheduledVerification, ...(loaded?.scheduledVerification || {}) },
    scheduledDrill: { ...DEFAULT_SETTINGS.scheduledDrill, ...(loaded?.scheduledDrill || {}) },
    scheduledScrub: { ...DEFAULT_SETTINGS.scheduledScrub, ...(loaded?.scheduledScrub || {}) },
    cloud: {
      s3: { ...DEFAULT_SETTINGS.cloud.s3, ...(loaded?.cloud?.s3 || {}) },
      sftp: { ...DEFAULT_SETTINGS.cloud.sftp, ...(loaded?.cloud?.sftp || {}) },
      ftp: { ...DEFAULT_SETTINGS.cloud.ftp, ...(loaded?.cloud?.ftp || {}) }
    },
    errorReporting: { ...DEFAULT_SETTINGS.errorReporting, ...(loaded?.errorReporting || {}) }
  });

  const handleSave = async () => {
    const saved = await window.electronAPI.updateSettings(settings);
    setSettings(mergeSettings(saved));
    setHasChanges(false);
  };

  const handleSelectVerificationDir = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      handleChange('scheduledVerification', { ...settings.scheduledVerification, destinationPath: dir });
    }
  };

  const handleSelectDrillDir = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      handleChange('scheduledDrill', { ...settings.scheduledDrill, destinationPath: dir });
    }
  };

  const handleSelectScrubDir = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      handleChange('scheduledScrub', { ...settings.scheduledScrub, destinationPath: dir });
    }
  };

  const handleSelectBackupLocation = async () => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setSettings({ ...settings, backupLocation: path });
      setHasChanges(true);
    }
  };

  const handleChange = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings({ ...settings, [key]: value });
    setHasChanges(true);
  };

  const handleS3Change = (key: keyof S3Profile, value: any) => {
    setSettings({ ...settings, cloud: { ...settings.cloud, s3: { ...settings.cloud.s3, [key]: value } } });
    setHasChanges(true);
  };

  const handleSftpChange = (key: keyof SftpProfile, value: any) => {
    setSettings({ ...settings, cloud: { ...settings.cloud, sftp: { ...settings.cloud.sftp, [key]: value } } });
    setHasChanges(true);
  };

  const handleFtpChange = (key: keyof FtpProfile, value: any) => {
    setSettings({ ...settings, cloud: { ...settings.cloud, ftp: { ...settings.cloud.ftp, [key]: value } } });
    setHasChanges(true);
  };

  const handleTestS3 = async () => {
    setS3Checking(true);
    setS3Result(null);
    try {
      const saved = await window.electronAPI.updateSettings(settings);
      setSettings(mergeSettings(saved));
      const result = await window.electronAPI.verifyS3();
      setS3Result(result.ok ? { ok: true, count: result.keys?.length ?? 0 } : { ok: false, error: result.error });
    } catch (e: any) {
      setS3Result({ ok: false, error: e?.message ?? 'Connection failed' });
    } finally {
      setS3Checking(false);
    }
  };

  const handleTestSftp = async () => {
    setSftpChecking(true);
    setSftpResult(null);
    try {
      const saved = await window.electronAPI.updateSettings(settings);
      setSettings(mergeSettings(saved));
      const result = await window.electronAPI.verifySftp();
      setSftpResult(result.ok ? { ok: true, count: result.count ?? 0 } : { ok: false, error: result.error });
    } catch (e: any) {
      setSftpResult({ ok: false, error: e?.message ?? 'Connection failed' });
    } finally {
      setSftpChecking(false);
    }
  };

  const handleTestFtp = async () => {
    setFtpChecking(true);
    setFtpResult(null);
    try {
      const saved = await window.electronAPI.updateSettings(settings);
      setSettings(mergeSettings(saved));
      const result = await window.electronAPI.verifyFtp();
      setFtpResult(result.ok ? { ok: true, count: result.count ?? 0 } : { ok: false, error: result.error });
    } catch (e: any) {
      setFtpResult({ ok: false, error: e?.message ?? 'Connection failed' });
    } finally {
      setFtpChecking(false);
    }
  };

  const handleExport = async () => {
    setExportResult(null);
    const res = await window.electronAPI.exportSettings();
    if (res.ok) {
      setExportResult({ ok: true, message: `Exported to ${res.path}` });
    } else if (!res.canceled) {
      setExportResult({ ok: false, message: res.error ?? 'Export failed' });
    }
  };

  const handleImport = async () => {
    setImportResult(null);
    const res = await window.electronAPI.importSettings();
    if (res.ok) {
      setSettings(mergeSettings(res.settings));
      setHasChanges(false);
      setImportResult({ ok: true, message: 'Settings imported.' });
    } else if (!res.canceled) {
      setImportResult({ ok: false, message: res.error ?? 'Import failed' });
    }
  };

  const formatSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  };


  return (
    <div className="settings">
      <h1>Settings</h1>
      
      <div className="settings-section">
        <h2>Backup Defaults</h2>
        
        <div className="setting-item">
          <label>Default Compression Level:</label>
          <select
            value={settings.defaultCompression}
            onChange={(e) => handleChange('defaultCompression', parseInt(e.target.value))}
          >
            <option value={0}>None</option>
            <option value={1}>Fast</option>
            <option value={3}>Balanced</option>
            <option value={6}>Best</option>
            <option value={9}>Maximum</option>
          </select>
        </div>
        
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.defaultVerification}
              onChange={(e) => handleChange('defaultVerification', e.target.checked)}
            />
            Enable verification by default
          </label>
        </div>
        
        <div className="setting-item">
          <label>Default Backup Location:</label>
          <div className="path-input">
            <input
              type="text"
              value={settings.backupLocation}
              readOnly
              placeholder="Select a folder..."
            />
            <button onClick={handleSelectBackupLocation}>Browse</button>
          </div>
        </div>
      </div>
      
      <div className="settings-section">
        <h2>Logging</h2>
        
        <div className="setting-item">
          <label>Log Level:</label>
          <select
            value={settings.logLevel}
            onChange={(e) => handleChange('logLevel', e.target.value as any)}
          >
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>
      
      <div className="settings-section">
        <h2>Retention</h2>
        
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.autoCleanup}
              onChange={(e) => handleChange('autoCleanup', e.target.checked)}
            />
            Enable automatic cleanup of old backups
          </label>
        </div>
        
        {settings.autoCleanup && (
          <>
            <div className="setting-item">
              <label>Keep backups for (days):</label>
              <input
                type="number"
                value={settings.retentionDays}
                onChange={(e) => handleChange('retentionDays', parseInt(e.target.value) || 30)}
                min="1"
                max="365"
              />
            </div>
            <div className="setting-item">
              <label>Full chains to keep:</label>
              <input
                type="number"
                value={settings.keepFull}
                onChange={(e) => handleChange('keepFull', parseInt(e.target.value) || 3)}
                min="0"
                max="50"
              />
            </div>
            <div className="setting-item">
              <label>Trailing deltas per chain:</label>
              <input
                type="number"
                value={settings.keepDeltasPerFull}
                onChange={(e) => handleChange('keepDeltasPerFull', parseInt(e.target.value) || 3)}
                min="0"
                max="100"
              />
            </div>
          </>
        )}
      </div>
      
      <div className="settings-section">
        <h2>Backup Elevation</h2>
        <p className="field-hint">
          Backups need raw disk access and VSS, which require elevation. Register
          the OPBS Helper task once — backups and scheduled backups then run
          elevated without a UAC prompt.
        </p>

        <div className="setting-item">
          {helperTaskRegistered ? (
            <p className="success-message" style={{ margin: 0, padding: '8px 12px' }}>
              OPBS Helper task is registered. Backups run without UAC prompts.
            </p>
          ) : (
            <>
              <p className="field-hint" style={{ marginBottom: 8 }}>
                Not registered — every backup triggers a UAC prompt. Scheduled
                backups at 2am will fail if nobody is at the machine.
              </p>
              <button
                className="btn-primary"
                onClick={registerHelperTask}
                disabled={helperTaskLoading}
              >
                {helperTaskLoading ? 'Registering...' : 'Register Helper Task (one-time UAC)'}
              </button>
              {helperTaskError && <p className="error-message" style={{ marginTop: 8 }}>{helperTaskError}</p>}
            </>
          )}
        </div>
      </div>
      
      <div className="settings-section">
        <h2>Scheduled Verification</h2>
        <p className="field-hint">
          Verifies images on a schedule while the app is running (no elevation needed).
          For always-on headless verification or backups, register a Windows Task
          Scheduler task from the CLI instead.
        </p>

        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.scheduledVerification.enabled}
              onChange={(e) =>
                handleChange('scheduledVerification', {
                  ...settings.scheduledVerification,
                  enabled: e.target.checked
                })
              }
            />
            Enable scheduled verification
          </label>
        </div>

        {settings.scheduledVerification.enabled && (
          <>
            <div className="setting-item">
              <label>Cron expression:</label>
              <input
                type="text"
                value={settings.scheduledVerification.cronExpression}
                onChange={(e) =>
                  handleChange('scheduledVerification', {
                    ...settings.scheduledVerification,
                    cronExpression: e.target.value
                  })
                }
                placeholder="0 2 * * * (daily at 02:00)"
              />
            </div>
            <div className="setting-item">
              <label>Images to check:</label>
              <select
                value={settings.scheduledVerification.scope}
                onChange={(e) =>
                  handleChange('scheduledVerification', {
                    ...settings.scheduledVerification,
                    scope: e.target.value as 'newest' | 'all'
                  })
                }
              >
                <option value="newest">Newest image</option>
                <option value="all">All images</option>
              </select>
            </div>
            <div className="setting-item">
              <label>Backup directory:</label>
              <div className="path-input">
                <input
                  type="text"
                  value={settings.scheduledVerification.destinationPath}
                  readOnly
                  placeholder="Select a folder..."
                />
                <button onClick={handleSelectVerificationDir}>Browse</button>
              </div>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.scheduledVerification.notifyOnFailure}
                  onChange={(e) =>
                    handleChange('scheduledVerification', {
                      ...settings.scheduledVerification,
                      notifyOnFailure: e.target.checked
                    })
                  }
                />
                Notify on verification failure
              </label>
            </div>
          </>
        )}
      </div>

      <div className="settings-section">
        <h2>Scheduled Restore Drills</h2>
        <p className="field-hint">
          Periodically restores the newest unencrypted backup in a directory onto a
          scratch disk, reads it back from the disk, and validates the filesystems.
          This proves "restores work" end to end — restoring is the part you only
          find out about at the worst moment. <strong>Destructive:</strong> the
          target disk is overwritten, so dedicate a scratch disk you can afford to lose.
        </p>

        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.scheduledDrill.enabled}
              onChange={(e) =>
                handleChange('scheduledDrill', {
                  ...settings.scheduledDrill,
                  enabled: e.target.checked
                })
              }
            />
            Enable scheduled restore drills
          </label>
        </div>

        {settings.scheduledDrill.enabled && (
          <>
            <div className="setting-item">
              <label>Cron expression:</label>
              <input
                type="text"
                value={settings.scheduledDrill.cronExpression}
                onChange={(e) =>
                  handleChange('scheduledDrill', {
                    ...settings.scheduledDrill,
                    cronExpression: e.target.value
                  })
                }
                placeholder="0 3 * * 0 (weekly Sunday at 03:00)"
              />
            </div>
            <div className="setting-item">
              <label>Backup directory:</label>
              <div className="path-input">
                <input
                  type="text"
                  value={settings.scheduledDrill.destinationPath}
                  readOnly
                  placeholder="Select the folder with the image to drill..."
                />
                <button onClick={handleSelectDrillDir}>Browse</button>
              </div>
            </div>
            <div className="setting-item">
              <label>Target (scratch) disk — will be overwritten:</label>
              <select
                value={settings.scheduledDrill.targetDiskIndex}
                onChange={(e) =>
                  handleChange('scheduledDrill', {
                    ...settings.scheduledDrill,
                    targetDiskIndex: Number(e.target.value)
                  })
                }
              >
                {disks.map((disk) => (
                  <option key={disk.index} value={disk.index}>
                    Disk {disk.index} — {disk.model || 'unknown'} ({formatSize(disk.size)})
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.scheduledDrill.verifyBeforeWrite !== false}
                  onChange={(e) =>
                    handleChange('scheduledDrill', {
                      ...settings.scheduledDrill,
                      verifyBeforeWrite: e.target.checked
                    })
                  }
                />
                Verify the chain before writing
              </label>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.scheduledDrill.notifyOnFailure}
                  onChange={(e) =>
                    handleChange('scheduledDrill', {
                      ...settings.scheduledDrill,
                      notifyOnFailure: e.target.checked
                    })
                  }
                />
                Notify when a drill fails
              </label>
            </div>
          </>
        )}
      </div>

      <div className="settings-section">
        <h2>Scheduled Scrub</h2>
        <p className="field-hint">
          Self-healing against bit-rot: read back every block of every image on
          a schedule and rebuild any corrupted block from the XOR parity
          sidecar (<code>.opar</code>) written automatically after each backup.
          A block is repaired — not just reported — whenever parity exists.
        </p>

        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.scheduledScrub.enabled}
              onChange={(e) =>
                handleChange('scheduledScrub', {
                  ...settings.scheduledScrub,
                  enabled: e.target.checked
                })
              }
            />
            Enable scheduled scrub
          </label>
        </div>

        {settings.scheduledScrub.enabled && (
          <>
            <div className="setting-item">
              <label>Cron expression:</label>
              <input
                type="text"
                value={settings.scheduledScrub.cronExpression}
                onChange={(e) =>
                  handleChange('scheduledScrub', {
                    ...settings.scheduledScrub,
                    cronExpression: e.target.value
                  })
                }
                placeholder="0 4 * * 1 (weekly Monday at 04:00)"
              />
            </div>
            <div className="setting-item">
              <label>Backup directory:</label>
              <div className="path-input">
                <input
                  type="text"
                  value={settings.scheduledScrub.destinationPath}
                  readOnly
                  placeholder="Select the folder with images to scrub..."
                />
                <button onClick={handleSelectScrubDir}>Browse</button>
              </div>
            </div>
            <div className="setting-item">
              <label>Scope:</label>
              <select
                value={settings.scheduledScrub.scope}
                onChange={(e) =>
                  handleChange('scheduledScrub', {
                    ...settings.scheduledScrub,
                    scope: e.target.value as 'newest' | 'all'
                  })
                }
              >
                <option value="all">All images</option>
                <option value="newest">Newest image only</option>
              </select>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.scheduledScrub.repair}
                  onChange={(e) =>
                    handleChange('scheduledScrub', {
                      ...settings.scheduledScrub,
                      repair: e.target.checked
                    })
                  }
                />
                Repair corrupted blocks from parity when available
              </label>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.scheduledScrub.notifyOnFailure}
                  onChange={(e) =>
                    handleChange('scheduledScrub', {
                      ...settings.scheduledScrub,
                      notifyOnFailure: e.target.checked
                    })
                  }
                />
                Notify when a scrub still reports failures
              </label>
            </div>
          </>
        )}
      </div>


      <div className="settings-section">
        <h2>Cloud (S3)</h2>
        <p className="field-hint">
          Credentials for backing up to <code>s3://bucket/prefix</code> destinations.
          The destination URI in the backup wizard still determines which bucket and
          prefix are written; the profile here supplies the access keys, region and
          endpoint. Any <code>AWS_ACCESS_KEY_ID</code>/<code>AWS_SECRET_ACCESS_KEY</code>
          environment variables take precedence when set.
        </p>

        <div className="setting-item">
          <label>Region:</label>
          <input
            type="text"
            value={settings.cloud.s3.region}
            onChange={(e) => handleS3Change('region', e.target.value)}
            placeholder="us-east-1"
          />
        </div>
        <div className="setting-item">
          <label>Endpoint (optional, custom/S3-compatible):</label>
          <input
            type="text"
            value={settings.cloud.s3.endpoint}
            onChange={(e) => handleS3Change('endpoint', e.target.value)}
            placeholder="https://minio.local"
          />
        </div>
        <div className="setting-item">
          <label>Default bucket:</label>
          <input
            type="text"
            value={settings.cloud.s3.bucket}
            onChange={(e) => handleS3Change('bucket', e.target.value)}
            placeholder="my-backups"
          />
        </div>
        <div className="setting-item">
          <label>Default prefix:</label>
          <input
            type="text"
            value={settings.cloud.s3.prefix}
            onChange={(e) => handleS3Change('prefix', e.target.value)}
            placeholder="opbs/"
          />
        </div>
        <div className="setting-item">
          <label>Access Key ID:</label>
          <input
            type="password"
            value={settings.cloud.s3.accessKeyId}
            onChange={(e) => handleS3Change('accessKeyId', e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="setting-item">
          <label>Secret Access Key:</label>
          <input
            type="password"
            value={settings.cloud.s3.secretAccessKey}
            onChange={(e) => handleS3Change('secretAccessKey', e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.cloud.s3.forcePathStyle}
              onChange={(e) => handleS3Change('forcePathStyle', e.target.checked)}
            />
            Force path-style requests (MinIO and most S3-compatible endpoints)
          </label>
        </div>

        {s3Result && (
          s3Result.ok ? (
            <div className="success-message">
              <p>Connected — {s3Result.count} key(s) listed in the default location.</p>
            </div>
          ) : (
            <div className="error-message">
              <p>Connection failed: {s3Result.error}</p>
            </div>
          )
        )}

        <div className="setting-item">
          <button className="btn-secondary" onClick={() => void handleTestS3()} disabled={s3Checking}>
            {s3Checking ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h2>Cloud (SFTP)</h2>
        <p className="field-hint">
          Credentials for backing up to <code>sftp://user@host/path</code> destinations.
          The destination URI in the backup wizard still determines the host and
          folder; the profile here supplies credentials and a fallback path. Any
          <code>SFTP_USER</code>/<code>SFTP_PASSWORD</code>/<code>SFTP_PRIVATE_KEY</code>
          environment variables take precedence when set. Private key may be a PEM
          file path.
        </p>

        <div className="setting-item">
          <label>Host:</label>
          <input
            type="text"
            value={settings.cloud.sftp.host}
            onChange={(e) => handleSftpChange('host', e.target.value)}
            placeholder="backup.example.com"
          />
        </div>
        <div className="setting-item">
          <label>Port:</label>
          <input
            type="number"
            value={settings.cloud.sftp.port}
            onChange={(e) => handleSftpChange('port', parseInt(e.target.value) || 22)}
          />
        </div>
        <div className="setting-item">
          <label>Username:</label>
          <input
            type="text"
            value={settings.cloud.sftp.username}
            onChange={(e) => handleSftpChange('username', e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="setting-item">
          <label>Password:</label>
          <input
            type="password"
            value={settings.cloud.sftp.password}
            onChange={(e) => handleSftpChange('password', e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="setting-item">
          <label>Private key (PEM file path):</label>
          <input
            type="text"
            value={settings.cloud.sftp.privateKey}
            onChange={(e) => handleSftpChange('privateKey', e.target.value)}
            placeholder="C:\\keys\\backup_ed25519"
          />
        </div>
        <div className="setting-item">
          <label>Default remote path:</label>
          <input
            type="text"
            value={settings.cloud.sftp.remotePath}
            onChange={(e) => handleSftpChange('remotePath', e.target.value)}
            placeholder="opbs"
          />
        </div>

        {sftpResult && (
          sftpResult.ok ? (
            <div className="success-message">
              <p>Connected — {sftpResult.count} file(s) listed in the default location.</p>
            </div>
          ) : (
            <div className="error-message">
              <p>Connection failed: {sftpResult.error}</p>
            </div>
          )
        )}

        <div className="setting-item">
          <button className="btn-secondary" onClick={() => void handleTestSftp()} disabled={sftpChecking}>
            {sftpChecking ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h2>Cloud (FTP/FTPS)</h2>
        <p className="field-hint">
          Credentials for backing up to <code>ftp://user@host/path</code> destinations.
          The destination URI in the backup wizard still determines the host and folder;
          the profile here supplies credentials, a fallback path and the TLS mode.
          <code>FTP_USER</code>/<code>FTP_PASSWORD</code> environment variables take
          precedence when set. Plain FTP passes credentials and file names in cleartext —
          prefer <strong>Explicit TLS</strong> (<code>ftps://</code>) unless the server is
          legacy-only. Images themselves stay AES-256-GCM encrypted regardless.
        </p>

        <div className="setting-item">
          <label>Host:</label>
          <input
            type="text"
            value={settings.cloud.ftp.host}
            onChange={(e) => handleFtpChange('host', e.target.value)}
            placeholder="backup.example.com"
          />
        </div>
        <div className="setting-item">
          <label>Port:</label>
          <input
            type="number"
            value={settings.cloud.ftp.port}
            onChange={(e) => handleFtpChange('port', parseInt(e.target.value) || 21)}
          />
        </div>
        <div className="setting-item">
          <label>Username:</label>
          <input
            type="text"
            value={settings.cloud.ftp.username}
            onChange={(e) => handleFtpChange('username', e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="setting-item">
          <label>Password:</label>
          <input
            type="password"
            value={settings.cloud.ftp.password}
            onChange={(e) => handleFtpChange('password', e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="setting-item">
          <label>Default remote path:</label>
          <input
            type="text"
            value={settings.cloud.ftp.remotePath}
            onChange={(e) => handleFtpChange('remotePath', e.target.value)}
            placeholder="opbs"
          />
        </div>
        <div className="setting-item">
          <label>Connection security:</label>
          <select
            value={settings.cloud.ftp.secure}
            onChange={(e) => handleFtpChange('secure', e.target.value)}
          >
            <option value="explicit">Explicit TLS (ftps://, recommended)</option>
            <option value="implicit">Implicit TLS (port 990)</option>
            <option value="plain">Plain FTP (unencrypted)</option>
          </select>
        </div>

        {ftpResult && (
          ftpResult.ok ? (
            <div className="success-message">
              <p>Connected — {ftpResult.count} file(s) listed in the default location.</p>
            </div>
          ) : (
            <div className="error-message">
              <p>Connection failed: {ftpResult.error}</p>
            </div>
          )
        )}

        <div className="setting-item">
          <button className="btn-secondary" onClick={() => void handleTestFtp()} disabled={ftpChecking}>
            {ftpChecking ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
      </div>
      
      <div className="settings-section">
        <h2>Notifications</h2>
        
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.notifications.enabled}
              onChange={(e) =>
                handleChange('notifications', {
                  ...settings.notifications,
                  enabled: e.target.checked
                })
              }
            />
            Enable notifications
          </label>
        </div>
        
        {settings.notifications.enabled && (
          <>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.notifications.notifyOnFailure}
                  onChange={(e) =>
                    handleChange('notifications', {
                      ...settings.notifications,
                      notifyOnFailure: e.target.checked
                    })
                  }
                />
                Notify on failure
              </label>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.notifications.notifyOnSuccess}
                  onChange={(e) =>
                    handleChange('notifications', {
                      ...settings.notifications,
                      notifyOnSuccess: e.target.checked
                    })
                  }
                />
                Notify on success
              </label>
            </div>
            <div className="setting-item">
              <label>Webhook URL (optional):</label>
              <input
                type="text"
                value={settings.notifications.webhookUrl}
                onChange={(e) =>
                  handleChange('notifications', {
                    ...settings.notifications,
                    webhookUrl: e.target.value
                  })
                }
                placeholder="https://example.com/hook"
              />
            </div>
</>
      )}
      </div>
      
      <div className="settings-section">
        <h2>Error Reporting</h2>
        <p className="field-hint">
          Opt in to send anonymous crash and error reports. Stack traces are stripped of
          local file paths before anything leaves this machine.
        </p>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.errorReporting.enabled}
              onChange={(e) =>
                handleChange('errorReporting', {
                  ...settings.errorReporting,
                  enabled: e.target.checked
                })
              }
            />
            Send anonymous error reports
          </label>
        </div>
        <div className="setting-item">
          <label>Error reporting endpoint URL:</label>
          <input
            type="text"
            value={settings.errorReporting.endpoint}
            onChange={(e) =>
              handleChange('errorReporting', {
                ...settings.errorReporting,
                endpoint: e.target.value
              })
            }
            placeholder="https://your-server.example.com/report"
          />
          <p className="field-hint">
            Reports are batched and posted as JSON. Leave empty to only log errors locally.
          </p>
        </div>
      </div>

      <div className="settings-section">
        <h2>File Associations</h2>
        <p className="field-hint">
          Register OPBS as the Windows handler for .opbs backup images. This enables
          the right-click menu (browse, mount, restore, verify) plus double-click to
          open. Changes apply immediately and persist across updates.
        </p>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.fileAssociations}
              onChange={(e) => handleChange('fileAssociations', e.target.checked)}
            />
            Associate .opbs images with OPBS
          </label>
        </div>
      </div>

      <div className="settings-section">
        <h2>Settings Backup</h2>
        <p className="field-hint">
          Export your settings and scheduled backups to a JSON file, or restore
          them from a previous export.
        </p>

        {exportResult && (
          exportResult.ok
            ? (
              <div className="success-message">
                <p>{exportResult.message}</p>
              </div>
            ) : (
              <div className="error-message">
                <p>{exportResult.message}</p>
              </div>
            )
        )}
        {importResult && (
          importResult.ok
            ? (
              <div className="success-message">
                <p>{importResult.message}</p>
              </div>
            ) : (
              <div className="error-message">
                <p>{importResult.message}</p>
              </div>
            )
        )}

        <div className="setting-item">
          <button className="btn-secondary" onClick={() => void handleExport()}>
            Export settings
          </button>
          <span style={{ marginLeft: 12 }}>
            <button className="btn-secondary" onClick={() => void handleImport()}>
              Import settings
            </button>
          </span>
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="btn-primary"
          disabled={!hasChanges}
          onClick={handleSave}
        >
          Save Settings
        </button>
      </div>
    </div>
  );
}

export default Settings;
