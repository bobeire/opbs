import { useState } from 'react';
import Dashboard from './components/Dashboard';
import BackupWizard from './components/BackupWizard';
import RestoreWizard from './components/RestoreWizard';
import Settings from './components/Settings';
import BrowseView from './components/BrowseView';
import MediaView from './components/MediaView';

type Page = 'dashboard' | 'backup' | 'restore' | 'browse' | 'media' | 'settings';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');

  const renderPage = () => {
    switch (currentPage) {
      case 'backup':
        return <BackupWizard onComplete={() => setCurrentPage('dashboard')} />;
      case 'restore':
        return <RestoreWizard onComplete={() => setCurrentPage('dashboard')} />;
      case 'browse':
        return <BrowseView onComplete={() => setCurrentPage('dashboard')} />;
      case 'media':
        return <MediaView onComplete={() => setCurrentPage('dashboard')} />;
      case 'settings':
        return <Settings />;
      default:
        return <Dashboard />;
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
        </div>
      </nav>
      
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}

export default App;
