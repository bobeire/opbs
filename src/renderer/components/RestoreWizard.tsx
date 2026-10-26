import { useState, useEffect, useRef, useCallback } from 'react';

/** VHD/VHDX target state shared by the target step, preflight and start. */
function virtualDiskFormatFromPath(p: string): 'vhd' | 'vhdx' {
  return /\.vhdx$/i.test(p) ? 'vhdx' : 'vhd';
}

interface RestoreWizardProps {
  onComplete: () => void;
  initialImagePath?: string;
  mode?: 'restore' | 'clone';
}

/** Payload of the 'cloud-download-progress' event. */
interface CloudDownloadProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  fileBytesDone: number;
  fileBytesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

interface DiskInfo {
  index: number;
  model: string;
  size: number;
  partitions: Array<{
    diskIndex: number;
    partitionIndex: number;
    driveLetter: string | null;
    label: string;
    fsType: string;
    size: number;
    usedSpace: number;
    isSystem: boolean;
    isBoot: boolean;
  }>;
}

interface PreflightResult {
  ok: boolean;
  error?: string;
  requiredBytes?: number;
  targetDiskBytes?: number;
  targetDiskModel?: string;
  targetDiskPartitionCount?: number;
  targets?: Array<{ partitionIndex: number; offset: number; size: number }>;
  shrinkInfo?: Array<{
    partitionIndex: number;
    currentBytes: number;
    targetBytes: number;
    minTargetBytes: number;
    minTargetClusters: number;
    usedClusters: number;
    clusterSize: number;
  }>;
  writeTableScheme?: string | null;
  warnings?: string[];
  sameDisk?: boolean;
  encrypted?: boolean;
  passphraseRequired?: boolean;
  unlockRequired?: boolean;
  lockedLetter?: string;
  targetIsSystemDisk?: boolean;
  targetsIncludeSystemVolume?: boolean;
  targetFileExists?: boolean;
}

interface RestoreResultSummary {
  targetsRestored?: number;
  bytesWritten?: number;
  durationMs?: number;
  warnings?: string[];
  freeBlocksCleared?: number;
  drill?: { ok: boolean; failures?: string[] };
}

type WizardStep = 'select_image' | 'select_target' | 'options' | 'progress' | 'complete' | 'error';

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
    case 'reading_image':
      return 'Reading image';
    case 'restoring':
      return 'Writing to target';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Failed';
    default:
      return 'Preparing';
  }
}

function RestoreWizard({ onComplete, initialImagePath, mode = 'restore' }: RestoreWizardProps) {
  const isClone = mode === 'clone';
  const [currentStep, setCurrentStep] = useState<WizardStep>('select_image');
  const [imagePath, setImagePath] = useState(initialImagePath ?? '');
  const [imageInfo, setImageInfo] = useState<any>(null);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [disksLoading, setDisksLoading] = useState(true);
  const [targetDiskIndex, setTargetDiskIndex] = useState<number | null>(null);
  const [targetKind, setTargetKind] = useState<'disk' | 'vhd'>('disk');
  const [vhdPath, setVhdPath] = useState('');
  const [vhdSizeGb, setVhdSizeGb] = useState(16);
  const [vhdType, setVhdType] = useState<'dynamic' | 'fixed'>('dynamic');
  const vhdSizeEdited = useRef(false);
  const [targetPartitions, setTargetPartitions] = useState<number[]>([]);
  // Per-partition target size in GB (string so an empty field means "keep the
  // captured size"). A smaller value shrinks the NTFS filesystem on restore.
  const [partitionSizesGb, setPartitionSizesGb] = useState<Record<number, string>>({});
  const [applyDeltas, setApplyDeltas] = useState(true);
  const [clearFreeSpace, setClearFreeSpace] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  // BitLocker unlock box (shown when preflight reports the image's volume is
  // locked). Bumping the nonce re-runs the preflight after a successful unlock.
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null);
  const [preflightNonce, setPreflightNonce] = useState(0);
  const [progress, setProgress] = useState<any>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResultSummary | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Cloud fetch: the URI downloads into an opbs-restore-* temp dir and the
  // staged local path feeds the normal flow. A ref (not state) holds the
  // staged path so the unmount cleanup always sees the current value.
  const [cloudUri, setCloudUri] = useState('');
  const [cloudFetching, setCloudFetching] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudProgress, setCloudProgress] = useState<CloudDownloadProgress | null>(null);
  const [stagedFrom, setStagedFrom] = useState<string | null>(null);
  const stagedRef = useRef<string | null>(null);

  const releaseStaged = () => {
    const staged = stagedRef.current;
    if (staged) {
      stagedRef.current = null;
      setStagedFrom(null);
      void window.electronAPI.releaseStagedImage(staged).catch(() => {});
    }
  };

  useEffect(() => {
    const cleanup = window.electronAPI.onRestoreProgress((p) => {
      setProgress(p);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onCloudDownloadProgress((p) => setCloudProgress(p));
    return cleanup;
  }, []);

  // Leaving the wizard drops any staged temp copy (restore completion and
  // image replacement release earlier; this is the safety net).
  useEffect(() => {
    return () => {
      const staged = stagedRef.current;
      if (staged) void window.electronAPI.releaseStagedImage(staged).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let alive = true;
    window.electronAPI
      .getDisks()
      .then((list) => {
        if (alive) setDisks(list ?? []);
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

  useEffect(() => {
    if (!imagePath) return;
    window.electronAPI
      .getImageInfo(imagePath)
      .then((info) => {
        setImageInfo(info);
        // Offer a virtual disk big enough for the whole image until the user
        // types their own size.
        if (!vhdSizeEdited.current && Array.isArray(info?.partitions)) {
          let end = 0;
          for (const p of info.partitions) {
            end = Math.max(end, (p.offsetOnDisk ?? 0) + p.size);
          }
          const bytes = Math.ceil((end + 1048576) / 1048576) * 1048576;
          setVhdSizeGb(Math.max(1, Math.ceil(bytes / 1073741824)));
        }
      })
      .catch(() => setImageInfo(null));
  }, [imagePath]);

  // Per-partition target sizes (GB) become a targetLayout override: an entry
  // is emitted only for a partition whose size field was actually filled in.
  // Offsets come from the image's captured on-disk offsets so only the size
  // deviates. Returns undefined when no size was customized (no override).
  const buildTargetLayout = useCallback(
    (): Array<{ partitionIndex: number; offset: number; size?: number }> | undefined => {
      const layout: Array<{ partitionIndex: number; offset: number; size?: number }> = [];
      for (const p of imageInfo?.partitions ?? []) {
        if (!targetPartitions.includes(p.index)) continue;
        const gb = partitionSizesGb[p.index];
        if (gb === undefined || gb.trim() === '') continue;
        const bytes = Math.round(Number(gb) * 1024 ** 3);
        if (!Number.isFinite(bytes) || bytes <= 0) continue;
        layout.push({ partitionIndex: p.index, offset: p.offsetOnDisk ?? 0, size: bytes });
      }
      return layout.length > 0 ? layout : undefined;
    },
    [imageInfo, targetPartitions, partitionSizesGb]
  );

  // Dry-run the restore whenever the target selection changes so the user sees
  // the data-loss warning and passphrase requirement BEFORE anything starts.
  useEffect(() => {
    let alive = true;
    const run = () => {
      const ready = targetKind === 'disk' ? targetDiskIndex !== null : vhdPath.trim() !== '';
      if (imagePath && ready && targetPartitions.length > 0) {
        setPreflightLoading(true);
        setAcknowledge(false);
        setUnlockNotice(null);
        setUnlockError(null);
        const targetLayout = buildTargetLayout();
        window.electronAPI
          .restorePreflight({
            imagePath,
            targetPartitions,
            applyDeltas,
            // A customized per-partition size resizes the filesystem (grow or
            // shrink) and moves the partition table, so the layout must be
            // acknowledged — the wizard surfaces that as the destructive ack.
            ...(targetLayout ? { targetLayout, acknowledgeLayout: true } : {}),
            ...(targetKind === 'vhd'
              ? {
                  targetVirtualDisk: {
                    path: vhdPath.trim(),
                    virtualSize: Math.round(vhdSizeGb * 1024 ** 3),
                    format: virtualDiskFormatFromPath(vhdPath.trim()),
                    type: vhdType
                  }
                }
              : { targetDiskIndex })
          })
          .then((res) => {
            if (alive) setPreflight(res);
          })
          .catch((e: any) => {
            if (alive) setPreflight({ ok: false, error: e?.message ?? 'Preflight failed' });
          })
          .finally(() => {
            if (alive) setPreflightLoading(false);
          });
      } else {
        setPreflight(null);
      }
    };
    Promise.resolve().then(() => {
      if (alive) run();
    });
    return () => {
      alive = false;
    };
  }, [
    imagePath,
    targetDiskIndex,
    targetPartitions,
    buildTargetLayout,
    applyDeltas,
    preflightNonce,
    targetKind,
    vhdPath,
    vhdSizeGb,
    vhdType
  ]);

  // Unlock the image's BitLocker-locked volume with a recovery password, then
  // re-run the preflight inside the same step (one UAC prompt on Windows).
  const handleUnlockVolume = async () => {
    const letter = preflight?.lockedLetter;
    if (!letter || !unlockPassword.trim()) return;
    setUnlockBusy(true);
    setUnlockError(null);
    try {
      const result = await window.electronAPI.bitlockerUnlock(letter, unlockPassword.trim());
      if (result.ok) {
        setUnlockPassword('');
        setUnlockNotice(`Volume ${letter}: unlocked. Re-checking the restore…`);
        setPreflightNonce((n) => n + 1);
      } else {
        setUnlockError(result.error);
      }
    } catch (e) {
      setUnlockError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlockBusy(false);
    }
  };

  const handleFetchCloud = async () => {
    const uri = cloudUri.trim();
    if (!uri || cloudFetching) return;
    setCloudFetching(true);
    setCloudError(null);
    setCloudProgress(null);
    releaseStaged();
    try {
      const result = await window.electronAPI.fetchCloudImage(uri);
      if (result?.ok && result.imagePath) {
        stagedRef.current = result.imagePath;
        setStagedFrom(uri);
        setImagePath(result.imagePath);
        setCloudProgress(null);
      } else {
        setCloudError(result?.error ?? 'Download failed');
      }
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : String(error));
    } finally {
      setCloudFetching(false);
    }
  };

  const handleSelectImage = async () => {
    const path = await window.electronAPI.selectFile({
      filters: [
        { name: 'All supported backup images', extensions: ['opbs', 'mrimgx', 'mrimg'] },
        { name: 'Backup Images', extensions: ['opbs'] },
        { name: 'Macrium Reflect Images', extensions: ['mrimgx', 'mrimg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (path) {
      releaseStaged();
      setImagePath(path);
    }
  };

  const handleSelectVhd = async () => {
    const p = await window.electronAPI.selectSaveFile({
      name: vhdPath || 'restore-target.vhdx',
      filters: [{ name: 'Virtual disks', extensions: ['vhdx', 'vhd'] }]
    });
    if (p) setVhdPath(p);
  };

  const targetReady = targetKind === 'disk' ? targetDiskIndex !== null : vhdPath.trim() !== '';

  const handleStartRestore = async () => {
    setCurrentStep('progress');
    setRestoreResult(null);
    setRestoreError(null);

    try {
      const targetLayout = buildTargetLayout();
      const result = (await window.electronAPI.startRestore({
        imagePath,
        targetPartitions,
        verifyBeforeWrite: true,
        applyDeltas,
        clearFreeSpace,
        ...(targetLayout ? { targetLayout, acknowledgeLayout: true } : {}),
        ...(targetKind === 'vhd'
          ? {
              targetVirtualDisk: {
                path: vhdPath.trim(),
                virtualSize: Math.round(vhdSizeGb * 1024 ** 3),
                format: virtualDiskFormatFromPath(vhdPath.trim()),
                type: vhdType
              }
            }
          : { targetDiskIndex: targetDiskIndex! }),
        ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {})
      })) as RestoreResultSummary | undefined;
      if (stagedRef.current) {
        // Restore finished — the staged temp copy has served its purpose.
        releaseStaged();
        setImagePath('');
        setImageInfo(null);
      }
      setRestoreResult(result ?? null);
      setCurrentStep('complete');
    } catch (error) {
      console.error('Restore failed:', error);
      setRestoreError(error instanceof Error ? error.message : String(error));
      setCurrentStep('error');
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

  const destructiveAckNeeded =
    !!preflight && preflight.ok &&
    (!!preflight.writeTableScheme || !!preflight.sameDisk ||
      !!preflight.targetFileExists ||
      (preflight.targetDiskPartitionCount ?? 0) > 0);

  // Hard stop: restoring into the live system/boot/SystemDrive volume is
  // impossible from inside the OS. Those volumes must be dismounted before we
  // raw-write them, and the ones Windows is running from can't be (AUTOCHK/
  // Explorer hold them) — the write fails with ERROR_ACCESS_DENIED, often
  // after partially touching the disk. Matched per-target (by offset), so
  // restoring a data partition that shares the system disk stays allowed.
  // Direct the user to bootable recovery media instead.
  const systemDiskBlocked = targetKind === 'disk' && !!preflight?.targetsIncludeSystemVolume;

  const canStart =
    !!preflight &&
    preflight.ok &&
    targetReady &&
    !systemDiskBlocked &&
    !(imageInfo?.encrypted && !passphrase.trim()) &&
    (!destructiveAckNeeded || acknowledge);

  const renderStep = () => {
    switch (currentStep) {
      case 'select_image':
        return (
          <div className="wizard-step">
            <h2>Select Backup Image</h2>
            
            <div className="image-selector">
              <div className="current-path">
                <label>Backup Image File:</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={imagePath}
                    readOnly
                    placeholder="Select an image file..."
                  />
                  <button onClick={handleSelectImage}>Browse</button>
                </div>
              </div>

              <div className="current-path">
                <label>Fetch from cloud (s3://, sftp://, ftp://)</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={cloudUri}
                    onChange={(e) => setCloudUri(e.target.value)}
                    placeholder="s3://bucket/prefix/image.opbs"
                    disabled={cloudFetching}
                  />
                  <button onClick={handleFetchCloud} disabled={cloudFetching || !cloudUri.trim()}>
                    {cloudFetching ? 'Fetching…' : 'Fetch'}
                  </button>
                </div>
              </div>
              {cloudError && <p className="warning-text">{cloudError}</p>}
              {cloudFetching && cloudProgress && (
                <p>
                  Downloading {cloudProgress.file} ({cloudProgress.fileIndex}/{cloudProgress.fileCount}) —{' '}
                  {cloudProgress.bytesTotal > 0 ? Math.round((cloudProgress.bytesDone / cloudProgress.bytesTotal) * 100) : 0}%
                  {' ('}
                  {formatSize(cloudProgress.bytesDone)} of {formatSize(cloudProgress.bytesTotal)})
                </p>
              )}
              {stagedFrom && !cloudFetching && (
                <p>
                  Staged {stagedFrom} — the temporary copy is removed after the restore finishes.
                </p>
              )}
              
              {imageInfo && (
                <div className="image-info">
                  <h3>Image Information</h3>
                  <ul>
                    <li>Total Size: {formatSize(imageInfo.totalSize)}</li>
                    <li>Partitions: {imageInfo.partitions.length}</li>
                    <li>Backup Date: {new Date(imageInfo.backupDate).toLocaleDateString()}</li>
                    <li>
                      Type:{' '}
                      {imageInfo.incremental
                        ? `Incremental ${imageInfo.baseImagePath ? `(base: ${imageInfo.baseImagePath.split(/[\\/]/).pop()})` : ''}`
                        : 'Full'}
                    </li>
                    <li>Encryption: {imageInfo.encrypted ? 'AES-256-GCM' : 'None'}</li>
                  </ul>
                </div>
              )}
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={onComplete}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!imagePath || !imageInfo}
                onClick={() => setCurrentStep('select_target')}
              >
                Next
              </button>
            </div>
          </div>
        );
        
      case 'select_target':
        return (
          <div className="wizard-step">
            <h2>{targetKind === 'vhd' ? 'Select Target Virtual Disk' : 'Select Target Disk'}</h2>

            <div className="target-disk-selector">
              {!isClone && (
                <div className="target-kind-toggle">
                  <label className={`target-kind-option ${targetKind === 'disk' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="target-kind"
                      checked={targetKind === 'disk'}
                      onChange={() => setTargetKind('disk')}
                    />
                    Physical disk
                  </label>
                  <label className={`target-kind-option ${targetKind === 'vhd' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="target-kind"
                      checked={targetKind === 'vhd'}
                      onChange={() => setTargetKind('vhd')}
                    />
                    Virtual disk (VHD / VHDX)
                  </label>
                </div>
              )}
              <p className="warning-text">
                {targetKind === 'vhd'
                  ? 'Warning: The restore writes into the virtual disk file, overwriting its contents!'
                  : 'Warning: Restoring overwrites the selected partitions on the target disk with the image contents!'}
              </p>

              {targetKind === 'disk' &&
                (disksLoading ? (
                  <div className="loading">Loading disks...</div>
                ) : (
                  <div className="disk-list">
                    {disks.map((disk) => (
                      <div
                        key={disk.index}
                        className={`disk-card ${targetDiskIndex === disk.index ? 'selected' : ''}`}
                        onClick={() => {
                          setTargetDiskIndex(disk.index);
                          setTargetPartitions([]);
                          setAcknowledge(false);
                        }}
                      >
                        <h3>{disk.model}</h3>
                        <p>Size: {formatSize(disk.size)}</p>
                        <p>Partitions: {disk.partitions.length}</p>
                      </div>
                    ))}
                  </div>
                ))}

              {targetKind === 'vhd' && (
                <div className="vhd-target">
                  <div className="current-path">
                    <label>Virtual Disk File (.vhd / .vhdx):</label>
                    <div className="path-input">
                      <input
                        type="text"
                        value={vhdPath}
                        placeholder="D:\VMs\restore-target.vhdx"
                        onChange={(e) => setVhdPath(e.target.value)}
                      />
                      <button onClick={() => void handleSelectVhd()}>Browse</button>
                    </div>
                  </div>
                  <div className="vhd-options">
                    <div className="option-group">
                      <label>Size (GB):</label>
                      <input
                        type="number"
                        min={1}
                        value={vhdSizeGb}
                        onChange={(e) => {
                          vhdSizeEdited.current = true;
                          setVhdSizeGb(Math.max(1, Number(e.target.value) || 1));
                        }}
                      />
                    </div>
                    <div className="option-group">
                      <label>Type:</label>
                      <select
                        value={vhdType}
                        onChange={(e) => setVhdType(e.target.value as 'dynamic' | 'fixed')}
                      >
                        <option value="dynamic">Dynamic (grows as data is written)</option>
                        <option value="fixed">Fixed (pre-allocates the full size)</option>
                      </select>
                    </div>
                  </div>
                  <p className="field-hint">
                    The size is only used when the file has to be created — an existing file's
                    capacity is used as-is. A fresh file gets a new partition table so the restored
                    volumes show up in Windows.
                  </p>
                </div>
              )}

              {targetReady && (
                <div className="partition-selection">
                  <h3>Select Partitions to Restore</h3>
                  <div className="partition-list">
                    {imageInfo?.partitions.map((partition: any) => {
                      const selected = targetPartitions.includes(partition.index);
                      const shrink = preflight?.shrinkInfo?.find(
                        (s) => s.partitionIndex === partition.index
                      );
                      return (
                        <div key={partition.index} className="partition-item">
                          <label className="partition-select">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setTargetPartitions([...targetPartitions, partition.index]);
                                } else {
                                  setTargetPartitions(
                                    targetPartitions.filter((p) => p !== partition.index)
                                  );
                                  // Drop the size override with the selection.
                                  setPartitionSizesGb((prev) => {
                                    const next = { ...prev };
                                    delete next[partition.index];
                                    return next;
                                  });
                                }
                              }}
                            />
                            <span className="partition-info">
                              Partition {partition.index}
                              {' - '}
                              {formatSize(partition.size)}
                              {' ('}
                              {partition.fsType}
                              {')'}
                            </span>
                          </label>
                          {selected && partition.fsType === 'NTFS' && (
                            <span className="partition-size">
                              <input
                                type="number"
                                min={0}
                                step="any"
                                placeholder={formatSize(partition.size)}
                                title="Target size in GB. Leave empty to keep the captured size; a smaller value shrinks the NTFS filesystem."
                                value={partitionSizesGb[partition.index] ?? ''}
                                onChange={(e) =>
                                  setPartitionSizesGb((prev) => ({
                                    ...prev,
                                    [partition.index]: e.target.value
                                  }))
                                }
                              />
                              <span className="field-hint">GB</span>
                              {shrink && (
                                <span className="field-hint">
                                  (min {formatSize(shrink.minTargetBytes)})
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {targetReady && targetPartitions.length > 0 && (
                <div className="preflight-panel">
                  {preflightLoading ? (
                    <p className="field-hint">Checking target disk…</p>
                  ) : preflight && !preflight.ok && preflight.unlockRequired ? (
                    <div className="bitlocker-unlock-box">
                      <div className="error-message">
                        <p>{preflight.error}</p>
                      </div>
                      {unlockNotice && (
                        <div className="warning-box">
                          <p>{unlockNotice}</p>
                        </div>
                      )}
                      <div className="bitlocker-unlock-row">
                        <input
                          type="password"
                          value={unlockPassword}
                          placeholder={`Recovery password for ${preflight.lockedLetter ?? ''}: (48 digits)`}
                          disabled={unlockBusy}
                          onChange={(e) => setUnlockPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleUnlockVolume();
                          }}
                        />
                        <button
                          className="btn-primary"
                          onClick={() => void handleUnlockVolume()}
                          disabled={unlockBusy || !unlockPassword.trim()}
                        >
                          {unlockBusy ? 'Unlocking…' : 'Unlock'}
                        </button>
                      </div>
                      {unlockError && (
                        <div className="error-message">
                          <p>{unlockError}</p>
                        </div>
                      )}
                      <p className="field-hint">
                        Unlocking costs one UAC confirmation on Windows. The password is passed to
                        the elevated helper in its environment only — never written to disk.
                      </p>
                    </div>
                  ) : preflight && !preflight.ok ? (
                    <div className="error-message">
                      <p>Cannot restore: {preflight.error}</p>
                    </div>
                  ) : preflight?.ok ? (
                    <>
                      <div className="preflight-grid">
                        <div>
                          <span>Required</span>
                          <strong>{formatSize(preflight.requiredBytes ?? 0)}</strong>
                        </div>
                        <div>
                          <span>Target capacity</span>
                          <strong>{formatSize(preflight.targetDiskBytes ?? 0)}</strong>
                        </div>
                        <div>
                          <span>Target</span>
                          <strong>
                            {targetKind === 'vhd'
                              ? preflight.targetDiskModel ?? 'Virtual disk'
                              : preflight.targetDiskModel ?? `Disk ${targetDiskIndex}`}
                          </strong>
                        </div>
                      </div>
                      {systemDiskBlocked && (
                        <div className="error-message">
                          <p>
                            <strong>This is the disk Windows is running from.</strong> A restore
                            cannot be performed from inside a live Windows session — the system
                            volume cannot be unlocked for writing, so the restore would fail (and
                            could leave the disk partially written).
                          </p>
                          <p>
                            To restore this disk, build a bootable recovery media under{' '}
                            <strong>Media</strong>, boot from it, and run the restore there.
                          </p>
                        </div>
                      )}
                      {(preflight.targetDiskPartitionCount ?? 0) > 0 && !systemDiskBlocked && (
                        <div className="error-message">
                          <p>
                            Target disk already has {preflight.targetDiskPartitionCount} partition(s).
                            {preflight.writeTableScheme
                              ? ' Restoring overwrites the existing data in place.'
                              : ` This restore writes only the ${preflight.targets?.length ?? 'selected'} selected partition(s) back to their original offsets — the partition table and any partitions you did not select are left untouched.`}
                          </p>
                        </div>
                      )}
                      {preflight.writeTableScheme && (
                        <div className="error-message">
                          <p>This restore writes a fresh {preflight.writeTableScheme.toUpperCase()} partition table, erasing the target disk's current layout.</p>
                        </div>
                      )}
                      {preflight.targetFileExists && (
                        <div className="error-message">
                          <p>A virtual disk file already exists at this path — restoring overwrites its contents.</p>
                        </div>
                      )}
                      {preflight.sameDisk && (
                        <div className="error-message">
                          <p>Target disk matches the disk the image was captured from. Restoring overwrites the source.</p>
                        </div>
                      )}
                      {preflight.passphraseRequired && (
                        <div className="error-message">
                          <p>This image is encrypted. Enter the passphrase to restore it.</p>
                        </div>
                      )}
                      {(preflight.warnings ?? []).map((w, i) => (
                        w.includes('matches the source disk') || w.includes('virtual disk') ? (
                          <div key={i} className="warning-box">
                            <p>{w}</p>
                          </div>
                        ) : null
                      ))}
                    </>
                  ) : null}
                </div>
              )}
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_image')}>
                Back
              </button>
              <button
                className="btn-primary"
                disabled={!targetReady || targetPartitions.length === 0 || (!!preflight && !preflight.ok) || preflightLoading}
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
            <h2>Restore Options</h2>
            
            <div className="options-form">
              {imageInfo?.incremental && (
                <div className="option-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={applyDeltas}
                      onChange={(e) => setApplyDeltas(e.target.checked)}
                    />
                    Include incremental deltas up to this image
                  </label>
                </div>
              )}

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={clearFreeSpace}
                    onChange={(e) => setClearFreeSpace(e.target.checked)}
                  />
                  Clear free space after restore
                </label>
                <p className="option-note">
                  Zeroes every block not in the image so files created after the backup cannot
                  survive (even with recovery tools). This writes the target's whole free space and
                  can take hours on slow drives — uncheck for a much faster restore that skips the
                  cleaning.
                </p>
              </div>

              <div className="option-group">
                <label>Encryption Passphrase:</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={imageInfo?.encrypted ? 'Required for encrypted image' : 'Optional'}
                />
              </div>
            </div>
            
            {destructiveAckNeeded && (
              <div className="acknowledge-box">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                  />
                  Yes, I understand{' '}
                  {targetKind === 'vhd'
                    ? 'the virtual disk file will be overwritten and existing data in it will be lost.'
                    : preflight?.writeTableScheme
                      ? 'the target disk will be permanently overwritten and existing data will be lost.'
                      : 'the selected partitions will be overwritten with the image contents.'}
                </label>
              </div>
            )}

            <div className="summary">
              <h3>{isClone ? 'Clone Summary' : 'Restore Summary'}</h3>
              <ul>
                <li>Source Image: {imagePath}</li>
                <li>
                  {targetKind === 'vhd' ? 'Target Virtual Disk' : 'Target Disk'}:{' '}
                  {targetKind === 'vhd'
                    ? vhdPath
                    : preflight?.targetDiskModel ?? `Disk ${targetDiskIndex}`}{' '}
                  ({formatSize(preflight?.targetDiskBytes ?? 0)})
                </li>
                <li>Partitions to Restore: {targetPartitions.length}</li>
                <li>Required Space: {formatSize(preflight?.requiredBytes ?? 0)}</li>
                <li>Clear free space: {clearFreeSpace ? 'Yes (slower, thorough)' : 'No (fast)'}</li>
              </ul>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_target')}>
                Back
              </button>
              <button className="btn-danger" onClick={handleStartRestore} disabled={!canStart}>
                {isClone ? 'Start Clone' : 'Start Restore'}
              </button>
            </div>
          </div>
        );
        
      case 'progress':
        return (
          <div className="wizard-step">
            <h2>{isClone ? 'Clone in Progress' : 'Restore in Progress'}</h2>
            
            <div className="progress-container">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progress?.percentComplete || 0}%` }}
                />
              </div>
              
              <div className="progress-info">
                <p>Phase: {phaseLabel(progress?.phase)}</p>
                <p>Progress: {Math.round((progress?.percentComplete || 0) * 10) / 10}%</p>
                {progress?.currentPartition && <p>Current: {progress.currentPartition}</p>}
                {(progress?.bytesProcessed ?? 0) > 0 && progress?.totalBytes > 0 && (
                  <p>
                    {formatSize(progress.bytesProcessed)} of {formatSize(progress.totalBytes)}
                  </p>
                )}
                {progress?.speed > 0 && <p>Speed: {formatSpeed(progress.speed)}</p>}
                {progress?.estimatedTimeRemaining > 0 && progress?.estimatedTimeRemaining < Infinity && (
                  <p>ETA: {formatDuration(progress.estimatedTimeRemaining)}</p>
                )}
                {(progress?.phase === 'restoring' || progress?.phase === 'reading_image') && (
                  <p className="progress-resume-note">
                    The target volume is locked and temporarily hidden from Explorer while the write
                    runs — it reappears when the restore finishes. This is normal.
                  </p>
                )}
              </div>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-danger" onClick={() => window.electronAPI.cancelRestore()}>
                Cancel Restore
              </button>
            </div>
          </div>
        );
        
      case 'complete': {
        const needsReboot = !!preflight?.targetIsSystemDisk;
        const warnings = restoreResult?.warnings ?? [];
        const drillFailures = restoreResult?.drill?.ok === false ? (restoreResult.drill.failures ?? []) : [];
        return (
          <div className="wizard-step">
            <h2>{isClone ? 'Clone Complete' : 'Restore Complete'}</h2>

            <div className="success-message">
              <p>
                {isClone
                  ? 'The disk has been cloned successfully from the backup image.'
                  : needsReboot
                    ? 'Your system has been restored successfully!'
                    : 'Restore completed successfully!'}
              </p>
              {needsReboot ? (
                <p>Please restart your computer to complete the process.</p>
              ) : (
                <p>
                  No restart is required for this drive. The restored volumes are ready — open them
                  in File Explorer or Disk Management.
                </p>
              )}
              {typeof restoreResult?.bytesWritten === 'number' && restoreResult.bytesWritten > 0 && (
                <p>
                  Wrote {formatSize(restoreResult.bytesWritten)}
                  {typeof restoreResult.targetsRestored === 'number'
                    ? ` to ${restoreResult.targetsRestored} partition(s)`
                    : ''}
                  {typeof restoreResult.durationMs === 'number'
                    ? ` in ${Math.max(1, Math.round(restoreResult.durationMs / 1000))}s`
                    : ''}
                  .
                </p>
              )}
              {typeof restoreResult?.freeBlocksCleared === 'number' && restoreResult.freeBlocksCleared > 0 && (
                <p>
                  Cleared {restoreResult.freeBlocksCleared} free-space block(s) that were not in the image, so
                  files created after the backup are gone.
                </p>
              )}
              {!needsReboot && (
                <p className="warning-text">
                  If a file still appears in Explorer, eject the drive and plug it back in (or reboot) so
                  Windows drops its cache.
                </p>
              )}
            </div>

            {warnings.length > 0 && (
              <div className="warning-box">
                <h3>Warnings</h3>
                <ul>
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {drillFailures.length > 0 && (
              <div className="error-message">
                <h3>Restore drill reported failures</h3>
                <ul>
                  {drillFailures.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="wizard-actions">
              <button className="btn-primary" onClick={onComplete}>
                Done
              </button>
            </div>
          </div>
        );
      }

      case 'error':
        return (
          <div className="wizard-step">
            <h2>Restore Failed</h2>
            <div className="error-message">
              <p>{restoreError ?? 'The restore did not complete.'}</p>
            </div>
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_target')}>
                Back
              </button>
              <button className="btn-primary" onClick={onComplete}>
                Close
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="restore-wizard">
      <div className="wizard-header">
        <h1>{isClone ? 'Clone Backup' : 'Restore Backup'}</h1>
        <div className="step-indicator">
          <span className={`step ${currentStep === 'select_image' ? 'active' : ''}`}>1</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'select_target' ? 'active' : ''}`}>2</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'options' ? 'active' : ''}`}>3</span>
        </div>
      </div>
      
      {renderStep()}
    </div>
  );
}

export default RestoreWizard;
