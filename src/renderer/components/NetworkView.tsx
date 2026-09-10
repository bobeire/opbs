import { useState, useEffect, useCallback } from 'react';

interface Machine {
  name: string;
  addresses: string[];
  services: string[];
}

interface Share {
  unc: string;
  name: string;
  kind: 'share' | 'admin';
  reachable: boolean;
  writable: boolean;
  remark?: string;
}

interface NetworkViewProps {
  onStartBackup: (destinationPath: string, allDisks: boolean) => void;
}

function NetworkView({ onStartBackup }: NetworkViewProps) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [openHost, setOpenHost] = useState<string | null>(null);
  const [sharesByHost, setSharesByHost] = useState<Map<string, Share[]>>(new Map());
  const [loadingShares, setLoadingShares] = useState<string | null>(null);
  const [pendingTest, setPendingTest] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, { ok: boolean; error?: string }>>(new Map());
  const [customPath, setCustomPath] = useState('');
  const [customResult, setCustomResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const res = await window.electronAPI.networkDiscover();
      setMachines(res.machines);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .networkDiscover()
      .then((res) => {
        if (!cancelled) setMachines(res.machines);
      })
      .catch(() => {
        if (!cancelled) setError('Discovery failed');
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleHost = async (host: string) => {
    if (openHost === host) {
      setOpenHost(null);
      return;
    }
    setOpenHost(host);
    if (sharesByHost.has(host)) return;
    setLoadingShares(host);
    try {
      const res = await window.electronAPI.networkShares(host);
      setSharesByHost((m) => {
        const next = new Map(m);
        next.set(host, res.shares);
        return next;
      });
    } catch {
      setSharesByHost((m) => {
        const next = new Map(m);
        next.set(host, []);
        return next;
      });
    } finally {
      setLoadingShares(null);
    }
  };

  const testShare = async (unc: string) => {
    setPendingTest(unc);
    const res = await window.electronAPI.networkTest(unc, true);
    setPendingTest(null);
    setTestResults((m) => {
      const next = new Map(m);
      next.set(unc, { ok: res.ok, error: res.error });
      return next;
    });
  };

  const applyDestination = (unc: string, allDisks: boolean) => {
    const dest = unc.endsWith('\\') ? unc + 'opbs' : unc + '\\opbs';
    onStartBackup(dest, allDisks);
  };

  const testCustom = async () => {
    setCustomResult(null);
    const res = await window.electronAPI.networkTest(customPath, true);
    setCustomResult(res.ok ? { ok: true } : { ok: false, error: res.error });
  };

  const stateFor = (unc: string) => testResults.get(unc);

  return (
    <div className="network-view">
      <div className="log-viewer-head">
        <h1>Network Destinations</h1>
        <div className="log-viewer-actions">
          <button className="btn-secondary btn-small" onClick={() => void discover()} disabled={discovering}>
            {discovering ? 'Discovering…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <p>{error}</p>
        </div>
      )}

      <p className="field-hint">
        Find computers on your local network that can receive backups, list their shared
        drives/folders, and use them as backup destinations. Back up a single partition, a
        whole disk, or your entire system to a central machine.
      </p>

      <div className="settings-section">
        <h2>Discovered machines</h2>
        {discovering && <div className="table-empty">Scanning the network…</div>}
        {!discovering && machines && machines.length === 0 && (
          <div className="table-empty">
            No machines found. You can still enter a UNC path or <code>smb://host/share</code>{' '}
            below to reach a computer that isn't auto-discoverable.
          </div>
        )}
        {!discovering && !machines && <div className="table-empty">Press Refresh to scan.</div>}

        {machines && machines.length > 0 && (
          <div className="net-machines">
            {machines.map((m) => (
              <div key={m.name} className="net-machine">
                <button className="net-machine-head" onClick={() => void toggleHost(m.name)}>
                  <span className="net-machine-name">{m.name}</span>
                  <span className="net-machine-meta">
                    {m.addresses.join(', ') || 'no address'}
                    {m.services.length > 0 ? ` · ${m.services.map((s) => s.replace(/^_/, '').replace(/\._tcp$/, '')).join(', ')}` : ''}
                  </span>
                  <span className="net-caret">{openHost === m.name ? '▾' : '▸'}</span>
                </button>
                {openHost === m.name && (
                  <div className="net-shares">
                    {loadingShares === m.name && <div className="table-empty">Listing shares…</div>}
                    {sharesByHost.get(m.name)?.length === 0 && !loadingShares && (
                      <div className="table-empty">No shares listed (hidden admin shares are probed below).</div>
                    )}
                    {sharesByHost.get(m.name)?.map((s) => {
                      const tr = stateFor(s.unc);
                      return (
                        <div key={s.unc} className="net-share">
                          <div className="net-share-main">
                            <span className={`share-dot ${s.reachable && s.writable ? 'ok' : ''}`} />
                            <code>{s.unc}</code>
                            <span className="share-kind">{s.kind === 'admin' ? 'admin share' : 'share'}</span>
                            {tr && tr.ok && <span className="share-ok">reachable &amp; writable</span>}
                            {tr && !tr.ok && <span className="share-bad">{tr.error ?? 'not writable'}</span>}
                          </div>
                          <div className="net-share-actions">
                            <button className="btn-secondary btn-small" onClick={() => void testShare(s.unc)}>
                              {pendingTest === s.unc ? 'Testing…' : 'Test'}
                            </button>
                            <button
                              className="btn-secondary btn-small"
                              disabled={!s.reachable && !s.writable}
                              onClick={() => applyDestination(s.unc, false)}
                            >
                              Backup here
                            </button>
                            <button
                              className="btn-primary btn-small"
                              disabled={!s.reachable && !s.writable}
                              onClick={() => applyDestination(s.unc, true)}
                            >
                              Central backup
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h2>Manual destination</h2>
        <p className="field-hint">
          Enter a UNC path such as <code>\\SERVER\Share</code>, <code>\\SERVER\Share\opbs</code>{' '}
          or an <code>smb://SERVER/share</code> URI. The folder is created if it doesn't exist.
        </p>
        <div className="path-input">
          <input
            type="text"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="\\\\SERVER\\Share\\opbs"
          />
          <button className="btn-secondary" onClick={() => void testCustom()} disabled={!customPath.trim()}>
            Test
          </button>
        </div>
        {customResult && (
          customResult.ok ? (
            <div className="success-message" style={{ marginTop: 8 }}>
              <p>Destination is reachable and writable.</p>
            </div>
          ) : (
            <div className="error-message" style={{ marginTop: 8 }}>
              <p>{customResult.error}</p>
            </div>
          )
        )}
        {customResult?.ok && (
          <div className="net-share-actions" style={{ marginTop: 10 }}>
            <button className="btn-primary" onClick={() => applyDestination(customPath, false)}>
              Backup here
            </button>
            <button className="btn-primary" onClick={() => applyDestination(customPath, true)}>
              Central backup (entire system)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default NetworkView;