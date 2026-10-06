import { useEffect, useState } from 'react';

type Tab = 'backup' | 'restore' | 'clone' | 'drill' | 'schedule';
type ScheduleMode = 'backup' | 'verify' | 'drill';

interface PartitionInfo {
  partitionIndex: number;
  size: number;
  usedSpace?: number;
  driveLetter?: string | null;
  label?: string;
  fsType?: string;
  isSystem?: boolean;
  isBoot?: boolean;
}

interface DiskInfo {
  index: number;
  model: string;
  size: number;
  partitions: PartitionInfo[];
}

interface BackupForm {
  sourceDiskIndex: number | null;
  sourcePartitions: number[];
  destinationPath: string;
  imageName: string;
  compressionType: 'zstd' | 'deflate';
  compressionLevel: number;
  compressionThreads: number;
  verificationEnabled: boolean;
  usedBlocksOnly: boolean;
  useUsnJournal: boolean;
  usnThresholdPct: string;
  resume: boolean;
  baseImagePath: string;
  passphrase: string;
}

interface RestoreForm {
  imagePath: string;
  targetKind: 'disk' | 'vhd';
  targetDiskIndex: number | null;
  vhdPath: string;
  vhdSizeGb: number;
  vhdType: 'dynamic' | 'fixed';
  targetPartitions: number[];
  verifyBeforeWrite: boolean;
  applyDeltas: boolean;
  writePartitionTable: boolean;
  tableScheme: string;
  verifyAfterRestore: boolean;
  acknowledgeSameDisk: boolean;
  passphrase: string;
  compressionThreads: number;
}

interface CloneForm {
  sourceDiskIndex: number | null;
  sourcePartitions: number[];
  targetDiskIndex: number | null;
  usedBlocksOnly: boolean;
  writePartitionTable: boolean;
  tableScheme: string;
  acknowledgeSameDisk: boolean;
}

interface DrillForm {
  imagePath: string;
  targetDiskIndex: number | null;
  targetPartitions: number[];
  verifyBeforeWrite: boolean;
  applyDeltas: boolean;
}

interface ScheduleForm {
  mode: ScheduleMode;
  taskName: string;
  configPath: string;
  dirPath: string;
  scope: 'newest' | 'all';
  drillDiskIndex: number | null;
  drillVerify: boolean;
  timeMode: 'time' | 'login';
  time: string;
  runAs: 'default' | 'system' | 'user';
}

const JSON_FILTERS = [{ name: 'JSON files', extensions: ['json'] }];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const compact = (obj: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));

const asNum = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const asStr = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const asIndex = (v: unknown, fallback: number | null): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
const asList = (v: unknown, fallback: number[]): number[] =>
  Array.isArray(v)
    ? v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    : fallback;
const asScheme = (v: unknown, fallback: string): string =>
  v === 'gpt' || v === 'mbr' || v === 'auto' ? v : fallback;

/** Parse a 0-100% USN threshold field into the 0..1 fraction (undefined = invalid/blank). */
const parseUsnPctInput = (raw: string): number | undefined => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : undefined;
};

const DEFAULT_BACKUP: BackupForm = {
  sourceDiskIndex: null,
  sourcePartitions: [],
  destinationPath: '',
  imageName: '',
  compressionType: 'zstd',
  compressionLevel: 3,
  compressionThreads: 0,
  verificationEnabled: true,
  usedBlocksOnly: true,
  useUsnJournal: true,
  usnThresholdPct: '',
  resume: false,
  baseImagePath: '',
  passphrase: ''
};

const DEFAULT_RESTORE: RestoreForm = {
  imagePath: '',
  targetKind: 'disk',
  targetDiskIndex: null,
  vhdPath: '',
  vhdSizeGb: 64,
  vhdType: 'dynamic',
  targetPartitions: [],
  verifyBeforeWrite: true,
  applyDeltas: true,
  writePartitionTable: true,
  tableScheme: '',
  verifyAfterRestore: false,
  acknowledgeSameDisk: false,
  passphrase: '',
  compressionThreads: 0
};

const DEFAULT_CLONE: CloneForm = {
  sourceDiskIndex: null,
  sourcePartitions: [],
  targetDiskIndex: null,
  usedBlocksOnly: true,
  writePartitionTable: true,
  tableScheme: '',
  acknowledgeSameDisk: false
};

const DEFAULT_DRILL: DrillForm = {
  imagePath: '',
  targetDiskIndex: null,
  targetPartitions: [],
  verifyBeforeWrite: true,
  applyDeltas: true
};

const DEFAULT_SCHEDULE: ScheduleForm = {
  mode: 'backup',
  taskName: '',
  configPath: '',
  dirPath: '',
  scope: 'newest',
  drillDiskIndex: null,
  drillVerify: false,
  timeMode: 'time',
  time: '02:00',
  runAs: 'default'
};

const TABS: { key: Tab; label: string }[] = [
  { key: 'backup', label: 'Backup' },
  { key: 'restore', label: 'Restore' },
  { key: 'clone', label: 'Clone' },
  { key: 'drill', label: 'Drill' },
  { key: 'schedule', label: 'Schedule' }
];

function ConfigBuilder() {
  const [tab, setTab] = useState<Tab>('backup');
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [disksLoading, setDisksLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [extras, setExtras] = useState<Partial<Record<Tab, Record<string, unknown>>>>({});
  const [imageInfo, setImageInfo] = useState<{
    partitions?: Array<{ index: number; size: number; fsType?: string }>;
  } | null>(null);

  const [backup, setBackup] = useState<BackupForm>(DEFAULT_BACKUP);
  const [restore, setRestore] = useState<RestoreForm>(DEFAULT_RESTORE);
  const [clone, setClone] = useState<CloneForm>(DEFAULT_CLONE);
  const [drill, setDrill] = useState<DrillForm>(DEFAULT_DRILL);
  const [sched, setSched] = useState<ScheduleForm>(DEFAULT_SCHEDULE);

  useEffect(() => {
    let alive = true;
    window.electronAPI
      .getDisks()
      .then((list) => {
        if (alive) setDisks((list ?? []) as DiskInfo[]);
      })
      .catch(() => {
        if (alive) setDisks([]);
      })
      .finally(() => {
        if (alive) setDisksLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Read the image's partition list for the restore tab — a VHD target has no
  // disk to read partitions from, so the image is the only source.
  useEffect(() => {
    let alive = true;
    const p = restore.imagePath.trim();
    Promise.resolve().then(() => {
      if (!alive) return;
      if (!p) {
        setImageInfo(null);
        return;
      }
      window.electronAPI
        .getImageInfo(p)
        .then((info) => {
          if (alive) setImageInfo(info);
        })
        .catch(() => {
          if (alive) setImageInfo(null);
        });
    });
    return () => {
      alive = false;
    };
  }, [restore.imagePath]);

  const formatSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const partLabel = (p: PartitionInfo): string => {
    const bits = [`Partition ${p.partitionIndex}`];
    if (p.driveLetter) bits.push(p.driveLetter);
    if (p.label) bits.push(`"${p.label}"`);
    bits.push(formatSize(p.size));
    if (p.fsType) bits.push(p.fsType);
    if (p.isSystem) bits.push('system');
    if (p.isBoot) bits.push('boot');
    return bits.join(' · ');
  };

  const toggle = (arr: number[], i: number): number[] =>
    arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i];

  const pickDirectory = async (setPath: (p: string) => void, title: string): Promise<void> => {
    const p = await window.electronAPI.selectDirectory({ title });
    if (p) setPath(p);
  };

  const pickFile = async (
    setPath: (p: string) => void,
    filters: Array<{ name: string; extensions: string[] }>
  ): Promise<void> => {
    const p = await window.electronAPI.selectFile({ filters });
    if (p) setPath(p);
  };

  const IMAGE_FILTERS = [
    { name: 'OPBS images', extensions: ['opbs'] },
    { name: 'All files', extensions: ['*'] }
  ];
  // Restore/drill sources also accept Macrium containers; the incremental
  // base image above must stay an .opbs chain member.
  const RESTORE_IMAGE_FILTERS = [
    { name: 'Backup images', extensions: ['opbs'] },
    { name: 'Macrium Reflect images', extensions: ['mrimgx', 'mrimg'] },
    { name: 'All files', extensions: ['*'] }
  ];
  const VHD_FILTERS = [{ name: 'Virtual disks', extensions: ['vhdx', 'vhd'] }];

  const pickSaveFile = async (
    setPath: (p: string) => void,
    name: string,
    filters: Array<{ name: string; extensions: string[] }>
  ): Promise<void> => {
    const p = await window.electronAPI.selectSaveFile({ name, filters });
    if (p) setPath(p);
  };

  const diskSelect = (label: string, value: number | null, onChange: (i: number | null) => void) => (
    <div className="builder-row">
      <label>{label}</label>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">{disksLoading ? 'Loading disks…' : 'Select a disk…'}</option>
        {disks.map((d) => (
          <option key={d.index} value={d.index}>
            Disk {d.index} — {d.model} ({formatSize(d.size)})
          </option>
        ))}
      </select>
    </div>
  );

  const partitionList = (diskIndex: number | null, selected: number[], onToggle: (i: number) => void) => {
    const disk = disks.find((d) => d.index === diskIndex);
    if (!disk) return null;
    if (disk.partitions.length === 0) {
      return <p className="field-hint">No partitions found on Disk {disk.index}.</p>;
    }
    return (
      <div className="partition-list builder-partitions">
        {disk.partitions.map((p) => (
          <label key={p.partitionIndex} className="partition-item">
            <input
              type="checkbox"
              checked={selected.includes(p.partitionIndex)}
              onChange={() => onToggle(p.partitionIndex)}
            />
            <span className="partition-info">{partLabel(p)}</span>
          </label>
        ))}
      </div>
    );
  };

  const buildObject = (): Record<string, unknown> => {
    const ex = extras[tab] ?? {};
    switch (tab) {
      case 'backup':
        return {
          ...ex,
          ...compact({
            kind: 'backup',
            sourceDiskIndex: backup.sourceDiskIndex ?? undefined,
            sourcePartitions: backup.sourcePartitions,
            destinationPath: backup.destinationPath.trim(),
            compressionLevel: backup.compressionLevel,
            compressionType: backup.compressionType,
            compressionThreads: backup.compressionThreads > 0 ? backup.compressionThreads : undefined,
            verificationEnabled: backup.verificationEnabled,
            usedBlocksOnly: backup.usedBlocksOnly,
            useUsnJournal: backup.useUsnJournal ? true : undefined,
            usnFullScanThreshold: parseUsnPctInput(backup.usnThresholdPct),
            resume: backup.resume ? true : undefined,
            imageName: backup.imageName.trim(),
            baseImagePath: backup.baseImagePath.trim(),
            passphrase: backup.passphrase
          })
        };
      case 'restore':
        return {
          ...ex,
          ...compact({
            kind: 'restore',
            imagePath: restore.imagePath.trim(),
            targetDiskIndex: restore.targetKind === 'disk' ? restore.targetDiskIndex ?? undefined : undefined,
            targetVirtualDisk:
              restore.targetKind === 'vhd' && restore.vhdPath.trim()
                ? {
                    path: restore.vhdPath.trim(),
                    virtualSize: Math.round(restore.vhdSizeGb * 1024 ** 3),
                    type: restore.vhdType
                  }
                : undefined,
            targetPartitions: restore.targetPartitions,
            verifyBeforeWrite: restore.verifyBeforeWrite,
            applyDeltas: restore.applyDeltas,
            writePartitionTable: restore.writePartitionTable,
            tableScheme: restore.tableScheme,
            compressionThreads: restore.compressionThreads > 0 ? restore.compressionThreads : undefined,
            verifyAfterRestore: restore.verifyAfterRestore ? true : undefined,
            acknowledgeSameDisk: restore.acknowledgeSameDisk ? true : undefined,
            passphrase: restore.passphrase
          })
        };
      case 'clone':
        return {
          ...ex,
          ...compact({
            kind: 'clone',
            sourceDiskIndex: clone.sourceDiskIndex ?? undefined,
            sourcePartitions: clone.sourcePartitions,
            targetDiskIndex: clone.targetDiskIndex ?? undefined,
            usedBlocksOnly: clone.usedBlocksOnly,
            writePartitionTable: clone.writePartitionTable,
            tableScheme: clone.tableScheme,
            acknowledgeSameDisk: clone.acknowledgeSameDisk ? true : undefined
          })
        };
      case 'drill':
        return {
          ...ex,
          ...compact({
            kind: 'restore-drill',
            imagePath: drill.imagePath.trim(),
            targetDiskIndex: drill.targetDiskIndex ?? undefined,
            targetPartitions: drill.targetPartitions,
            verifyBeforeWrite: drill.verifyBeforeWrite,
            applyDeltas: drill.applyDeltas,
            validateAfterWrite: true
          })
        };
      case 'schedule':
        return ex;
    }
  };

  const buildCommand = (): string => {
    const parts = ['OPBS.exe', '--cli', 'schedule'];
    const name = `"${sched.taskName.trim()}"`;
    if (sched.mode === 'backup') {
      parts.push('install-backup', name, '--config', `"${sched.configPath}"`);
    } else if (sched.mode === 'verify') {
      parts.push('install-verify', name, '--dir', `"${sched.dirPath}"`, '--scope', sched.scope);
    } else {
      parts.push('install-drill', name, '--dir', `"${sched.dirPath}"`);
      if (sched.drillDiskIndex !== null) parts.push('--disk', String(sched.drillDiskIndex));
      if (sched.drillVerify) parts.push('--verify');
    }
    if (sched.timeMode === 'login') {
      parts.push('--on-login');
    } else if (sched.time) {
      parts.push('--time', sched.time);
    }
    if (sched.runAs === 'system') parts.push('--as-system');
    if (sched.runAs === 'user') parts.push('--run-as-user');
    return parts.join(' ');
  };

  const outputText = tab === 'schedule' ? buildCommand() : JSON.stringify(buildObject(), null, 2);

  const missingFor = (t: Tab): string[] => {
    const missing: string[] = [];
    if (t === 'backup') {
      if (backup.sourceDiskIndex === null) missing.push('source disk');
      if (backup.sourcePartitions.length === 0) missing.push('partitions');
      if (!backup.destinationPath.trim()) missing.push('destination');
    } else if (t === 'restore') {
      if (!restore.imagePath.trim()) missing.push('image path');
      if (restore.targetKind === 'disk') {
        if (restore.targetDiskIndex === null) missing.push('target disk');
      } else if (!restore.vhdPath.trim()) {
        missing.push('virtual disk file');
      }
      if (restore.targetPartitions.length === 0) missing.push('partitions');
    } else if (t === 'clone') {
      if (clone.sourceDiskIndex === null) missing.push('source disk');
      if (clone.sourcePartitions.length === 0) missing.push('partitions');
      if (clone.targetDiskIndex === null) missing.push('target disk');
    } else if (t === 'drill') {
      if (!drill.imagePath.trim()) missing.push('image path');
      if (drill.targetDiskIndex === null) missing.push('target disk');
      if (drill.targetPartitions.length === 0) missing.push('partitions');
    } else {
      if (!sched.taskName.trim()) missing.push('task name');
      if (sched.mode === 'backup' && !sched.configPath.trim()) missing.push('config file');
      if (sched.mode !== 'backup' && !sched.dirPath.trim()) missing.push('image directory');
      if (sched.mode === 'drill' && sched.drillDiskIndex === null) missing.push('scratch disk');
      if (sched.timeMode === 'time' && !sched.time) missing.push('run time');
    }
    return missing;
  };

  const applyParsed = (t: Tab, parsed: Record<string, unknown>): void => {
    const rest: Record<string, unknown> = { ...parsed };
    delete rest.kind;
    // A restore config carries its virtual-disk target as targetVirtualDisk —
    // fold it into the form fields and keep it out of the unknown-key extras
    // (buildObject regenerates it from the form, so no stale copy can linger).
    let parsedVhd: Record<string, unknown> | null = null;
    if (
      t === 'restore' &&
      typeof rest.targetVirtualDisk === 'object' &&
      rest.targetVirtualDisk !== null &&
      !Array.isArray(rest.targetVirtualDisk)
    ) {
      parsedVhd = rest.targetVirtualDisk as Record<string, unknown>;
      delete rest.targetVirtualDisk;
    }
    const knownByTab: Record<Exclude<Tab, 'schedule'>, string[]> = {
      backup: Object.keys(DEFAULT_BACKUP),
      restore: Object.keys(DEFAULT_RESTORE),
      clone: Object.keys(DEFAULT_CLONE),
      drill: Object.keys(DEFAULT_DRILL)
    };
    if (t === 'schedule') return;
    const known = new Set(knownByTab[t]);
    const unknown: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (!known.has(k)) unknown[k] = v;
    }
    setExtras((prev) => ({ ...prev, [t]: unknown }));
    if (t === 'backup') {
      setBackup((prev) => ({
        ...prev,
        sourceDiskIndex: asIndex(rest.sourceDiskIndex, prev.sourceDiskIndex),
        sourcePartitions: asList(rest.sourcePartitions, prev.sourcePartitions),
        destinationPath: asStr(rest.destinationPath, prev.destinationPath),
        imageName: asStr(rest.imageName, prev.imageName),
        compressionType: rest.compressionType === 'deflate' ? 'deflate' : rest.compressionType === 'zstd' ? 'zstd' : prev.compressionType,
        compressionLevel: asNum(rest.compressionLevel, prev.compressionLevel),
        compressionThreads: asNum(rest.compressionThreads, prev.compressionThreads),
        verificationEnabled: asBool(rest.verificationEnabled, prev.verificationEnabled),
        usedBlocksOnly: asBool(rest.usedBlocksOnly, prev.usedBlocksOnly),
        useUsnJournal: asBool(rest.useUsnJournal, prev.useUsnJournal),
        usnThresholdPct:
          typeof rest.usnFullScanThreshold === 'number' && Number.isFinite(rest.usnFullScanThreshold)
            ? String(Math.max(0, Math.min(100, Math.round(rest.usnFullScanThreshold * 100))))
            : prev.usnThresholdPct,
        resume: asBool(rest.resume, prev.resume),
        baseImagePath: asStr(rest.baseImagePath, prev.baseImagePath),
        passphrase: asStr(rest.passphrase, prev.passphrase)
      }));
    } else if (t === 'restore') {
      const vhdObj = parsedVhd;
      const vhdPathParsed = vhdObj ? asStr(vhdObj.path, '') : '';
      const vhdSizeParsed = vhdObj ? asNum(vhdObj.virtualSize, 0) : 0;
      setRestore((prev) => ({
        ...prev,
        imagePath: asStr(rest.imagePath, prev.imagePath),
        targetKind: vhdPathParsed ? 'vhd' : rest.targetDiskIndex !== undefined && rest.targetDiskIndex !== null ? 'disk' : prev.targetKind,
        targetDiskIndex: asIndex(rest.targetDiskIndex, prev.targetDiskIndex),
        vhdPath: vhdPathParsed || prev.vhdPath,
        vhdSizeGb: vhdSizeParsed > 0 ? Math.max(1, Math.ceil(vhdSizeParsed / 1024 ** 3)) : prev.vhdSizeGb,
        vhdType: vhdObj && vhdObj.type === 'fixed' ? 'fixed' : vhdObj ? 'dynamic' : prev.vhdType,
        targetPartitions: asList(rest.targetPartitions, prev.targetPartitions),
        verifyBeforeWrite: asBool(rest.verifyBeforeWrite, prev.verifyBeforeWrite),
        applyDeltas: asBool(rest.applyDeltas, prev.applyDeltas),
        writePartitionTable: asBool(rest.writePartitionTable, prev.writePartitionTable),
        tableScheme: asScheme(rest.tableScheme, prev.tableScheme),
        verifyAfterRestore: asBool(rest.verifyAfterRestore, prev.verifyAfterRestore),
        acknowledgeSameDisk: asBool(rest.acknowledgeSameDisk, prev.acknowledgeSameDisk),
        passphrase: asStr(rest.passphrase, prev.passphrase),
        compressionThreads: asNum(rest.compressionThreads, prev.compressionThreads)
      }));
    } else if (t === 'clone') {
      setClone((prev) => ({
        ...prev,
        sourceDiskIndex: asIndex(rest.sourceDiskIndex, prev.sourceDiskIndex),
        sourcePartitions: asList(rest.sourcePartitions, prev.sourcePartitions),
        targetDiskIndex: asIndex(rest.targetDiskIndex, prev.targetDiskIndex),
        usedBlocksOnly: asBool(rest.usedBlocksOnly, prev.usedBlocksOnly),
        writePartitionTable: asBool(rest.writePartitionTable, prev.writePartitionTable),
        tableScheme: asScheme(rest.tableScheme, prev.tableScheme),
        acknowledgeSameDisk: asBool(rest.acknowledgeSameDisk, prev.acknowledgeSameDisk)
      }));
    } else {
      setDrill((prev) => ({
        ...prev,
        imagePath: asStr(rest.imagePath, prev.imagePath),
        targetDiskIndex: asIndex(rest.targetDiskIndex, prev.targetDiskIndex),
        targetPartitions: asList(rest.targetPartitions, prev.targetPartitions),
        verifyBeforeWrite: asBool(rest.verifyBeforeWrite, prev.verifyBeforeWrite),
        applyDeltas: asBool(rest.applyDeltas, prev.applyDeltas)
      }));
    }
  };

  const loadJson = async (): Promise<void> => {
    try {
      const p = await window.electronAPI.selectFile({ filters: JSON_FILTERS });
      if (!p) return;
      const text = await window.electronAPI.loadTextFile(p);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      applyParsed(tab, parsed);
      setMsg({ kind: 'ok', text: `Loaded ${p}` });
    } catch (e) {
      setMsg({ kind: 'err', text: `Could not load config: ${errText(e)}` });
    }
  };

  const saveJson = async (): Promise<void> => {
    try {
      const defaultName = tab === 'backup' ? 'job-backup.json'
        : tab === 'restore' ? 'job-restore.json'
        : tab === 'clone' ? 'job-clone.json'
        : 'drill-config.json';
      const p = await window.electronAPI.selectSaveFile({ name: defaultName, filters: JSON_FILTERS });
      if (!p) return;
      await window.electronAPI.saveTextFile(p, outputText);
      setMsg({ kind: 'ok', text: `Saved ${p}` });
    } catch (e) {
      setMsg({ kind: 'err', text: `Could not save config: ${errText(e)}` });
    }
  };

  const copyOutput = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(outputText);
      setMsg({ kind: 'ok', text: tab === 'schedule' ? 'Command copied to clipboard' : 'JSON copied to clipboard' });
    } catch (e) {
      setMsg({ kind: 'err', text: `Could not copy: ${errText(e)}` });
    }
  };

  const missing = missingFor(tab);

  return (
    <div className="dashboard">
      <h1>Config Builder</h1>
      <p className="builder-note">
        Build job configuration files for the headless CLI (<code>OPBS.exe --cli backup job.json</code>),
        Windows scheduled tasks and staged WinPE restores. The preview updates as you type —
        copy it or save it as a file.
      </p>

      <div className="builder-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`builder-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => {
              setTab(t.key);
              setMsg(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="builder-panel">
        {tab === 'backup' && (
          <>
            {diskSelect('Source disk', backup.sourceDiskIndex, (i) =>
              setBackup((prev) => ({ ...prev, sourceDiskIndex: i, sourcePartitions: [] })))
            }
            <div className="builder-row">
              <label>Partitions to image</label>
              <div className="builder-hint-row">
                <button
                  className="btn-secondary btn-small"
                  onClick={() => {
                    const disk = disks.find((d) => d.index === backup.sourceDiskIndex);
                    setBackup((prev) => ({ ...prev, sourcePartitions: disk ? disk.partitions.map((p) => p.partitionIndex) : [] }));
                  }}
                >
                  Select all
                </button>
                <button
                  className="btn-secondary btn-small"
                  onClick={() => setBackup((prev) => ({ ...prev, sourcePartitions: [] }))}
                >
                  Clear
                </button>
              </div>
            </div>
            {partitionList(backup.sourceDiskIndex, backup.sourcePartitions, (i) =>
              setBackup((prev) => ({ ...prev, sourcePartitions: toggle(prev.sourcePartitions, i) })))}

            <div className="builder-row">
              <label>Destination folder</label>
              <div className="path-input">
                <input
                  type="text"
                  value={backup.destinationPath}
                  placeholder="D:\OPBS"
                  onChange={(e) => setBackup((prev) => ({ ...prev, destinationPath: e.target.value }))}
                />
                <button
                  className="btn-secondary"
                  onClick={() => void pickDirectory((p) => setBackup((prev) => ({ ...prev, destinationPath: p })), 'Choose backup destination')}
                >
                  Browse…
                </button>
              </div>
            </div>

            <div className="builder-row">
              <label>Image name (optional)</label>
              <input
                type="text"
                value={backup.imageName}
                placeholder="opbs-disk0 (timestamped when empty)"
                onChange={(e) => setBackup((prev) => ({ ...prev, imageName: e.target.value }))}
              />
            </div>

            <div className="builder-grid">
              <div className="builder-row">
                <label>Compression</label>
                <select
                  value={backup.compressionType}
                  onChange={(e) => setBackup((prev) => ({ ...prev, compressionType: e.target.value === 'deflate' ? 'deflate' : 'zstd' }))}
                >
                  <option value="zstd">zstd (recommended)</option>
                  <option value="deflate">deflate</option>
                </select>
              </div>
              <div className="builder-row">
                <label>Level (0–9)</label>
                <input
                  type="number"
                  min={0}
                  max={9}
                  value={backup.compressionLevel}
                  onChange={(e) => setBackup((prev) => ({ ...prev, compressionLevel: Math.max(0, Math.min(9, Number(e.target.value))) }))}
                />
              </div>
              <div className="builder-row">
                <label>Threads (0 = sync)</label>
                <input
                  type="number"
                  min={0}
                  value={backup.compressionThreads}
                  onChange={(e) => setBackup((prev) => ({ ...prev, compressionThreads: Math.max(0, Number(e.target.value)) }))}
                />
              </div>
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={backup.verificationEnabled}
                onChange={(e) => setBackup((prev) => ({ ...prev, verificationEnabled: e.target.checked }))}
              />
              Verify the image after writing
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={backup.usedBlocksOnly}
                onChange={(e) => setBackup((prev) => ({ ...prev, usedBlocksOnly: e.target.checked }))}
              />
              Used blocks only (skip free space, NTFS)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={backup.useUsnJournal}
                onChange={(e) => setBackup((prev) => ({ ...prev, useUsnJournal: e.target.checked }))}
              />
              USN journal (incremental changed-block tracking)
            </label>
            {backup.useUsnJournal && (
              <div className="builder-row">
                <label>USN full-scan threshold (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  placeholder="No limit"
                  value={backup.usnThresholdPct}
                  onChange={(e) => setBackup((prev) => ({ ...prev, usnThresholdPct: e.target.value }))}
                />
              </div>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={backup.resume}
                onChange={(e) => setBackup((prev) => ({ ...prev, resume: e.target.checked }))}
              />
              Resume an interrupted image if present
            </label>

            <div className="builder-row">
              <label>Incremental base image (optional)</label>
              <div className="path-input">
                <input
                  type="text"
                  value={backup.baseImagePath}
                  placeholder="D:\OPBS\previous-image.opbs"
                  onChange={(e) => setBackup((prev) => ({ ...prev, baseImagePath: e.target.value }))}
                />
                <button
                  className="btn-secondary"
                  onClick={() => void pickFile((p) => setBackup((prev) => ({ ...prev, baseImagePath: p })), IMAGE_FILTERS)}
                >
                  Browse…
                </button>
              </div>
            </div>

            <div className="builder-row">
              <label>Encryption passphrase (optional)</label>
              <input
                type="password"
                value={backup.passphrase}
                placeholder="Empty = no encryption"
                onChange={(e) => setBackup((prev) => ({ ...prev, passphrase: e.target.value }))}
              />
            </div>
          </>
        )}

        {tab === 'restore' && (
          <>
            <div className="builder-row">
              <label>Image file</label>
              <div className="path-input">
                <input
                  type="text"
                  value={restore.imagePath}
                  placeholder="D:\OPBS\opbs-disk0-….opbs"
                  onChange={(e) => setRestore((prev) => ({ ...prev, imagePath: e.target.value }))}
                />
                <button
                  className="btn-secondary"
                  onClick={() => void pickFile((p) => setRestore((prev) => ({ ...prev, imagePath: p })), RESTORE_IMAGE_FILTERS)}
                >
                  Browse…
                </button>
              </div>
            </div>

            <div className="builder-row">
              <label>Target</label>
              <select
                value={restore.targetKind}
                onChange={(e) =>
                  setRestore((prev) => ({ ...prev, targetKind: e.target.value === 'vhd' ? 'vhd' : 'disk' }))
                }
              >
                <option value="disk">Physical disk</option>
                <option value="vhd">Virtual disk (VHD / VHDX)</option>
              </select>
            </div>

            {restore.targetKind === 'disk' ? (
              diskSelect('Target disk', restore.targetDiskIndex, (i) =>
                setRestore((prev) => ({ ...prev, targetDiskIndex: i, targetPartitions: [] })))
            ) : (
              <>
                <div className="builder-row">
                  <label>Virtual disk file</label>
                  <div className="path-input">
                    <input
                      type="text"
                      value={restore.vhdPath}
                      placeholder="D:\VMs\restore-target.vhdx"
                      onChange={(e) => setRestore((prev) => ({ ...prev, vhdPath: e.target.value }))}
                    />
                    <button
                      className="btn-secondary"
                      onClick={() =>
                        void pickSaveFile(
                          (p) => setRestore((prev) => ({ ...prev, vhdPath: p })),
                          'restore-target.vhdx',
                          VHD_FILTERS
                        )
                      }
                    >
                      Browse…
                    </button>
                  </div>
                </div>
                <div className="builder-grid">
                  <div className="builder-row">
                    <label>Size (GB)</label>
                    <input
                      type="number"
                      min={1}
                      value={restore.vhdSizeGb}
                      onChange={(e) =>
                        setRestore((prev) => ({ ...prev, vhdSizeGb: Math.max(1, Number(e.target.value) || 1) }))
                      }
                    />
                  </div>
                  <div className="builder-row">
                    <label>Type</label>
                    <select
                      value={restore.vhdType}
                      onChange={(e) =>
                        setRestore((prev) => ({ ...prev, vhdType: e.target.value === 'fixed' ? 'fixed' : 'dynamic' }))
                      }
                    >
                      <option value="dynamic">Dynamic (grows as data is written)</option>
                      <option value="fixed">Fixed (pre-allocates the full size)</option>
                    </select>
                  </div>
                </div>
                <p className="field-hint">
                  The size is only used when the file has to be created — an existing file's capacity
                  is used as-is.
                </p>
              </>
            )}

            <div className="builder-row">
              <label>Partitions to restore</label>
              <div className="builder-hint-row">
                <button
                  className="btn-secondary btn-small"
                  onClick={() => {
                    const all =
                      restore.targetKind === 'disk'
                        ? disks.find((d) => d.index === restore.targetDiskIndex)?.partitions.map((p) => p.partitionIndex) ?? []
                        : (imageInfo?.partitions ?? []).map((p) => p.index);
                    setRestore((prev) => ({ ...prev, targetPartitions: all }));
                  }}
                >
                  Select all
                </button>
                <button
                  className="btn-secondary btn-small"
                  onClick={() => setRestore((prev) => ({ ...prev, targetPartitions: [] }))}
                >
                  Clear
                </button>
              </div>
            </div>
            {restore.targetKind === 'disk' ? (
              partitionList(restore.targetDiskIndex, restore.targetPartitions, (i) =>
                setRestore((prev) => ({ ...prev, targetPartitions: toggle(prev.targetPartitions, i) })))
            ) : imageInfo?.partitions?.length ? (
              <div className="partition-list builder-partitions">
                {imageInfo.partitions.map((p) => (
                  <label key={p.index} className="partition-item">
                    <input
                      type="checkbox"
                      checked={restore.targetPartitions.includes(p.index)}
                      onChange={() =>
                        setRestore((prev) => ({ ...prev, targetPartitions: toggle(prev.targetPartitions, p.index) }))
                      }
                    />
                    <span className="partition-info">
                      Partition {p.index} · {formatSize(p.size)} · {p.fsType ?? 'Unknown'}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="field-hint">
                {restore.imagePath.trim()
                  ? imageInfo
                    ? 'No partitions found in this image.'
                    : 'Could not read that image.'
                  : 'Pick an image file to list its partitions.'}
              </p>
            )}

            <div className="builder-grid">
              <div className="builder-row">
                <label>Partition table</label>
                <select
                  value={restore.tableScheme}
                  onChange={(e) => setRestore((prev) => ({ ...prev, tableScheme: e.target.value }))}
                >
                  <option value="">Default (auto)</option>
                  <option value="gpt">GPT</option>
                  <option value="mbr">MBR</option>
                  <option value="auto">auto</option>
                </select>
              </div>
              <div className="builder-row">
                <label>Threads (0 = sync)</label>
                <input
                  type="number"
                  min={0}
                  value={restore.compressionThreads}
                  onChange={(e) => setRestore((prev) => ({ ...prev, compressionThreads: Math.max(0, Number(e.target.value)) }))}
                />
              </div>
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={restore.verifyBeforeWrite}
                onChange={(e) => setRestore((prev) => ({ ...prev, verifyBeforeWrite: e.target.checked }))}
              />
              Verify the image before writing
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={restore.applyDeltas}
                onChange={(e) => setRestore((prev) => ({ ...prev, applyDeltas: e.target.checked }))}
              />
              Apply delta chain (restore the newest state)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={restore.writePartitionTable}
                onChange={(e) => setRestore((prev) => ({ ...prev, writePartitionTable: e.target.checked }))}
              />
              Write the partition table (uncheck to write raw blocks only)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={restore.verifyAfterRestore}
                onChange={(e) => setRestore((prev) => ({ ...prev, verifyAfterRestore: e.target.checked }))}
              />
              Verify after restore (read back every block and compare CRCs)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={restore.acknowledgeSameDisk}
                onChange={(e) => setRestore((prev) => ({ ...prev, acknowledgeSameDisk: e.target.checked }))}
              />
              Acknowledge same-disk restore (overwrites the disk the image came from)
            </label>

            <div className="builder-row">
              <label>Image passphrase (if encrypted)</label>
              <input
                type="password"
                value={restore.passphrase}
                onChange={(e) => setRestore((prev) => ({ ...prev, passphrase: e.target.value }))}
              />
            </div>
          </>
        )}

        {tab === 'clone' && (
          <>
            {diskSelect('Source disk', clone.sourceDiskIndex, (i) =>
              setClone((prev) => ({ ...prev, sourceDiskIndex: i, sourcePartitions: [] })))}

            <div className="builder-row">
              <label>Partitions to clone</label>
              <div className="builder-hint-row">
                <button
                  className="btn-secondary btn-small"
                  onClick={() => {
                    const disk = disks.find((d) => d.index === clone.sourceDiskIndex);
                    setClone((prev) => ({ ...prev, sourcePartitions: disk ? disk.partitions.map((p) => p.partitionIndex) : [] }));
                  }}
                >
                  Select all
                </button>
                <button
                  className="btn-secondary btn-small"
                  onClick={() => setClone((prev) => ({ ...prev, sourcePartitions: [] }))}
                >
                  Clear
                </button>
              </div>
            </div>
            {partitionList(clone.sourceDiskIndex, clone.sourcePartitions, (i) =>
              setClone((prev) => ({ ...prev, sourcePartitions: toggle(prev.sourcePartitions, i) })))}

            {diskSelect('Target disk', clone.targetDiskIndex, (i) =>
              setClone((prev) => ({ ...prev, targetDiskIndex: i })))}

            <div className="builder-row">
              <label>Partition table</label>
              <select
                value={clone.tableScheme}
                onChange={(e) => setClone((prev) => ({ ...prev, tableScheme: e.target.value }))}
              >
                <option value="">Default (auto)</option>
                <option value="gpt">GPT</option>
                <option value="mbr">MBR</option>
                <option value="auto">auto</option>
              </select>
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={clone.usedBlocksOnly}
                onChange={(e) => setClone((prev) => ({ ...prev, usedBlocksOnly: e.target.checked }))}
              />
              Used blocks only (skip free space, NTFS)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={clone.writePartitionTable}
                onChange={(e) => setClone((prev) => ({ ...prev, writePartitionTable: e.target.checked }))}
              />
              Write the partition table (uncheck to copy raw blocks only)
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={clone.acknowledgeSameDisk}
                onChange={(e) => setClone((prev) => ({ ...prev, acknowledgeSameDisk: e.target.checked }))}
              />
              Acknowledge same-disk clone (target is the source disk)
            </label>
          </>
        )}

        {tab === 'drill' && (
          <>
            <div className="builder-row">
              <label>Image file</label>
              <div className="path-input">
                <input
                  type="text"
                  value={drill.imagePath}
                  placeholder="D:\OPBS\opbs-disk0-….opbs"
                  onChange={(e) => setDrill((prev) => ({ ...prev, imagePath: e.target.value }))}
                />
                <button
                  className="btn-secondary"
                  onClick={() => void pickFile((p) => setDrill((prev) => ({ ...prev, imagePath: p })), RESTORE_IMAGE_FILTERS)}
                >
                  Browse…
                </button>
              </div>
            </div>

            {diskSelect('Scratch target disk', drill.targetDiskIndex, (i) =>
              setDrill((prev) => ({ ...prev, targetDiskIndex: i, targetPartitions: [] })))}

            <div className="builder-row">
              <label>Partitions to drill</label>
              <div className="builder-hint-row">
                <button
                  className="btn-secondary btn-small"
                  onClick={() => {
                    const disk = disks.find((d) => d.index === drill.targetDiskIndex);
                    setDrill((prev) => ({ ...prev, targetPartitions: disk ? disk.partitions.map((p) => p.partitionIndex) : [] }));
                  }}
                >
                  Select all
                </button>
                <button
                  className="btn-secondary btn-small"
                  onClick={() => setDrill((prev) => ({ ...prev, targetPartitions: [] }))}
                >
                  Clear
                </button>
              </div>
            </div>
            {partitionList(drill.targetDiskIndex, drill.targetPartitions, (i) =>
              setDrill((prev) => ({ ...prev, targetPartitions: toggle(prev.targetPartitions, i) })))}

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={drill.verifyBeforeWrite}
                onChange={(e) => setDrill((prev) => ({ ...prev, verifyBeforeWrite: e.target.checked }))}
              />
              Verify the image before writing
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={drill.applyDeltas}
                onChange={(e) => setDrill((prev) => ({ ...prev, applyDeltas: e.target.checked }))}
              />
              Apply delta chain
            </label>
            <p className="field-hint">
              The drill always validates the filesystems after writing — it exits 0 only when the
              restore and the validation both pass.
            </p>
          </>
        )}

        {tab === 'schedule' && (
          <>
            <div className="builder-row">
              <label>Task type</label>
              <select
                value={sched.mode}
                onChange={(e) => setSched((prev) => ({ ...prev, mode: e.target.value === 'verify' ? 'verify' : e.target.value === 'drill' ? 'drill' : 'backup' }))}
              >
                <option value="backup">Backup (runs a config.json elevated)</option>
                <option value="verify">Verify images in a directory</option>
                <option value="drill">Restore drill on a scratch disk</option>
              </select>
            </div>

            <div className="builder-row">
              <label>Task name</label>
              <input
                type="text"
                value={sched.taskName}
                placeholder="OPBS nightly"
                onChange={(e) => setSched((prev) => ({ ...prev, taskName: e.target.value }))}
              />
            </div>

            {sched.mode === 'backup' ? (
              <div className="builder-row">
                <label>Config file</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={sched.configPath}
                    placeholder="D:\configs\job-backup.json"
                    onChange={(e) => setSched((prev) => ({ ...prev, configPath: e.target.value }))}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => void pickFile((p) => setSched((prev) => ({ ...prev, configPath: p })), JSON_FILTERS)}
                  >
                    Browse…
                  </button>
                </div>
              </div>
            ) : (
              <div className="builder-row">
                <label>Image directory</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={sched.dirPath}
                    placeholder="D:\OPBS"
                    onChange={(e) => setSched((prev) => ({ ...prev, dirPath: e.target.value }))}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => void pickDirectory((p) => setSched((prev) => ({ ...prev, dirPath: p })), 'Choose image directory')}
                  >
                    Browse…
                  </button>
                </div>
              </div>
            )}

            {sched.mode === 'verify' && (
              <div className="builder-row">
                <label>Scope</label>
                <select
                  value={sched.scope}
                  onChange={(e) => setSched((prev) => ({ ...prev, scope: e.target.value === 'all' ? 'all' : 'newest' }))}
                >
                  <option value="newest">Newest image only</option>
                  <option value="all">All images</option>
                </select>
              </div>
            )}

            {sched.mode === 'drill' && (
              <>
                {diskSelect('Scratch target disk', sched.drillDiskIndex, (i) =>
                  setSched((prev) => ({ ...prev, drillDiskIndex: i })))}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sched.drillVerify}
                    onChange={(e) => setSched((prev) => ({ ...prev, drillVerify: e.target.checked }))}
                  />
                  Verify the image before writing
                </label>
              </>
            )}

            <div className="builder-grid">
              <div className="builder-row">
                <label>Trigger</label>
                <select
                  value={sched.timeMode}
                  onChange={(e) => setSched((prev) => ({ ...prev, timeMode: e.target.value === 'login' ? 'login' : 'time' }))}
                >
                  <option value="time">Daily at a time</option>
                  <option value="login">At login</option>
                </select>
              </div>
              {sched.timeMode === 'time' && (
                <div className="builder-row">
                  <label>Time (HH:MM)</label>
                  <input
                    type="time"
                    value={sched.time}
                    onChange={(e) => setSched((prev) => ({ ...prev, time: e.target.value }))}
                  />
                </div>
              )}
              <div className="builder-row">
                <label>Run as</label>
                <select
                  value={sched.runAs}
                  onChange={(e) => setSched((prev) => ({ ...prev, runAs: e.target.value === 'system' ? 'system' : e.target.value === 'user' ? 'user' : 'default' }))}
                >
                  <option value="default">Default (highest privileges)</option>
                  <option value="system">SYSTEM account (--as-system)</option>
                  <option value="user">Current user, no elevation (--run-as-user)</option>
                </select>
              </div>
            </div>

            <p className="field-hint">
              The task runs the headless CLI directly — no UAC prompt at run time. Run the command
              below in an elevated prompt to register it
              {sched.mode === 'backup' ? (
                <> — build the config file first in the Backup tab.</>
              ) : (
                <>.</>
              )}
            </p>
          </>
        )}
      </div>

      <div className="builder-preview-block">
        <div className="builder-preview-head">
          <span>{tab === 'schedule' ? 'Command' : 'JSON preview'}</span>
        </div>
        <pre className="builder-preview">{outputText}</pre>
      </div>

      {missing.length > 0 && (
        <p className="field-hint builder-missing">
          Still needed: {missing.join(', ')}
        </p>
      )}

      {msg && (
        msg.kind === 'ok' ? (
          <div className="success-message">
            <p>{msg.text}</p>
          </div>
        ) : (
          <div className="error-message">
            <p>{msg.text}</p>
          </div>
        )
      )}

      <div className="wizard-actions builder-actions">
        {tab !== 'schedule' && (
          <>
            <button className="btn-secondary" onClick={() => void loadJson()}>
              Load…
            </button>
            <button className="btn-secondary" onClick={() => void saveJson()}>
              Save as…
            </button>
          </>
        )}
        <button className="btn-primary" onClick={() => void copyOutput()}>
          {tab === 'schedule' ? 'Copy command' : 'Copy JSON'}
        </button>
      </div>
    </div>
  );
}

export default ConfigBuilder;
