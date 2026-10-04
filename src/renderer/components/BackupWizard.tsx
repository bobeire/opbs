import { useState, useEffect } from 'react';

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

interface BitlockerVolume {
  letter: string;
  volumeType: string;
  locked: boolean;
  protectionOn: boolean;
  conversion: string;
  protectors: Array<{ type: string }>;
}

/** Recovery-password protectors are the only kind Phase 1 can store/unlock. */
function isRecoveryType(type: string): boolean {
  const normalized = type.toLowerCase().replace(/[\s_-]/g, '');
  return normalized === 'numericalpassword' || normalized === 'recoverypassword';
}

interface BackupConfig {
  sourceDiskIndex: number;
  sourcePartitions: number[];
  sourceVirtualDisk?: string;
  destinationPath: string;
  imageName?: string;
  compressionLevel: number;
  compressionType?: 'deflate' | 'zstd';
  compressionThreads?: number;
  verificationEnabled: boolean;
  usedBlocksOnly?: boolean;
  useUsnJournal?: boolean;
  usnFullScanThreshold?: number;
  baseImagePath?: string;
  passphrase?: string;
  resume?: boolean;
  repoDir?: string;
  repoLockDays?: number;
}

interface BackupProgress {
  phase: string;
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
  resuming?: boolean;
  verifyDone?: number;
  verifyTotal?: number;
  /** Set on the 'completed' event — the image just written. */
  imagePath?: string;
}

interface BackupWizardProps {
  onComplete: () => void;
  initialDestination?: string;
  initialAllDisks?: boolean;
  activeProgress?: BackupProgress | null;
  backupRunning?: boolean;
  /** Open the just-created image in the file browser (BrowseView). */
  onViewImage?: (imagePath: string) => void;
}

type WizardStep = 'select_source' | 'select_destination' | 'options' | 'progress' | 'complete';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1073741824) return `${(bytesPerSec / 1073741824).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

function phaseLabel(phase?: string): string {
  switch (phase) {
    case 'snapshotting':
      return 'Creating snapshot';
    case 'backing_up':
      return 'Backing up';
    case 'verifying':
      return 'Verifying image';
    case 'finalizing':
      // The sub-line (currentPartition) carries the detail: "Writing image
      // index…" during the job tail, "Building parity recovery data…" after.
      return 'Finalizing';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Error';
    default:
      return 'Preparing...';
  }
}

/** Parse a 0-100% USN threshold field into the 0..1 fraction (undefined = invalid/blank). */
function parseUsnPct(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : undefined;
}

function BackupWizard({ onComplete, initialDestination, initialAllDisks, activeProgress, backupRunning, onViewImage }: BackupWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>(
    backupRunning && activeProgress ? 'progress' : 'select_source'
  );
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [selectedDisk, setSelectedDisk] = useState<DiskInfo | null>(null);
  const [selectedPartitions, setSelectedPartitions] = useState<number[]>([]);
  const [sourceVhdPath, setSourceVhdPath] = useState<string | null>(null);
  const [allDisks, setAllDisks] = useState(initialAllDisks ?? false);
  const [destinationPath, setDestinationPath] = useState(initialDestination ?? '');
  const [imageName, setImageName] = useState('');
  const [compressionLevel, setCompressionLevel] = useState(3);
  const [compressionType, setCompressionType] = useState<'deflate' | 'zstd'>('zstd');
  const [compressionThreads, setCompressionThreads] = useState(() =>
    Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
  );
  const [verificationEnabled, setVerificationEnabled] = useState(true);
  const [usedBlocksOnly, setUsedBlocksOnly] = useState(true);
  const [useUsnJournal, setUseUsnJournal] = useState(true);
  const [usnThresholdPct, setUsnThresholdPct] = useState('');
  const [incrementalEnabled, setIncrementalEnabled] = useState(false);
  const [resumeEnabled, setResumeEnabled] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [baseImagePath, setBaseImagePath] = useState<string | undefined>(undefined);
  const [baseImageName, setBaseImageName] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<BackupProgress | null>(activeProgress ?? null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [diskLabel, setDiskLabel] = useState<string | null>(null);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [profileName, setProfileName] = useState('');
  const [profileMsg, setProfileMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [blVolumes, setBlVolumes] = useState<BitlockerVolume[] | null>(null);
  const [blChecking, setBlChecking] = useState(false);
  const [blNeedsElevation, setBlNeedsElevation] = useState(false);
  const [blError, setBlError] = useState<string | null>(null);
  const [repoDir, setRepoDir] = useState('');
  const [s3RepoUri, setS3RepoUri] = useState('');
  const [repoLockDays, setRepoLockDays] = useState(30);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [prevDestination, setPrevDestination] = useState('');
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const [repoWarn, setRepoWarn] = useState<string | null>(null);

  useEffect(() => {
    loadDisks();
    void checkBitlocker('silent');
    window.electronAPI
      .getSettings()
      .then((s) => setProfiles(s?.backupProfiles ?? []))
      .catch(() => setProfiles([]));
    const cleanup = window.electronAPI.onBackupProgress((p) => {
      setProgress(p);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (!initialDestination) return;
    if (destinationPath.trim()) {
      void resolveNewestBase(destinationPath.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDisks = async () => {
    try {
      const diskList = await window.electronAPI.getDisks();
      setDisks(diskList);
    } catch (error) {
      console.error('Failed to load disks:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Silent on mount (cached or non-elevated probe — no UAC). 'elevate' costs
   * one administrator prompt; 'refresh' bypasses the session cache.
   */
  const checkBitlocker = async (mode: 'silent' | 'elevate' | 'refresh') => {
    setBlChecking(true);
    setBlError(null);
    try {
      const opts =
        mode === 'elevate' ? { elevate: true, refresh: true } : mode === 'refresh' ? { refresh: true } : {};
      const res = await window.electronAPI.bitlockerStatus(opts);
      if (res.ok) {
        setBlVolumes(res.volumes);
        setBlNeedsElevation(false);
      } else {
        setBlVolumes(null);
        setBlNeedsElevation(res.needsElevation === true);
        setBlError(res.error ?? 'BitLocker status check failed.');
      }
    } catch (error) {
      setBlNeedsElevation(false);
      setBlError(error instanceof Error ? error.message : String(error));
    } finally {
      setBlChecking(false);
    }
  };

  const blWarnings: string[] = [];
  const blOkNotes: string[] = [];
  if (blVolumes) {
    for (const v of blVolumes) {
      if (v.locked) {
        blWarnings.push(`${v.letter}: is BitLocker-locked — unlock it (Disk Tools) before imaging it.`);
        continue;
      }
      const encrypted = !!v.conversion && v.conversion !== 'FullyDecrypted';
      if (encrypted) {
        blWarnings.push(
          `${v.letter}: is encrypted (${v.conversion}) — turn on backup encryption (passphrase) ` +
            `on the options step so recovery keys are stored with the backup.`
        );
        if (!v.protectors.some((p) => isRecoveryType(p.type))) {
          blWarnings.push(
            `${v.letter}: has no recovery-password protector, so OPBS cannot store a recovery key for it.`
          );
        }
      } else {
        // No warning for this volume — say what was checked instead of
        // pointing at notes that don't exist.
        blOkNotes.push(
          v.conversion === 'FullyDecrypted'
            ? `${v.letter}: unlocked and not encrypted — no action needed.`
            : `${v.letter}: unlocked — no action needed.`
        );
      }
    }
  }

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

  const handleSelectDestination = async () => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setDestinationPath(path);
      resolveNewestBase(path);
    }
  };

  const handleDestinationChange = (value: string) => {
    setDestinationPath(value);
    if (value.trim().startsWith('s3://') || value.trim().startsWith('sftp://')) {
      setBaseImagePath(undefined);
      setBaseImageName(undefined);
    } else if (value.trim()) {
      resolveNewestBase(value.trim());
    }
  };

  const handleSelectRepository = async () => {
    setRepoError(null);
    const picked = await window.electronAPI.selectDirectory({ title: 'Select an OPBS repository' });
    if (!picked) return;
    try {
      const res = await window.electronAPI.repoOpen(picked);
      if (!res.ok) {
        setRepoError(res.error ?? 'Not an OPBS repository — initialize one in the Repositories view first.');
        return;
      }
      const imagesPath = `${picked.replace(/[\\/]+$/, '')}\\images`;
      setPrevDestination(destinationPath);
      setRepoDir(picked);
      setRepoLockDays(res.header?.defaultLockDays ?? 30);
      setDestinationPath(imagesPath);
      resolveNewestBase(imagesPath);
    } catch (error) {
      setRepoError(error instanceof Error ? error.message : String(error));
    }
  };

  const clearRepository = () => {
    setRepoDir('');
    setRepoError(null);
    if (prevDestination) {
      setDestinationPath(prevDestination);
      resolveNewestBase(prevDestination);
    }
    setPrevDestination('');
  };

  const openS3Repository = async () => {
    setRepoError(null);
    const uri = s3RepoUri.trim();
    if (!/^s3:\/\//i.test(uri)) {
      setRepoError('Enter an s3://bucket/prefix location.');
      return;
    }
    try {
      const res = await window.electronAPI.repoOpen(uri);
      if (!res.ok) {
        setRepoError(res.error ?? 'Not an OPBS repository — initialize one in the Repositories view first.');
        return;
      }
      setPrevDestination(destinationPath);
      setRepoDir(uri);
      setRepoLockDays(res.header?.defaultLockDays ?? 30);
      // The repository IS the destination; start-backup stages the image in
      // the local cache and uploads it to the bucket.
      setDestinationPath(uri);
      setS3RepoUri('');
      setBaseImagePath(undefined);
      setBaseImageName(undefined);
    } catch (error) {
      setRepoError(error instanceof Error ? error.message : String(error));
    }
  };

  const resolveNewestBase = async (dir: string) => {
    try {
      const result = await window.electronAPI.listImages(dir);
      const newest = result?.entries?.[0];
      setBaseImagePath(newest?.path);
      setBaseImageName(newest?.name);
    } catch (error) {
      console.error('Failed to resolve base image:', error);
      setBaseImagePath(undefined);
      setBaseImageName(undefined);
    }
  };

  const eligibleDisks = disks.filter((d) => d.partitions.length > 0);

  const applyProfile = (profile: any) => {
    setSourceVhdPath(null);
    const disk = disks.find((d) => d.index === profile.sourceDiskIndex);
    if (!disk) {
      setProfileMsg({ kind: 'err', text: `Profile "${profile.name}" references disk ${profile.sourceDiskIndex}, which is not present on this machine.` });
      return;
    }
    setSelectedDisk(disk);
    setSelectedPartitions(profile.sourcePartitions ?? []);
    if (profile.destinationPath) {
      setDestinationPath(profile.destinationPath);
      void resolveNewestBase(profile.destinationPath);
    }
    if (profile.repoDir) {
      setRepoDir(profile.repoDir);
      setRepoLockDays(profile.repoLockDays ?? 30);
      setRepoError(null);
    } else {
      setRepoDir('');
      setRepoError(null);
    }
    setCompressionLevel(profile.compressionLevel ?? 3);
    setCompressionType(profile.compressionType ?? 'zstd');
    setCompressionThreads(
      profile.compressionThreads || Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
    );
    setVerificationEnabled(profile.verificationEnabled ?? true);
    setUsedBlocksOnly(profile.usedBlocksOnly ?? true);
    setUseUsnJournal(profile.useUsnJournal ?? true);
    setUsnThresholdPct(
      profile.usnFullScanThreshold !== undefined
        ? String(Math.round(profile.usnFullScanThreshold * 100))
        : ''
    );
    setIncrementalEnabled(profile.incremental ?? false);
    setResumeEnabled(profile.resume ?? false);
    setPassphrase(profile.passphrase ?? '');
    setProfileMsg({ kind: 'ok', text: `Profile "${profile.name}" applied.` });
  };

  const deleteProfile = async (id: string) => {
    await window.electronAPI.deleteBackupProfile(id);
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    setSelectedProfileId('');
  };

  const pickSourceVhd = async () => {
    const picked = await window.electronAPI.selectFile({
      title: 'Select a virtual disk to back up',
      filters: [
        { name: 'Virtual Disks', extensions: ['vhdx', 'vhd'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (picked) {
      setSourceVhdPath(picked);
      setSelectedDisk(null);
      setSelectedPartitions([]);
      setAllDisks(false);
    }
  };

  const saveAsProfile = async () => {
    setProfileMsg(null);
    if (!profileName.trim()) {
      setProfileMsg({ kind: 'err', text: 'Enter a profile name.' });
      return;
    }
    if (sourceVhdPath) {
      setProfileMsg({ kind: 'err', text: 'Profiles store physical disk sources — select a disk instead of a VHD/VHDX file.' });
      return;
    }
    if (!selectedDisk || !destinationPath.trim()) {
      setProfileMsg({ kind: 'err', text: 'Select a source disk and destination first.' });
      return;
    }
    if (selectedPartitions.length === 0) {
      setProfileMsg({ kind: 'err', text: 'Select at least one partition to back up.' });
      return;
    }
    const payload: any = {
      name: profileName.trim(),
      sourceDiskIndex: selectedDisk.index,
      sourcePartitions: selectedPartitions,
      destinationPath,
      compressionLevel,
      compressionType,
      compressionThreads,
      verificationEnabled,
      usedBlocksOnly,
      useUsnJournal,
      incremental: incrementalEnabled,
      ...(useUsnJournal && parseUsnPct(usnThresholdPct) !== undefined
        ? { usnFullScanThreshold: parseUsnPct(usnThresholdPct) }
        : {}),
      ...(resumeEnabled ? { resume: true } : {}),
      ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
      ...(repoDir ? { repoDir, repoLockDays } : {})
    };
    const created = await window.electronAPI.addBackupProfile(payload);
    if (created) {
      setProfiles((prev) => [...prev, created]);
      setProfileName('');
      setSelectedProfileId(created.id);
      setProfileMsg({ kind: 'ok', text: `Profile "${created.name}" saved.` });
    } else {
      setProfileMsg({ kind: 'err', text: 'Could not save the profile.' });
    }
  };

  const handleStartBackup = async () => {
    setCurrentStep('progress');
    setErrorMsg(null);
    setProgress(null);
    setRepoNote(null);
    setRepoWarn(null);

    const common: Omit<BackupConfig, 'sourceDiskIndex' | 'sourcePartitions'> = {
      destinationPath,
      ...(imageName.trim() ? { imageName: imageName.trim() } : {}),
      compressionLevel,
      compressionType,
      compressionThreads,
      verificationEnabled,
      usedBlocksOnly,
      useUsnJournal,
      ...(useUsnJournal && parseUsnPct(usnThresholdPct) !== undefined
        ? { usnFullScanThreshold: parseUsnPct(usnThresholdPct) }
        : {}),
      ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
      ...(resumeEnabled ? { resume: true } : {}),
      ...(repoDir ? { repoDir, repoLockDays } : {})
    };

    const trackResult = (result: Awaited<ReturnType<typeof window.electronAPI.startBackup>>) => {
      const parts: string[] = [];
      if (result?.repoRecord) {
        parts.push(
          `Journaled: ${result.repoRecord.image} — immutable until ${new Date(result.repoRecord.lockUntil).toLocaleString()}`
        );
      }
      if (result?.repoAnchor) {
        parts.push(`journal anchored off-box through seq ${result.repoAnchor.seq}`);
      }
      if (parts.length > 0) setRepoNote(parts.join(' · '));
      const journalWarn = (result?.warnings ?? []).find(
        (w) => w.toLowerCase().includes('journaled') || w.toLowerCase().includes('anchored')
      );
      if (journalWarn) setRepoWarn(journalWarn);
    };

    try {
      if (sourceVhdPath) {
        setDiskLabel(null);
        const config: BackupConfig = {
          ...common,
          sourceVirtualDisk: sourceVhdPath,
          sourceDiskIndex: -1,
          sourcePartitions: [],
          ...(incrementalEnabled && baseImagePath ? { baseImagePath } : {})
        };
        trackResult(await window.electronAPI.startBackup(config));
      } else if (allDisks) {
        for (let i = 0; i < eligibleDisks.length; i++) {
          const disk = eligibleDisks[i];
          setDiskLabel(`Disk ${i + 1} of ${eligibleDisks.length}: ${disk.model}`);
          const config: BackupConfig = {
            ...common,
            ...(imageName.trim() ? { imageName: `${imageName.trim()}-disk${disk.index}` } : {}),
            sourceDiskIndex: disk.index,
            sourcePartitions: disk.partitions.map((p) => p.partitionIndex),
            ...(incrementalEnabled && baseImagePath ? { baseImagePath } : {})
          };
          trackResult(await window.electronAPI.startBackup(config));
        }
      } else {
        setDiskLabel(null);
        const config: BackupConfig = {
          ...common,
          sourceDiskIndex: selectedDisk!.index,
          sourcePartitions: selectedPartitions,
          ...(incrementalEnabled && baseImagePath ? { baseImagePath } : {})
        };
        trackResult(await window.electronAPI.startBackup(config));
      }
      setCurrentStep('complete');
    } catch (error) {
      console.error('Backup failed:', error);
      const msg = error instanceof Error ? error.message : String(error ?? 'Backup failed');
      setErrorMsg(msg);
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 'select_source':
        return (
          <div className="wizard-step">
            <h2>Select Source Disk</h2>

            <div className="setting-item bitlocker-status-row">
              <span>BitLocker:</span>
              {blChecking ? (
                <span className="field-hint">Checking status…</span>
              ) : blVolumes ? (
                <span className="field-hint">
                  {blVolumes.length === 0
                    ? 'No BitLocker volumes found.'
                    : blWarnings.length > 0
                      ? `${blVolumes.length} volume${blVolumes.length === 1 ? '' : 's'} checked — see notes below.`
                      : `${blVolumes.length} volume${blVolumes.length === 1 ? '' : 's'} checked — no issues found.`}
                </span>
              ) : blNeedsElevation ? (
                <>
                  <span className="field-hint">Administrator rights required to read status.</span>
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => void checkBitlocker('elevate')}
                  >
                    Check (one UAC prompt)
                  </button>
                </>
              ) : blError ? (
                <>
                  <span className="field-hint">{blError}</span>
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => void checkBitlocker('refresh')}
                  >
                    Retry
                  </button>
                </>
              ) : (
                <span className="field-hint">Not checked</span>
              )}
            </div>
            {blWarnings.map((w, i) => (
              <div key={i} className="warning-box">
                <p>{w}</p>
              </div>
            ))}
            {blWarnings.length === 0 &&
              blOkNotes.map((n, i) => (
                <div key={i} className="bl-ok-note">
                  <p>{n}</p>
                </div>
              ))}

            {isLoading ? (
              <div className="loading">Loading disks...</div>
            ) : (
              <>
                <label className="checkbox-label all-disks-option">
                  <input
                    type="checkbox"
                    checked={allDisks}
                    disabled={!!sourceVhdPath}
                    onChange={(e) => {
                      setAllDisks(e.target.checked);
                      if (e.target.checked) {
                        setSelectedDisk(null);
                        setSelectedPartitions([]);
                      }
                    }}
                  />
                  Back up entire system (all disks, all partitions) to one destination
                </label>

                <p className="field-hint">
                  Central backup: every disk with partitions ({eligibleDisks.length} available) is
                  imaged sequentially to the destination you choose next.
                </p>
              </>
            )}

            <div className="setting-item vhd-source-row">
              <span>Virtual disk:</span>
              {sourceVhdPath ? (
                <>
                  <span className="field-hint vhd-source-path" title={sourceVhdPath}>
                    {sourceVhdPath}
                  </span>
                  <button className="btn-secondary btn-small" onClick={() => void pickSourceVhd()}>
                    Change…
                  </button>
                  <button className="btn-secondary btn-small" onClick={() => setSourceVhdPath(null)}>
                    Use a disk instead
                  </button>
                </>
              ) : (
                <button className="btn-secondary btn-small" onClick={() => void pickSourceVhd()}>
                  Back up from a VHD/VHDX file…
                </button>
              )}
            </div>
            {sourceVhdPath && (
              <p className="field-hint">
                All partitions on the virtual disk are captured — the file's layout is read when the
                backup starts (attached write-protected, then detached).
              </p>
            )}

            {!allDisks && (
              <>
                <div className="profile-row">
                  <label>Load profile:</label>
                  <select
                    value={selectedProfileId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedProfileId(id);
                      const profile = profiles.find((p) => p.id === id);
                      if (profile) applyProfile(profile);
                    }}
                  >
                    <option value="">Choose a saved configuration…</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  {selectedProfileId && (
                    <button className="btn-danger btn-small" onClick={() => void deleteProfile(selectedProfileId)}>
                      Delete
                    </button>
                  )}
                </div>
                {profileMsg && (
                  profileMsg.kind === 'ok' ? (
                    <div className="success-message">
                      <p>{profileMsg.text}</p>
                    </div>
                  ) : (
                    <div className="error-message">
                      <p>{profileMsg.text}</p>
                    </div>
                  )
                )}
              </>
            )}

            {!allDisks && !sourceVhdPath && (
              <div className="disk-list">
                {disks.map((disk) => (
                  <div
                    key={disk.index}
                    className={`disk-card ${selectedDisk?.index === disk.index ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedDisk(disk);
                      setSelectedPartitions([]);
                    }}
                  >
                    <h3>{disk.model}</h3>
                    <p>Size: {formatSize(disk.size)}</p>
                    <p>Partitions: {disk.partitions.length}</p>
                    <button
                      className="btn-primary btn-small disk-image-all"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedDisk(disk);
                        setSelectedPartitions(disk.partitions.map((p) => p.partitionIndex));
                        setCurrentStep('select_destination');
                      }}
                    >
                      Image this entire disk
                    </button>
                  </div>
                ))}
              </div>
            )}
            
{selectedDisk && !sourceVhdPath && (
              <div className="partition-selection">
                <h3>Select Partitions to Backup</h3>
                <div className="partition-list">
                  {selectedDisk.partitions.map((partition) => (
                    <label key={partition.partitionIndex} className="partition-item">
                      <input
                        type="checkbox"
                        checked={selectedPartitions.includes(partition.partitionIndex)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedPartitions([...selectedPartitions, partition.partitionIndex]);
                          } else {
                            setSelectedPartitions(
                              selectedPartitions.filter((p) => p !== partition.partitionIndex)
                            );
                          }
                        }}
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

            <div className="wizard-actions">
              <button className="btn-secondary" onClick={onComplete}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!allDisks && !sourceVhdPath && (!selectedDisk || selectedPartitions.length === 0)}
                onClick={() => setCurrentStep('select_destination')}
              >
                Next
              </button>
            </div>
          </div>
        );
        
      case 'select_destination':
        return (
          <div className="wizard-step">
            <h2>Select Destination</h2>
            
            <div className="destination-selector">
              <div className="current-path">
                <label>Destination:</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={destinationPath}
                    onChange={(e) => handleDestinationChange(e.target.value)}
                    readOnly={!!repoDir}
                    placeholder="Local folder, s3://bucket/prefix or sftp://user@host/path"
                  />
                  <button onClick={handleSelectDestination} disabled={!!repoDir}>
                    Browse
                  </button>
                </div>
                <div className="net-browse-row">
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => setNetworkOpen((v) => !v)}
                  >
                    {networkOpen ? 'Hide network shares' : 'Browse network…'}
                  </button>
                </div>
                {networkOpen && (
                  <NetworkPicker
                    onPick={(unc) => {
                      const dest = unc.endsWith('\\') ? `${unc}opbs` : `${unc}\\opbs`;
                      setDestinationPath(dest);
                      void resolveNewestBase(dest);
                    }}
                  />
                )}
                <p className="field-hint">
                  Use <code>s3://bucket/prefix</code> or <code>sftp://[user[:pass]@]host[:port]/path</code> to
                  upload the finished image with the cloud credentials configured in Settings.
                </p>
              </div>

              <div className="current-path">
                <label>Image name:</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={imageName}
                    onChange={(e) => setImageName(e.target.value)}
                    placeholder="Leave blank for opbs-diskN-<date>.opbs"
                  />
                </div>
                <p className="field-hint">
                  Base name for the image file. <code>.opbs</code> is appended automatically; multi-volume
                  images add <code>.001</code>, <code>.002</code>, … suffixes.
                </p>
              </div>

              <div className="current-path">
                <label>Immutable repository:</label>
                {repoDir ? (
                  <div className="path-input">
                    <input type="text" readOnly value={repoDir} />
                    <button onClick={clearRepository}>Clear</button>
                  </div>
                ) : (
                  <div className="net-browse-row">
                    <button className="btn-secondary" onClick={() => void handleSelectRepository()}>
                      Use a repository…
                    </button>
                    <input
                      type="text"
                      placeholder="s3://bucket/prefix"
                      value={s3RepoUri}
                      onChange={(e) => setS3RepoUri(e.target.value)}
                      style={{ flex: 1, minWidth: 180 }}
                    />
                    <button
                      className="btn-secondary"
                      disabled={!s3RepoUri.trim()}
                      onClick={() => void openS3Repository()}
                    >
                      Open S3 repo
                    </button>
                  </div>
                )}
                {repoError && <p className="error-message">{repoError}</p>}
                {repoDir ? (
                  <>
                    <div className="setting-item" style={{ marginTop: 6 }}>
                      <label>Lock (days):</label>
                      <input
                        type="number"
                        min={0}
                        value={repoLockDays}
                        onChange={(e) => setRepoLockDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        style={{ width: 90 }}
                      />
                    </div>
                    <p className="field-hint">
                      {/^s3:\/\//i.test(repoDir) ? (
                        <>
                          The image is uploaded to <code>{repoDir}/images</code> in S3 and journaled as immutable
                          for {repoLockDays} day(s). Track it in the Repositories view.
                        </>
                      ) : (
                        <>
                          The image goes to <code>{repoDir}\images</code>, is write-protected, and is journaled as
                          immutable for {repoLockDays} day(s). Track it in the Repositories view.
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <p className="field-hint">
                    Store backups in an append-only, signed repository — images are write-protected and
                    time-locked, and <code>repo verify</code> detects edits or deletions.
                  </p>
                )}
              </div>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_source')}>
                Back
              </button>
              <button
                className="btn-primary"
                disabled={!destinationPath}
                onClick={() => setCurrentStep('options')}
              >
                Next
              </button>
            </div>
          </div>
        );
        
      case 'options':
        return (
          <div className="wizard-step">
            <h2>Backup Options</h2>
            
            <div className="options-form">
              <div className="option-group">
                <label>Compression Level:</label>
                <select
                  value={compressionLevel}
                  onChange={(e) => setCompressionLevel(parseInt(e.target.value))}
                >
                  <option value={0}>None — fastest, no compression</option>
                  <option value={1}>Fast — ~200 MB/s, light compression</option>
                  <option value={3}>Balanced — ~100 MB/s, good ratio (default)</option>
                  <option value={6}>Best — ~40 MB/s, high compression</option>
                  <option value={9}>Maximum — ~15 MB/s, smallest size</option>
                </select>
                <p className="field-hint">
                  Higher levels produce smaller images but take longer. With native zstd,
                  "Balanced" typically sustains 100+ MB/s on modern hardware.
                </p>
              </div>

              <div className="option-group">
                <label>Compression Method:</label>
                <select
                  value={compressionType}
                  onChange={(e) => setCompressionType(e.target.value as 'deflate' | 'zstd')}
                >
                  <option value="zstd">Zstandard (zstd)</option>
                  <option value="deflate">Deflate (zlib)</option>
                </select>
                <p className="field-hint">
                  Zstandard compresses faster and typically smaller; deflate is the classic fallback.
                </p>
              </div>

              <div className="option-group">
                <label>Compression Threads:</label>
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={compressionThreads}
                  onChange={(e) => setCompressionThreads(Math.max(0, parseInt(e.target.value) || 0))}
                />
                <p className="field-hint">1+ parallelizes compression across worker threads (0 disables).</p>
              </div>
              
              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={verificationEnabled}
                    onChange={(e) => setVerificationEnabled(e.target.checked)}
                  />
                  Verify backup after completion
                </label>
              </div>

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={usedBlocksOnly}
                    onChange={(e) => setUsedBlocksOnly(e.target.checked)}
                  />
                  Only back up used data (skip free space)
                </label>
                <p className="field-hint">
                  Reads the filesystem allocation map (NTFS, FAT32, exFAT) so free space is skipped
                  entirely — a mostly-empty 256 GB drive backs up as a few GB instead of the whole disk.
                </p>
              </div>

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={useUsnJournal}
                    onChange={(e) => setUseUsnJournal(e.target.checked)}
                  />
                  USN journal (read only changed blocks for incrementals)
                </label>
                <p className="field-hint">
                  Asks NTFS which files changed since the last backup and reads only their blocks.
                  When the journal is unavailable or uncertain the backup silently reads everything,
                  so this is always safe — just faster when it works.
                </p>
              </div>

              {useUsnJournal && (
                <div className="option-group">
                  <label>USN full-scan threshold (%):</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="No limit"
                    value={usnThresholdPct}
                    onChange={(e) => setUsnThresholdPct(e.target.value)}
                  />
                  <p className="field-hint">
                    When the journal flags more than this share of a partition as changed, read every
                    block instead (0-100; blank = never fall back).
                  </p>
                </div>
              )}

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={incrementalEnabled}
                    onChange={(e) => setIncrementalEnabled(e.target.checked)}
                  />
                  Incremental backup (only changed blocks)
                </label>
                {incrementalEnabled && (
                  <p className="field-hint">
                    {baseImageName
                      ? `Base: ${baseImageName}`
                      : 'No existing image found - this will run as a full backup.'}
                  </p>
                )}
              </div>

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={resumeEnabled}
                    onChange={(e) => setResumeEnabled(e.target.checked)}
                  />
                  Resume an interrupted backup if one exists
                </label>
                <p className="field-hint">
                  If a previous backup to this destination was interrupted, its completed
                  partitions are kept and the run continues from where it stopped instead of
                  starting over. Only works for local destinations.
                </p>
              </div>

              <div className="option-group">
                <label>Encryption Passphrase:</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Leave empty for no encryption"
                />
                <p className="field-hint">
                  AES-256-GCM per-block. The passphrase is required to verify or restore this backup.
                </p>
              </div>

              <div className="option-group">
                <label>Save as profile:</label>
                <div className="profile-save-row">
                  <input
                    type="text"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="Profile name, e.g. Weekly workstation"
                  />
                  <button className="btn-secondary btn-small" onClick={() => void saveAsProfile()}>
                    Save as profile
                  </button>
                </div>
                <p className="field-hint">Reuse this configuration later from the first step.</p>
              </div>
            </div>
            
            <div className="summary">
              <h3>Backup Summary</h3>
              <ul>
                {sourceVhdPath ? (
                  <>
                    <li>Source: Virtual disk file</li>
                    <li>File: {sourceVhdPath}</li>
                    <li>Partitions: All (resolved when the file is attached)</li>
                  </>
                ) : allDisks ? (
                  <>
                    <li>Source: Entire system ({eligibleDisks.length} disks)</li>
                    <li>Disks: {eligibleDisks.map((d) => d.model).join(' | ') || 'none found'}</li>
                  </>
                ) : (
                  <>
                    <li>Source Disk: {selectedDisk?.model}</li>
                    <li>Partitions: {selectedPartitions.length}</li>
                  </>
                )}
                <li>Destination: {destinationPath}</li>
                <li>Compression: Level {compressionLevel} ({compressionType}{compressionThreads > 1 ? `, ${compressionThreads} threads` : ''})</li>
                <li>Verification: {verificationEnabled ? 'Enabled' : 'Disabled'}</li>
                <li>Used data only: {usedBlocksOnly ? 'Enabled (skips free space)' : 'Disabled (whole partition)'}</li>
                <li>
                  USN journal:{' '}
                  {useUsnJournal
                    ? parseUsnPct(usnThresholdPct) !== undefined
                      ? `Enabled (full scan above ${Math.round(parseUsnPct(usnThresholdPct)! * 100)}%)`
                      : 'Enabled (no fallback limit)'
                    : 'Disabled (incrementals read everything)'}
                </li>
                <li>Incremental: {incrementalEnabled && baseImagePath ? 'Enabled' : 'Full backup'}</li>
                <li>Resume: {resumeEnabled ? 'Enabled (continues interrupted backups)' : 'Disabled'}</li>
                <li>Encryption: {passphrase.trim() ? 'AES-256-GCM' : 'None'}</li>
              </ul>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_destination')}>
                Back
              </button>
              <button className="btn-primary" onClick={handleStartBackup}>
                Start Backup
              </button>
            </div>
          </div>
        );
        
      case 'progress':
        if (errorMsg) {
          return (
            <div className="wizard-step">
              <h2>Backup Failed</h2>
              <div className="error-message">
                <p>{errorMsg}</p>
              </div>
              <p className="field-hint">
                The backup did not start. See the Logs page for details, then check that
                the destination folder exists and is writable.
              </p>
              <div className="wizard-actions">
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setErrorMsg(null);
                    setCurrentStep('select_source');
                  }}
                >
                  Back to source
                </button>
              </div>
            </div>
          );
        }
        return (
          <div className="wizard-step">
            <h2>
              {progress?.phase === 'completed'
                ? 'Backup Complete'
                : progress?.phase === 'error'
                  ? 'Backup Failed'
                  : 'Backup in Progress'}
            </h2>
            
            <div className="progress-container">
              {diskLabel && <p className="progress-disk-label">{diskLabel}</p>}
              {progress?.resuming && (
                <p className="progress-resume-note">
                  Resuming from an interrupted backup — previously completed partitions are
                  being kept.
                </p>
              )}
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progress?.percentComplete || 0}%` }}
                />
              </div>
              
              <div className="progress-info">
                <p>Phase: {phaseLabel(progress?.phase)}</p>
                <p>Progress: {Math.round((progress?.percentComplete || 0) * 10) / 10}%</p>
                {progress?.phase === 'verifying' && progress?.verifyTotal ? (
                  <p>
                    Verifying image… {progress.verifyDone?.toLocaleString()} /{' '}
                    {progress.verifyTotal.toLocaleString()} blocks
                  </p>
                ) : (
                  progress?.currentPartition && (
                    <p>Current Partition: {progress.currentPartition}</p>
                  )
                )}
                {progress?.estimatedTimeRemaining > 0 && progress?.estimatedTimeRemaining < Infinity && (
                  <p>ETA: {formatDuration(progress.estimatedTimeRemaining)}</p>
                )}
                {progress?.speed > 0 && (
                  <p>Speed: {formatSpeed(progress.speed)}</p>
                )}
              </div>
            </div>
            
            <div className="wizard-actions">
              {progress?.phase === 'completed' ? (
                progress.imagePath && onViewImage ? (
                  <button className="btn-primary" onClick={() => onViewImage(progress.imagePath!)}>
                    View image
                  </button>
                ) : (
                  <button className="btn-primary" onClick={() => setCurrentStep('complete')}>
                    Continue
                  </button>
                )
              ) : (
                <button className="btn-danger" onClick={() => window.electronAPI.cancelBackup()}>
                  Cancel Backup
                </button>
              )}
            </div>
          </div>
        );
        
      case 'complete':
        return (
          <div className="wizard-step">
            <h2>Backup Complete</h2>
            
            <div className="success-message">
              <p>Your backup has been created successfully!</p>
              {repoNote && <p>✓ {repoNote}</p>}
            </div>
            {repoWarn && <div className="error-message">{repoWarn}</div>}
            
            <div className="wizard-actions">
              {progress?.imagePath && onViewImage && (
                <button
                  className="btn-secondary"
                  onClick={() => onViewImage(progress.imagePath!)}
                >
                  View image
                </button>
              )}
              <button className="btn-primary" onClick={onComplete}>
                Done
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="backup-wizard">
      <div className="wizard-header">
        <h1>Create New Backup</h1>
        <div className="step-indicator">
          <span className={`step ${currentStep === 'select_source' ? 'active' : ''}`}>1</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'select_destination' ? 'active' : ''}`}>2</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'options' ? 'active' : ''}`}>3</span>
        </div>
      </div>
      
      {renderStep()}
    </div>
  );
}

interface NetworkShare {
  unc: string;
  name: string;
  kind: 'share' | 'admin';
  reachable: boolean;
  writable: boolean;
  remark?: string;
}

interface NetworkPickerProps {
  onPick: (unc: string) => void;
}

function NetworkPicker({ onPick }: NetworkPickerProps) {
  const [machines, setMachines] = useState<{ name: string; addresses: string[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [openHost, setOpenHost] = useState<string | null>(null);
  const [sharesByHost, setSharesByHost] = useState<Map<string, NetworkShare[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.electronAPI
      .networkDiscover()
      .then((res) => {
        if (alive) setMachines(res.machines ?? []);
      })
      .catch((e: any) => {
        if (alive) setError(e?.message ?? 'Discovery failed');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleHost = async (host: string) => {
    if (openHost === host) {
      setOpenHost(null);
      return;
    }
    setOpenHost(host);
    if (sharesByHost.has(host)) return;
    try {
      const res = await window.electronAPI.networkShares(host);
      setSharesByHost((m) => {
        const next = new Map(m);
        next.set(host, res.shares ?? []);
        return next;
      });
    } catch {
      // ignore
    }
  };

  return (
    <div className="network-picker">
      {loading && <div className="table-empty">Scanning the network…</div>}
      {error && (
        <div className="error-message">
          <p>{error}</p>
        </div>
      )}
      {!loading && machines.length === 0 && (
        <div className="table-empty">
          No machines found. Enter a UNC path or <code>smb://host/share</code> above instead.
        </div>
      )}
      {machines.map((m) => (
        <div key={m.name} className="net-machine">
          <button className="net-machine-head" onClick={() => void toggleHost(m.name)}>
            <span className="net-machine-name">{m.name}</span>
            <span className="net-caret">{openHost === m.name ? '▾' : '▸'}</span>
          </button>
          {openHost === m.name && (
            <div className="net-shares">
              {(sharesByHost.get(m.name) ?? []).map((s) => (
                <div key={s.unc} className="net-share">
                  <code className="net-share-unc">{s.unc}</code>
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => onPick(s.unc)}
                    disabled={!s.reachable && !s.writable}
                  >
                    Use
                  </button>
                </div>
              ))}
              {!(sharesByHost.get(m.name) ?? []).length && (
                <div className="table-empty">No shares.</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default BackupWizard;
