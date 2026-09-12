import { useState, useEffect } from 'react';

interface VssServiceState {
  service: string;
  displayName: string;
  state: string;
  stateCode: number;
  startType: string;
  running: boolean;
  queryError?: string;
}

interface VssWriterInfo {
  name: string;
  id?: string;
  instanceId?: string;
  state: string;
  stateCode: number;
  lastError: string;
}

interface VssProviderInfo {
  name: string;
  type?: string;
  id?: string;
  version?: string;
}

interface VssInspectResult {
  operation: 'writers';
  ok: boolean;
  writers: VssWriterInfo[];
  providers: VssProviderInfo[];
  errors: string[];
}

interface VssSmokeResult {
  operation: 'smoke-test';
  ok: boolean;
  volume?: string;
  id?: string;
  devicePath?: string;
  durationMs?: number;
  deleted?: boolean;
  deleteError?: string;
  error?: string;
}

interface VssRepairResult {
  operation: 'repair';
  ok: boolean;
  results: Array<{ dll: string; ok: boolean; skipped?: boolean; error?: string }>;
  service?: { running: boolean; state?: string; startError?: string };
  error?: string;
}

interface VssServiceControlResult {
  operation: 'start' | 'stop';
  ok: boolean;
  already?: string;
  message?: string;
  service?: { running: boolean; state?: string; startError?: string };
  error?: string;
}

interface VssViewProps {
  onComplete?: () => void;
}

function VssView({ onComplete }: VssViewProps) {
  const [status, setStatus] = useState<VssServiceState | null>(null);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [selectedVolume, setSelectedVolume] = useState('');
  const [inspect, setInspect] = useState<VssInspectResult | null>(null);
  const [smoke, setSmoke] = useState<VssSmokeResult | null>(null);
  const [repair, setRepair] = useState<VssRepairResult | null>(null);
  const [control, setControl] = useState<VssServiceControlResult | null>(null);
  const [busy, setBusy] = useState<{ kind: string; label: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | 'stop' | 'start' | 'repair'>(null);
  const [error, setError] = useState('');

  const loadStatus = async () => {
    try {
      setStatus(await window.electronAPI.getVssStatus());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to query the VSS service');
    }
  };

  const loadVolumes = async () => {
    try {
      const vols = await window.electronAPI.getVssVolumes();
      setVolumes(vols);
      setSelectedVolume((prev) => (prev && vols.includes(prev) ? prev : vols[0] ?? ''));
    } catch {
      /* leave empty */
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await window.electronAPI.getVssStatus());
      } catch (e: any) {
        setError(e?.message ?? 'Failed to query the VSS service');
      }
    })();
    void (async () => {
      try {
        const vols = await window.electronAPI.getVssVolumes();
        setVolumes(vols);
        setSelectedVolume((prev) => (prev && vols.includes(prev) ? prev : vols[0] ?? ''));
      } catch {
        /* leave empty */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runInspect = async () => {
    setInspect(null);
    setBusy({ kind: 'inspect', label: 'Inspecting VSS writers and providers…' });
    setError('');
    try {
      const r = await window.electronAPI.inspectVss();
      setInspect(r);
      setControl(null);
    } catch (e: any) {
      setError(e?.message ?? 'VSS inspection failed');
    } finally {
      setBusy(null);
    }
  };

  const runSmokeTest = async () => {
    if (!selectedVolume) return;
    setSmoke(null);
    setBusy({ kind: 'smoke', label: `Creating a shadow copy of ${selectedVolume}…` });
    setError('');
    try {
      const r = await window.electronAPI.vssSmokeTest(selectedVolume);
      setSmoke(r);
      setControl(null);
    } catch (e: any) {
      setError(e?.message ?? 'Snapshot smoke test failed');
    } finally {
      setBusy(null);
    }
  };

  const runServiceControl = async (action: 'start' | 'stop') => {
    setConfirmAction(null);
    setControl(null);
    setBusy({ kind: 'control', label: action === 'start' ? 'Starting the VSS service…' : 'Stopping the VSS service…' });
    setError('');
    try {
      const r = await window.electronAPI.vssServiceControl(action);
      setControl(r);
      await loadStatus();
    } catch (e: any) {
      setError(e?.message ?? `Failed to ${action} the VSS service`);
    } finally {
      setBusy(null);
    }
  };

  const runRepair = async () => {
    setConfirmAction(null);
    setRepair(null);
    setBusy({ kind: 'repair', label: 'Re-registering VSS DLLs and ensuring the service…' });
    setError('');
    try {
      const r = await window.electronAPI.vssRepair();
      setRepair(r);
      await loadStatus();
    } catch (e: any) {
      setError(e?.message ?? 'VSS repair failed');
    } finally {
      setBusy(null);
    }
  };

  const stateBadge = (state: string, running: boolean) => {
    if (running) return <span className="badge badge-ok">Running</span>;
    if (/STOPPED|DISABLED/.test(state)) return <span className="badge badge-err">{state}</span>;
    return <span className="badge badge-warn">{state}</span>;
  };

  const writerBadge = (w: VssWriterInfo) => {
    const stable = w.stateCode === 1 && /no error/i.test(w.lastError);
    if (stable) return <span className="badge badge-ok">Stable</span>;
    if (w.stateCode === 1) return <span className="badge badge-warn">Stable (last error)</span>;
    return <span className="badge badge-err">{w.stateCode === 0 ? 'Unknown' : w.state}</span>;
  };

  const confirm = (action: 'stop' | 'start' | 'repair'): void => {
    if (confirmAction === action) {
      if (action === 'repair') void runRepair();
      else void runServiceControl(action);
    } else {
      setConfirmAction(action);
      window.setTimeout(() => setConfirmAction((prev) => (prev === action ? null : prev)), 5000);
    }
  };

  return (
    <div className="vss-view">
      <div className="wizard-header">
        <h1>Volume Shadow Copy</h1>
        <p className="field-hint">
          Every OPBS backup reads its source through a VSS shadow copy. This page shows whether the VSS
          service is healthy and can create snapshots, re-register the core VSS DLLs after a broken
          install, and start or stop the service. Anything that changes the system runs only after you
          confirm and is executed through a Windows administrator prompt.
        </p>
      </div>

      {error && (
        <div className="error-message">
          <p>{error}</p>
        </div>
      )}

      <div className="settings-section">
        <h2>Service</h2>
        <div className="setting-item">
          <label>State:</label>
          {status ? (
            <span>
              {stateBadge(status.state, status.running)}
              <span className="mono-value"> start type: {status.startType}</span>
            </span>
          ) : (
            <span>…</span>
          )}
        </div>
        {status?.queryError && (
          <div className="error-message">
            <p>Could not query the service: {status.queryError}</p>
          </div>
        )}
        <div className="wizard-actions">
          <button className="btn-secondary btn-small" onClick={() => void loadStatus()} disabled={busy != null}>
            Refresh
          </button>
          <button
            className="btn-secondary btn-small"
            disabled={busy != null || !status || status.running}
            onClick={() => confirm('start')}
          >
            {busy?.kind === 'control' ? '…' : confirmAction === 'start' ? 'Start — confirm?' : 'Start service'}
          </button>
          <button
            className="btn-danger btn-small"
            disabled={busy != null || !status || !status.running}
            onClick={() => confirm('stop')}
          >
            {busy?.kind === 'control' ? '…' : confirmAction === 'stop' ? 'Stop — confirm?' : 'Stop service'}
          </button>
        </div>
        {control && (
          control.ok ? (
            <div className="success-message">
              <p>{control.message ?? (control.already ? `Already ${control.already}.` : 'Done.')}</p>
            </div>
          ) : (
            <div className="error-message">
              <p>{control.error}</p>
            </div>
          )
        )}
      </div>

      <div className="settings-section">
        <h2>Writers &amp; Providers</h2>
        <p className="field-hint">
          Lists the VSS writers publishers and storage providers registered on this machine. A writer in a
          non-stable state or with a last error is often the reason shadow copies fail — re-registering below
          usually clears it.
        </p>
        <div className="wizard-actions">
          <button className="btn-secondary btn-small" disabled={busy != null} onClick={() => void runInspect()}>
            {busy?.kind === 'inspect' ? 'Waiting for administrator confirmation…' : 'Inspect writers'}
          </button>
        </div>
        {inspect && inspect.writers.length === 0 && inspect.providers.length === 0 && (
          <div className="error-message">
            <p>Nothing returned: {inspect.errors.join('; ') || 'no writers or providers found.'}</p>
          </div>
        )}
        {inspect && inspect.writers.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Writer</th>
                <th>State</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {inspect.writers.map((w, i) => (
                <tr key={`${w.name}-${i}`}>
                  <td>{w.name}</td>
                  <td>{writerBadge(w)}</td>
                  <td className="mono-value">{w.lastError || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {inspect && inspect.providers.length > 0 && (
          <div className="setting-item">
            <label>Providers:</label>
            <ul>
              {inspect.providers.map((p, i) => (
                <li key={`${p.name}-${i}`}>
                  <span className="mono-value">{p.name}</span>
                  {p.version ? ` (v${p.version})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h2>Snapshot smoke test</h2>
        <p className="field-hint">
          Creates a shadow copy of the chosen volume, then immediately deletes it. Proves the whole path —
          service, providers and writers — actually works end to end. Nothing is kept afterwards.
        </p>
        <div className="setting-item">
          <label>Volume:</label>
          <select value={selectedVolume} onChange={(e) => setSelectedVolume(e.target.value)}>
            {volumes.length === 0 && <option value="">(no volumes found)</option>}
            {volumes.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="wizard-actions">
          <button className="btn-secondary btn-small" disabled={busy != null || !selectedVolume} onClick={() => void runSmokeTest()}>
            {busy?.kind === 'smoke' ? busy.label : 'Create & delete snapshot'}
          </button>
        </div>
        {smoke &&
          (smoke.ok ? (
            <div className="success-message">
              <p>
                Snapshot OK {smoke.volume ? `on ${smoke.volume}` : ''} in {smoke.durationMs ?? '?'} ms — {smoke.devicePath} and{' '}
                {smoke.deleted ? '' : 'NOT '}deleted.
              </p>
            </div>
          ) : (
            <div className="error-message">
              <p>Snapshot test failed: {smoke.error ?? smoke.deleteError ?? 'unknown error'}</p>
            </div>
          ))}
      </div>

      <div className="settings-section">
        <h2>Repair</h2>
        <p className="field-hint">
          Re-registers the core VSS DLLs ({'vssapi.dll, vss_ps.dll, vsscore.dll, vsstrace.dll'}) with
          regsvr32 — the standard fix after an interrupted Windows Update or a system restore broke VSS —
          then starts the service if it is stopped. Files that do not exist on this system are skipped.
        </p>
        <div className="wizard-actions">
          <button className="btn-danger btn-small" disabled={busy != null} onClick={() => confirm('repair')}>
            {busy?.kind === 'repair' ? busy.label : confirmAction === 'repair' ? 'Re-register — confirm?' : 'Re-register VSS DLLs + ensure service'}
          </button>
        </div>
        {repair && (
          <div className="setting-item">
            <label>DLL re-registration:</label>
            <ul>
              {repair.results.map((r) => (
                <li key={r.dll}>
                  <span className="mono-value">{r.dll}</span>{' '}
                  {r.skipped ? <span className="drill-not-tested">(not present — skipped)</span> : r.ok ? <span className="badge badge-ok">ok</span> : <span className="badge badge-err">failed: {r.error ?? '?'}</span>}
                </li>
              ))}
            </ul>
            <p className="field-hint">
              Service: {repair.service?.running ? 'running' : repair.service ? 'not running' : 'unknown'}
              {repair.service?.startError ? ` — ${repair.service.startError}` : ''}
              {repair.error ? ` — ${repair.error}` : ''}
            </p>
          </div>
        )}
      </div>

      {onComplete && (
        <div className="wizard-actions">
          <button className="btn-secondary" onClick={onComplete}>
            Back
          </button>
        </div>
      )}

      <p className="field-hint">
        Inspect, smoke test, start/stop and repair each require a single administrator confirmation.
        Stopping the VSS service affects other programs that use shadow copies until it is restarted.
      </p>
    </div>
  );
}

export default VssView;