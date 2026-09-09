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

interface CloudSettings {
  s3: S3Profile;
  sftp: SftpProfile;
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
  cloud: CloudSettings;
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

function Settings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);
  const [s3Checking, setS3Checking] = useState(false);
  const [s3Result, setS3Result] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);
  const [sftpChecking, setSftpChecking] = useState(false);
  const [sftpResult, setSftpResult] = useState<{ ok: boolean; count?: number; error?: string } | null>(null);

  useEffect(() => {
    window.electronAPI.getSettings().then((loaded) => {
      setSettings(mergeSettings(loaded));
    });
  }, []);

  const mergeSettings = (loaded: any): Settings => ({
    ...DEFAULT_SETTINGS,
    ...loaded,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(loaded?.notifications || {}) },
    scheduledVerification: { ...DEFAULT_SETTINGS.scheduledVerification, ...(loaded?.scheduledVerification || {}) },
    cloud: {
      s3: { ...DEFAULT_SETTINGS.cloud.s3, ...(loaded?.cloud?.s3 || {}) },
      sftp: { ...DEFAULT_SETTINGS.cloud.sftp, ...(loaded?.cloud?.sftp || {}) }
    }
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
