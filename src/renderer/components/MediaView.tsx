import { useState, useEffect, useCallback } from 'react';

interface MediaCheckReport {
  ok: boolean;
  arch: string;
  adkRoot: string | null;
  copype: string | null;
  makeWinPEMedia: string | null;
  dism: string | null;
  oscdimg: string | null;
  winpeBitlocker: boolean;
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

interface MediaDriveOption {
  letter: string;
  volumeLabel: string;
  sizeBytes: number;
  busType: string;
  text: string;
}

interface MediaDriveGroups {
  primary: MediaDriveOption[];
  others: MediaDriveOption[];
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
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<MediaCreateResult | null>(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<'adk' | 'node' | null>(null);
  const [installError, setInstallError] = useState('');
  const [drives, setDrives] = useState<MediaDriveGroups | null>(null);
  const [drivesLoading, setDrivesLoading] = useState(false);
  const [drivesError, setDrivesError] = useState('');

  const loadDrives = useCallback(async () => {
    setDrivesLoading(true);
    setDrivesError('');
    try {
      const g = await window.electronAPI.mediaDrives();
      setDrives(g);
      setDrivesError(g?.error ?? '');
    } catch (e) {
      setDrivesError(e instanceof Error ? e.message : 'Failed to list drives');
    } finally {
      setDrivesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (format !== 'usb') return;
    // Deferred so loadDrives' initial setState doesn't run synchronously
    // inside the effect (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void loadDrives(), 0);
    return () => clearTimeout(timer);
  }, [format, loadDrives]);

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
    setProgress('');
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

  // Live build steps streamed from the elevated script (progress.txt), so the
  // multi-minute media build never looks frozen. Progress is cleared in
  // handleCreate (event context), not here — setState in an effect body is
  // a cascading-render hazard.
  useEffect(() => {
    if (!building) return;
    const off = window.electronAPI.onMediaProgress?.((p) => setProgress(p?.message ?? ''));
    return () => off?.();
  }, [building]);

  const refreshReport = async () => {
    try {
      const r = await window.electronAPI.mediaCheck();
      setReport(r);
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : 'Failed to re-check media tools');
    }
  };

  const handleInstall = async (kind: 'adk' | 'node') => {
    setInstallError('');
    setInstalling(kind);
    try {
      const r = kind === 'adk' ? await window.electronAPI.adkInstall({}) : await window.electronAPI.nodeInstall();
      if (!r?.ok) {
        setInstallError(r?.error ?? (kind === 'adk' ? 'ADK install failed.' : 'Node.js install failed.'));
      }
      await refreshReport();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : 'Install failed');
    } finally {
      setInstalling(null);
    }
  };

  const allDrives = drives ? [...drives.primary, ...drives.others] : [];
  const selectedDrive = allDrives.find((d) => d.letter === usbDrive);

  const canCreate =
    !building &&
    report?.ready &&
    (format === 'iso' ? !!isoPath : !!selectedDrive && usbConfirmed);

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
            <div className="media-missing">
              {(!report?.adkRoot || !report?.dism) && (
                <div className="error-message">
                  <p>
                    <strong>Windows ADK not found.</strong> Building recovery media needs the
                    Windows ADK with the Windows Preinstallation Environment (WinPE) add-on.
                  </p>
                  <button
                    className="btn-secondary"
                    disabled={!!installing}
                    onClick={() => void handleInstall('adk')}
                  >
                    {installing === 'adk' ? 'Installing ADK…' : 'Install ADK (silent)'}
                  </button>
                  {installing === 'adk' && (
                    <p className="field-hint">
                      Downloading (~1 GB) and installing — one administrator confirmation, a few minutes.
                    </p>
                  )}
                </div>
              )}
              {!report?.node && (
                <div className="error-message">
                  <p>
                    <strong>Node.js runtime not found.</strong> The recovery media boots and runs
                    node.exe — install the portable runtime (per-user, no admin rights needed).
                  </p>
                  <button
                    className="btn-secondary"
                    disabled={!!installing}
                    onClick={() => void handleInstall('node')}
                  >
                    {installing === 'node' ? 'Installing Node.js…' : 'Install Node.js (silent)'}
                  </button>
                  {installing === 'node' && (
                      <p className="field-hint">Downloading (~38 MB) — no confirmation needed.</p>
                  )}
                </div>
              )}
              {installError && (
                <div className="error-message">
                  <p>{installError}</p>
                </div>
              )}
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
          {report?.adkRoot && (
            <div className="setting-item">
              <label>WinPE BitLocker support:</label>
              <span className="mono-value">
                {report.winpeBitlocker ? 'Included (WinPE-SecureStartup)' : 'Not available (ADK component missing)'}
              </span>
            </div>
          )}
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
              <label>USB drive:</label>
              <div className="path-input">
                <select
                  value={selectedDrive ? usbDrive : ''}
                  onChange={(e) => {
                    setUsbDrive(e.target.value);
                    setUsbConfirmed(false);
                  }}
                >
                  <option value="" disabled>
                    {drivesLoading && !drives ? 'Listing drives…' : 'Select a drive…'}
                  </option>
                  {drives && drives.primary.length > 0 && (
                    <optgroup label="USB / removable drives">
                      {drives.primary.map((d) => (
                        <option key={d.letter} value={d.letter}>
                          {d.text}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {drives && drives.others.length > 0 && (
                    <optgroup label="Other drives — double-check before selecting">
                      {drives.others.map((d) => (
                        <option key={d.letter} value={d.letter}>
                          {d.text}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button onClick={() => void loadDrives()} disabled={drivesLoading}>
                  {drivesLoading ? 'Listing…' : 'Refresh'}
                </button>
              </div>
              {drivesError && <p className="field-hint">{drivesError}</p>}
              {!drivesLoading && !drivesError && drives && allDrives.length === 0 && (
                <p className="field-hint">No drives found — plug in the USB stick, then click Refresh.</p>
              )}
              <p className="field-hint">
                Pick the USB stick to turn into recovery media — it will be completely erased.
              </p>
            </div>
            {selectedDrive && (
              <div className="setting-item">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={usbConfirmed}
                    onChange={(e) => setUsbConfirmed(e.target.checked)}
                  />
                  I understand: erase everything on {selectedDrive.text}
                </label>
              </div>
            )}
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

        {building && (
          <p className="field-hint media-progress">
            {progress || 'Waiting for the elevated build step to start…'}
          </p>
        )}
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