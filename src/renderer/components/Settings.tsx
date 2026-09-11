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

interface ScheduledBackup {
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

interface ScheduleForm {
  id?: string;
  name: string;
  cronExpression: string;
  sourceDiskIndex: number;
  sourcePartitions: number[];
  destinationPath: string;
  compressionLevel: number;
  compressionType: 'deflate' | 'zstd';
  compressionThreads: number;
  verificationEnabled: boolean;
  incremental: boolean;
  passphrase: string;
  maxRetries: number;
  retryDelayMinutes: number;
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
  scheduledBackups: ScheduledBackup[];
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
  scheduledBackups: [],
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
  const [exportResult, setExportResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [importResult, setImportResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cronValid, setCronValid] = useState<boolean | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleMsg, setScheduleMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    window.electronAPI.getSettings().then((loaded) => {
      if (alive) setSettings(mergeSettings(loaded));
    });
    window.electronAPI.getDisks().then((diskList) => {
      if (alive) setDisks(diskList ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

  const mergeSettings = (loaded: any): Settings => ({
    ...DEFAULT_SETTINGS,
    ...loaded,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(loaded?.notifications || {}) },
    scheduledVerification: { ...DEFAULT_SETTINGS.scheduledVerification, ...(loaded?.scheduledVerification || {}) },
    scheduledDrill: { ...DEFAULT_SETTINGS.scheduledDrill, ...(loaded?.scheduledDrill || {}) },
    cloud: {
      s3: { ...DEFAULT_SETTINGS.cloud.s3, ...(loaded?.cloud?.s3 || {}) },
      sftp: { ...DEFAULT_SETTINGS.cloud.sftp, ...(loaded?.cloud?.sftp || {}) }
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

  const reloadSettings = async () => {
    const loaded = await window.electronAPI.getSettings();
    setSettings(mergeSettings(loaded));
  };

  const defaultScheduleForm = (): ScheduleForm => ({
    name: '',
    cronExpression: '0 2 * * *',
    sourceDiskIndex: -1,
    sourcePartitions: [],
    destinationPath: settings.backupLocation || '',
    compressionLevel: settings.defaultCompression,
    compressionType: 'zstd',
    compressionThreads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
    verificationEnabled: settings.defaultVerification,
    incremental: false,
    passphrase: '',
    maxRetries: 2,
    retryDelayMinutes: 5
  });

  const openNewSchedule = () => {
    setEditingId(null);
    setScheduleError(null);
    setCronValid(null);
    setScheduleForm(defaultScheduleForm());
  };

  const openEditSchedule = (job: ScheduledBackup) => {
    setEditingId(job.id);
    setScheduleError(null);
    setCronValid(null);
    setScheduleForm({
      id: job.id,
      name: job.name,
      cronExpression: job.cronExpression,
      sourceDiskIndex: job.sourceDiskIndex,
      sourcePartitions: job.sourcePartitions || [],
      destinationPath: job.destinationPath,
      compressionLevel: job.compressionLevel,
      compressionType: job.compressionType || 'zstd',
      compressionThreads: job.compressionThreads || defaultScheduleForm().compressionThreads,
      verificationEnabled: job.verificationEnabled,
      incremental: job.incremental,
      passphrase: job.passphrase || '',
      maxRetries: job.maxRetries ?? 2,
      retryDelayMinutes: job.retryDelayMinutes ?? 5
    });
  };

  const closeScheduleForm = () => {
    setScheduleForm(null);
    setEditingId(null);
    setScheduleError(null);
    setCronValid(null);
  };

  const selectScheduleDisk = (diskIndex: number) => {
    const disk = disks.find((d) => d.index === diskIndex);
    setScheduleForm((f) => ({
      ...(f as ScheduleForm),
      sourceDiskIndex: diskIndex,
      sourcePartitions: disk ? disk.partitions.map((p) => p.partitionIndex) : []
    }));
  };

  const toggleSchedulePartition = (partitionIndex: number) => {
    if (!scheduleForm) return;
    const has = scheduleForm.sourcePartitions.includes(partitionIndex);
    setScheduleForm({
      ...scheduleForm,
      sourcePartitions: has
        ? scheduleForm.sourcePartitions.filter((p) => p !== partitionIndex)
        : [...scheduleForm.sourcePartitions, partitionIndex]
    });
  };

  const onCronChange = (value: string) => {
    setScheduleForm((f) => ({ ...(f as ScheduleForm), cronExpression: value }));
    void window.electronAPI.validateCron(value).then((ok) => setCronValid(ok));
  };

  const handleScheduleDir = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir && scheduleForm) {
      setScheduleForm({ ...scheduleForm, destinationPath: dir });
    }
  };

  const handleScheduleSave = async () => {
    if (!scheduleForm) return;
    setScheduleError(null);
    const valid = await window.electronAPI.validateCron(scheduleForm.cronExpression);
    if (!valid) {
      setScheduleError('Invalid cron expression. Example: 0 2 * * * = every day at 02:00.');
      return;
    }
    const disk = disks.find((d) => d.index === scheduleForm.sourceDiskIndex);
    if (!disk) {
      setScheduleError('Select a source disk.');
      return;
    }
    if (!scheduleForm.destinationPath.trim()) {
      setScheduleError('Select a destination folder.');
      return;
    }
    if (scheduleForm.sourcePartitions.length === 0) {
      setScheduleError('Select at least one partition to back up.');
      return;
    }
    const payload = {
      name: scheduleForm.name.trim() || 'Scheduled backup',
      cronExpression: scheduleForm.cronExpression,
      sourceDiskIndex: disk.index,
      sourcePartitions: scheduleForm.sourcePartitions,
      destinationPath: scheduleForm.destinationPath.trim(),
      compressionLevel: scheduleForm.compressionLevel,
      compressionType: scheduleForm.compressionType,
      compressionThreads: scheduleForm.compressionThreads,
      verificationEnabled: scheduleForm.verificationEnabled,
      incremental: scheduleForm.incremental,
      maxRetries: scheduleForm.maxRetries,
      retryDelayMinutes: scheduleForm.retryDelayMinutes,
      ...(scheduleForm.passphrase.trim() ? { passphrase: scheduleForm.passphrase.trim() } : {})
    };
    try {
      if (editingId) {
        await window.electronAPI.updateScheduledBackup(editingId, payload);
        setScheduleMsg({ ok: true, text: 'Scheduled backup updated.' });
      } else {
        await window.electronAPI.addScheduledBackup(payload);
        setScheduleMsg({ ok: true, text: 'Scheduled backup added and enabled.' });
      }
      closeScheduleForm();
      await reloadSettings();
    } catch (e: any) {
      setScheduleError(e?.message ?? 'Failed to save the scheduled backup.');
    }
  };

  const handleToggleSchedule = async (job: ScheduledBackup) => {
    await window.electronAPI.updateScheduledBackup(job.id, { enabled: !job.enabled });
    await reloadSettings();
  };

  const handleDeleteSchedule = async (job: ScheduledBackup) => {
    await window.electronAPI.deleteScheduledBackup(job.id);
    if (editingId === job.id) closeScheduleForm();
    setScheduleMsg({ ok: true, text: `Scheduled backup "${job.name}" removed.` });
    await reloadSettings();
  };

  const handleRunSchedule = async (job: ScheduledBackup) => {
    const cfg: any = {
      sourceDiskIndex: job.sourceDiskIndex,
      sourcePartitions: job.sourcePartitions,
      destinationPath: job.destinationPath,
      compressionLevel: job.compressionLevel,
      compressionType: job.compressionType || 'zstd',
      compressionThreads: job.compressionThreads || 0,
      verificationEnabled: job.verificationEnabled,
      ...(job.passphrase ? { passphrase: job.passphrase } : {})
    };
    if (job.incremental) {
      try {
        const li = await window.electronAPI.listImages(job.destinationPath);
        const newest = li?.entries?.[0]?.path;
        if (newest) cfg.baseImagePath = newest;
      } catch {
        // no base image resolvable; run as a full backup
      }
    }
    try {
      await window.electronAPI.startBackup(cfg);
      setScheduleMsg({ ok: true, text: `Scheduled backup "${job.name}" finished.` });
    } catch (e: any) {
      setScheduleMsg({ ok: false, text: `"${job.name}" failed: ${e?.message ?? 'unknown error'}` });
    }
  };

  const scheduleSourceLabel = (job: ScheduledBackup): string => {
    const disk = disks.find((d) => d.index === job.sourceDiskIndex);
    const base = disk ? disk.model : `Disk ${job.sourceDiskIndex}`;
    return `${base} (${job.sourcePartitions.length} partition${job.sourcePartitions.length === 1 ? '' : 's'})`;
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
        <h2>Scheduled Backups</h2>
        <p className="field-hint">
          Runs the selected backup job on a cron schedule while the app is open
          (no elevation needed). For backups that must run even when the app is
          closed, register a Windows Task Scheduler task from the CLI:
          <code> opbs schedule install-backup &lt;name&gt; --config config.json</code>.
        </p>

        {scheduleMsg && (
          scheduleMsg.ok ? (
            <div className="success-message">
              <p>{scheduleMsg.text}</p>
            </div>
          ) : (
            <div className="error-message">
              <p>{scheduleMsg.text}</p>
            </div>
          )
        )}

        {settings.scheduledBackups.length === 0 && !scheduleForm && (
          <div className="schedule-empty">No scheduled backups yet.</div>
        )}

        {settings.scheduledBackups.length > 0 && (
          <div className="schedule-list">
            {settings.scheduledBackups.map((job) => (
              <div key={job.id} className="schedule-row">
                <div className="schedule-main">
                  <strong>{job.name}</strong>
                  <span className={`schedule-badge ${job.enabled ? 'on' : 'off'}`}>
                    {job.enabled ? 'Enabled' : 'Paused'}
                  </span>
                </div>
                <div className="schedule-meta">
                  <code>{job.cronExpression}</code>
                  <span> · {scheduleSourceLabel(job)}</span>
                  <span> · {job.incremental ? 'Incremental' : 'Full'}</span>
                  <span> · {job.destinationPath}</span>
                </div>
                {job.lastRun && (
                  <div className="schedule-meta">
                    Last run: {new Date(job.lastRun).toLocaleString()}
                  </div>
                )}
                <div className="schedule-actions">
                  <button className="btn-secondary btn-small" onClick={() => void handleToggleSchedule(job)}>
                    {job.enabled ? 'Pause' : 'Enable'}
                  </button>
                  <button className="btn-secondary btn-small" onClick={() => void handleRunSchedule(job)}>
                    Run now
                  </button>
                  <button className="btn-secondary btn-small" onClick={() => openEditSchedule(job)}>
                    Edit
                  </button>
                  <button className="btn-danger btn-small" onClick={() => void handleDeleteSchedule(job)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {scheduleForm && (
          <div className="schedule-form">
            <h3>{editingId ? 'Edit Scheduled Backup' : 'New Scheduled Backup'}</h3>

            <div className="setting-item">
              <label>Name:</label>
              <input
                type="text"
                value={scheduleForm.name}
                onChange={(e) => setScheduleForm({ ...scheduleForm, name: e.target.value })}
                placeholder="Nightly system backup"
              />
            </div>

            <div className="setting-item">
              <label>Cron expression:</label>
              <input
                type="text"
                value={scheduleForm.cronExpression}
                onChange={(e) => onCronChange(e.target.value)}
                placeholder="0 2 * * * (daily at 02:00)"
              />
              <div className="cron-presets">
                <button className="btn-secondary btn-small" onClick={() => onCronChange('0 2 * * *')}>Daily 02:00</button>
                <button className="btn-secondary btn-small" onClick={() => onCronChange('0 2 * * 0')}>Weekly Sun 02:00</button>
                <button className="btn-secondary btn-small" onClick={() => onCronChange('0 */6 * * *')}>Every 6 hours</button>
              </div>
              {scheduleForm.cronExpression.trim() === '' ? null : cronValid === true ? (
                <p className="field-hint cron-valid">Valid cron expression.</p>
              ) : cronValid === false ? (
                <p className="field-hint cron-invalid">Invalid cron expression.</p>
              ) : null}
            </div>

            <div className="setting-item">
              <label>Source disk:</label>
              <select
                value={scheduleForm.sourceDiskIndex}
                onChange={(e) => selectScheduleDisk(parseInt(e.target.value))}
              >
                <option value={-1} disabled>Select a disk…</option>
                {disks.map((disk) => (
                  <option key={disk.index} value={disk.index}>
                    {disk.model} ({formatSize(disk.size)})
                  </option>
                ))}
              </select>
            </div>

            {scheduleForm.sourceDiskIndex >= 0 && (
              <div className="setting-item">
                <label>Partitions:</label>
                <div className="partition-list">
                  {disks
                    .find((d) => d.index === scheduleForm.sourceDiskIndex)
                    ?.partitions.map((partition) => (
                      <label key={partition.partitionIndex} className="partition-item">
                        <input
                          type="checkbox"
                          checked={scheduleForm.sourcePartitions.includes(partition.partitionIndex)}
                          onChange={() => toggleSchedulePartition(partition.partitionIndex)}
                        />
                        <span className="partition-info">
                          {partition.driveLetter ? `${partition.driveLetter}:` : `Partition ${partition.partitionIndex}`}
                          {' - '}
                          {partition.label}
                          {' ('}
                          {formatSize(partition.size)}
                          {')'}
                        </span>
                      </label>
                    ))}
                </div>
              </div>
            )}

            <div className="setting-item">
              <label>Destination:</label>
              <div className="path-input">
                <input
                  type="text"
                  value={scheduleForm.destinationPath}
                  onChange={(e) => setScheduleForm({ ...scheduleForm, destinationPath: e.target.value })}
                  placeholder="Local folder, s3:// or sftp://"
                />
                <button onClick={() => void handleScheduleDir()}>Browse</button>
              </div>
            </div>

            <div className="setting-item">
              <label>Compression Level:</label>
              <select
                value={scheduleForm.compressionLevel}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, compressionLevel: parseInt(e.target.value) })
                }
              >
                <option value={0}>None</option>
                <option value={1}>Fast</option>
                <option value={3}>Balanced</option>
                <option value={6}>Best</option>
                <option value={9}>Maximum</option>
              </select>
            </div>

            <div className="setting-item">
              <label>Compression Method:</label>
              <select
                value={scheduleForm.compressionType}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, compressionType: e.target.value as 'deflate' | 'zstd' })
                }
              >
                <option value="zstd">Zstandard (zstd)</option>
                <option value="deflate">Deflate (zlib)</option>
              </select>
            </div>

            <div className="setting-item">
              <label>Compression Threads:</label>
              <input
                type="number"
                min={0}
                max={32}
                value={scheduleForm.compressionThreads}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, compressionThreads: Math.max(0, parseInt(e.target.value) || 0) })
                }
              />
              <p className="field-hint">1+ parallelizes compression across worker threads (0 disables).</p>
            </div>

            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={scheduleForm.incremental}
                  onChange={(e) => setScheduleForm({ ...scheduleForm, incremental: e.target.checked })}
                />
                Incremental backup (only changed blocks; falls back to full if no image exists)
              </label>
            </div>

            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={scheduleForm.verificationEnabled}
                  onChange={(e) => setScheduleForm({ ...scheduleForm, verificationEnabled: e.target.checked })}
                />
                Verify backup after completion
              </label>
            </div>

            <div className="setting-item">
              <label>Automatic retries on failure:</label>
              <input
                type="number"
                min={0}
                max={10}
                value={scheduleForm.maxRetries}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, maxRetries: Math.max(0, parseInt(e.target.value) || 0) })
                }
              />
              <p className="field-hint">Number of retries with backoff (0 = fail immediately, alert once).</p>
            </div>

            <div className="setting-item">
              <label>Retry delay (minutes):</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={scheduleForm.retryDelayMinutes}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, retryDelayMinutes: Math.max(1, parseInt(e.target.value) || 1) })
                }
              />
              <p className="field-hint">Base delay between attempts; doubles on each retry.</p>
            </div>

            <div className="setting-item">
              <label>Encryption Passphrase:</label>
              <input
                type="password"
                value={scheduleForm.passphrase}
                onChange={(e) => setScheduleForm({ ...scheduleForm, passphrase: e.target.value })}
                placeholder="Leave empty for no encryption"
              />
              <p className="field-hint">
                AES-256-GCM per-block. Required to verify or restore this backup. Stored in your settings file.
              </p>
            </div>

            {scheduleError && (
              <div className="error-message">
                <p>{scheduleError}</p>
              </div>
            )}

            <div className="wizard-actions">
              <button className="btn-secondary" onClick={closeScheduleForm}>Cancel</button>
              <button className="btn-primary" onClick={() => void handleScheduleSave()}>
                {editingId ? 'Save Changes' : 'Add Scheduled Backup'}
              </button>
            </div>
          </div>
        )}

        {!scheduleForm && (
          <div className="schedule-add">
            <button className="btn-secondary" onClick={openNewSchedule}>
              Add Scheduled Backup
            </button>
          </div>
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
