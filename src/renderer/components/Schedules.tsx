import { useState, useEffect } from 'react';
import {
  buildCronFromFriendly,
  parseCronToFriendly,
  describeCron,
  WEEKDAY_ABBREVS
} from '../lib/schedule-helpers';

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
  maxRetries?: number;
  retryDelayMinutes?: number;
  retentionApplied?: boolean;
  retentionKeepFull?: number;
  retentionKeepDeltasPerFull?: number;
  retentionDays?: number;
  unattended?: boolean;
}

interface ScheduleForm {
  id?: string;
  name: string;
  cronExpression: string;
  scheduleType: 'daily' | 'weekly' | 'monthly';
  scheduleTime: string;
  scheduleWeekDays: number[];
  scheduleMonthDay: number;
  advancedCron: boolean;
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
  retentionApplied: boolean;
  retentionKeepFull: number;
  retentionKeepDeltasPerFull: number;
  retentionDays: number;
  unattended: boolean;
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
  keepFull: number;
  keepDeltasPerFull: number;
  retentionDays: number;
  autoCleanup: boolean;
}

function mergeDefaults(loaded: any): ScheduleDefaults {
  return {
    backupLocation: loaded?.backupLocation ?? '',
    defaultCompression: loaded?.defaultCompression ?? 3,
    defaultVerification: loaded?.defaultVerification ?? true,
    keepFull: loaded?.keepFull ?? 3,
    keepDeltasPerFull: loaded?.keepDeltasPerFull ?? 3,
    retentionDays: loaded?.retentionDays ?? 30,
    autoCleanup: loaded?.autoCleanup ?? false
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
  const [taskStatuses, setTaskStatuses] = useState<Record<string, { lastRun: string; lastResult: string; nextRun: string; status: string }>>({});

  const fetchTaskStatuses = async (scheduleList: ScheduledBackup[]) => {
    const unattended = scheduleList.filter((j) => j.unattended);
    if (unattended.length === 0) { setTaskStatuses({}); return; }
    const statuses: Record<string, { lastRun: string; lastResult: string; nextRun: string; status: string }> = {};
    for (const job of unattended) {
      const taskName = `OPBS Backup ${job.id}`;
      const status = await window.electronAPI.getTaskStatus(taskName);
      if (status) {
        statuses[job.id] = { lastRun: status.lastRun, lastResult: status.lastResult, nextRun: status.nextRun, status: status.status };
      }
    }
    setTaskStatuses(statuses);
  };

  useEffect(() => {
    let alive = true;
    window.electronAPI.getSettings().then((loaded) => {
      if (alive) setDefaults(mergeDefaults(loaded));
    });
    window.electronAPI.getDisks().then((diskList) => {
      if (alive) setDisks(diskList ?? []);
    });
    window.electronAPI.getSettings().then((loaded) => {
      const loadedJobs = loaded?.scheduledBackups ?? [];
      if (alive) {
        setJobs(loadedJobs);
        void fetchTaskStatuses(loadedJobs);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const reloadJobs = async () => {
    const loaded = await window.electronAPI.getSettings();
    const loadedJobs = loaded?.scheduledBackups ?? [];
    setJobs(loadedJobs);
    void fetchTaskStatuses(loadedJobs);
  };

  const defaultScheduleForm = (): ScheduleForm => ({
    name: '',
    cronExpression: '0 2 * * *',
    scheduleType: 'daily',
    scheduleTime: '02:00',
    scheduleWeekDays: [],
    scheduleMonthDay: 1,
    advancedCron: false,
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
    retryDelayMinutes: 5,
    retentionApplied: false,
    retentionKeepFull: defaults.keepFull,
    retentionKeepDeltasPerFull: defaults.keepDeltasPerFull,
    retentionDays: defaults.retentionDays,
    unattended: false
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
    const parsed = parseCronToFriendly(job.cronExpression);
    const base = defaultScheduleForm();
    setScheduleForm({
      id: job.id,
      name: job.name,
      cronExpression: job.cronExpression,
      scheduleType: parsed?.type ?? 'daily',
      scheduleTime: parsed?.time ?? '02:00',
      scheduleWeekDays: parsed?.weekDays ?? [],
      scheduleMonthDay: parsed?.monthDay ?? 1,
      advancedCron: !parsed,
      sourceDiskIndex: job.sourceDiskIndex,
      sourcePartitions: job.sourcePartitions || [],
      destinationPath: job.destinationPath,
      compressionLevel: job.compressionLevel,
      compressionType: job.compressionType || 'zstd',
      compressionThreads: job.compressionThreads || base.compressionThreads,
      verificationEnabled: job.verificationEnabled,
      incremental: job.incremental,
      passphrase: job.passphrase || '',
      maxRetries: job.maxRetries ?? 2,
      retryDelayMinutes: job.retryDelayMinutes ?? 5,
      retentionApplied: job.retentionApplied ?? false,
      retentionKeepFull: job.retentionKeepFull ?? base.retentionKeepFull,
      retentionKeepDeltasPerFull: job.retentionKeepDeltasPerFull ?? base.retentionKeepDeltasPerFull,
      retentionDays: job.retentionDays ?? base.retentionDays,
      unattended: job.unattended ?? false
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

  const applyFriendlySchedule = (form: ScheduleForm): ScheduleForm => {
    const cron = buildCronFromFriendly({
      type: form.scheduleType,
      time: form.scheduleTime,
      weekDays: form.scheduleWeekDays,
      monthDay: form.scheduleMonthDay
    });
    return cron === null ? form : { ...form, cronExpression: cron };
  };

  const onScheduleTypeChange = (type: ScheduleForm['scheduleType']) => {
    setScheduleForm((f) => applyFriendlySchedule({ ...(f as ScheduleForm), scheduleType: type }));
  };

  const onScheduleTimeChange = (time: string) => {
    setScheduleForm((f) => applyFriendlySchedule({ ...(f as ScheduleForm), scheduleTime: time }));
  };

  const toggleScheduleWeekDay = (dayIndex: number) => {
    setScheduleForm((f) => {
      const form = f as ScheduleForm;
      const has = form.scheduleWeekDays.includes(dayIndex);
      return applyFriendlySchedule({
        ...form,
        scheduleWeekDays: has
          ? form.scheduleWeekDays.filter((d) => d !== dayIndex)
          : [...form.scheduleWeekDays, dayIndex]
      });
    });
  };

  const onScheduleMonthDayChange = (day: number) => {
    setScheduleForm((f) => applyFriendlySchedule({ ...(f as ScheduleForm), scheduleMonthDay: day }));
  };

  const toggleAdvancedCron = () => {
    setScheduleForm((f) => {
      const form = f as ScheduleForm;
      if (!form.advancedCron) {
        return { ...form, advancedCron: true };
      }
      const parsed = parseCronToFriendly(form.cronExpression);
      if (!parsed) {
        setScheduleError("This cron expression can't be shown in the simple schedule picker.");
        return form;
      }
      setScheduleError(null);
      return {
        ...form,
        scheduleType: parsed.type,
        scheduleTime: parsed.time,
        scheduleWeekDays: parsed.weekDays,
        scheduleMonthDay: parsed.monthDay,
        advancedCron: false
      };
    });
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

    let cronExpression = scheduleForm.cronExpression;
    if (!scheduleForm.advancedCron) {
      const rebuilt = buildCronFromFriendly({
        type: scheduleForm.scheduleType,
        time: scheduleForm.scheduleTime,
        weekDays: scheduleForm.scheduleWeekDays,
        monthDay: scheduleForm.scheduleMonthDay
      });
      if (!rebuilt) {
        setScheduleError('Select at least one day of the week.');
        return;
      }
      cronExpression = rebuilt;
    }

    const valid = await window.electronAPI.validateCron(cronExpression);
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
      cronExpression,
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
      ...(scheduleForm.passphrase.trim() ? { passphrase: scheduleForm.passphrase.trim() } : {}),
      retentionApplied: scheduleForm.retentionApplied,
      ...(scheduleForm.retentionApplied
        ? {
            retentionKeepFull: scheduleForm.retentionKeepFull,
            retentionKeepDeltasPerFull: scheduleForm.retentionKeepDeltasPerFull,
            retentionDays: scheduleForm.retentionDays
          }
        : {})
    };
    try {
      let savedId = editingId;
      if (editingId) {
        await window.electronAPI.updateScheduledBackup(editingId, payload);
        setScheduleMsg({ ok: true, text: 'Scheduled backup updated.' });
      } else {
        const result = await window.electronAPI.addScheduledBackup(payload);
        savedId = result?.id;
        setScheduleMsg({ ok: true, text: 'Scheduled backup added and enabled.' });
      }

      // Register or unregister the Windows Task Scheduler entry.
      if (scheduleForm.unattended && savedId) {
        try {
          await window.electronAPI.registerUnattendedBackupTask(savedId, payload);
          setScheduleMsg({ ok: true, text: 'Scheduled backup updated. Unattended task registered — runs without UAC.' });
        } catch (taskErr: any) {
          setScheduleMsg({ ok: false, text: `Schedule saved, but task registration failed: ${taskErr?.message ?? taskErr}. The schedule will still run with UAC when the app is open.` });
        }
      } else if (!scheduleForm.unattended && savedId) {
        await window.electronAPI.unregisterUnattendedBackupTask(savedId).catch(() => {});
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
    if (job.unattended) {
      await window.electronAPI.unregisterUnattendedBackupTask(job.id).catch(() => {});
    }
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
        Runs the selected backup job on a cron schedule while the app is open.
        A UAC prompt appears each time the backup triggers (same as a manual
        backup). For unattended backups that run without a UAC prompt, register
        a Windows Task Scheduler task from the CLI:
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
                {job.unattended && (
                  <span className="schedule-badge on" title="Registered as a Windows Task — runs without UAC, even when the app is closed">
                    Unattended
                  </span>
                )}
              </div>
              <div className="schedule-meta">
                <span>{describeCron(job.cronExpression)}</span>
                <span> · <code>{job.cronExpression}</code></span>
                <span> · {scheduleSourceLabel(job)}</span>
                <span> · {job.incremental ? 'Incremental' : 'Full'}</span>
                <span> · {job.destinationPath}</span>
              </div>
              {job.lastRun && (
                <div className="schedule-meta">
                  Last run: {new Date(job.lastRun).toLocaleString()}
                </div>
              )}
              {job.unattended && taskStatuses[job.id] && (
                <div className="schedule-meta">
                  <span>Task status: {taskStatuses[job.id].status}</span>
                  {taskStatuses[job.id].lastRun !== 'N/A' && (
                    <span> · Last task run: {taskStatuses[job.id].lastRun}</span>
                  )}
                  {taskStatuses[job.id].lastResult !== 'N/A' && taskStatuses[job.id].lastResult !== '0' && (
                    <span> · Last result: {taskStatuses[job.id].lastResult}</span>
                  )}
                  {taskStatuses[job.id].nextRun !== 'N/A' && (
                    <span> · Next run: {taskStatuses[job.id].nextRun}</span>
                  )}
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
            <label>When to run:</label>
            {!scheduleForm.advancedCron ? (
              <div className="schedule-builder">
                <div className="schedule-builder-row">
                  <select
                    value={scheduleForm.scheduleType}
                    onChange={(e) => onScheduleTypeChange(e.target.value as ScheduleForm['scheduleType'])}
                  >
                    <option value="daily">Every day</option>
                    <option value="weekly">On chosen weekdays</option>
                    <option value="monthly">Once a month</option>
                  </select>
                  <input
                    type="time"
                    value={scheduleForm.scheduleTime}
                    onChange={(e) => onScheduleTimeChange(e.target.value)}
                  />
                </div>

                {scheduleForm.scheduleType === 'weekly' && (
                  <div className="weekday-picker">
                    {WEEKDAY_ABBREVS.map((abbr, index) => {
                      const checked = scheduleForm.scheduleWeekDays.includes(index);
                      return (
                        <label key={abbr} className={`weekday-chip${checked ? ' on' : ''}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleScheduleWeekDay(index)}
                          />
                          {abbr}
                        </label>
                      );
                    })}
                  </div>
                )}

                {scheduleForm.scheduleType === 'monthly' && (
                  <div className="schedule-month-day">
                    <label>
                      Day of month:
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={scheduleForm.scheduleMonthDay}
                        onChange={(e) => onScheduleMonthDayChange(parseInt(e.target.value, 10) || 1)}
                      />
                    </label>
                  </div>
                )}

                <div className="schedule-builder-row">
                  <button type="button" className="btn-secondary btn-small" onClick={toggleAdvancedCron}>
                    Edit raw cron expression
                  </button>
                </div>
                <p className="field-hint">
                  Runs while the app is open. Current schedule:{' '}
                  <strong>{describeCron(scheduleForm.cronExpression)}</strong> (<code>{scheduleForm.cronExpression}</code>).
                </p>
              </div>
            ) : (
              <div className="cron-editor">
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
                <div className="schedule-builder-row">
                  <button type="button" className="btn-secondary btn-small" onClick={toggleAdvancedCron}>
                    Use simple schedule picker
                  </button>
                </div>
              </div>
            )}
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
                placeholder='Local folder, network share (\\\\server\\share or smb://), s3:// or sftp://'
              />
              <button onClick={() => void handleScheduleDir()}>Browse</button>
            </div>
            <p className="field-hint">
              Network shares (UNC <code>\\server\share</code> or <code>smb://server/share</code>) work as destinations
              for scheduled backups. Cloud locations (<code>s3://</code>, <code>sftp://</code>) are supported too.
            </p>
          </div>

          <div className="setting-item">
            <label>Compression Level:</label>
            <select
              value={scheduleForm.compressionLevel}
              onChange={(e) =>
                setScheduleForm({ ...scheduleForm, compressionLevel: parseInt(e.target.value) })
              }
            >
              <option value={0}>None — fastest, no compression</option>
              <option value={1}>Fast — ~200 MB/s, light compression</option>
              <option value={3}>Balanced — ~100 MB/s, good ratio (default)</option>
              <option value={6}>Best — ~40 MB/s, high compression</option>
              <option value={9}>Maximum — ~15 MB/s, smallest size</option>
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
                checked={scheduleForm.unattended}
                onChange={(e) => setScheduleForm({ ...scheduleForm, unattended: e.target.checked })}
              />
              Run unattended (registers a Windows Task — no UAC prompt, runs even when the app is closed)
            </label>
            {scheduleForm.unattended && (
              <p className="field-hint" style={{ marginTop: 4 }}>
                Registers a Windows Task Scheduler entry for this schedule. The task
                runs as the current user with highest privileges. For incremental
                backups, the newest image in the destination is resolved automatically
                at each run.
              </p>
            )}
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
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={scheduleForm.retentionApplied}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, retentionApplied: e.target.checked })
                }
              />
              Apply a retention policy after each run
            </label>
            <p className="field-hint">
              Enable per-schedule pruning. When off, only the global Settings → auto-cleanup
              applies (currently {defaults.autoCleanup ? 'enabled' : 'disabled'}).
            </p>
            {scheduleForm.retentionApplied && (
              <div className="retention-fields">
                <label>
                  Keep full chains:
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={scheduleForm.retentionKeepFull}
                    onChange={(e) =>
                      setScheduleForm({
                        ...scheduleForm,
                        retentionKeepFull: Math.max(1, parseInt(e.target.value) || 1)
                      })
                    }
                  />
                </label>
                <label>
                  Deltas per full chain:
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={scheduleForm.retentionKeepDeltasPerFull}
                    onChange={(e) =>
                      setScheduleForm({
                        ...scheduleForm,
                        retentionKeepDeltasPerFull: Math.max(0, parseInt(e.target.value) || 0)
                      })
                    }
                  />
                </label>
                <label>
                  Always keep newest (days):
                  <input
                    type="number"
                    min={0}
                    max={3650}
                    value={scheduleForm.retentionDays}
                    onChange={(e) =>
                      setScheduleForm({
                        ...scheduleForm,
                        retentionDays: Math.max(0, parseInt(e.target.value) || 0)
                      })
                    }
                  />
                </label>
              </div>
            )}
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