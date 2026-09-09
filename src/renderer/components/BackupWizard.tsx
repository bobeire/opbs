import { useState, useEffect } from 'react';

interface DiskInfo {
  index: number;
  model: string;
  size: number;
  partitions: PartitionInfo[];
}

interface PartitionInfo {
  diskIndex: number;
  partitionIndex: number;
  driveLetter: string | null;
  label: string;
  fsType: string;
  size: number;
  usedSpace: number;
  isSystem: boolean;
  isBoot: boolean;
}

interface BackupConfig {
  sourceDiskIndex: number;
  sourcePartitions: number[];
  destinationPath: string;
  compressionLevel: number;
  compressionType?: 'deflate' | 'zstd';
  compressionThreads?: number;
  verificationEnabled: boolean;
  baseImagePath?: string;
  passphrase?: string;
}

interface BackupProgress {
  phase: string;
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
}

interface BackupWizardProps {
  onComplete: () => void;
}

type WizardStep = 'select_source' | 'select_destination' | 'options' | 'progress' | 'complete';

function BackupWizard({ onComplete }: BackupWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>('select_source');
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [selectedDisk, setSelectedDisk] = useState<DiskInfo | null>(null);
  const [selectedPartitions, setSelectedPartitions] = useState<number[]>([]);
  const [destinationPath, setDestinationPath] = useState('');
  const [compressionLevel, setCompressionLevel] = useState(3);
  const [compressionType, setCompressionType] = useState<'deflate' | 'zstd'>('zstd');
  const [compressionThreads, setCompressionThreads] = useState(() =>
    Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
  );
  const [verificationEnabled, setVerificationEnabled] = useState(true);
  const [incrementalEnabled, setIncrementalEnabled] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [baseImagePath, setBaseImagePath] = useState<string | undefined>(undefined);
  const [baseImageName, setBaseImageName] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadDisks();
    const cleanup = window.electronAPI.onBackupProgress((p) => {
      setProgress(p);
    });
    return cleanup;
  }, []);

  const loadDisks = async () => {
    try {
      const diskList = await window.electronAPI.getDisks();
      setDisks(diskList);
    } catch (error) {
      console.error('Failed to load disks:', error);
    } finally {
      setIsLoading(false);
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

  const handleSelectDestination = async () => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setDestinationPath(path);
      resolveNewestBase(path);
    }
  };

  const handleDestinationChange = (value: string) => {
    setDestinationPath(value);
    if (value.trim().startsWith('s3://') || value.trim().startsWith('sftp://')) {
      setBaseImagePath(undefined);
      setBaseImageName(undefined);
    } else if (value.trim()) {
      resolveNewestBase(value.trim());
    }
  };

  const resolveNewestBase = async (dir: string) => {
    try {
      const result = await window.electronAPI.listImages(dir);
      const newest = result?.entries?.[0];
      setBaseImagePath(newest?.path);
      setBaseImageName(newest?.name);
    } catch (error) {
      console.error('Failed to resolve base image:', error);
      setBaseImagePath(undefined);
      setBaseImageName(undefined);
    }
  };

  const handleStartBackup = async () => {
    setCurrentStep('progress');

    const config: BackupConfig = {
      sourceDiskIndex: selectedDisk!.index,
      sourcePartitions: selectedPartitions,
      destinationPath,
      compressionLevel,
      compressionType,
      compressionThreads,
      verificationEnabled,
      ...(incrementalEnabled && baseImagePath ? { baseImagePath } : {}),
      ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {})
    };

    try {
      await window.electronAPI.startBackup(config);
      setCurrentStep('complete');
    } catch (error) {
      console.error('Backup failed:', error);
      setCurrentStep('select_source');
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 'select_source':
        return (
          <div className="wizard-step">
            <h2>Select Source Disk</h2>
            
            {isLoading ? (
              <div className="loading">Loading disks...</div>
            ) : (
              <div className="disk-list">
                {disks.map((disk) => (
                  <div
                    key={disk.index}
                    className={`disk-card ${selectedDisk?.index === disk.index ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedDisk(disk);
                      setSelectedPartitions([]);
                    }}
                  >
                    <h3>{disk.model}</h3>
                    <p>Size: {formatSize(disk.size)}</p>
                    <p>Partitions: {disk.partitions.length}</p>
                  </div>
                ))}
              </div>
            )}
            
            {selectedDisk && (
              <div className="partition-selection">
                <h3>Select Partitions to Backup</h3>
                <div className="partition-list">
                  {selectedDisk.partitions.map((partition) => (
                    <label key={partition.partitionIndex} className="partition-item">
                      <input
                        type="checkbox"
                        checked={selectedPartitions.includes(partition.partitionIndex)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedPartitions([...selectedPartitions, partition.partitionIndex]);
                          } else {
                            setSelectedPartitions(
                              selectedPartitions.filter((p) => p !== partition.partitionIndex)
                            );
                          }
                        }}
                      />
                      <span className="partition-info">
                        {partition.driveLetter ? `${partition.driveLetter}:` : `Partition ${partition.partitionIndex}`}
                        {' - '}
                        {partition.label}
                        {' ('}
                        {formatSize(partition.size)}
                        {')'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={onComplete}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!selectedDisk || selectedPartitions.length === 0}
                onClick={() => setCurrentStep('select_destination')}
              >
                Next
              </button>
            </div>
          </div>
        );
        
      case 'select_destination':
        return (
          <div className="wizard-step">
            <h2>Select Destination</h2>
            
            <div className="destination-selector">
              <div className="current-path">
                <label>Destination:</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={destinationPath}
                    onChange={(e) => handleDestinationChange(e.target.value)}
                    placeholder="Local folder, s3://bucket/prefix or sftp://user@host/path"
                  />
                  <button onClick={handleSelectDestination}>Browse</button>
                </div>
                <p className="field-hint">
                  Use <code>s3://bucket/prefix</code> or <code>sftp://[user[:pass]@]host[:port]/path</code> to
                  upload the finished image with the cloud credentials configured in Settings.
                </p>
              </div>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_source')}>
                Back
              </button>
              <button
                className="btn-primary"
                disabled={!destinationPath}
                onClick={() => setCurrentStep('options')}
              >
                Next
              </button>
            </div>
          </div>
        );
        
      case 'options':
        return (
          <div className="wizard-step">
            <h2>Backup Options</h2>
            
            <div className="options-form">
              <div className="option-group">
                <label>Compression Level:</label>
                <select
                  value={compressionLevel}
                  onChange={(e) => setCompressionLevel(parseInt(e.target.value))}
                >
                  <option value={0}>None</option>
                  <option value={1}>Fast</option>
                  <option value={3}>Balanced</option>
                  <option value={6}>Best</option>
                  <option value={9}>Maximum</option>
                </select>
              </div>

              <div className="option-group">
                <label>Compression Method:</label>
                <select
                  value={compressionType}
                  onChange={(e) => setCompressionType(e.target.value as 'deflate' | 'zstd')}
                >
                  <option value="zstd">Zstandard (zstd)</option>
                  <option value="deflate">Deflate (zlib)</option>
                </select>
                <p className="field-hint">
                  Zstandard compresses faster and typically smaller; deflate is the classic fallback.
                </p>
              </div>

              <div className="option-group">
                <label>Compression Threads:</label>
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={compressionThreads}
                  onChange={(e) => setCompressionThreads(Math.max(0, parseInt(e.target.value) || 0))}
                />
                <p className="field-hint">1+ parallelizes compression across worker threads (0 disables).</p>
              </div>
              
              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={verificationEnabled}
                    onChange={(e) => setVerificationEnabled(e.target.checked)}
                  />
                  Verify backup after completion
                </label>
              </div>

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={incrementalEnabled}
                    onChange={(e) => setIncrementalEnabled(e.target.checked)}
                  />
                  Incremental backup (only changed blocks)
                </label>
                {incrementalEnabled && (
                  <p className="field-hint">
                    {baseImageName
                      ? `Base: ${baseImageName}`
                      : 'No existing image found - this will run as a full backup.'}
                  </p>
                )}
              </div>

              <div className="option-group">
                <label>Encryption Passphrase:</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Leave empty for no encryption"
                />
                <p className="field-hint">
                  AES-256-GCM per-block. The passphrase is required to verify or restore this backup.
                </p>
              </div>
            </div>
            
            <div className="summary">
              <h3>Backup Summary</h3>
              <ul>
                <li>Source Disk: {selectedDisk?.model}</li>
                <li>Partitions: {selectedPartitions.length}</li>
                <li>Destination: {destinationPath}</li>
                <li>Compression: Level {compressionLevel} ({compressionType}{compressionThreads > 1 ? `, ${compressionThreads} threads` : ''})</li>
                <li>Verification: {verificationEnabled ? 'Enabled' : 'Disabled'}</li>
                <li>Incremental: {incrementalEnabled && baseImagePath ? 'Enabled' : 'Full backup'}</li>
                <li>Encryption: {passphrase.trim() ? 'AES-256-GCM' : 'None'}</li>
              </ul>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_destination')}>
                Back
              </button>
              <button className="btn-primary" onClick={handleStartBackup}>
                Start Backup
              </button>
            </div>
          </div>
        );
        
      case 'progress':
        return (
          <div className="wizard-step">
            <h2>Backup in Progress</h2>
            
            <div className="progress-container">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progress?.percentComplete || 0}%` }}
                />
              </div>
              
              <div className="progress-info">
                <p>Phase: {progress?.phase || 'Preparing...'}</p>
                <p>Progress: {progress?.percentComplete || 0}%</p>
                {progress?.currentPartition && (
                  <p>Current Partition: {progress.currentPartition}</p>
                )}
              </div>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-danger" onClick={() => window.electronAPI.cancelBackup()}>
                Cancel Backup
              </button>
            </div>
          </div>
        );
        
      case 'complete':
        return (
          <div className="wizard-step">
            <h2>Backup Complete</h2>
            
            <div className="success-message">
              <p>Your backup has been created successfully!</p>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-primary" onClick={onComplete}>
                Done
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="backup-wizard">
      <div className="wizard-header">
        <h1>Create New Backup</h1>
        <div className="step-indicator">
          <span className={`step ${currentStep === 'select_source' ? 'active' : ''}`}>1</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'select_destination' ? 'active' : ''}`}>2</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'options' ? 'active' : ''}`}>3</span>
        </div>
      </div>
      
      {renderStep()}
    </div>
  );
}

export default BackupWizard;
