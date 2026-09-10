import { useState, useEffect } from 'react';

interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: number;
  ageDays: number;
}

function LogViewer({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getLogs()
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setContent('');
        setError(null);
        setLoading(true);
        setSelected(null);
        if (list.length > 0) {
          setSelected(list[0].path);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Failed to list logs');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    window.electronAPI
      .readLogFile(selected)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setContent(res.content ?? '');
          setError(null);
        } else {
          setError(res.error ?? 'Failed to read log');
          setContent('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to read log');
          setContent('');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const refresh = () => setRefreshKey((k) => k + 1);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="log-viewer">
      <div className="log-viewer-head">
        <h1>Logs</h1>
        <div className="log-viewer-actions">
          <button className="btn-secondary btn-small" onClick={refresh}>
            Refresh
          </button>
          <button className="btn-secondary btn-small" onClick={onClose}>
            Back
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <p>{error}</p>
        </div>
      )}

      <div className="log-layout">
        <div className="log-file-list">
          {files.length === 0 ? (
            <div className="table-empty">No log files yet</div>
          ) : (
            files.map((f) => (
              <button
                key={f.path}
                className={`log-file-item ${selected === f.path ? 'active' : ''}`}
                onClick={() => setSelected(f.path)}
              >
                <span className="log-file-name">{f.name}</span>
                <span className="log-file-meta">
                  {formatDate(f.modified)} · {formatSize(f.size)}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="log-content-wrap">
          {loading ? (
            <div className="table-empty">Loading…</div>
          ) : content ? (
            <textarea className="log-content" readOnly value={content} spellCheck={false} />
          ) : (
            <div className="table-empty">Select a log file</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default LogViewer;