import { useState, useEffect } from 'react';

interface MediaCheckReport {
  ok: boolean;
  arch: string;
  adkRoot: string | null;
  copype: string | null;
  makeWinPEMedia: string | null;
  dism: string | null;
  oscdimg: string | null;
  node: string | null;
  ready: boolean;
}

interface MediaCreateResult {
  ok: boolean;
  format: 'iso' | 'usb';
  output: string;
  arch: string;
  sizeBytes?: number;
  error?: string;
}

interface MediaViewProps {
  onComplete?: () => void;
}

function MediaView({ onComplete }: MediaViewProps) {
  const [report, setReport] = useState<MediaCheckReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [format, setFormat] = useState<'iso' | 'usb'>('iso');
  const [isoPath, setIsoPath] = useState('');
  const [usbDrive, setUsbDrive] = useState('');
  const [usbConfirmed, setUsbConfirmed] = useState(false);
  const [arch, setArch] = useState('amd64');
  const [restoreConfig, setRestoreConfig] = useState('');
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<MediaCreateResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.electronAPI.mediaCheck();
        setReport(r);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to check media tools');
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const handleSelectIso = async () => {
    const p = await window.electronAPI.selectSaveFile({
      filters: [{ name: 'ISO Image', extensions: ['iso'] }],
      name: 'opbs-winpe'
    });
    if (p) setIsoPath(p);
  };

  const handleSelectRestoreConfig = async () => {
    const p = await window.electronAPI.selectFile({
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (p) setRestoreConfig(p);
  };

  const handleCreate = async () => {
    setError('');
    setResult(null);
    setBuilding(true);
    try {
      const options: any = {
        format,
        arch: arch as 'amd64' | 'arm64',
        output: format === 'iso' ? isoPath : usbDrive,
        restoreConfig: restoreConfig || undefined
      };
      if (format === 'usb') {
        options.yesForUsb = true;
      }
      const r = await window.electronAPI.mediaCreate(options);
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? 'Media creation failed');
    } finally {
      setBuilding(false);
    }
  };

  const canCreate =
    !building &&
    report?.ready &&
    (format === 'iso' ? !!isoPath : !!usbDrive && usbConfirmed);

  return (
    <div className="media-view">
      <div className="wizard-header">
        <h1>Recovery Media</h1>
        <p className="field-hint">
          Build a bootable WinPE image with the OPBS restore tool bundled, so you can
          recover a machine without an installed copy of OPBS.
        </p>
      </div>

      {checking ? (
        <p>Checking media tools…</p>
      ) : (
        <div className="settings-section">
          <h2>Tools Check</h2>
          {report?.ready ? (
            <div className="success-message">
              <p>Ready — Windows ADK (WinPE) and a bundled Node runtime were found.</p>
            </div>
          ) : (
            <div className="error-message">
              <p>
                WinPE ADK tools are not available. Install the Windows ADK with the Windows
                Preinstallation Environment component, then retry.
              </p>
            </div>
          )}
          <div className="setting-item">
            <label>ADK root:</label>
            <span className="mono-value">{report?.adkRoot ?? '(not found)'}</span>
          </div>
          <div className="setting-item">
            <label>Bundled Node.exe:</label>
            <span className="mono-value">{report?.node ?? '(not found)'}</span>
          </div>
          <div className="setting-item">
            <label>Architecture:</label>
            <select value={arch} onChange={(e) => setArch(e.target.value)}>
              <option value="amd64">amd64 (x64)</option>
              <option value="arm64">arm64</option>
            </select>
          </div>
        </div>
      )}

      <div className="settings-section">
        <h2>Media Format</h2>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="radio"
              name="format"
              checked={format === 'iso'}
              onChange={() => setFormat('iso')}
            />
            ISO image file
          </label>
        </div>
        {format === 'iso' && (
          <div className="setting-item">
            <label>Output:</label>
            <div className="path-input">
              <input type="text" value={isoPath} readOnly placeholder="Select an .iso path…" />
              <button onClick={handleSelectIso}>Browse</button>
            </div>
          </div>
        )}

        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="radio"
              name="format"
              checked={format === 'usb'}
              onChange={() => setFormat('usb')}
            />
            USB drive
          </label>
        </div>
        {format === 'usb' && (
          <>
            <div className="setting-item">
              <label>Drive letter:</label>
              <input
                type="text"
                value={usbDrive}
                onChange={(e) => setUsbDrive(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                placeholder="E"
                maxLength={1}
              />
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={usbConfirmed}
                  onChange={(e) => setUsbConfirmed(e.target.checked)}
                />
                I confirm this will erase the contents of drive {usbDrive || '…'}
              </label>
            </div>
          </>
        )}

        <div className="setting-item">
          <label>Pre-seed restore config (optional):</label>
          <div className="path-input">
            <input
              type="text"
              value={restoreConfig}
              readOnly
              placeholder="OPBS-restore.json to run automatically…"
            />
            <button onClick={handleSelectRestoreConfig}>Browse</button>
          </div>
          <p className="field-hint">
            If set, the media boots and runs this restore automatically instead of prompting.
          </p>
        </div>

        {error && (
          <div className="error-message">
            <p>{error}</p>
          </div>
        )}

        {result && (
          result.ok ? (
            <div className="success-message">
              <p>
                Recovery media written: {result.output}
                {result.sizeBytes ? ` (${formatBytes(result.sizeBytes)})` : ''}
              </p>
            </div>
          ) : (
            <div className="error-message">
              <p>Media creation failed: {result.error}</p>
            </div>
          )
        )}

        <div className="wizard-actions">
          {onComplete && (
            <button className="btn-secondary" onClick={onComplete}>
              Back
            </button>
          )}
          <button className="btn-primary" disabled={!canCreate} onClick={() => void handleCreate()}>
            {building ? 'Building…' : format === 'iso' ? 'Create ISO' : 'Create USB Drive'}
          </button>
        </div>

        <p className="field-hint">
          Building requires a single administrator confirmation for the ADK tooling (copype/DISM).
        </p>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export default MediaView;