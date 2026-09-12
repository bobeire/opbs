import { useState, useEffect, useCallback } from 'react';

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
  onNavigate: (page: 'backup' | 'restore' | 'clone', intent?: { imagePath?: string }) => void;
}

function Dashboard({ onNavigate }: DashboardProps) {
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
  const [now, setNow] = useState(0);

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
    } catch {
      setBackups([]);
      setHealth([]);
    } finally {
      setLoading(false);
    }
  }, []);

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
      });
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [load]);

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

  const runOpen = async () => {
    setBusy('Opening…');
    await window.electronAPI.openPath(selectedItems[0].path);
    setBusy(null);
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