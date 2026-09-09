import { useState, useEffect } from 'react';

interface BackupInfo {
  id: string;
  name: string;
  date: string;
  size: number;
  status: 'completed' | 'failed' | 'in_progress';
}

function Dashboard() {
  const [recentBackups, setRecentBackups] = useState<BackupInfo[]>([]);
  const [systemInfo, setSystemInfo] = useState({
    disks: 0,
    totalSpace: 0,
    usedSpace: 0
  });

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    // TODO: Load actual backup history and system info
    setRecentBackups([
      {
        id: '1',
        name: 'Full System Backup',
        date: new Date().toISOString(),
        size: 50000000000,
        status: 'completed'
      }
    ]);
    
    setSystemInfo({
      disks: 2,
      totalSpace: 1000000000000,
      usedSpace: 500000000000
    });
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

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
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
          <p className="stat-value">{recentBackups.length}</p>
        </div>
      </div>
      
      <div className="recent-backups">
        <h2>Recent Backups</h2>
        
        {recentBackups.length === 0 ? (
          <div className="empty-state">
            <p>No backups yet. Create your first backup!</p>
          </div>
        ) : (
          <table className="backup-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Date</th>
                <th>Size</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentBackups.map((backup) => (
                <tr key={backup.id}>
                  <td>{backup.name}</td>
                  <td>{formatDate(backup.date)}</td>
                  <td>{formatSize(backup.size)}</td>
                  <td>
                    <span className={`status-badge ${backup.status}`}>
                      {backup.status}
                    </span>
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
