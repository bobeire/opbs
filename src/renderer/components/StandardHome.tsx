import { useEffect, useRef, useState } from 'react';

interface RecentBackup {
  id: string;
  name: string;
  path: string;
  date: number;
  encrypted?: boolean;
}

interface DestinationHealth {
  path: string;
  reachable: boolean;
}

interface StandardHomeProps {
  onNavigate: (page: 'backup' | 'restore' | 'browse' | 'media') => void;
  /** Fires once the initial backup-list queries settle (drives the startup splash). */
  onLoaded?: () => void;
}

function formatWhen(date: number | undefined): string {
  if (typeof date !== 'number') return 'date not available';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'date not available';
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function StandardHome({ onNavigate, onLoaded }: StandardHomeProps) {
  const [latest, setLatest] = useState<RecentBackup | null>(null);
  const [destinationSummary, setDestinationSummary] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [listUnavailable, setListUnavailable] = useState(false);
  const notifiedLoaded = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await window.electronAPI.listRecentBackups();
        if (!alive) return;
        const entries = (res?.entries ?? []) as RecentBackup[];
        const newest = [...entries].sort((a, b) => (b.date ?? 0) - (a.date ?? 0))[0] ?? null;
        setLatest(newest);

        const dirs = res?.destinations ?? [];
        if (dirs.length === 0) {
          setDestinationSummary('No backup destinations are listed yet');
        } else {
          const health = (await window.electronAPI.destinationHealth(dirs)) as DestinationHealth[];
          if (!alive) return;
          const reachable = health.filter((entry) => entry.reachable).length;
          setDestinationSummary(`${reachable} of ${dirs.length} destination(s) reachable`);
        }
      } catch {
        if (alive) setListUnavailable(true);
      } finally {
        if (alive) {
          setLoading(false);
          if (!notifiedLoaded.current) {
            notifiedLoaded.current = true;
            onLoaded?.();
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [onLoaded]);

  return (
    <div className="standard-home">
      <div className="standard-intro">
        <h1>Home</h1>
        <p>
          Start with a backup, restore files from an image, or make recovery media.
          Everything else is still available in Advanced view.
        </p>
      </div>

      <div className="standard-actions">
        <button className="standard-action-card" onClick={() => onNavigate('backup')}>
          <span className="standard-action-icon" aria-hidden="true">💾</span>
          <span className="standard-action-copy">
            <strong>Back up now</strong>
            <small>Choose what to capture and where to store the image.</small>
          </span>
          <span className="standard-action-arrow" aria-hidden="true">→</span>
        </button>
        <button className="standard-action-card" onClick={() => onNavigate('restore')}>
          <span className="standard-action-icon" aria-hidden="true">♻️</span>
          <span className="standard-action-copy">
            <strong>Restore files</strong>
            <small>Pick an image and follow the restore steps.</small>
          </span>
          <span className="standard-action-arrow" aria-hidden="true">→</span>
        </button>
        <button className="standard-action-card" onClick={() => onNavigate('browse')}>
          <span className="standard-action-icon" aria-hidden="true">🗂️</span>
          <span className="standard-action-copy">
            <strong>Browse an image</strong>
            <small>Look inside an image or mount it as a drive.</small>
          </span>
          <span className="standard-action-arrow" aria-hidden="true">→</span>
        </button>
        <button className="standard-action-card" onClick={() => onNavigate('media')}>
          <span className="standard-action-icon" aria-hidden="true">💿</span>
          <span className="standard-action-copy">
            <strong>Recovery media</strong>
            <small>Build media for restoring outside Windows.</small>
          </span>
          <span className="standard-action-arrow" aria-hidden="true">→</span>
        </button>
      </div>

      <section className="standard-status">
        <h2>Backup overview</h2>
        {loading ? (
          <p className="standard-muted">Checking the backup list…</p>
        ) : listUnavailable ? (
          <p className="standard-muted">The backup list is not available right now. You can still start a backup or restore.</p>
        ) : latest ? (
          <div className="standard-status-grid">
            <div className="standard-status-item">
              <span className="standard-muted">Latest image listed</span>
              <strong title={latest.path}>{latest.name || latest.path}</strong>
              <small>{formatWhen(latest.date)}</small>
            </div>
            <div className="standard-status-item">
              <span className="standard-muted">Destinations</span>
              <strong>{destinationSummary}</strong>
              <small>Based on the current destination check.</small>
            </div>
          </div>
        ) : (
          <p className="standard-muted">
            No backups are listed yet. Start with <strong>Back up now</strong> above.
          </p>
        )}
      </section>

      <p className="standard-mode-note">
        Need schedules, disk tools, or other controls? Use <strong>Advanced view</strong> at the bottom of the sidebar.
      </p>
    </div>
  );
}

export default StandardHome;
