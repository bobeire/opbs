import { useEffect, useState } from 'react';

type Tab = 'mbr' | 'check' | 'trim' | 'smart';

function DiskTools({ onComplete }: { onComplete: () => void }) {
  const [tab, setTab] = useState<Tab>('mbr');
  const [disks, setDisks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // MBR state
  const [selectedDisk, setSelectedDisk] = useState<number | null>(null);
  const [mbrInfo, setMbrInfo] = useState<any | null>(null);
  const [mbrRaw, setMbrRaw] = useState<any | null>(null);
  const [mbrLoading, setMbrLoading] = useState(false);
  const [bootAction, setBootAction] = useState<string | null>(null);
  const [bootResult, setBootResult] = useState<any | null>(null);
  const [bootConfirm, setBootConfirm] = useState<string | null>(null);
  const [bootBusy, setBootBusy] = useState(false);

  // Chkdsk state
  const [chkdskVolume, setChkdskVolume] = useState('C:');
  const [chkdskMode, setChkdskMode] = useState<string | null>(null);
  const [chkdskResult, setChkdskResult] = useState<any | null>(null);
  const [chkdskBusy, setChkdskBusy] = useState(false);

  // TRIM state
  const [trimStatus, setTrimStatus] = useState<any | null>(null);
  const [trimBusy, setTrimBusy] = useState(false);
  const [retrimResult, setRetrimResult] = useState<any | null>(null);
  const [retrimVolume, setRetrimVolume] = useState('C:');

  // SMART state
  const [smart, setSmart] = useState<any[]>([]);
  const [smartLoading, setSmartLoading] = useState(false);

  useEffect(() => {
    void window.electronAPI.getDisks().then((list) => {
      setDisks(list);
      if (list.length > 0 && selectedDisk === null) setSelectedDisk(list[0].index);
      setLoading(false);
    });
  }, []);

  const loadSmart = async () => {
    setSmartLoading(true);
    try {
      const result = await (window.electronAPI as any).getSmartAllDisks();
      setSmart(result);
    } catch { /* ignore */ }
    setSmartLoading(false);
  };

  useEffect(() => {
    if (tab !== 'smart' || smart.length > 0) return;
    let cancelled = false;
    (window.electronAPI as any).getSmartAllDisks().then((result: any[]) => {
      if (!cancelled) setSmart(result);
    }).catch(() => { /* ignore */ }).finally(() => {
      if (!cancelled) setSmartLoading(false);
    });
    return () => { cancelled = true; };
  }, [tab]);

  const formatSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) { size /= 1024; unitIndex++; }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const readMbr = async () => {
    if (selectedDisk === null) return;
    setMbrLoading(true);
    setMbrRaw(null);
    try {
      const info = await (window.electronAPI as any).getMbrInfo(selectedDisk);
      setMbrInfo(info);
    } catch (e: any) { setMbrInfo({ ok: false, error: e?.message }); }
    setMbrLoading(false);
  };

  const readMbrRaw = async () => {
    if (selectedDisk === null) return;
    setMbrLoading(true);
    setMbrInfo(null);
    try {
      const raw = await (window.electronAPI as any).getMbrRaw(selectedDisk);
      setMbrRaw(raw);
    } catch (e: any) { setMbrRaw({ ok: false, error: e?.message }); }
    setMbrLoading(false);
  };

  const runBootRec = async (action: 'fixmbr' | 'rebuildbcd') => {
    if (bootConfirm !== action) { setBootConfirm(action); return; }
    setBootConfirm(null);
    setBootBusy(true);
    setBootAction(action);
    try {
      const result = await (window.electronAPI as any)[action === 'fixmbr' ? 'bootRecFixMbr' : 'bootRecRebuildBcd']();
      setBootResult(result);
    } catch (e: any) { setBootResult({ ok: false, error: e?.message, action }); }
    setBootBusy(false);
  };

  const runChkdsk = async (mode: 'scan' | 'fix' | 'bad-sectors') => {
    if (mode !== 'scan' && bootConfirm !== `chkdsk-${mode}`) { setBootConfirm(`chkdsk-${mode}`); return; }
    setBootConfirm(null);
    setChkdskBusy(true);
    setChkdskMode(mode);
    try {
      const result = await (window.electronAPI as any)[`chkdsk${mode === 'scan' ? 'Scan' : mode === 'fix' ? 'Fix' : 'BadSectors'}`](chkdskVolume);
      setChkdskResult(result);
    } catch (e: any) { setChkdskResult({ ok: false, error: e?.message }); }
    setChkdskBusy(false);
  };

  const checkTrim = async () => {
    setTrimBusy(true);
    try {
      const result = await (window.electronAPI as any).getTrimStatus();
      setTrimStatus(result);
    } catch (e: any) { setTrimStatus({ ok: false, error: e?.message }); }
    setTrimBusy(false);
  };

  const runRetrim = async () => {
    if (bootConfirm !== 'retrim') { setBootConfirm('retrim'); return; }
    setBootConfirm(null);
    setTrimBusy(true);
    try {
      const result = await (window.electronAPI as any).retrimVolume(retrimVolume);
      setRetrimResult(result);
    } catch (e: any) { setRetrimResult({ ok: false, error: e?.message }); }
    setTrimBusy(false);
  };

  if (loading) return <div className="dashboard"><h1>Disk Tools</h1><p>Loading disks…</p></div>;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'mbr', label: 'MBR & Boot Repair' },
    { key: 'check', label: 'Disk Error Check' },
    { key: 'trim', label: 'SSD TRIM' },
    { key: 'smart', label: 'SMART Health' }
  ];

  return (
    <div className="dashboard">
      <h1>Disk Tools</h1>
      <div className="disk-tools-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`disk-tools-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'mbr' && (
        <div className="disk-tools-panel">
          <h2>MBR & Boot Repair</h2>
          <p className="disk-tools-note">
            Read the Master Boot Record from a disk, or repair boot code and rebuild the BCD store.
          </p>

          <div className="disk-tools-row">
            <label>Disk:</label>
            <select value={selectedDisk ?? ''} onChange={(e) => setSelectedDisk(parseInt(e.target.value, 10))}>
              {disks.map((d) => (
                <option key={d.index} value={d.index}>Disk {d.index} — {d.model || 'Unknown'} ({formatSize(d.size)})</option>
              ))}
            </select>
            <button className="btn-primary btn-small" disabled={mbrLoading || selectedDisk === null} onClick={() => void readMbr()}>
              {mbrLoading ? 'Reading…' : 'Read MBR Info'}
            </button>
            <button className="btn-secondary btn-small" disabled={mbrLoading || selectedDisk === null} onClick={() => void readMbrRaw()}>
              {mbrLoading ? 'Reading…' : 'Read Raw MBR (Elevated)'}
            </button>
          </div>

          {mbrInfo && (
            <div className="mbr-result">
              <h3>MBR Information</h3>
              {mbrInfo.ok === false ? (
                <div className="error-message"><p>{mbrInfo.error}</p></div>
              ) : (
                <div className="mbr-details">
                  <div className="mbr-row"><span className="mbr-label">Partition Style:</span> <strong>{mbrInfo.partitionStyle?.toUpperCase()}</strong></div>
                  {mbrInfo.diskSignature !== undefined && <div className="mbr-row"><span className="mbr-label">Disk Signature:</span> 0x{(mbrInfo.diskSignature >>> 0).toString(16).toUpperCase().padStart(8, '0')}</div>}
                  <div className="mbr-row"><span className="mbr-label">Partitions:</span> {mbrInfo.partitionCount}</div>
                  {mbrInfo.bootable !== undefined && <div className="mbr-row"><span className="mbr-label">Bootable Partition:</span> #{mbrInfo.bootable}</div>}

                  {mbrInfo.partitions.length > 0 && (
                    <div className="mbr-table-wrap">
                      <table className="mbr-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Active</th><th>Type</th><th>Offset</th><th>Size</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mbrInfo.partitions.map((p: any, i: number) => (
                            <tr key={i}>
                              <td>{p.index + 1}</td>
                              <td>{p.active ? '✓' : ''}</td>
                              <td>{p.typeLabel}</td>
                              <td>LBA {p.startLba}</td>
                              <td>{formatSize(p.sizeBytes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {mbrRaw && (
            <div className="mbr-result">
              <h3>Raw MBR Sector (Elevated)</h3>
              {mbrRaw.ok === false ? (
                <div className="error-message"><p>{mbrRaw.error}</p></div>
              ) : (
                <div className="mbr-details">
                  <div className="mbr-row"><span className="mbr-label">Boot Signature:</span> {mbrRaw.bootSignature} {mbrRaw.bootSignature === '0x55AA' ? '✓' : '— invalid'}</div>
                  <div className="mbr-row"><span className="mbr-label">Disk Signature:</span> {mbrRaw.diskSignatureHex}</div>
                  {mbrRaw.partitions.length > 0 && (
                    <table className="mbr-table">
                      <thead>
                        <tr><th>#</th><th>Active</th><th>Type</th><th>Start LBA</th><th>Sectors</th><th>Size</th><th>Start CHS</th><th>End CHS</th></tr>
                      </thead>
                      <tbody>
                        {mbrRaw.partitions.map((p: any, i: number) => (
                          <tr key={i}>
                            <td>{p.index + 1}</td>
                            <td>{p.active ? '✓' : ''}</td>
                            <td>{p.typeLabel}</td>
                            <td>{p.startLba.toLocaleString()}</td>
                            <td>{p.sectorCount.toLocaleString()}</td>
                            <td>{formatSize(p.sizeBytes)}</td>
                            <td>{p.startChs}</td>
                            <td>{p.endChs}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="disk-tools-section">
            <h3>Boot Repair</h3>
            <p className="disk-tools-note">Requires Windows Recovery Environment (WinRE). Run from recovery media or a bootable OPBS drive for best results.</p>
            <div className="disk-tools-actions">
              <button className="btn-danger btn-small" disabled={bootBusy} onClick={() => void runBootRec('fixmbr')}>
                {bootBusy && bootAction === 'fixmbr' ? 'Working…' : bootConfirm === 'fixmbr' ? 'Confirm — Fix MBR Boot Code' : 'Fix MBR Boot Code'}
              </button>
              <button className="btn-danger btn-small" disabled={bootBusy} onClick={() => void runBootRec('rebuildbcd')}>
                {bootBusy && bootAction === 'rebuildbcd' ? 'Working…' : bootConfirm === 'rebuildbcd' ? 'Confirm — Rebuild BCD Store' : 'Rebuild BCD Store'}
              </button>
            </div>
            {bootResult && bootResult.action !== 'chkdsk' && (
              <div className={`disk-tools-output ${bootResult.ok ? 'ok' : 'err'}`}>
                <p className="disk-tools-output-head">{bootResult.action?.toUpperCase()} — {bootResult.ok ? 'Success' : 'Failed'}</p>
                {bootResult.error && <p>{bootResult.error}</p>}
                {bootResult.output && <pre className="disk-tools-pre">{bootResult.output}</pre>}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'check' && (
        <div className="disk-tools-panel">
          <h2>Disk Error Check</h2>
          <p className="disk-tools-note">Scan a volume for filesystem errors. Scan is read-only and fast. Fix and bad-sector modes require elevation.</p>

          <div className="disk-tools-row">
            <label>Volume:</label>
            <input className="disk-tools-input" value={chkdskVolume} onChange={(e) => setChkdskVolume(e.target.value.toUpperCase())} placeholder="C:" />
            <button className="btn-primary btn-small" disabled={chkdskBusy} onClick={() => void runChkdsk('scan')}>
              {chkdskBusy && chkdskMode === 'scan' ? 'Scanning…' : 'Scan (Read-Only)'}
            </button>
            <button className="btn-secondary btn-small" disabled={chkdskBusy} onClick={() => void runChkdsk('fix')}>
              {chkdskBusy && chkdskMode === 'fix' ? 'Fixing…' : bootConfirm === 'chkdsk-fix' ? 'Confirm — Fix Errors (Elevated)' : 'Fix Errors (Elevated)'}
            </button>
            <button className="btn-danger btn-small" disabled={chkdskBusy} onClick={() => void runChkdsk('bad-sectors')}>
              {chkdskBusy && chkdskMode === 'bad-sectors' ? 'Scanning…' : bootConfirm === 'chkdsk-bad-sectors' ? 'Confirm — Bad Sector Scan (Slow)' : 'Bad Sector Scan (Slow, Elevated)'}
            </button>
          </div>

          {bootConfirm && bootConfirm.startsWith('chkdsk-') && (
            <div className="disk-tools-confirm-note">
              Click again to confirm. This requires administrator privileges.
            </div>
          )}

          {chkdskResult && (
            <div className={`disk-tools-output ${chkdskResult.ok ? 'ok' : 'err'}`}>
              <p className="disk-tools-output-head">{chkdskResult.mode?.toUpperCase()} on {chkdskResult.volume} — {chkdskResult.ok ? 'OK' : 'Error'}</p>
              {chkdskResult.error && <p>{chkdskResult.error}</p>}
              {chkdskResult.output && <pre className="disk-tools-pre">{chkdskResult.output}</pre>}
            </div>
          )}
        </div>
      )}

      {tab === 'trim' && (
        <div className="disk-tools-panel">
          <h2>SSD TRIM</h2>
          <p className="disk-tools-note">TRIM tells the SSD which blocks are no longer in use, helping maintain write performance.</p>

          <div className="disk-tools-row">
            <button className="btn-primary btn-small" disabled={trimBusy} onClick={() => void checkTrim()}>
              {trimBusy ? 'Checking…' : 'Check TRIM Status'}
            </button>
          </div>

          {trimStatus && (
            <div className={`disk-tools-output ${trimStatus.ok ? 'ok' : 'err'}`}>
              <p className="disk-tools-output-head">
                TRIM Status: {trimStatus.ok ? (trimStatus.enabled ? 'Enabled ✓' : 'Disabled ✗') : 'Error'}
              </p>
              {trimStatus.error && <p>{trimStatus.error}</p>}
              {trimStatus.output && <pre className="disk-tools-pre">{trimStatus.output}</pre>}
            </div>
          )}

          <div className="disk-tools-section">
            <h3>Manual Retrim</h3>
            <p className="disk-tools-note">Runs a retrim on the specified volume to reclaim deleted blocks.</p>
            <div className="disk-tools-row">
              <label>Volume:</label>
              <input className="disk-tools-input" value={retrimVolume} onChange={(e) => setRetrimVolume(e.target.value.toUpperCase())} placeholder="C:" />
              <button className="btn-danger btn-small" disabled={trimBusy} onClick={() => void runRetrim()}>
                {trimBusy ? 'Running…' : bootConfirm === 'retrim' ? 'Confirm — Run Retrim (Elevated)' : 'Run Retrim (Elevated)'}
              </button>
            </div>
            {retrimResult && (
              <div className={`disk-tools-output ${retrimResult.ok ? 'ok' : 'err'}`}>
                <p className="disk-tools-output-head">Retrim — {retrimResult.ok ? 'OK' : 'Error'}</p>
                {retrimResult.error && <p>{retrimResult.error}</p>}
                {retrimResult.output && <pre className="disk-tools-pre">{retrimResult.output}</pre>}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'smart' && (
        <div className="disk-tools-panel">
          <h2>SMART Health</h2>
          <p className="disk-tools-note">Per-disk health data from the Windows Storage Reliability Counter. Elevation may be required for some drives.</p>
          <div className="disk-tools-row">
            <button className="btn-primary btn-small" disabled={smartLoading} onClick={() => void loadSmart()}>
              {smartLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {smart.length > 0 && (
            <div className="mbr-table-wrap">
              <table className="mbr-table smart-table">
                <thead>
                  <tr>
                    <th>Disk</th>
                    <th>Model</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Temp</th>
                    <th>Wear</th>
                    <th>Bad Sectors</th>
                    <th>Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {smart.map((s: any) => (
                    <tr key={s.diskIndex}>
                      <td>{s.diskIndex}</td>
                      <td>{s.model}</td>
                      <td>{formatSize(s.size)}</td>
                      <td>
                        <span className={s.reliable ? 'badge-ok' : 'badge-err'}>
                          {s.reliable ? 'OK' : 'Warning'}
                        </span>
                      </td>
                      <td>{s.temperatureCelsius != null ? `${s.temperatureCelsius}°C` : '—'}</td>
                      <td>{s.wear != null ? `${s.wear}%` : '—'}</td>
                      <td>{s.unreliableSectors != null ? s.unreliableSectors : '—'}</td>
                      <td>{s.warnings?.length > 0 ? s.warnings.join('; ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {smart.length === 0 && !smartLoading && (
            <p className="disk-tools-note">No disks found or unable to query health data.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default DiskTools;
