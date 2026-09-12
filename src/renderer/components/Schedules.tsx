import { useState, useEffect } from 'react';

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

interface ScheduleDefaults {
  backupLocation: string;
  defaultCompression: number;
  defaultVerification: boolean;
}

function mergeDefaults(loaded: any): ScheduleDefaults {
  return {
    backupLocation: loaded?.backupLocation ?? '',
    defaultCompression: loaded?.defaultCompression ?? 3,
    defaultVerification: loaded?.defaultVerification ?? true
  };
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function Schedules() {
  const [defaults, setDefaults] = useState<ScheduleDefaults>(mergeDefaults(null));
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cronValid, setCronValid] = useState<boolean | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleMsg, setScheduleMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [jobs, setJobs] = useState<ScheduledBackup[]>([]);

  useEffect(() => {
    let alive = true;
    window.electronAPI.getSettings().then((loaded) => {
      if (alive) setDefaults(mergeDefaults(loaded));
    });
    window.electronAPI.getDisks().then((diskList) => {
      if (alive) setDisks(diskList ?? []);
    });
    window.electronAPI.getSettings().then((loaded) => {
      if (alive) setJobs(loaded?.scheduledBackups ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

  const reloadJobs = async () => {
    const loaded = await window.electronAPI.getSettings();
    setJobs(loaded?.scheduledBackups ?? []);
  };

  const defaultScheduleForm = (): ScheduleForm => ({
    name: '',
    cronExpression: '0 2 * * *',
    sourceDiskIndex: -1,
    sourcePartitions: [],
    destinationPath: defaults.backupLocation || '',
    compressionLevel: defaults.defaultCompression,
    compressionType: 'zstd',
    compressionThreads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
    verificationEnabled: defaults.defaultVerification,
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
      await reloadJobs();
    } catch (e: any) {
      setScheduleError(e?.message ?? 'Failed to save the scheduled backup.');
    }
  };

  const handleToggleSchedule = async (job: ScheduledBackup) => {
    await window.electronAPI.updateScheduledBackup(job.id, { enabled: !job.enabled });
    await reloadJobs();
  };

  const handleDeleteSchedule = async (job: ScheduledBackup) => {
    await window.electronAPI.deleteScheduledBackup(job.id);
    if (editingId === job.id) closeScheduleForm();
    setScheduleMsg({ ok: true, text: `Scheduled backup "${job.name}" removed.` });
    await reloadJobs();
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
      <h1>Scheduled Backups</h1>
      <p className="field-hint">
        Runs the selected backup job on a cron schedule while the app is open
        (no elevation needed). For backups that must run even when the app is
        closed, register a Windows Task Scheduler task from the CLI:
        <code> opbs schedule install-backup &lt;name&gt; --config config.json</code>.
        Verification, restore-drill and scrub schedules are managed in Settings.
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

      {jobs.length === 0 && !scheduleForm && (
        <div className="schedule-empty">No scheduled backups yet.</div>
      )}

      {jobs.length > 0 && (
        <div className="schedule-list">
          {jobs.map((job) => (
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
  );
}

export default Schedules;