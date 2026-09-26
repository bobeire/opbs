import { useState, useEffect, useCallback, useRef } from 'react';

interface RecentBackup {
  id: string;
  name: string;
  path: string;
  destPath: string;
  size: number;
  date: number;
  incremental: boolean;
  encrypted: boolean;
  verified: boolean;
  drillTestedAt?: number;
  chain: string[];
}

interface DashboardProps {
  onNavigate: (page: 'backup' | 'restore' | 'clone' | 'copy' | 'disks' | 'browse', intent?: { imagePath?: string }) => void;
  /** Fires once the initial backup-list and drive queries have settled (drives the startup splash). */
  onLoaded?: () => void;
}

function Dashboard({ onNavigate, onLoaded }: DashboardProps) {
  const [backups, setBackups] = useState<RecentBackup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [systemInfo, setSystemInfo] = useState({ disks: 0, totalSpace: 0, usedSpace: 0 });
  const [destinations, setDestinations] = useState<string[]>([]);
  const [health, setHealth] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<{
    destinations: any[];
    totals: { totalDiskBytes: number; totalImageBytes: number; avgCompressionRatio: number };
  } | null>(null);
  const [scrubStatus, setScrubStatus] = useState<any[]>([]);
  const [integrity, setIntegrity] = useState<any[]>([]);
  const [storageHealth, setStorageHealth] = useState<any[]>([]);
  const [mediaHealth, setMediaHealth] = useState<any[]>([]);
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [perfRunning, setPerfRunning] = useState<string | null>(null);
  const [winfspMissing, setWinfspMissing] = useState(false);
  const [winfspPhase, setWinfspPhase] = useState<'idle' | 'installing' | 'error'>('idle');
  const [winfspError, setWinfspError] = useState('');
  const [helperTaskRegistered, setHelperTaskRegistered] = useState(true); // assume registered until checked
  const [helperTaskLoading, setHelperTaskLoading] = useState(false);
  const [now, setNow] = useState(0);

  const initial = useRef({ load: false, disks: false });
  const notifiedInitial = useRef(false);
  const notifyInitialLoaded = useCallback(() => {
    if (notifiedInitial.current || !initial.current.load || !initial.current.disks) return;
    notifiedInitial.current = true;
    onLoaded?.();
  }, [onLoaded]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.listRecentBackups();
      setBackups(res.entries ?? []);
      const dirs = res.destinations ?? [];
      setDestinations(dirs);
      if (dirs.length > 0) {
        const healthRes = await window.electronAPI.destinationHealth(dirs);
        setHealth(Array.isArray(healthRes) ? healthRes : []);
      } else {
        setHealth([]);
      }
      const analyticsRes = await window.electronAPI.getBackupAnalytics();
      if (analyticsRes && Array.isArray(analyticsRes.destinations)) {
        setAnalytics(analyticsRes);
      }
      const scrubRes = await window.electronAPI.getScrubStatus();
      setScrubStatus(Array.isArray(scrubRes) ? scrubRes : []);
      const integrityRes = await window.electronAPI.getBackupIntegrity();
      setIntegrity(Array.isArray(integrityRes) ? integrityRes : []);
      const storageRes = await window.electronAPI.getStorageHealth();
      setStorageHealth(Array.isArray(storageRes) ? storageRes : []);
      const mediaRes = await window.electronAPI.getMediaHealth();
      setMediaHealth(Array.isArray(mediaRes) ? mediaRes : []);
      const anomalyRes = await window.electronAPI.getBackupAnomalies();
      setAnomalies(Array.isArray(anomalyRes) ? anomalyRes : []);
    } catch {
      setBackups([]);
      setHealth([]);
    } finally {
      setLoading(false);
      initial.current.load = true;
      notifyInitialLoaded();
    }
  }, [notifyInitialLoaded]);

  const runScrub = useCallback(async () => {
    setBusy('scrub');
    try {
      const dirs = destinations.length > 0 ? destinations : (await window.electronAPI.listRecentBackups()).destinations ?? [];
      for (const dir of dirs) {
        await window.electronAPI.startScrub(dir, 'all');
      }
      setMessage({ kind: 'ok', text: `Scrub started in the background for ${dirs.length} destination(s)` });
    } catch {
      setMessage({ kind: 'err', text: 'Could not start scrub' });
    } finally {
      setBusy(null);
    }
  }, [destinations]);

  const runPerf = useCallback(async (directory: string) => {
    setPerfRunning(directory);
    try {
      const result = await window.electronAPI.runDiskPerf(directory);
      if (result?.ok) {
        setMessage({
          kind: 'ok',
          text: `Write test for ${directory} done: ${result.seqWriteMBs.toFixed(1)} MiB/s write, ${result.seqReadMBs.toFixed(1)} MiB/s read.`
        });
      } else {
        setMessage({ kind: 'err', text: `Write test failed for ${directory}: ${result?.error ?? 'unknown error'}` });
      }
      await load();
    } catch {
      setMessage({ kind: 'err', text: `Could not run the write test for ${directory}` });
    } finally {
      setPerfRunning(null);
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setNow(Date.now());
    };
    Promise.resolve().then(tick);
    const interval = setInterval(tick, 60000);
    Promise.resolve().then(() => {
      if (cancelled) return;
      load().catch(() => {
        if (!cancelled) setBackups([]);
      });
    });
    window.electronAPI
      .getDisks()
      .then((diskList) => {
        if (cancelled) return;
        const disks: any[] = diskList ?? [];
        const total = disks.reduce((sum: number, d: any) => sum + (d.size || 0), 0);
        const used = disks.reduce((sum: number, d: any) => {
          const parts: any[] | undefined = d.partitions;
          return sum + (parts?.reduce((s: number, p: any) => s + (p.usedSpace || 0), 0) ?? 0);
        }, 0);
        setSystemInfo({ disks: disks.length, totalSpace: total, usedSpace: used });
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        initial.current.disks = true;
        notifyInitialLoaded();
      });
    window.electronAPI
      .winfspStatus()
      .then((status) => {
        if (!cancelled) setWinfspMissing(status?.available === false);
      })
      .catch(() => {
        // ignore
      });
    window.electronAPI
      .isHelperTaskRegistered()
      .then((registered) => {
        if (!cancelled) setHelperTaskRegistered(registered);
      })
      .catch(() => {
        // ignore — assume registered on error
      });
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [load, notifyInitialLoaded]);

  const installWinfsp = useCallback(async () => {
    setWinfspPhase('installing');
    setWinfspError('');
    try {
      const result = await window.electronAPI.winfspInstall();
      if (result && result.available) {
        setWinfspMissing(false);
        setWinfspPhase('idle');
      } else {
        setWinfspError(result?.error ?? 'WinFsp installation failed.');
        setWinfspPhase('error');
      }
    } catch (e: any) {
      setWinfspError(e?.message ?? 'WinFsp installation failed.');
      setWinfspPhase('error');
    }
  }, []);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedItems = backups.filter((b) => selected.has(b.id));

  const scanFolder = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (!dir) return;
    await window.electronAPI.addRecentDestination(dir);
    await load();
  };

  const runOpen = () => {
    onNavigate('browse', { imagePath: selectedItems[0].path });
  };

  const runCloudStore = async () => {
    setBusy('Uploading to cloud…');
    const results = [];
    for (const item of selectedItems) {
      const res = await window.electronAPI.uploadToCloud(item.path);
      results.push({ name: item.name, ok: res.ok, error: res.error });
    }
    setBusy(null);
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      setMessage({ kind: 'ok', text: `Uploaded ${results.length} image(s) to cloud.` });
    } else {
      setMessage({ kind: 'err', text: failed[0].error ?? `Failed to upload ${failed.length} image(s).` });
    }
  };

  const runExternalCopy = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (!dir) return;
    setBusy('Copying to external drive…');
    let copiedCount = 0;
    for (const item of selectedItems) {
      const res = await window.electronAPI.copyImage(item.path, dir);
      if (res.ok) copiedCount += (res.copied ?? []).length;
    }
    setBusy(null);
    setMessage({ kind: 'ok', text: `Copied ${copiedCount} image file(s) to ${dir}` });
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

  const formatDate = (ts: number): string => {
    return new Date(ts).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const ageDays = (ts: number): number => {
    return now > 0 ? Math.max(0, Math.floor((now - ts) / 86400000)) : 0;
  };

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <h3>System Disks</h3>
          <p className="stat-value">{systemInfo.disks}</p>
        </div>
        <div className="stat-card">
          <h3>Total Storage</h3>
          <p className="stat-value">{formatSize(systemInfo.totalSpace)}</p>
        </div>
        <div className="stat-card">
          <h3>Used Storage</h3>
          <p className="stat-value">{formatSize(systemInfo.usedSpace)}</p>
        </div>
        <div className="stat-card">
          <h3>Backup Count</h3>
          <p className="stat-value">{backups.length}</p>
        </div>
      </div>

      <div className="dashboard-actions">
        <button className="btn-primary btn-small" onClick={() => onNavigate('copy')}>
          📤 Partition Copy
        </button>
        <button className="btn-secondary btn-small" onClick={() => onNavigate('disks')}>
          🔧 Disk Tools
        </button>
        <span className="dashboard-actions-note">
          Drag partitions to copy them, or run disk health checks and MBR repair.
        </span>
      </div>

      {winfspMissing && (
        <div className="dashboard-banner">
          <div className="dashboard-banner-text">
            <strong>WinFsp runtime not installed</strong>
            <span>Needed to mount backup partitions as read-only drives.</span>
          </div>
          {winfspPhase === 'installing' && (
            <span className="busy-spinner">Installing… (confirm the UAC prompt)</span>
          )}
          {winfspPhase === 'error' && <span className="banner-error">{winfspError}</span>}
          <button
            className="btn-secondary"
            disabled={winfspPhase === 'installing'}
            onClick={() => void installWinfsp()}
          >
            {winfspPhase === 'installing' ? 'Installing…' : 'Install WinFsp now'}
          </button>
        </div>
      )}

      {!helperTaskRegistered && (
        <div className="dashboard-banner">
          <div className="dashboard-banner-text">
            <strong>Backup automation not enabled</strong>
            <span>Register the helper task once so backups run without a UAC prompt. Scheduled backups at 2am will fail without this.</span>
          </div>
          <button
            className="btn-primary"
            disabled={helperTaskLoading}
            onClick={async () => {
              setHelperTaskLoading(true);
              try {
                await window.electronAPI.registerHelperTask();
                setHelperTaskRegistered(true);
              } catch {
                // User cancelled UAC or registration failed — try again next time
              } finally {
                setHelperTaskLoading(false);
              }
            }}
          >
            {helperTaskLoading ? 'Registering…' : 'Register Helper Task'}
          </button>
        </div>
      )}

      {analytics && analytics.totals.totalDiskBytes > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Backup Analytics</h2>
          </div>
          <div className="stats-grid" style={{ marginBottom: '12px' }}>
            <div className="stat-card">
              <h3>Disk Captured</h3>
              <p className="stat-value">{formatSize(analytics.totals.totalDiskBytes)}</p>
            </div>
            <div className="stat-card">
              <h3>Image Storage</h3>
              <p className="stat-value">{formatSize(analytics.totals.totalImageBytes)}</p>
            </div>
            <div className="stat-card">
              <h3>Avg Compression</h3>
              <p className="stat-value">{analytics.totals.avgCompressionRatio.toFixed(1)}x</p>
            </div>
            <div className="stat-card">
              <h3>Destinations</h3>
              <p className="stat-value">{analytics.destinations.length}</p>
            </div>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>Images</th>
                <th>Chains</th>
                <th>Disk Captured</th>
                <th>Image Storage</th>
                <th>Compression</th>
                <th>Best Chain Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {analytics.destinations.map((dest) => {
                const bestChain = (dest.chains ?? []).reduce<{ chainEfficiency: number } | null>(
                  (best, c) => (best === null || c.chainEfficiency > best.chainEfficiency ? c : best),
                  null
                );
                return (
                  <tr key={dest.directory}>
                    <td className="col-dest" title={dest.directory}>
                      {dest.directory}
                    </td>
                    <td>{dest.imageCount}</td>
                    <td>{dest.chainCount}</td>
                    <td>{formatSize(dest.totalDiskBytes)}</td>
                    <td>{formatSize(dest.totalImageBytes)}</td>
                    <td>{dest.avgCompressionRatio ? `${dest.avgCompressionRatio.toFixed(1)}x` : '—'}</td>
                    <td>{bestChain ? `${(bestChain.chainEfficiency * 100).toFixed(0)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {scrubStatus.length > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Scrub Health</h2>
            <button className="btn btn-secondary" disabled={busy === 'scrub'} onClick={() => void runScrub()}>
              {busy === 'scrub' ? 'Starting…' : 'Run scrub now'}
            </button>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>Last scrub</th>
                <th>Status</th>
                <th>Total repaired</th>
                <th>Corrupt images</th>
              </tr>
            </thead>
            <tbody>
              {scrubStatus.map((s) => (
                <tr key={s.directory}>
                  <td className="col-dest" title={s.directory}>
                    {s.directory}
                  </td>
                  <td>{s.lastScrubAt ? formatDate(s.lastScrubAt) : 'never'}</td>
                  <td>
                    {s.lastScrubAt === 0 ? (
                      <span className="drill-not-tested">never scrubbed</span>
                    ) : s.lastOk ? (
                      <span className="badge badge-ok">ok</span>
                    ) : (
                      <span className="badge badge-err">needs attention</span>
                    )}
                  </td>
                  <td>{s.totalRepaired}</td>
                  <td>{s.corruptImages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {integrity.length > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Backup Integrity</h2>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>Chains</th>
                <th>Missing bases</th>
                <th>Chain status</th>
                <th>Tamper check</th>
                <th>Drift vs manifest</th>
              </tr>
            </thead>
            <tbody>
              {integrity.map((entry) => {
                const chain = entry.chain ?? {};
                const tamper = entry.tamper ?? {};
                const drift =
                  (tamper.diff?.missing?.length ?? 0) +
                  (tamper.diff?.sizeChanged?.length ?? 0) +
                  (tamper.diff?.unexpected?.length ?? 0);
                return (
                  <tr key={entry.directory}>
                    <td className="col-dest" title={entry.directory}>
                      {entry.directory}
                    </td>
                    <td>
                      {chain.completeChains}/{chain.chainCount}
                    </td>
                    <td>{chain.missingBases?.length ?? 0}</td>
                    <td>
                      {chain.brokenChains > 0 ? (
                        <span className="badge badge-err">broken</span>
                      ) : (
                        <span className="badge badge-ok">ok</span>
                      )}
                    </td>
                    <td>
                      {!tamper.manifestPresent ? (
                        <span className="drill-not-tested">no manifest</span>
                      ) : tamper.ok ? (
                        <span className="badge badge-ok">clean</span>
                      ) : (
                        <span className="badge badge-err">drifted</span>
                      )}
                    </td>
                    <td>
                      {tamper.diff?.missing?.length > 0 && (
                        <span title={(tamper.diff.missing ?? []).map((m) => m.name).join(', ')}>
                          {`${tamper.diff.missing.length} deleted, `}
                        </span>
                      )}
                      {tamper.diff?.sizeChanged?.length > 0 && (
                        <span title={(tamper.diff.sizeChanged ?? []).map((m) => m.name).join(', ')}>
                          {`${tamper.diff.sizeChanged.length} modified, `}
                        </span>
                      )}
                      {tamper.diff?.unexpected?.length > 0 && (
                        <span title={(tamper.diff.unexpected ?? []).map((m) => m.name).join(', ')}>
                          {`${tamper.diff.unexpected.length} unexpected`}
                        </span>
                      )}
                      {drift === 0 && (tamper.ok || !tamper.manifestPresent) ? '—' : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {integrity.some((e) => (e.chain?.brokenChains ?? 0) > 0 || !(e.tamper?.ok ?? true)) && (
            <p className="drill-not-tested" style={{ marginTop: '8px' }}>
              Chains with missing delta bases or manifest drift are not restorable / not trustworthy — investigate
              before relying on a restore.
            </p>
          )}
        </div>
      )}

      {storageHealth.length > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Storage Health</h2>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>Reliability</th>
                <th>Free space</th>
                <th>Coverage (verified / parity / scrub)</th>
                <th>Chains</th>
                <th>Last drill</th>
                <th>SMART</th>
                <th>Write perf</th>
              </tr>
            </thead>
            <tbody>
              {storageHealth.map((entry) => {
                const freePct =
                  entry.totalBytes > 0 ? Math.round((entry.freeBytes / entry.totalBytes) * 100) : null;
                const statusClass =
                  entry.status === 'good' ? 'badge-ok' : entry.status === 'degraded' ? 'badge-warn' : 'badge-err';
                return (
                  <tr key={entry.path}>
                    <td className="col-dest" title={entry.path}>
                      {entry.path}
                    </td>
                    <td>
                      <span className={`badge ${statusClass}`} title={entry.warnings.join('\n')}>
                        {entry.score}/100 {entry.status}
                      </span>
                    </td>
                    <td>
                      {freePct != null ? `${freePct}%` : entry.reachable ? '—' : 'offline'}
                    </td>
                    <td title={`${entry.verifiedImages} verified, ${entry.parityProtectedImages} parity-protected, ${entry.imagesScrubbed} scrubbed`}>
                      {entry.imageCount > 0
                        ? `${entry.verifiedImages}/${entry.imageCount} · ${entry.parityProtectedImages}/${entry.imageCount} · ${entry.imagesScrubbed}`
                        : '—'}
                    </td>
                    <td>
                      {entry.completeChains}/{entry.chainCount}
                    </td>
                    <td>
                      {entry.hasDrill ? (
                        <span className="badge badge-ok">tested</span>
                      ) : entry.imageCount > 0 ? (
                        <span className="drill-not-tested">never tested</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {entry.smart?.available ? (
                        entry.smart.warnings.length === 0 ? (
                          <span className="badge badge-ok">healthy</span>
                        ) : (
                          <span className="badge badge-err" title={entry.smart.warnings.join('\n')}>
                            at-risk
                          </span>
                        )
                      ) : entry.smart?.driveLetter ? (
                        <span className="drill-not-tested">n/a ({entry.smart.driveLetter}:)</span>
                      ) : (
                        <span className="drill-not-tested">n/a</span>
                      )}
                    </td>
                    <td>
                      {entry.perf?.ok && typeof entry.perf.seqWriteMBs === 'number' ? (
                        <span
                          className={`badge ${
                            entry.perf.seqWriteMBs >= 100
                              ? 'badge-ok'
                              : entry.perf.seqWriteMBs >= 40
                                ? 'badge-warn'
                                : 'badge-err'
                          }`}
                          title={`${entry.perf.seqWriteMBs.toFixed(1)} MiB/s write, ${entry.perf.seqReadMBs?.toFixed(1) ?? '?'} MiB/s read${entry.perf.at ? ` (${new Date(entry.perf.at).toLocaleString()})` : ''}`}
                        >
                          {entry.perf.seqWriteMBs.toFixed(0)} MiB/s
                        </span>
                      ) : entry.perf?.error ? (
                        <span className="drill-not-tested" title={entry.perf.error}>failed</span>
                      ) : (
                        <span className="drill-not-tested">never tested</span>
                      )}{' '}
                      <button
                        className="btn-secondary btn-small"
                        disabled={perfRunning != null}
                        onClick={() => void runPerf(entry.path)}
                      >
                        {perfRunning === entry.path ? 'Running…' : 'Test'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {storageHealth.some((e) => e.status === 'at-risk') && (
            <p className="drill-not-tested" style={{ marginTop: '8px' }}>
              At-risk destinations flagged for review — see the CLI <code>storage-health --dir</code> for details, or
              run a scrub / drill on the flagged destination.
            </p>
          )}
        </div>
      )}

      {mediaHealth.length > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Media Health</h2>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Disk</th>
                <th>Model</th>
                <th>Size</th>
                <th>Volumes</th>
                <th>Health</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {mediaHealth.map((entry) => {
                const data = entry.health?.data ?? null;
                const warnings = entry.health?.warnings ?? [];
                return (
                  <tr key={entry.diskIndex}>
                    <td>{entry.diskIndex}</td>
                    <td>{entry.model}</td>
                    <td>{entry.size > 0 ? `${(entry.size / 1e9).toFixed(0)} GB` : '—'}</td>
                    <td>{entry.driveLetters?.length > 0 ? `${entry.driveLetters.join(', ')}:` : '—'}</td>
                    <td>
                      {data ? (
                        entry.unhealthy ? (
                          <span className="badge badge-err" title={warnings.join('\n')}>
                            at-risk
                          </span>
                        ) : (
                          <span className="badge badge-ok">healthy</span>
                        )
                      ) : (
                        <span className="drill-not-tested" title="SMART data unavailable (drive may not support it or requires elevation)">
                          n/a
                        </span>
                      )}
                    </td>
                    <td>
                      {data
                        ? [
                            data.healthStatus && data.healthStatus !== 'Healthy'
                              ? data.healthStatus
                              : null,
                            data.temperatureCelsius != null ? `${data.temperatureCelsius.toFixed(0)}°C` : null,
                            data.wear != null ? `${data.wear.toFixed(0)}% wear` : null,
                            data.unreliableSectors != null && data.unreliableSectors > 0
                              ? `${data.unreliableSectors} bad sectors`
                              : null
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : warnings.join(' · ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {mediaHealth.some((e) => e.unhealthy) && (
            <p className="drill-not-tested" style={{ marginTop: '8px' }}>
              A storage drive reports SMART problems. Backups that write to it are refused until the drive is
              healthy — replace or service the media before relying on it.
            </p>
          )}
        </div>
      )}

      {anomalies.length > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Anomaly Detection</h2>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>History</th>
                <th>Latest</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((entry) => {
                const flags = (entry.anomalies ?? []).filter((a: any) => a.severity !== 'info');
                const notes = (entry.anomalies ?? []).filter((a: any) => a.severity === 'info');
                const b = entry.baseline ?? {};
                return (
                  <tr key={entry.directory}>
                    <td className="col-dest" title={entry.directory}>
                      {entry.directory}
                    </td>
                    <td>{entry.historyCount} run(s)</td>
                    <td>
                      {b.medianIntervalMs != null
                        ? entry.historyCount >= 3
                          ? `~${Math.max(1, Math.round(b.medianIntervalMs / (24 * 3600 * 1000)))}d cadence`
                          : 'too few runs'
                        : 'no cadence'}
                    </td>
                    <td>
                      {flags.length === 0 ? (
                        <span className="badge badge-ok">no anomalies</span>
                      ) : (
                        <span className="badge badge-err" title={flags.map((f: any) => f.message).join('\n')}>
                          {flags.map((f: any) => f.kind).join(', ')}
                        </span>
                      )}
                      {notes.length > 0 && (
                        <span className="drill-not-tested" title={notes.map((n: any) => n.message).join('\n')}>
                          {" ·"} {notes[0].message}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {anomalies.some((e) => !e.ok) && (
            <p className="drill-not-tested" style={{ marginTop: '8px' }}>
              Deviations detected against the run history — see the CLI <code>anomalies check --dir</code> for the
              full baseline details, and verify the source/disks/retention before continuing.
            </p>
          )}
        </div>
      )}

      {destinations.length > 0 && (
        <div className="recent-backups">
          <div className="recent-backups-head">
            <h2>Backup Destinations</h2>
          </div>
          <table className="backup-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>Free space</th>
                <th>Images</th>
                <th>Chains</th>
                <th>Newest image</th>
                <th>Prune preview</th>
              </tr>
            </thead>
            <tbody>
              {destinations.map((dir) => {
                const h = health.find((x) => x && x.path === dir);
                return (
                  <tr key={dir}>
                    <td className="col-dest" title={dir}>
                      {dir}
                    </td>
                    <td>
                      {h && h.reachable && h.totalBytes ? (
                        <div className="health-free-wrap" title={`${formatSize(h.freeBytes)} free of ${formatSize(h.totalBytes)}`}>
                          <div
                            className="health-free-bar"
                            style={{ width: `${Math.max(2, Math.min(100, (h.freeBytes / h.totalBytes) * 100))}%` }}
                          />
                          <span>
                            {formatSize(h.freeBytes)} free
                          </span>
                        </div>
                      ) : (
                        <span className="status-badge in_progress">{h && !h.reachable ? 'offline' : '…'}</span>
                      )}
                    </td>
                    <td>{h ? h.imageCount : '…'}</td>
                    <td>{h ? h.chainCount : '…'}</td>
                    <td>
                      {h && h.newestDate ? (
                        <span className={`status-badge ${ageDays(h.newestDate) > 7 ? 'in_progress' : 'completed'}`}>
                          {ageDays(h.newestDate)}d ago
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{h && h.plannedPrune > 0 ? `${h.plannedPrune} would prune` : 'in retention'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="recent-backups">
        <div className="recent-backups-head">
          <h2>Recent Backups</h2>
          <div className="log-viewer-actions">
            <button className="btn-secondary btn-small" onClick={() => void scanFolder()}>
              Scan backup folder…
            </button>
          </div>
        </div>

        {message && (
          <div className={`${message.kind === 'ok' ? 'success-message' : 'error-message'} dashboard-message`}>
            <p>{message.text}</p>
          </div>
        )}

        {selectedItems.length > 0 && (
          <div className="selection-actions">
            <span className="selection-count">{selectedItems.length} selected</span>
            <button className="btn-secondary btn-small" onClick={() => void runOpen()}>
              Open
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => onNavigate('restore', { imagePath: selectedItems[0].path })}
            >
              Restore
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => onNavigate('clone', { imagePath: selectedItems[0].path })}
            >
              Clone
            </button>
            <button className="btn-secondary btn-small" onClick={() => void runCloudStore()}>
              Store to Cloud
            </button>
            <button className="btn-secondary btn-small" onClick={() => void runExternalCopy()}>
              Store to External Drive
            </button>
            {busy && <span className="busy-spinner">{busy}</span>}
          </div>
        )}

        {loading ? (
          <div className="empty-state">
            <p>Loading backups…</p>
          </div>
        ) : backups.length === 0 ? (
          <div className="empty-state">
            <p>
              No backups found yet. Create your first backup, or{' '}
              <button className="btn-secondary btn-small" onClick={() => void scanFolder()}>
                scan a backup folder
              </button>{' '}
              to list existing images.
            </p>
          </div>
        ) : (
          <table className="backup-table">
            <thead>
              <tr>
                <th className="col-check" />
                <th>Name</th>
                <th>Date</th>
                <th>Size</th>
                <th>Type</th>
                <th>Status</th>
                <th>Destination</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr
                  key={backup.id}
                  className={`backup-row ${selected.has(backup.id) ? 'selected' : ''}`}
                  onClick={() => toggleSelected(backup.id)}
                >
                  <td className="col-check">
                    <input
                      type="checkbox"
                      checked={selected.has(backup.id)}
                      readOnly
                    />
                  </td>
                  <td>{backup.name}</td>
                  <td>{formatDate(backup.date)}</td>
                  <td>{formatSize(backup.size)}</td>
                  <td>{backup.incremental ? 'Incremental' : 'Full'}</td>
                  <td>
                    <span className={`status-badge ${backup.verified ? 'completed' : 'in_progress'}`}>
                      {backup.verified ? 'verified' : 'unverified'}
                    </span>
                    {backup.drillTestedAt ? (
                      <span
                        className="status-badge completed"
                        style={{ marginLeft: '4px' }}
                        title={`Restore drill passed ${new Date(backup.drillTestedAt).toLocaleString()}`}
                      >
                        drill-tested
                      </span>
                    ) : null}
                  </td>
                  <td className="col-dest" title={backup.destPath}>
                    {backup.destPath}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default Dashboard;