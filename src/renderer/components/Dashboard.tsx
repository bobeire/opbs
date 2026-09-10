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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.listRecentBackups();
      setBackups(res.entries ?? []);
    } catch {
      setBackups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .listRecentBackups()
      .then((res) => {
        if (!cancelled) setBackups(res.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setBackups([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
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
    };
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