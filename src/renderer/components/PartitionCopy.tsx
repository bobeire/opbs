import { useEffect, useMemo, useRef, useState } from 'react';
import { planTargetLayout } from '../../main/utils/clone-layout';

interface DragSource {
  diskIndex: number;
  partitionIndex: number;
}

interface PlacedDrop {
  partitionIndex: number;
}

interface ProgressInfo {
  phase: string;
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  currentPartition: string;
}

function PartitionCopy({ onComplete }: { onComplete: () => void }) {
  const [disks, setDisks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [targetDiskIndex, setTargetDiskIndex] = useState<number | null>(null);
  const [sourceDiskIndex, setSourceDiskIndex] = useState<number | null>(null);
  const [placed, setPlaced] = useState<PlacedDrop[]>([]);
  const [growLast, setGrowLast] = useState(true);

  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const dragRef = useRef<DragSource | null>(null);

  const [preflightState, setPreflightState] = useState<{ configKey: string; result: any; error?: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [phase, setPhase] = useState<'config' | 'running' | 'done' | 'error'>('config');
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadDisks = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await window.electronAPI.getDisks();
      setDisks(list);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Failed to list disks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.getDisks().then((list) => {
      if (!cancelled) {
        setDisks(list);
        setLoading(false);
      }
    }).catch((e: any) => {
      if (!cancelled) {
        setLoadError(e?.message ?? 'Failed to list disks');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onCloneProgress((p: any) => {
      setProgress({ ...p });
    });
    return cleanup;
  }, []);

  const targetDisk = targetDiskIndex !== null ? disks.find((d) => d.index === targetDiskIndex) : null;

  const partitionOf = (diskIndex: number, partitionIndex: number): any => {
    const disk = disks.find((d) => d.index === diskIndex);
    if (!disk) return null;
    return disk.partitions.find((p: any) => p.partitionIndex === partitionIndex) ?? null;
  };

  const partitionLabel = (p: any): string => {
    if (!p) return 'Partition';
    if (p.driveLetter) return `${p.driveLetter}:`;
    return p.label ?? `Partition ${p.partitionIndex}`;
  };

  const plan = useMemo(() => {
    if (targetDiskIndex === null || sourceDiskIndex === null || placed.length === 0 || !targetDisk) return null;
    const parts = placed
      .map((d) => partitionOf(sourceDiskIndex, d.partitionIndex))
      .filter((p) => p !== null)
      .map((p) => ({ partitionIndex: p.partitionIndex, offset: p.offset, size: p.size, label: partitionLabel(p) }));
    if (parts.length === 0) return null;
    return planTargetLayout(parts, targetDisk.size, { growLast });
  }, [placed, targetDiskIndex, sourceDiskIndex, targetDisk, disks, growLast]);

  const cloneConfig = useMemo(() => {
    if (!plan || !plan.ok || sourceDiskIndex === null || targetDiskIndex === null) return null;
    return {
      sourceDiskIndex,
      sourcePartitions: placed.map((d) => d.partitionIndex),
      targetDiskIndex,
      targetLayout: plan.targets.map((t) => ({ partitionIndex: t.partitionIndex, offset: t.offset, size: t.size })),
      usedBlocksOnly: true,
      acknowledgeLayout: true,
      tableScheme: 'gpt'
    };
  }, [plan, sourceDiskIndex, targetDiskIndex, placed]);

  const configKey = useMemo(() => (cloneConfig ? JSON.stringify(cloneConfig) : null), [cloneConfig]);

  const currentPreflight = preflightState && preflightState.configKey === configKey ? preflightState : null;
  const preflightError = currentPreflight?.error ?? null;

  useEffect(() => {
    if (phase !== 'config' || !cloneConfig || !configKey) return;
    let cancelled = false;
    void window.electronAPI.clonePreflight(cloneConfig).then((p: any) => {
      if (cancelled) return;
      if (p?.ok) {
        setPreflightState({ configKey, result: p });
      } else {
        setPreflightState({ configKey, result: null, error: p?.error ?? 'Copy plan rejected' });
      }
    }).catch((e: any) => {
      if (!cancelled) {
        setPreflightState({ configKey, result: null, error: e?.message ?? 'Copy plan rejected' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cloneConfig, configKey, phase]);

  const selectTarget = (diskIndex: number) => {
    if (targetDiskIndex !== null && targetDiskIndex !== diskIndex && placed.length > 0) {
      setPlaced([]);
      setSourceDiskIndex(null);
      setPreflightState(null);
      setAck(false);
      setNote('Switched target disk; previous placement was cleared.');
    }
    setTargetDiskIndex(diskIndex);
    setNote(null);
  };

  const addDrop = (source: DragSource) => {
    if (source.diskIndex === targetDiskIndex) {
      setNote('Cannot copy a partition onto the disk it comes from.');
      return;
    }
    if (sourceDiskIndex !== null && source.diskIndex !== sourceDiskIndex) {
      setNote('All partitions in one copy must come from the same source disk.');
      return;
    }
    setNote(null);
    if (sourceDiskIndex === null) {
      setSourceDiskIndex(source.diskIndex);
    }
    setPlaced((prev) => {
      if (prev.some((d) => d.partitionIndex === source.partitionIndex)) return prev;
      return [...prev, { partitionIndex: source.partitionIndex }];
    });
  };

  const addAll = (disk: any) => {
    if (targetDiskIndex === null) {
      setNote('Select a target disk first.');
      return;
    }
    const empty = disk.partitions.length === 0;
    if (empty) {
      setNote(`Disk ${disk.index} has no partitions to copy.`);
      return;
    }
    setNote(null);
    if (disk.index === targetDiskIndex) {
      setNote(`Cannot copy a disk onto itself.`);
      return;
    }
    if (sourceDiskIndex !== null && disk.index !== sourceDiskIndex) {
      setNote('All partitions in one copy must come from the same source disk.');
      return;
    }
    if (sourceDiskIndex === null) {
      setSourceDiskIndex(disk.index);
    }
    setPlaced((prev) => {
      const seen = new Set(prev.map((d) => d.partitionIndex));
      const additions = disk.partitions
        .map((p: any) => p.partitionIndex)
        .filter((i: number) => !seen.has(i))
        .map((i: number) => ({ partitionIndex: i }));
      return [...prev, ...additions];
    });
  };

  const removeDrop = (partitionIndex: number) => {
    setPlaced((prev) => {
      const next = prev.filter((d) => d.partitionIndex !== partitionIndex);
      if (next.length === 0) {
        setSourceDiskIndex(null);
      }
      return next;
    });
  };

  const onDrop = (diskIndex: number) => {
    const source = dragRef.current;
    dragRef.current = null;
    setDragOver(null);
    if (!source) return;
    if (targetDiskIndex !== null && targetDiskIndex !== diskIndex && placed.length > 0) {
      selectTarget(diskIndex);
    }
    setTargetDiskIndex(diskIndex);
    addDrop(source);
  };

  const reset = () => {
    setTargetDiskIndex(null);
    setSourceDiskIndex(null);
    setPlaced([]);
    setPreflightState(null);
    setAck(false);
    setNote(null);
    setProgress(null);
    setResult(null);
    setErrorMsg(null);
    setPhase('config');
  };

  const start = async () => {
    if (!cloneConfig || !currentPreflight?.result?.ok) return;
    setPhase('running');
    try {
      const res = await window.electronAPI.startClone(cloneConfig);
      setResult(res);
      setPhase('done');
    } catch (e: any) {
      setErrorMsg(e?.message ?? 'Copy failed');
      setPhase('error');
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

  if (loading) {
    return <div className="dashboard"><h1>Partition Copy</h1><p>Loading disks…</p></div>;
  }

  if (loadError) {
    return (
      <div className="dashboard">
        <h1>Partition Copy</h1>
        <div className="error-message"><p>{loadError}</p></div>
        <div className="wizard-actions">
          <button className="btn-primary" onClick={() => void loadDisks()}>Retry</button>
        </div>
      </div>
    );
  }

  if (phase === 'running') {
    return (
      <div className="dashboard">
        <h1>Partition Copy in Progress</h1>
        <div className="progress-container">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress?.percentComplete || 0}%` }} />
          </div>
          <div className="progress-info">
            <p>Phase: {progress?.phase || 'Preparing…'}</p>
            <p>Progress: {progress?.percentComplete || 0}%</p>
            {progress?.currentPartition && <p>Partition: {progress.currentPartition}</p>}
          </div>
        </div>
        <div className="wizard-actions">
          <button className="btn-danger" onClick={() => void window.electronAPI.cancelClone()}>
            Cancel Copy
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="dashboard">
        <h1>Copy Complete</h1>
        <div className="success-message">
          <p>Partitions were copied to the target disk successfully.</p>
          <p>The source disk was not modified.</p>
          {(result?.warnings?.length ?? 0) > 0 && (
            <p className="dashboard-message">{result.warnings.join('; ')}</p>
          )}
        </div>
        <div className="wizard-actions">
          <button className="btn-primary" onClick={() => void loadDisks().then(() => reset())}>Start Another Copy</button>
          <button className="btn-secondary" onClick={onComplete}>Done</button>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="dashboard">
        <h1>Copy Failed</h1>
        <div className="error-message"><p>{errorMsg}</p></div>
        <div className="wizard-actions">
          <button className="btn-primary" onClick={reset}>Back to Setup</button>
        </div>
      </div>
    );
  }

  const sourceCandidates = disks.filter((d) => d.partitions.length > 0);

  return (
    <div className="dashboard">
      <h1>Partition Copy</h1>
      <p className="copy-intro">
        Copy partitions from one physical disk to another. Drag a partition onto a target disk, or use
        “Copy all partitions”. The target receives a fresh partition table — everything on it is erased.
      </p>

      {note && (
        <div className="copy-note"><span>{note}</span></div>
      )}

      <div className="copy-layout">
        <div className="copy-sources">
          <h2>Source Disks</h2>
          {sourceCandidates.map((disk) => (
            <div key={disk.index} className="copy-source-card">
              <div className="copy-source-head">
                <strong>Disk {disk.index}</strong>
                <span>{disk.model || 'Unknown model'} · {formatSize(disk.size)}</span>
                <button
                  className="btn-secondary btn-small"
                  disabled={targetDiskIndex === null || phase !== 'config'}
                  onClick={() => addAll(disk)}
                >
                  Copy all partitions
                </button>
              </div>
              <div className="copy-chip-list">
                {disk.partitions.map((p: any) => {
                  const usedHere = placed.some((d) => d.partitionIndex === p.partitionIndex) && sourceDiskIndex === disk.index;
                  return (
                    <div
                      key={p.partitionIndex}
                      draggable
                      className={`copy-chip ${usedHere ? 'used' : ''}`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', `part-${disk.index}-${p.partitionIndex}`);
                        e.dataTransfer.effectAllowed = 'copy';
                        dragRef.current = { diskIndex: disk.index, partitionIndex: p.partitionIndex };
                        setDragSource({ diskIndex: disk.index, partitionIndex: p.partitionIndex });
                      }}
                      onDragEnd={() => {
                        dragRef.current = null;
                        setDragSource(null);
                        setDragOver(null);
                      }}
                    >
                      <span className="copy-chip-label">{partitionLabel(p)}</span>
                      <span className="copy-chip-size">{formatSize(p.size)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="copy-targets">
          <h2>Target Disks</h2>
          <p className="copy-hint">Click a disk to select it, then drag partitions onto it.</p>
          {disks.map((disk) => {
            const isActive = targetDiskIndex === disk.index;
            const isSourceOfDrag = dragSource?.diskIndex === disk.index;
            const disabledTarget = phase !== 'config';
            return (
              <div
                key={disk.index}
                className={`copy-target-well ${isActive ? 'active' : ''} ${dragOver === disk.index ? 'drag-over' : ''}`}
                onClick={() => selectTarget(disk.index)}
                onDragOver={(e) => {
                  if (isSourceOfDrag || disabledTarget) return;
                  e.preventDefault();
                  setDragOver(disk.index);
                }}
                onDragLeave={() => {
                  if (dragOver === disk.index) setDragOver(null);
                }}
                onDrop={(e) => {
                  if (isSourceOfDrag || disabledTarget) return;
                  e.preventDefault();
                  onDrop(disk.index);
                }}
              >
                <div className="copy-target-head">
                  <strong>Disk {disk.index}</strong>
                  <span>{disk.model || 'Unknown model'} · {formatSize(disk.size)}</span>
                  {isActive && <span className="copy-active-badge">Selected target</span>}
                </div>

                <div className="copy-target-strip">
                  <div className="copy-strip-label">Current layout</div>
                  <div className="copy-strip">
                    {disk.partitions.length === 0 && <div className="copy-strip-free" style={{ width: '100%' }}>Empty</div>}
                    {disk.partitions.map((p: any) => (
                      <div
                        key={p.partitionIndex}
                        className="copy-strip-existing"
                        style={{ left: `${(p.offset / disk.size) * 100}%`, width: `${Math.max(1.5, (p.size / disk.size) * 100)}%`, minWidth: '2px' }}
                        title={partitionLabel(p)}
                      />
                    ))}
                  </div>
                </div>

                {isActive && (
                  <>
                    <div className="copy-target-strip">
                      <div className="copy-strip-label">Planned copy</div>
                      {plan && plan.ok ? (
                        <div className="copy-strip">
                          {plan.targets.map((t) => (
                            <div
                              key={t.partitionIndex}
                              className="copy-strip-plan"
                              style={{ left: `${(t.offset / disk.size) * 100}%`, width: `${Math.max(1.5, (t.size / disk.size) * 100)}%` }}
                              title={`Partition ${t.partitionIndex} at ${formatSize(t.offset)} (${formatSize(t.size)})`}
                            />
                          ))}
                          <div
                            className="copy-strip-free"
                            style={{ left: `${((plan.targets.length > 0 ? plan.targets[plan.targets.length - 1].offset + plan.targets[plan.targets.length - 1].size : 0) / disk.size) * 100}%`, width: `${(plan.freeBytes / disk.size) * 100}%` }}
                          />
                        </div>
                      ) : (
                        <div className="copy-error-text">{plan?.error ?? 'No partitions placed yet.'}</div>
                      )}
                    </div>

                    {placed.length > 0 && (
                      <div className="copy-placed-list">
                        {placed.map((d) => {
                          const p = partitionOf(sourceDiskIndex!, d.partitionIndex);
                          return (
                            <div key={d.partitionIndex} className="copy-placed-item">
                              <span>{partitionLabel(p)}</span>
                              <span>{p ? formatSize(p.size) : ''}</span>
                              <button className="btn-small btn-danger" onClick={() => removeDrop(d.partitionIndex)}>
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <label className="copy-grow-row">
                      <input type="checkbox" checked={growLast} onChange={(e) => setGrowLast(e.target.checked)} />
                      Grow the last partition to fill free space on the target disk
                    </label>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {targetDiskIndex !== null && plan && (
        <div className="copy-confirm">
          <div className="copy-confirm-summary">
            <h2>Copy Plan</h2>
            <ul>
              <li>
                Target: {targetDisk?.model || `Disk ${targetDiskIndex}`} ({targetDisk ? formatSize(targetDisk.size) : '?'})
                {currentPreflight?.result?.targetDiskPartitionCount ? ` · has ${currentPreflight.result.targetDiskPartitionCount} existing partition(s)` : ''}
              </li>
              <li>Partitions: {placed.length} · {formatSize(plan.totalBytes)} to write{plan.growBytes > 0 ? ` (+${formatSize(plan.growBytes)} grow)` : ''}</li>
              <li>Table scheme: {currentPreflight?.result?.writeTableScheme ? currentPreflight.result.writeTableScheme.toUpperCase() : 'GPT'} on {formatSize(targetDisk?.size ?? 0)}</li>
            </ul>
            {currentPreflight?.result?.warnings && currentPreflight.result.warnings.length > 0 && (
              <ul className="copy-warnings">
                {currentPreflight.result.warnings.map((w: string, i: number) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {preflightError && <div className="error-message"><p>{preflightError}</p></div>}
            {!plan.ok && <div className="error-message"><p>{plan.error}</p></div>}
          </div>

          <label className="copy-ack-row">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand this permanently erases the target disk's current layout.
          </label>

          <div className="wizard-actions">
            <button className="btn-primary" disabled={!ack || !currentPreflight?.result?.ok} onClick={() => void start()}>
              Start Copy
            </button>
            <button className="btn-secondary" onClick={reset}>Clear Plan</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PartitionCopy;