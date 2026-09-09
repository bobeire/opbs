import { useState, useEffect } from 'react';

interface RestoreWizardProps {
  onComplete: () => void;
}

type WizardStep = 'select_image' | 'select_target' | 'options' | 'progress' | 'complete';

function RestoreWizard({ onComplete }: RestoreWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>('select_image');
  const [imagePath, setImagePath] = useState('');
  const [imageInfo, setImageInfo] = useState<any>(null);
  const [targetDiskIndex, setTargetDiskIndex] = useState<number | null>(null);
  const [targetPartitions, setTargetPartitions] = useState<number[]>([]);
  const [resizePartitions, setResizePartitions] = useState(true);
  const [applyDeltas, setApplyDeltas] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [progress, setProgress] = useState<any>(null);

  useEffect(() => {
    const cleanup = window.electronAPI.onRestoreProgress((p) => {
      setProgress(p);
    });
    return cleanup;
  }, []);

  const handleSelectImage = async () => {
    const path = await window.electronAPI.selectFile({
      filters: [
        { name: 'OPBS Images', extensions: ['opbs'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (path) {
      setImagePath(path);
      try {
        const info = await window.electronAPI.getImageInfo(path);
        setImageInfo(info);
      } catch (error) {
        console.error('Failed to read image info:', error);
        setImageInfo(null);
      }
    }
  };

  const handleStartRestore = async () => {
    setCurrentStep('progress');
    
    try {
      await window.electronAPI.startRestore({
        imagePath,
        targetDiskIndex: targetDiskIndex!,
        targetPartitions,
        verifyBeforeWrite: true,
        applyDeltas,
        ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {})
      });
      setCurrentStep('complete');
    } catch (error) {
      console.error('Restore failed:', error);
      setCurrentStep('select_image');
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

  const renderStep = () => {
    switch (currentStep) {
      case 'select_image':
        return (
          <div className="wizard-step">
            <h2>Select Backup Image</h2>
            
            <div className="image-selector">
              <div className="current-path">
                <label>Backup Image File:</label>
                <div className="path-input">
                  <input
                    type="text"
                    value={imagePath}
                    readOnly
                    placeholder="Select an image file..."
                  />
                  <button onClick={handleSelectImage}>Browse</button>
                </div>
              </div>
              
              {imageInfo && (
                <div className="image-info">
                  <h3>Image Information</h3>
                  <ul>
                    <li>Total Size: {formatSize(imageInfo.totalSize)}</li>
                    <li>Partitions: {imageInfo.partitions.length}</li>
                    <li>Backup Date: {new Date(imageInfo.backupDate).toLocaleDateString()}</li>
                    <li>
                      Type:{' '}
                      {imageInfo.incremental
                        ? `Incremental ${imageInfo.baseImagePath ? `(base: ${imageInfo.baseImagePath.split(/[\\/]/).pop()})` : ''}`
                        : 'Full'}
                    </li>
                    <li>Encryption: {imageInfo.encrypted ? 'AES-256-GCM' : 'None'}</li>
                  </ul>
                </div>
              )}
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={onComplete}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!imagePath || !imageInfo}
                onClick={() => setCurrentStep('select_target')}
              >
                Next
              </button>
            </div>
          </div>
        );
        
      case 'select_target':
        return (
          <div className="wizard-step">
            <h2>Select Target Disk</h2>
            
            <div className="target-disk-selector">
              <p className="warning-text">
                Warning: This will overwrite all data on the target disk!
              </p>
              
              <div className="disk-list">
                {/* TODO: Load actual disks */}
                <div
                  className={`disk-card ${targetDiskIndex === 0 ? 'selected' : ''}`}
                  onClick={() => setTargetDiskIndex(0)}
                >
                  <h3>Disk 0 - System Disk</h3>
                  <p>Size: 1 TB</p>
                  <p>Partitions: 2</p>
                </div>
              </div>
              
              {targetDiskIndex !== null && (
                <div className="partition-selection">
                  <h3>Select Target Partitions</h3>
                  <div className="partition-list">
                    {imageInfo?.partitions.map((partition: any) => (
                      <label key={partition.index} className="partition-item">
                        <input
                          type="checkbox"
                          checked={targetPartitions.includes(partition.index)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setTargetPartitions([...targetPartitions, partition.index]);
                            } else {
                              setTargetPartitions(
                                targetPartitions.filter((p) => p !== partition.index)
                              );
                            }
                          }}
                        />
                        <span className="partition-info">
                          Partition {partition.index}
                          {' - '}
                          {formatSize(partition.size)}
                          {' ('}
                          {partition.fsType}
                          {')'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_image')}>
                Back
              </button>
              <button
                className="btn-primary"
                disabled={targetDiskIndex === null || targetPartitions.length === 0}
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
            <h2>Restore Options</h2>
            
            <div className="options-form">
              {imageInfo?.incremental && (
                <div className="option-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={applyDeltas}
                      onChange={(e) => setApplyDeltas(e.target.checked)}
                    />
                    Include incremental deltas up to this image
                  </label>
                </div>
              )}

              <div className="option-group">
                <label>Encryption Passphrase:</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={imageInfo?.encrypted ? 'Required for encrypted image' : 'Optional'}
                />
              </div>

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={resizePartitions}
                    onChange={(e) => setResizePartitions(e.target.checked)}
                  />
                  Resize partitions to fit target disk
                </label>
              </div>
            </div>
            
            <div className="summary">
              <h3>Restore Summary</h3>
              <ul>
                <li>Source Image: {imagePath}</li>
                <li>Target Disk: Disk {targetDiskIndex}</li>
                <li>Partitions to Restore: {targetPartitions.length}</li>
                <li>Resize: {resizePartitions ? 'Yes' : 'No'}</li>
              </ul>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setCurrentStep('select_target')}>
                Back
              </button>
              <button className="btn-danger" onClick={handleStartRestore}>
                Start Restore
              </button>
            </div>
          </div>
        );
        
      case 'progress':
        return (
          <div className="wizard-step">
            <h2>Restore in Progress</h2>
            
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
              </div>
            </div>
            
            <div className="wizard-actions">
              <button className="btn-danger" onClick={() => window.electronAPI.cancelRestore()}>
                Cancel Restore
              </button>
            </div>
          </div>
        );
        
      case 'complete':
        return (
          <div className="wizard-step">
            <h2>Restore Complete</h2>
            
            <div className="success-message">
              <p>Your system has been restored successfully!</p>
              <p>Please restart your computer to complete the process.</p>
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
    <div className="restore-wizard">
      <div className="wizard-header">
        <h1>Restore Backup</h1>
        <div className="step-indicator">
          <span className={`step ${currentStep === 'select_image' ? 'active' : ''}`}>1</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'select_target' ? 'active' : ''}`}>2</span>
          <span className="step-line" />
          <span className={`step ${currentStep === 'options' ? 'active' : ''}`}>3</span>
        </div>
      </div>
      
      {renderStep()}
    </div>
  );
}

export default RestoreWizard;
