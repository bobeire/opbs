import { useState, useEffect } from 'react';

interface RestoreWizardProps {
  onComplete: () => void;
  initialImagePath?: string;
  mode?: 'restore' | 'clone';
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
  writeTableScheme?: string | null;
  warnings?: string[];
  sameDisk?: boolean;
  encrypted?: boolean;
  passphraseRequired?: boolean;
  targetIsSystemDisk?: boolean;
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

function RestoreWizard({ onComplete, initialImagePath, mode = 'restore' }: RestoreWizardProps) {
  const isClone = mode === 'clone';
  const [currentStep, setCurrentStep] = useState<WizardStep>('select_image');
  const [imagePath, setImagePath] = useState(initialImagePath ?? '');
  const [imageInfo, setImageInfo] = useState<any>(null);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [disksLoading, setDisksLoading] = useState(true);
  const [targetDiskIndex, setTargetDiskIndex] = useState<number | null>(null);
  const [targetPartitions, setTargetPartitions] = useState<number[]>([]);
  const [applyDeltas, setApplyDeltas] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [progress, setProgress] = useState<any>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResultSummary | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    const cleanup = window.electronAPI.onRestoreProgress((p) => {
      setProgress(p);
    });
    return cleanup;
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
      .then((info) => setImageInfo(info))
      .catch(() => setImageInfo(null));
  }, [imagePath]);

  // Dry-run the restore whenever the target selection changes so the user sees
  // the data-loss warning and passphrase requirement BEFORE anything starts.
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (imagePath && targetDiskIndex !== null && targetPartitions.length > 0) {
        setPreflightLoading(true);
        setAcknowledge(false);
        window.electronAPI
          .restorePreflight({
            imagePath,
            targetDiskIndex,
            targetPartitions,
            applyDeltas
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
  }, [imagePath, targetDiskIndex, targetPartitions.join(','), applyDeltas]);

  const handleSelectImage = async () => {
    const path = await window.electronAPI.selectFile({
      filters: [
        { name: 'OPBS Images', extensions: ['opbs'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (path) {
      setImagePath(path);
    }
  };

  const handleStartRestore = async () => {
    setCurrentStep('progress');
    setRestoreResult(null);
    setRestoreError(null);

    try {
      const result = (await window.electronAPI.startRestore({
        imagePath,
        targetDiskIndex: targetDiskIndex!,
        targetPartitions,
        verifyBeforeWrite: true,
        applyDeltas,
        ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {})
      })) as RestoreResultSummary | undefined;
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
      (preflight.targetDiskPartitionCount ?? 0) > 0);

  const canStart =
    !!preflight &&
    preflight.ok &&
    !!targetDiskIndex &&
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
            <h2>Select Target Disk</h2>
            
            <div className="target-disk-selector">
              <p className="warning-text">
                Warning: This will overwrite all data on the target disk!
              </p>
              
              {disksLoading ? (
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
              )}
              
              {targetDiskIndex !== null && (
                <div className="partition-selection">
                  <h3>Select Partitions to Restore</h3>
                  <div className="partition-list">
                    {imageInfo?.partitions.map((partition: any) => (
                      <label key={partition.index} className="partition-item">
                        <input
                          type="checkbox"
                          checked={targetPartitions.includes(partition.index)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setTargetPartitions([...targetPartitions, partition.index]);
                            } else {
                              setTargetPartitions(
                                targetPartitions.filter((p) => p !== partition.index)
                              );
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
                    ))}
                  </div>
                </div>
              )}

              {targetDiskIndex !== null && targetPartitions.length > 0 && (
                <div className="preflight-panel">
                  {preflightLoading ? (
                    <p className="field-hint">Checking target disk…</p>
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
                          <strong>{preflight.targetDiskModel ?? `Disk ${targetDiskIndex}`}</strong>
                        </div>
                      </div>
                      {(preflight.targetDiskPartitionCount ?? 0) > 0 && (
                        <div className="error-message">
                          <p>
                            Target disk already has {preflight.targetDiskPartitionCount} partition(s).
                            Restoring overwrites the existing data in place.
                          </p>
                        </div>
                      )}
                      {preflight.writeTableScheme && (
                        <div className="error-message">
                          <p>This restore writes a fresh {preflight.writeTableScheme.toUpperCase()} partition table, erasing the target disk's current layout.</p>
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
                      {preflight.warnings.map((w, i) => (
                        w.includes('matches the source disk') ? (
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
                disabled={targetDiskIndex === null || targetPartitions.length === 0 || (!!preflight && !preflight.ok) || preflightLoading}
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
                  Yes, I understand the target disk will be permanently overwritten and existing data will be lost.
                </label>
              </div>
            )}

            <div className="summary">
              <h3>{isClone ? 'Clone Summary' : 'Restore Summary'}</h3>
              <ul>
                <li>Source Image: {imagePath}</li>
                <li>Target Disk: {preflight?.targetDiskModel ?? `Disk ${targetDiskIndex}`} ({formatSize(preflight?.targetDiskBytes ?? 0)})</li>
                <li>Partitions to Restore: {targetPartitions.length}</li>
                <li>Required Space: {formatSize(preflight?.requiredBytes ?? 0)}</li>
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
                <p>Phase: {progress?.phase || 'Preparing...'}</p>
                <p>Progress: {Math.round((progress?.percentComplete || 0) * 10) / 10}%</p>
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
