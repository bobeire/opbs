import { useEffect, useState } from 'react';

type BusyAction = 'open' | 'init' | 'verify' | 'prune' | 'unlock' | 'anchor' | null;

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString();
}

function statusBadge(state: RepoImageStateInfo): { cls: string; label: string } {
  if (!state.filesPresent) return { cls: 'repo-badge repo-badge-err', label: '⚠ Files missing' };
  if (state.unlocked) return { cls: 'repo-badge repo-badge-warn', label: '🔓 Unlocked' };
  if (state.expired) {
    return {
      cls: 'repo-badge repo-badge-warn',
      label: state.lockUntil ? `Expired ${formatDate(state.lockUntil)}` : 'No lock'
    };
  }
  return { cls: 'repo-badge repo-badge-ok', label: `🔒 Locked until ${formatDate(state.lockUntil ?? '')}` };
}

function Repositories() {
  const [dir, setDir] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [overview, setOverview] = useState<RepoOpenResult | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verifyReport, setVerifyReport] = useState<RepoVerifyResult | null>(null);
  const [pruneResult, setPruneResult] = useState<RepoPruneResult | null>(null);
  const [initLockDays, setInitLockDays] = useState('30');
  const [remoteUri, setRemoteUri] = useState('');
  const [remoteLock, setRemoteLock] = useState<'' | 'GOVERNANCE' | 'COMPLIANCE'>('');
  const [anchorTarget, setAnchorTarget] = useState('');
  const [anchorStatus, setAnchorStatus] = useState('');
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [confirmUnlockAll, setConfirmUnlockAll] = useState(false);
  const [confirmUnlockRow, setConfirmUnlockRow] = useState('');

  // Streamed verify progress.
  useEffect(() => {
    if (busy !== 'verify') return;
    const off = window.electronAPI.onRepoProgress((p) => setProgress(p.message));
    return off;
  }, [busy]);

  // Remember the last opened repository and anchor target.
  useEffect(() => {
    void window.electronAPI.getSettings().then((settings) => {
      if (settings?.lastRepoDir) setDir(settings.lastRepoDir);
      if (settings?.lastRepoAnchorTarget) setAnchorTarget(settings.lastRepoAnchorTarget);
    });
  }, []);

  const fail = (message: string) => {
    setError(message);
    setNotice('');
  };

  const dirIsS3 = /^s3:\/\//i.test(dir.trim());

  const openRepo = async (showErrors = true): Promise<boolean> => {
    if (!dir) return false;
    setBusy('open');
    if (showErrors) {
      setError('');
      setNotice('');
    }
    try {
      const res = await window.electronAPI.repoOpen(dir);
      if (res.ok) {
        setOverview(res);
        if (showErrors) {
          setError('');
        }
        void window.electronAPI.updateSettings({ lastRepoDir: dir });
        return true;
      }
      setOverview(null);
      if (showErrors) fail(res.error ?? 'Failed to open repository');
      return false;
    } catch (caught) {
      setOverview(null);
      if (showErrors) fail(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const pickDir = async () => {
    const picked = await window.electronAPI.selectDirectory({ title: 'Select a repository directory' });
    if (picked) {
      setDir(picked);
      setOverview(null);
      setError('');
      setNotice('');
      setVerifyReport(null);
      setPruneResult(null);
    }
  };

  const initRepo = async () => {
    if (!dir) return;
    setBusy('init');
    setError('');
    setNotice('');
    try {
      const lockDays = Number(initLockDays);
      const uri = remoteUri.trim();
      const lockMode = remoteLock || undefined;
      // For an s3:// path the target IS the storage location — the mirror
      // input is hidden and only the lock mode matters; a typed mirror URI
      // that points elsewhere is rejected server-side.
      const remote = uri
        ? { uri, ...(remoteLock ? { lockMode } : {}) }
        : dirIsS3
          ? { uri: dir.trim(), ...(lockMode ? { lockMode } : {}) }
          : undefined;
      const res = await window.electronAPI.repoInit({
        dir,
        lockDays: Number.isFinite(lockDays) && lockDays >= 0 ? lockDays : undefined,
        passphrase: passphrase || undefined,
        ...(remote ? { remote } : {})
      });
      if (!res.ok) {
        fail(res.error ?? 'Initialization failed');
        return;
      }
      setNotice(
        `Repository initialized${res.keyfile ? ` — keyfile: ${res.keyfile} (BACK IT UP)` : ' (key derived from passphrase)'}.`
      );
      await openRepo(false);
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const runVerify = async (fast: boolean) => {
    if (!dir) return;
    setBusy('verify');
    setError('');
    setNotice('');
    setVerifyReport(null);
    setProgress('');
    try {
      const res = await window.electronAPI.repoVerify({
        dir,
        fast,
        passphrase: passphrase || undefined,
        anchorTarget: anchorTarget.trim() || undefined
      });
      setVerifyReport(res);
      if (res.error) setError(res.error);
      await openRepo(false);
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProgress('');
      setBusy(null);
    }
  };

  const runAnchor = async () => {
    const target = anchorTarget.trim();
    if (!dir || !target) return;
    setBusy('anchor');
    setError('');
    setNotice('');
    setAnchorStatus('');
    try {
      const res = await window.electronAPI.repoAnchor({ dir, target });
      if (!res.ok) {
        fail(res.error ?? 'Anchor failed');
        return;
      }
      setAnchorStatus(`Anchored through seq ${res.seq} at ${formatDate(res.anchoredAt ?? '')}`);
      setNotice(
        `Journal anchored off-box through seq ${res.seq} (${res.journalBytes} bytes) → ${res.target ?? target}.`
      );
      void window.electronAPI.updateSettings({ lastRepoAnchorTarget: target });
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const runPrune = async (dryRun: boolean) => {
    if (!dir) return;
    setBusy('prune');
    setError('');
    setNotice('');
    try {
      const res = await window.electronAPI.repoPrune({ dir, dryRun, passphrase: passphrase || undefined });
      if (!res.ok) {
        fail(res.error ?? 'Prune failed');
        setConfirmPrune(false);
        return;
      }
      setPruneResult(res);
      setConfirmPrune(!dryRun ? false : (res.eligible?.length ?? 0) > 0);
      if (dryRun) {
        setNotice(
          (res.eligible?.length ?? 0) > 0
            ? `${res.eligible?.length ?? 0} image(s) eligible for deletion — press "Confirm prune" to proceed.`
            : 'Nothing is eligible for pruning right now.'
        );
      } else {
        setNotice(`Pruned ${res.removed?.length ?? 0} image(s).`);
        await openRepo(false);
      }
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const runUnlock = async (target: string) => {
    if (!dir) return;
    setBusy('unlock');
    setError('');
    setNotice('');
    try {
      const res = await window.electronAPI.repoUnlock({ dir, target, passphrase: passphrase || undefined });
      if (!res.ok) {
        fail(res.error ?? 'Unlock failed');
        return;
      }
      setNotice(
        res.unlocked && res.unlocked.length > 0
          ? `Unlocked: ${res.unlocked.join(', ')} — run "Confirm prune" (or CLI prune) to delete.`
          : 'Nothing to unlock — all images are already unlocked.'
      );
      await openRepo(false);
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConfirmUnlockAll(false);
      setConfirmUnlockRow('');
      setBusy(null);
    }
  };

  const states = overview?.states ?? [];
  const verifying = busy === 'verify';

  return (
    <div className="dashboard">
      <h1>Immutable Repositories</h1>
      <p className="field-hint">
        Append-only, HMAC-signed backup repositories: images are write-protected and time-locked, the journal is
        tamper-evident, and <code>Verify</code> catches edits, missing files and deletions.
      </p>

      <div className="settings-section">
        <div className="path-input" style={{ flex: 1, minWidth: 260 }}>
          <input
            type="text"
            value={dir}
            placeholder="Repository directory or s3://bucket/prefix…"
            onChange={(e) => {
              setDir(e.target.value);
              setOverview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void openRepo();
            }}
          />
          <button onClick={() => void pickDir()}>Browse</button>
          <button className="btn-primary" disabled={!dir || busy !== null} onClick={() => void openRepo()}>
            {busy === 'open' ? 'Opening…' : 'Open'}
          </button>
        </div>
        <div className="path-input" style={{ flex: 1, minWidth: 260, marginTop: 8 }}>
          <input
            type="password"
            value={passphrase}
            placeholder="Passphrase (only for passphrase-initialized repositories)"
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </div>
        {progress && <p className="field-hint">{progress}</p>}
        {error && <div className="error-message">{error}</div>}
        {notice && <div className="success-message">{notice}</div>}
      </div>

      {!overview && busy === null && (
        <div className="settings-section">
          <h3>Initialize a repository here</h3>
          <p className="field-hint">
            {dirIsS3 ? (
              <>
                Stores <code>opbs-repo.json</code>, the append-only signed journal and every image volume directly
                in the bucket at <code>{dir.trim()}</code> (S3-hosted repository).
              </>
            ) : (
              <>
                Creates <code>opbs-repo.json</code>, an append-only signed journal and an <code>images/</code>{' '}
                directory. The signing key is stored outside the repository (keyfile under{' '}
                <code>~/.opbs/repo-keys</code>) unless a passphrase is given above.
              </>
            )}
          </p>
          <div className="disk-tools-row">
            <label>Default lock (days)</label>
            <input
              type="number"
              min={0}
              value={initLockDays}
              onChange={(e) => setInitLockDays(e.target.value)}
              style={{ width: 90 }}
            />
            <button className="btn-primary" disabled={!dir || busy !== null} onClick={() => void initRepo()}>
              {busy === 'init' ? 'Initializing…' : 'Initialize repository'}
            </button>
          </div>
          <div className="disk-tools-row" style={{ marginTop: 8 }}>
            <label>{dirIsS3 ? 'Object Lock (bucket objects)' : 'S3 mirror (optional)'}</label>
            {!dirIsS3 && (
              <input
                type="text"
                value={remoteUri}
                placeholder="s3://bucket/prefix — WORM copies of every image volume"
                onChange={(e) => setRemoteUri(e.target.value)}
                style={{ flex: 1, minWidth: 240 }}
              />
            )}
            <label>Object Lock</label>
            <select value={remoteLock} onChange={(e) => setRemoteLock(e.target.value as '' | 'GOVERNANCE' | 'COMPLIANCE')}>
              <option value="">{dirIsS3 ? 'None' : 'None (mirror only)'}</option>
              <option value="GOVERNANCE">Governance</option>
              <option value="COMPLIANCE">Compliance</option>
            </select>
          </div>
          <p className="field-hint">
            {dirIsS3 ? (
              <>
                The header, journal and image volumes all live in the bucket — with Object Lock, S3 itself refuses
                modification and deletion until retention expires. Credentials come from{' '}
                <strong>Settings → Cloud (S3)</strong> or <code>AWS_*</code> environment variables.
              </>
            ) : (
              <>
                The mirror keeps a locked (Object Lock) copy of every image volume in S3 — journal and header stay
                local. Credentials come from <strong>Settings → Cloud (S3)</strong> or <code>AWS_*</code> environment
                variables.
              </>
            )}
          </p>
        </div>
      )}

      {overview && overview.header && (
        <>
          <div className="settings-section">
            <div className="repo-header-grid">
              <div>
                <span className="field-hint">Repository ID</span>
                <p className="mono-value">{overview.header.id}</p>
              </div>
              <div>
                <span className="field-hint">Created</span>
                <p className="mono-value">{formatDate(overview.header.createdAt)}</p>
              </div>
              <div>
                <span className="field-hint">Default lock</span>
                <p className="mono-value">{overview.header.defaultLockDays} day(s)</p>
              </div>
              <div>
                <span className="field-hint">Journal records</span>
                <p className="mono-value">{overview.recordCount}</p>
              </div>
              <div>
                <span className="field-hint">Key</span>
                <p>
                  <span className={overview.keyAvailable ? 'repo-badge repo-badge-ok' : 'repo-badge repo-badge-warn'}>
                    {overview.keyAvailable ? '✓ Available' : 'Passphrase required'}
                  </span>
                </p>
              </div>
              {overview.header.remote && (
                <div>
                  <span className="field-hint">{overview.s3Repo ? 'S3 storage' : 'S3 mirror'}</span>
                  <p className="mono-value">
                    {overview.header.remote.uri}
                    {overview.header.remote.lockMode ? ` · ${overview.header.remote.lockMode}` : ''}
                  </p>
                </div>
              )}
              <div>
                <span className="field-hint">Chain</span>
                <p>
                  <span className={overview.chainOk ? 'repo-badge repo-badge-ok' : 'repo-badge repo-badge-err'}>
                    {overview.chainOk ? '✓ Intact' : '✗ Broken'}
                  </span>
                  {(overview.orphanCount ?? 0) > 0 && (
                    <span className="repo-badge repo-badge-err" style={{ marginLeft: 6 }}>
                      ⚠ {overview.orphanCount} orphan file(s)
                    </span>
                  )}
                </p>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="repo-actions">
              <button disabled={busy !== null} onClick={() => void openRepo()}>
                {busy === 'open' ? 'Refreshing…' : 'Refresh'}
              </button>
              <button className="btn-primary" disabled={busy !== null} onClick={() => void runVerify(false)}>
                {verifying ? 'Verifying…' : 'Verify (full)'}
              </button>
              <button disabled={busy !== null} onClick={() => void runVerify(true)}>
                Verify (fast)
              </button>
              <button
                className={confirmPrune ? 'btn-danger' : 'btn-secondary'}
                disabled={busy !== null}
                onClick={() => {
                  if (confirmPrune) void runPrune(false);
                  else void runPrune(true);
                }}
              >
                {busy === 'prune'
                  ? 'Pruning…'
                  : confirmPrune
                    ? `Confirm — prune ${pruneResult?.eligible?.length ?? 0} image(s)`
                    : 'Prune…'}
              </button>
              <button
                className={confirmUnlockAll ? 'btn-danger' : 'btn-secondary'}
                disabled={busy !== null}
                onClick={() => {
                  if (confirmUnlockAll) void runUnlock('*');
                  else setConfirmUnlockAll(true);
                }}
              >
                {confirmUnlockAll ? 'Confirm — unlock ALL' : 'Unlock all…'}
              </button>
              {confirmUnlockAll && (
                <button disabled={busy !== null} onClick={() => setConfirmUnlockAll(false)}>
                  Cancel
                </button>
              )}
            </div>

            <div className="path-input" style={{ flex: 1, minWidth: 260, marginTop: 8 }}>
              <input
                type="text"
                value={anchorTarget}
                placeholder="Anchor target: directory, s3://bucket/prefix or sftp://host/path…"
                onChange={(e) => setAnchorTarget(e.target.value)}
              />
              <button
                className="btn-secondary"
                disabled={busy !== null || !anchorTarget.trim()}
                onClick={() => void runAnchor()}
              >
                {busy === 'anchor' ? 'Anchoring…' : 'Anchor now'}
              </button>
            </div>
            <p className="field-hint">
              An off-box snapshot of the header + journal. After a local journal rollback or rewrite,{' '}
              <strong>Verify</strong> (which checks the anchor when a target is set) reports it. Successful
              repository backups re-anchor automatically.
              {anchorStatus && <span className="mono-value"> — {anchorStatus}</span>}
            </p>

            {verifying && <p className="field-hint">{progress || 'Working…'}</p>}

            {verifyReport && !verifyReport.error && (
              <div className={`disk-tools-output ${verifyReport.ok ? 'ok' : 'err'}`}>
                <p className="disk-tools-output-head">
                  Verify — {verifyReport.ok ? 'OK' : `${verifyReport.problems.length} problem(s)`}
                </p>
                <p className="field-hint">
                  Signatures {verifyReport.signaturesVerified ? 'verified' : 'not verified (key unavailable)'}.
                  {verifyReport.anchor &&
                    (verifyReport.anchor.ok
                      ? ` Anchor OK — through seq ${verifyReport.anchor.seq} (anchored ${formatDate(
                          verifyReport.anchor.anchoredAt
                        )}).`
                      : ' Anchor check FAILED.')}
                </p>
                {verifyReport.problems.length > 0 && (
                  <ul className="repo-problem-list">
                    {verifyReport.problems.map((problem, index) => (
                      <li key={`${problem.kind}-${index}`}>
                        <strong>{problem.kind}</strong>: {problem.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {pruneResult?.dryRun && (
              <div className="disk-tools-output ok">
                <p className="disk-tools-output-head">Prune dry-run — nothing was deleted</p>
                {(pruneResult.eligible ?? []).length > 0 && (
                  <>
                    <p className="field-hint">Eligible:</p>
                    <ul className="repo-problem-list">
                      {(pruneResult.eligible ?? []).map((entry) => (
                        <li key={entry.name}>
                          {entry.name} — {entry.reason} ({formatBytes(entry.bytes)})
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {(pruneResult.skipped ?? []).length > 0 && (
                  <>
                    <p className="field-hint">Kept:</p>
                    <ul className="repo-problem-list">
                      {(pruneResult.skipped ?? []).map((entry) => (
                        <li key={entry.name}>
                          {entry.name} — {entry.reason}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="settings-section">
            <h3>Images</h3>
            {states.length === 0 ? (
              <p className="table-empty">No images recorded yet — run a backup with this repository as destination.</p>
            ) : (
              <div className="mbr-table-wrap">
                <table className="mbr-table">
                  <thead>
                    <tr>
                      <th>Image</th>
                      <th>Created</th>
                      <th>Size</th>
                      <th>Base</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {states.map((state) => {
                      const badge = statusBadge(state);
                      return (
                        <tr key={state.name}>
                          <td className="repo-name-cell">{state.name}</td>
                          <td>{formatDate(state.created)}</td>
                          <td>{formatBytes(state.bytes)}</td>
                          <td>{state.base ?? '—'}</td>
                          <td>
                            <span className={badge.cls}>{badge.label}</span>
                          </td>
                          <td>
                            <button
                              className={`btn-small ${confirmUnlockRow === state.name ? 'btn-danger' : ''}`}
                              disabled={busy !== null || state.unlocked}
                              onClick={() => {
                                if (confirmUnlockRow === state.name) void runUnlock(state.name);
                                else setConfirmUnlockRow(state.name);
                              }}
                            >
                              {state.unlocked
                                ? 'Unlocked'
                                : confirmUnlockRow === state.name
                                  ? 'Confirm unlock'
                                  : 'Unlock'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="field-hint" style={{ marginTop: 8 }}>
              Deletion can’t be blocked for readable files on Windows — <strong>Verify</strong> detects it instead
              (missing files, orphans, broken signatures). Backups can target a repository via
              <code> --repo &lt;dir&gt;</code> on the CLI.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default Repositories;
