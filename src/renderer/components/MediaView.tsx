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
  /** Dual-partition USB: letters of the FAT32 boot and NTFS data partitions. */
  bootLetter?: string;
  dataLetter?: string;
  error?: string;
}

interface MediaCreateOptions {
  format: 'iso' | 'usb';
  arch: 'amd64' | 'arm64';
  output: string;
  restoreConfig?: string;
  yesForUsb?: boolean;
  /** FAT32 boot + NTFS data partition (USB only). */
  dualPartition?: boolean;
  bootSizeMb?: number;
  copyToData?: string[];
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
  // Opt-in dual-partition layout (FAT32 boot + NTFS data); the default stays
  // the single FAT32 partition for the one-click flow.
  const [dualPartition, setDualPartition] = useState(false);
  const [bootSizeMb, setBootSizeMb] = useState('4096');
  const [dataFolder, setDataFolder] = useState('');
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
        const r: MediaCheckReport = await window.electronAPI.mediaCheck();
        setReport(r);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
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
      const options: MediaCreateOptions = {
        format,
        arch: arch as 'amd64' | 'arm64',
        output: format === 'iso' ? isoPath : usbDrive,
        restoreConfig: restoreConfig || undefined
      };
      if (format === 'usb') {
        options.yesForUsb = true;
        if (dualPartition) {
          options.dualPartition = true;
          const mb = Number(bootSizeMb);
          if (Number.isFinite(mb)) options.bootSizeMb = mb;
          if (dataFolder) options.copyToData = [dataFolder];
        }
      }
      const r: MediaCreateResult = await window.electronAPI.mediaCreate(options);
      setResult(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
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
      const r: MediaCheckReport = await window.electronAPI.mediaCheck();
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
  // Windows can only FAT32-format drives up to 32 GB, and the default build
  // formats the whole stick as FAT32 — larger sticks fail at the format step.
  // A dual-partition stick is FAT32 only on its small boot partition, so the
  // cap does not apply there.
  const FAT32_MAX_BYTES = 32 * 1024 * 1024 * 1024;
  const usbTooLarge = !!selectedDrive && selectedDrive.sizeBytes > FAT32_MAX_BYTES && !dualPartition;
  const bootMb = Number(bootSizeMb);
  const bootSizeInvalid = dualPartition && (!Number.isInteger(bootMb) || bootMb < 1024 || bootMb > 32768);

  const canCreate =
    !building &&
    report?.ready &&
    !bootSizeInvalid &&
    (format === 'iso' ? !!isoPath : !!selectedDrive && !usbTooLarge && usbConfirmed);

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
                The default media is a single FAT32 partition, which Windows cannot format above
                32 GB (and which cannot hold files over 4 GB). For a bigger stick — or to store
                backup images on it — use the dual-partition layout below.
              </p>
            </div>
            {usbTooLarge && (
              <div className="error-message">
                <p>
                  {selectedDrive.text} is larger than 32 GB — a single-partition build would fail
                  at the format step (Windows cannot FAT32-format drives above 32 GB). Turn on
                  the dual-partition layout below, use a 32 GB or smaller stick, or build an ISO
                  and write it to this drive with Rufus.
                </p>
              </div>
            )}
            {selectedDrive && (
              <>
                <div className="setting-item">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={dualPartition}
                      onChange={(e) => setDualPartition(e.target.checked)}
                    />
                    Dual-partition layout: FAT32 boot + NTFS data partition (optional)
                  </label>
                  <p className="field-hint">
                    Splits the stick into a small boot partition plus an NTFS data partition on
                    the rest of it, so backup images larger than 4 GB can live on the media. Boot
                    works the same way (UEFI and BIOS). Off by default: the classic single FAT32
                    partition is still the one-click path.
                  </p>
                </div>
                {dualPartition && (
                  <div className="setting-item">
                    <label>Boot partition size (MiB):</label>
                    <input
                      type="text"
                      value={bootSizeMb}
                      onChange={(e) => setBootSizeMb(e.target.value)}
                      placeholder="4096"
                    />
                    {bootSizeInvalid && (
                      <p className="error-text">Enter 1024–32768 MiB (default 4096).</p>
                    )}
                  </div>
                )}
                {dualPartition && (
                  <div className="setting-item">
                    <label>Copy backup images to the data partition (optional):</label>
                    <div className="path-input">
                      <input
                        type="text"
                        value={dataFolder}
                        readOnly
                        placeholder="A folder of .opbs / Macrium images…"
                      />
                      <button
                        onClick={async () => {
                          const p = await window.electronAPI.selectDirectory({
                            title: 'Choose a folder of backup images to copy'
                          });
                          if (p) setDataFolder(p);
                        }}
                      >
                        Browse
                      </button>
                    </div>
                    <p className="field-hint">
                      Copied into <code>OPBS-Images</code> on the NTFS partition, so the stick can
                      restore without another drive. Large folders take a while.
                    </p>
                  </div>
                )}
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
              </>
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
                {result.bootLetter && result.dataLetter
                  ? ` — boot ${result.bootLetter}:, data ${result.dataLetter}: (images in OPBS-Images)`
                  : ''}
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