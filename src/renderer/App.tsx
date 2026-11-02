import { useState, useEffect, useCallback } from 'react';
import Dashboard from './components/Dashboard';
import BackupWizard from './components/BackupWizard';
import RestoreWizard from './components/RestoreWizard';
import MigrateWizard from './components/MigrateWizard';
import Settings from './components/Settings';
import Schedules from './components/Schedules';
import ConfigBuilder from './components/ConfigBuilder';
import VssView from './components/VssView';
import BrowseView from './components/BrowseView';
import MediaView from './components/MediaView';
import LogViewer from './components/LogViewer';
import NetworkView from './components/NetworkView';
import PartitionCopy from './components/PartitionCopy';
import DiskTools from './components/DiskTools';
import Repositories from './components/Repositories';
import ToastHost from './components/ToastHost';
import AdkPrompt from './components/AdkPrompt';
import SplashScreen from './components/SplashScreen';
import { applyTheme } from './lib/theme';

type Page =
  | 'dashboard'
  | 'backup'
  | 'restore'
  | 'migrate'
  | 'copy'
  | 'disks'
  | 'repositories'
  | 'browse'
  | 'media'
  | 'schedules'
  | 'builder'
  | 'network'
  | 'logs'
  | 'vss'
  | 'settings';

interface BackupIntent {
  destinationPath?: string;
  allDisks?: boolean;
}

interface BrowseIntent {
  imagePath: string;
  autoMount?: boolean;
}

/** Startup report of a staged recovery restore that ran at boot. */
interface RecoveryNotice {
  kind: 'success' | 'error';
  title: string;
  body: string;
  /** Warnings reported by the restore that ran in the recovery environment. */
  details?: string[];
}

/**
 * When a recovery restore actually ran, for a report shown at the next
 * launch. Returns null when the marker has no usable time (the batch
 * fallback writes a locale date string we cannot reliably parse) — the
 * caller then says it is an earlier restore without naming a time.
 */
function formatRecoveryWhen(finishedAt?: string): string | null {
  if (!finishedAt) return null;
  const parsed = new Date(finishedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Payload of the 'backup-progress' IPC event (mirrors BackupProgress in main; feeds BackupWizard's activeProgress). */
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

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [backupIntent, setBackupIntent] = useState<BackupIntent | null>(null);
  const [restoreIntent, setRestoreIntent] = useState<{ imagePath?: string; mode?: 'restore' | 'clone' } | null>(null);
  const [browseIntent, setBrowseIntent] = useState<BrowseIntent | null>(null);
  const [backupRunning, setBackupRunning] = useState(false);
  const [lastBackupProgress, setLastBackupProgress] = useState<BackupProgress | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [initialDataReady, setInitialDataReady] = useState(false);
  const [splashMinElapsed, setSplashMinElapsed] = useState(false);

  // Splash stays up briefly (avoids a flash) and never blocks forever even if
  // the dashboard's drive/backup queries hang.
  useEffect(() => {
    const minTimer = setTimeout(() => setSplashMinElapsed(true), 700);
    const hardCap = setTimeout(() => setInitialDataReady(true), 8000);
    return () => {
      clearTimeout(minTimer);
      clearTimeout(hardCap);
    };
  }, []);

  const handleDashboardLoaded = useCallback(() => setInitialDataReady(true), []);

  // Hidden until the dashboard's drive/backup data is loaded (and a minimum
  // display time has passed). A file-association open landing on another page
  // hides it immediately — that data isn't what it's waiting for.
  const splashVisible = currentPage === 'dashboard' && !(initialDataReady && splashMinElapsed);

  useEffect(() => {
    void window.electronAPI.getVersion().then((v) => setAppVersion(v));
    // Theme: authoritative settings value over the cached first-paint value.
    void window.electronAPI.getSettings().then((s) => applyTheme(s?.theme));
    // `--open-page <page>` startup flag: pulled here (not pushed at
    // did-finish-load) so the nav can't race listener registration.
    void window.electronAPI.takeStartupNav().then((page) => {
      if (page) setCurrentPage(page);
    });
    // Update check happens in main at startup (initAutoUpdater); calling it
    // here too would make background checks indistinguishable from the
    // manual "Check for updates" button.
  }, []);

  // A staged recovery restore runs outside OPBS (reboot into WinRE); report
  // its result once when OPBS next starts. A restore that is staged but has
  // not run yet is deliberately not nagged about here — the Restore page owns
  // that flow.
  useEffect(() => {
    let alive = true;
    void window.electronAPI
      .recoveryStatus()
      .then((status) => {
        const result = status?.pendingResult;
        if (!alive || !result) return;
        const warnings = result.warnings ?? [];
        const logNote = result.logPath ? ` Full log: ${result.logPath}.` : '';
        // This reports something that already happened, often hours ago. The
        // toast never auto-hides, so without a time in it the user reads it as
        // belonging to whatever job they just ran (field report 2026-11-02:
        // "at the end of a successful backup, I get a message saying the
        // restore was successful"). Say when, and say it is not now.
        const when = formatRecoveryWhen(result.finishedAt);
        const history = when
          ? `This restore ran ${when} — before this session. `
          : 'This is a report from an earlier restore, not from anything you just ran. ';
        setRecoveryNotice(
          result.ok
            ? {
                kind: 'success',
                title:
                  'Earlier: recovery restore ' +
                  (warnings.length > 0
                    ? `finished with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
                    : 'finished'),
                body:
                  history +
                  (warnings.length > 0
                    ? 'These are the messages the recovery environment reported:'
                    : 'It completed successfully.') +
                  logNote,
                details: warnings.length > 0 ? warnings : undefined
              }
            : {
                kind: 'error',
                title: 'Earlier: recovery restore failed',
                body: `${history}It did not complete${
                  typeof result.exitCode === 'number' ? ` (exit code ${result.exitCode})` : ''
                }.${result.error ? ` ${result.error}` : ''} Try the restore again, or run it from the recovery media.${logNote}`,
                details: warnings.length > 0 ? warnings : undefined
              }
        );
      })
      .catch(() => {
        // A failed status check has nothing to report — stay silent.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Track backup state globally so it persists across navigation
  useEffect(() => {
    void window.electronAPI.isBackupRunning().then((running) => setBackupRunning(running));
    const cleanup = window.electronAPI.onBackupProgress((p: BackupProgress) => {
      setBackupRunning(true);
      setLastBackupProgress(p);
      if (p.phase === 'completed' || p.phase === 'error') {
        setBackupRunning(false);
      }
    });
    return cleanup;
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onNav((page) => {
      if (page === 'browse' || page === 'backup' || page === 'restore' || page === 'schedules' || page === 'vss' || page === 'copy' || page === 'disks' || page === 'repositories') {
        setCurrentPage(page);
      }
    });
    return cleanup;
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onOpenImage((payload) => {
      if (payload.verb === 'restore') {
        setRestoreIntent({ imagePath: payload.imagePath, mode: 'restore' });
        setCurrentPage('restore');
      } else {
        setBrowseIntent({ imagePath: payload.imagePath, autoMount: payload.verb === 'mount' });
        setCurrentPage('browse');
      }
    });
    return cleanup;
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'backup':
        return <BackupWizard onComplete={() => setCurrentPage('dashboard')} initialDestination={backupIntent?.destinationPath} initialAllDisks={backupIntent?.allDisks} activeProgress={lastBackupProgress} backupRunning={backupRunning} onViewImage={(imagePath) => { setBrowseIntent({ imagePath }); setCurrentPage('browse'); }} />;
      case 'restore':
        return (
          <RestoreWizard
            onComplete={() => setCurrentPage('dashboard')}
            initialImagePath={restoreIntent?.imagePath}
            mode={restoreIntent?.mode ?? 'restore'}
          />
        );
      case 'migrate':
        return <MigrateWizard onComplete={() => setCurrentPage('dashboard')} />;
      case 'copy':
        return <PartitionCopy onComplete={() => setCurrentPage('dashboard')} />;
      case 'disks':
        return <DiskTools onComplete={() => setCurrentPage('dashboard')} />;
      case 'repositories':
        return <Repositories />;
      case 'browse':
        return <BrowseView key={browseIntent?.imagePath ?? 'empty'} onComplete={() => setCurrentPage('dashboard')} initialImagePath={browseIntent?.imagePath} autoMount={browseIntent?.autoMount} />;
      case 'media':
        return <MediaView onComplete={() => setCurrentPage('dashboard')} />;
      case 'network':
        return (
          <NetworkView
            onStartBackup={(destinationPath, allDisks) => {
              setBackupIntent({ destinationPath, allDisks });
              setCurrentPage('backup');
            }}
          />
        );
      case 'logs':
        return <LogViewer onClose={() => setCurrentPage('dashboard')} />;
      case 'schedules':
        return <Schedules />;
      case 'builder':
        return <ConfigBuilder />;
      case 'vss':
        return <VssView />;
      case 'settings':
        return <Settings />;
      default:
        return (
          <Dashboard
            onLoaded={handleDashboardLoaded}
            onNavigate={(page, intent) => {
              if (page === 'restore' || page === 'clone') {
                setRestoreIntent({ imagePath: intent?.imagePath, mode: page });
                setCurrentPage('restore');
              } else if (page === 'browse' && intent?.imagePath) {
                setBrowseIntent({ imagePath: intent.imagePath });
                setCurrentPage('browse');
              } else {
                setCurrentPage(page);
              }
            }}
          />
        );
    }
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1>OPBS</h1>
          <p>Open Pickle Backup System</p>
        </div>
        
        <ul className="nav-menu">
          <li>
            <button
              className={`nav-item ${currentPage === 'dashboard' ? 'active' : ''}`}
              onClick={() => setCurrentPage('dashboard')}
            >
              <span className="nav-icon">📊</span>
              Dashboard
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'backup' ? 'active' : ''}`}
              onClick={() => setCurrentPage('backup')}
            >
              <span className="nav-icon">💾</span>
              New Backup
              {backupRunning && <span className="nav-badge">Running</span>}
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'restore' ? 'active' : ''}`}
              onClick={() => setCurrentPage('restore')}
            >
              <span className="nav-icon">♻️</span>
              Restore
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'migrate' ? 'active' : ''}`}
              onClick={() => setCurrentPage('migrate')}
            >
              <span className="nav-icon">🚚</span>
              Migrate
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'copy' ? 'active' : ''}`}
              onClick={() => setCurrentPage('copy')}
            >
              <span className="nav-icon">📤</span>
              Partition Copy
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'disks' ? 'active' : ''}`}
              onClick={() => setCurrentPage('disks')}
            >
              <span className="nav-icon">🔧</span>
              Disk Tools
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'repositories' ? 'active' : ''}`}
              onClick={() => setCurrentPage('repositories')}
            >
              <span className="nav-icon">🗄️</span>
              Repositories
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'schedules' ? 'active' : ''}`}
              onClick={() => setCurrentPage('schedules')}
            >
              <span className="nav-icon">🕐</span>
              Schedules
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'builder' ? 'active' : ''}`}
              onClick={() => setCurrentPage('builder')}
            >
              <span className="nav-icon">📝</span>
              Config Builder
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'browse' ? 'active' : ''}`}
              onClick={() => setCurrentPage('browse')}
            >
              <span className="nav-icon">🗂️</span>
              Browse Files
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'media' ? 'active' : ''}`}
              onClick={() => setCurrentPage('media')}
            >
              <span className="nav-icon">💿</span>
              Recovery Media
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'vss' ? 'active' : ''}`}
              onClick={() => setCurrentPage('vss')}
            >
              <span className="nav-icon">🧊</span>
              Volume Shadow Copy
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'network' ? 'active' : ''}`}
              onClick={() => setCurrentPage('network')}
            >
              <span className="nav-icon">🌐</span>
              Network
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'logs' ? 'active' : ''}`}
              onClick={() => setCurrentPage('logs')}
            >
              <span className="nav-icon">📜</span>
              Logs
            </button>
          </li>
          <li>
            <button
              className={`nav-item ${currentPage === 'settings' ? 'active' : ''}`}
              onClick={() => setCurrentPage('settings')}
            >
              <span className="nav-icon">⚙️</span>
              Settings
            </button>
          </li>
        </ul>
        
        <div className="sidebar-footer">
          <button className="version-btn" onClick={() => window.electronAPI.showAbout()}>
            v{appVersion}
          </button>
          <button className="version-btn" onClick={() => void window.electronAPI.checkForUpdates()}>
            Check for updates
          </button>
        </div>
      </nav>
      
      <main className="main-content">
        {renderPage()}
      </main>

      <ToastHost />
      {recoveryNotice && (
        // ToastHost is fed only from main's activity events, so the startup
        // recovery report reuses the same toast classes (offset below the
        // ToastHost stack) and stays until dismissed — a restore result is
        // too important to auto-hide.
        <div className="toast-host" style={{ top: 'auto', bottom: 16, maxWidth: recoveryNotice.details?.length ? 560 : undefined }}>
          <div
            className={`toast ${recoveryNotice.kind === 'success' ? 'toast-success' : 'toast-error'}`}
          >
            <div className="toast-title">{recoveryNotice.title}</div>
            <div className="toast-body">{recoveryNotice.body}</div>
            {recoveryNotice.details?.length ? (
              <ul className="toast-list">
                {recoveryNotice.details.map((detail, index) => (
                  <li key={index}>{detail}</li>
                ))}
              </ul>
            ) : null}
            <button className="toast-close" onClick={() => setRecoveryNotice(null)}>
              ×
            </button>
          </div>
        </div>
      )}
      <AdkPrompt />

      {splashVisible && <SplashScreen />}
    </div>
  );
}

export default App;