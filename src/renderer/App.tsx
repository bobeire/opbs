import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import BackupWizard from './components/BackupWizard';
import RestoreWizard from './components/RestoreWizard';
import Settings from './components/Settings';
import Schedules from './components/Schedules';
import VssView from './components/VssView';
import BrowseView from './components/BrowseView';
import MediaView from './components/MediaView';
import LogViewer from './components/LogViewer';
import NetworkView from './components/NetworkView';
import ToastHost from './components/ToastHost';
import AdkPrompt from './components/AdkPrompt';

type Page = 'dashboard' | 'backup' | 'restore' | 'browse' | 'media' | 'schedules' | 'network' | 'logs' | 'vss' | 'settings';

interface BackupIntent {
  destinationPath?: string;
  allDisks?: boolean;
}

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [backupIntent, setBackupIntent] = useState<BackupIntent | null>(null);
  const [restoreIntent, setRestoreIntent] = useState<{ imagePath?: string; mode?: 'restore' | 'clone' } | null>(null);
  const [browseIntent, setBrowseIntent] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.checkForUpdates();
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onNav((page) => {
      if (page === 'backup' || page === 'restore' || page === 'schedules' || page === 'vss') setCurrentPage(page);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onOpenImage((payload) => {
      if (payload.verb === 'restore') {
        setRestoreIntent({ imagePath: payload.imagePath, mode: 'restore' });
        setCurrentPage('restore');
      } else {
        setBrowseIntent(payload.imagePath);
        setCurrentPage('browse');
      }
    });
    return cleanup;
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'backup':
        return <BackupWizard onComplete={() => setCurrentPage('dashboard')} initialDestination={backupIntent?.destinationPath} initialAllDisks={backupIntent?.allDisks} />;
      case 'restore':
        return (
          <RestoreWizard
            onComplete={() => setCurrentPage('dashboard')}
            initialImagePath={restoreIntent?.imagePath}
            mode={restoreIntent?.mode ?? 'restore'}
          />
        );
      case 'browse':
        return <BrowseView key={browseIntent ?? 'empty'} onComplete={() => setCurrentPage('dashboard')} initialImagePath={browseIntent ?? undefined} />;
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
      case 'vss':
        return <VssView />;
      case 'settings':
        return <Settings />;
      default:
        return (
          <Dashboard
            onNavigate={(page, intent) => {
              if (page === 'restore' || page === 'clone') {
                setRestoreIntent({ imagePath: intent?.imagePath, mode: page });
                setCurrentPage('restore');
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
              className={`nav-item ${currentPage === 'schedules' ? 'active' : ''}`}
              onClick={() => setCurrentPage('schedules')}
            >
              <span className="nav-icon">🕐</span>
              Schedules
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
            v0.1.0
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
      <AdkPrompt />
    </div>
  );
}

export default App;