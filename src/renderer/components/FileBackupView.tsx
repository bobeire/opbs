import { useEffect, useState } from 'react';
import { PassphraseInput } from './PassphraseInput';

/**
 * GUI for the headless file-backup engine. Everything that changes data is an
 * explicit button press here: previews do not write, mirror apply and deletions
 * are separate opt-ins, and restore defaults to skipping existing files.
 */
type BusyAction =
  | 'preview'
  | 'create'
  | 'list'
  | 'verify'
  | 'restore'
  | 'prune-plan'
  | 'prune-apply'
  | 'mirror-plan'
  | 'mirror-apply'
  | null;

interface Notice {
  kind: 'ok' | 'error' | 'info';
  text: string;
  details?: string[];
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatWhen(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString();
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

interface MirrorLike {
  dryRun?: boolean;
  applied?: boolean;
  added?: unknown[];
  changed?: unknown[];
  deleted?: unknown[];
  replaced?: unknown[];
  quarantined?: number;
  confirmationRequired?: boolean;
  problems?: string[];
}

function mirrorLines(report: MirrorLike): string[] {
  const lines = [
    `${report.dryRun ? 'Mirror plan' : 'Mirror result'}: ${report.added?.length ?? 0} added, ` +
      `${report.changed?.length ?? 0} changed, ${report.deleted?.length ?? 0} planned removal(s), ` +
      `${report.replaced?.length ?? 0} replaced.`
  ];
  if (!report.applied) lines.push('The destination was not changed.');
  if (report.quarantined && report.quarantined > 0) {
    lines.push(`${report.quarantined} item(s) moved into quarantine.`);
  }
  if (report.confirmationRequired) {
    lines.push('Deletion threshold exceeded — tick the large-deletion confirmation to apply it.');
  }
  for (const problem of report.problems ?? []) lines.push(`Problem: ${problem}`);
  return lines;
}

function FileBackupView() {
  const [repo, setRepo] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [keyfile, setKeyfile] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [excludesText, setExcludesText] = useState('');
  const [snapshots, setSnapshots] = useState<FileListRecordInfo[]>([]);
  const [snapshotId, setSnapshotId] = useState('');
  const [restoreTarget, setRestoreTarget] = useState('');
  const [includeText, setIncludeText] = useState('');
  const [overwrite, setOverwrite] = useState<'skip' | 'replace' | 'rename'>('skip');
  const [keep, setKeep] = useState(3);
  const [fastVerify, setFastVerify] = useState(false);
  const [mirrorTarget, setMirrorTarget] = useState('');
  const [applyMirror, setApplyMirror] = useState(false);
  const [allowDeletes, setAllowDeletes] = useState(false);
  const [confirmDeletes, setConfirmDeletes] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [progress, setProgress] = useState<FileBackupProgressInfo | null>(null);

  useEffect(() => window.electronAPI.onFileBackupProgress(setProgress), []);

  const keyOpts = () => ({
    ...(passphrase ? { passphrase } : {}),
    ...(keyfile ? { keyfile } : {})
  });

  const requireRepo = (): string => {
    if (!repo.trim()) throw new Error('Choose the repository first.');
    return repo.trim();
  };

  const requireSnapshot = (): string => {
    if (!snapshotId.trim()) throw new Error('Choose a version first — refresh the list or paste its ID.');
    return snapshotId.trim();
  };

  const requireMirrorTarget = (): string => {
    if (!mirrorTarget.trim()) throw new Error('Choose a mirror destination first.');
    return mirrorTarget.trim();
  };

  const perform = async (action: Exclude<BusyAction, null>, fn: () => Promise<void>): Promise<void> => {
    setBusy(action);
    setNotice(null);
    try {
      await fn();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const choose = async (kind: 'repo' | 'source-dir' | 'source-file' | 'keyfile' | 'restore' | 'mirror') => {
    try {
      if (kind === 'source-file' || kind === 'keyfile') {
        const picked = await window.electronAPI.selectFile({
          title: kind === 'keyfile' ? 'Choose the repository keyfile' : 'Choose a file to back up'
        });
        if (!picked) return;
        if (kind === 'keyfile') setKeyfile(picked);
        else setSources((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
      } else {
        const titles: Record<string, string> = {
          repo: 'Choose an OPBS repository',
          'source-dir': 'Choose a folder to back up',
          restore: 'Choose where to restore the files',
          mirror: 'Choose the mirror destination'
        };
        const picked = await window.electronAPI.selectDirectory({ title: titles[kind] });
        if (!picked) return;
        if (kind === 'repo') setRepo(picked);
        else if (kind === 'source-dir') setSources((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
        else if (kind === 'restore') setRestoreTarget(picked);
        else setMirrorTarget(picked);
      }
    } catch (error) {
      setNotice({ kind: 'error', text: `Could not open the picker: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const refreshVersions = async (silent: boolean): Promise<void> => {
    const res = await window.electronAPI.filesList({ repo: requireRepo() });
    if (!res.ok) throw new Error(res.error ?? 'Could not read the file versions.');
    setSnapshots(res.snapshots);
    if (!silent) setNotice({ kind: 'ok', text: `${res.snapshots.length} file version(s) found.` });
  };

  const runBackup = async (preview: boolean) => {
    const repoDir = requireRepo();
    if (sources.length === 0) throw new Error('Add at least one folder or file to back up.');
    const config = {
      type: 'backup-files' as const,
      sources,
      repo: repoDir,
      excludes: splitLines(excludesText),
      ...(mirrorTarget.trim()
        ? {
            mirror: {
              enabled: true,
              apply: !preview && applyMirror,
              path: mirrorTarget.trim(),
              deletions: allowDeletes ? ('quarantine' as const) : ('off' as const)
            }
          }
        : {})
    };
    const res = await window.electronAPI.filesBackup({
      config,
      ...keyOpts(),
      dryRun: preview,
      applyMirror: !preview && applyMirror,
      allowDeletes,
      confirmDeletes,
      deletions: allowDeletes ? 'quarantine' : 'off'
    });
    if (!res.ok) throw new Error(res.error ?? 'The file backup did not finish.');

    if (!preview) {
      const list = await window.electronAPI.filesList({ repo: repoDir });
      if (list.ok) setSnapshots(list.snapshots);
      if (res.snapshotId) setSnapshotId(res.snapshotId);
    }
    const stats = res.manifest?.stats;
    const details = [...(res.warnings ?? [])];
    if (res.mirror) details.push(...mirrorLines(res.mirror));
    setNotice({
      kind: 'ok',
      text: preview
        ? `Preview only — nothing was written. ${stats?.files ?? 0} file(s), ${formatBytes(stats?.logicalBytes)} would be captured.`
        : `Version ${res.snapshotId ?? ''} saved. ${stats?.files ?? 0} file(s), ${formatBytes(stats?.logicalBytes)} captured.`,
      details: details.length > 0 ? details : undefined
    });
  };

  const runVerify = async () => {
    const res = await window.electronAPI.filesVerify({
      repo: requireRepo(),
      ...keyOpts(),
      ...(snapshotId.trim() ? { id: snapshotId.trim() } : {}),
      fast: fastVerify
    });
    const details = res.problems.map((problem) => `${problem.kind}: ${problem.detail}`);
    if (!res.ok && details.length === 0) {
      details.push(res.error ?? 'Verification failed.');
    }
    setNotice({
      kind: res.ok && details.length === 0 ? 'ok' : 'error',
      text:
        res.ok && details.length === 0
          ? `Checked ${res.snapshots.length} file version(s); signatures ${res.signaturesVerified ? 'verified' : 'not verified'}.`
          : 'Verification reported problems.',
      details: details.length > 0 ? details : undefined
    });
  };

  const runRestore = async () => {
    const target = restoreTarget.trim();
    if (!target) throw new Error('Choose where to restore the files first.');
    const res = await window.electronAPI.filesRestore({
      repo: requireRepo(),
      id: requireSnapshot(),
      target,
      include: splitLines(includeText),
      overwrite,
      ...keyOpts()
    });
    if (!res.ok) throw new Error(res.error ?? 'The restore did not finish.');
    const details = [
      ...(res.skipped ?? []).map((item) => `Skipped ${item.path}: ${item.reason}`),
      ...(res.warnings ?? [])
    ];
    setNotice({
      kind: 'ok',
      text: `Restored ${res.restored?.length ?? 0} item(s) to ${res.target ?? target}. Existing files were ${
        overwrite === 'skip' ? 'left alone' : overwrite === 'replace' ? 'replaced' : 'kept under a new name'
      }.`,
      details: details.length > 0 ? details : undefined
    });
  };

  const runPrune = async (apply: boolean) => {
    const res = await window.electronAPI.filesPrune({
      repo: requireRepo(),
      keep,
      apply,
      ...keyOpts()
    });
    if (!res.ok) throw new Error(res.error ?? 'The cleanup did not finish.');
    const details = (res.eligible ?? []).map((entry) => `${entry.id}: ${entry.reason}`);
    setNotice({
      kind: 'ok',
      text: apply
        ? `Removed ${res.removed?.length ?? 0} expired version(s) and collected ${res.chunksRemoved ?? 0} chunk(s).`
        : `Cleanup plan: ${res.eligible?.length ?? 0} version(s) eligible, ${res.skipped?.length ?? 0} kept. Nothing was removed.`,
      details: details.length > 0 ? details : undefined
    });
  };

  const runMirror = async (apply: boolean) => {
    const res = await window.electronAPI.filesMirror({
      repo: requireRepo(),
      id: requireSnapshot(),
      target: requireMirrorTarget(),
      apply,
      allowDeletes,
      confirmDeletes,
      deletions: allowDeletes ? 'quarantine' : 'off',
      ...keyOpts()
    });
    if (!res.ok) throw new Error(res.error ?? 'The mirror plan was refused.');
    setNotice({
      kind: res.problems && res.problems.length > 0 ? 'error' : 'ok',
      text: apply ? 'The mirror ran. See the details below.' : 'This is a plan only — the destination was not changed.',
      details: mirrorLines(res)
    });
  };

  const noticeClass = notice?.kind === 'ok' ? 'success-message' : 'error-message';

  return (
    <div className="file-backup-view">
      <div className="wizard-header">
        <h1>Files &amp; folders</h1>
        <p className="field-hint">
          Keep dated, encrypted versions of chosen files and folders inside an OPBS repository. A version is
          separate from a disk image and restoring it never changes your originals. This page reads files as
          they are — it does not use VSS, watch for changes, or sync two folders in both directions.
        </p>
      </div>

      {notice && (
        <div className={noticeClass}>
          <p>{notice.text}</p>
          {notice.details && notice.details.length > 0 && (
            <ul className="file-backup-details">
              {notice.details.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="settings-section">
        <h2>Repository &amp; key</h2>
        <p className="field-hint">
          Pick an existing OPBS repository. Leave both key fields empty if its automatic keyfile is available;
          otherwise enter the passphrase or choose the keyfile.
        </p>
        <div className="setting-item">
          <label>Repository folder:</label>
          <div className="file-backup-inline">
            <input
              type="text"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="D:\\OPBS-REPO"
              aria-label="Repository folder"
            />
            <button className="btn-secondary btn-small" onClick={() => void choose('repo')} disabled={busy !== null}>
              Browse…
            </button>
          </div>
        </div>
        <div className="setting-item">
          <label>Repository passphrase (optional):</label>
          <PassphraseInput
            value={passphrase}
            onChange={setPassphrase}
            ariaLabel="Repository passphrase for file backups"
            placeholder="Leave empty for the automatic keyfile"
            disabled={busy !== null}
          />
        </div>
        <div className="setting-item">
          <label>Or a keyfile (optional):</label>
          <div className="file-backup-inline">
            <input
              type="text"
              value={keyfile}
              onChange={(event) => setKeyfile(event.target.value)}
              placeholder="C:\\keys\\opbs.key"
              aria-label="Repository keyfile"
            />
            <button className="btn-secondary btn-small" onClick={() => void choose('keyfile')} disabled={busy !== null}>
              Browse…
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>Create a version</h2>
        <p className="field-hint">
          Add the folders or files you want to keep. Preview first if you are unsure — a preview writes nothing.
        </p>
        <div className="setting-item">
          <label>Sources:</label>
          <div className="wizard-actions">
            <button className="btn-secondary btn-small" onClick={() => void choose('source-dir')} disabled={busy !== null}>
              Add folder
            </button>
            <button className="btn-secondary btn-small" onClick={() => void choose('source-file')} disabled={busy !== null}>
              Add file
            </button>
          </div>
          {sources.length === 0 ? (
            <p className="field-hint">No sources added yet.</p>
          ) : (
            <ul className="file-backup-sources">
              {sources.map((source) => (
                <li key={source}>
                  <span className="mono-value">{source}</span>
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => setSources((prev) => prev.filter((item) => item !== source))}
                    disabled={busy !== null}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="setting-item">
          <label>Exclude patterns (one per line, optional):</label>
          <textarea
            rows={3}
            value={excludesText}
            onChange={(event) => setExcludesText(event.target.value)}
            placeholder={'**\\node_modules\\**\n**\\*.tmp'}
            aria-label="Exclude patterns"
          />
        </div>
        <div className="wizard-actions">
          <button
            className="btn-secondary"
            onClick={() => void perform('preview', () => runBackup(true))}
            disabled={busy !== null}
          >
            {busy === 'preview' ? 'Preparing preview…' : 'Preview — write nothing'}
          </button>
          <button
            className="btn-primary"
            onClick={() => void perform('create', () => runBackup(false))}
            disabled={busy !== null}
          >
            {busy === 'create' ? 'Saving version…' : 'Save a version'}
          </button>
        </div>
        {progress && (busy === 'preview' || busy === 'create') && (
          <div className="file-backup-progress">
            <div>{progress.phase} — {Math.round(progress.percent)}%</div>
            <div className="file-backup-progress-bar">
              <div style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
            </div>
            {progress.currentPath && <p className="field-hint mono-value">{progress.currentPath}</p>}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h2>Saved versions</h2>
        <p className="field-hint">Refresh to see the versions in this repository, then pick one to restore, verify, mirror or clean up.</p>
        <div className="wizard-actions">
          <button
            className="btn-secondary btn-small"
            onClick={() => void perform('list', () => refreshVersions(false))}
            disabled={busy !== null}
          >
            {busy === 'list' ? 'Refreshing…' : 'Refresh versions'}
          </button>
          <label className="checkbox-label">
            <input type="checkbox" checked={fastVerify} onChange={(event) => setFastVerify(event.target.checked)} />
            Quick verify (sizes only)
          </label>
          <button
            className="btn-secondary btn-small"
            onClick={() => void perform('verify', runVerify)}
            disabled={busy !== null}
          >
            {busy === 'verify' ? 'Verifying…' : 'Verify versions'}
          </button>
        </div>
        {snapshots.length === 0 ? (
          <p className="field-hint">No versions listed yet. Save a version, or refresh the list.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Saved</th>
                <th>Files</th>
                <th>Size</th>
                <th>Locked until</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td className="mono-value">{snapshot.id}</td>
                  <td>{formatWhen(snapshot.at)}</td>
                  <td>{snapshot.files ?? 0}</td>
                  <td>{formatBytes(snapshot.bytes)}</td>
                  <td>{snapshot.lockUntil ? formatWhen(snapshot.lockUntil) : '—'}</td>
                  <td>
                    <button className="btn-secondary btn-small" onClick={() => setSnapshotId(snapshot.id)}>
                      Use this version
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="setting-item">
          <label>Selected version ID:</label>
          <input
            type="text"
            value={snapshotId}
            onChange={(event) => setSnapshotId(event.target.value)}
            placeholder="Paste an ID, or use one from the list"
            aria-label="Selected file version ID"
          />
        </div>
      </div>

      <div className="settings-section">
        <h2>Restore a version</h2>
        <p className="field-hint">Restores into a folder you choose. Nothing outside that folder is touched.</p>
        <div className="setting-item">
          <label>Restore into:</label>
          <div className="file-backup-inline">
            <input
              type="text"
              value={restoreTarget}
              onChange={(event) => setRestoreTarget(event.target.value)}
              placeholder="E:\\Restored"
              aria-label="Restore destination"
            />
            <button className="btn-secondary btn-small" onClick={() => void choose('restore')} disabled={busy !== null}>
              Browse…
            </button>
          </div>
        </div>
        <div className="setting-item">
          <label>If a file already exists:</label>
          <select value={overwrite} onChange={(event) => setOverwrite(event.target.value as typeof overwrite)}>
            <option value="skip">Skip it (default)</option>
            <option value="rename">Save under a new name</option>
            <option value="replace">Replace it</option>
          </select>
        </div>
        <div className="setting-item">
          <label>Only these paths (one pattern per line, optional):</label>
          <textarea
            rows={2}
            value={includeText}
            onChange={(event) => setIncludeText(event.target.value)}
            placeholder={'**\\*.docx\nDocuments\\**'}
            aria-label="Paths to include in the restore"
          />
        </div>
        <div className="wizard-actions">
          <button
            className="btn-primary"
            onClick={() => void perform('restore', runRestore)}
            disabled={busy !== null}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore selected version'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h2>One-way mirror</h2>
        <p className="field-hint">
          Makes a destination folder match the selected version. Changes in the destination are never copied
          back. Planning is the default; applying and removals are separate choices.
        </p>
        <div className="setting-item">
          <label>Mirror destination:</label>
          <div className="file-backup-inline">
            <input
              type="text"
              value={mirrorTarget}
              onChange={(event) => setMirrorTarget(event.target.value)}
              placeholder="E:\\Mirror"
              aria-label="Mirror destination"
            />
            <button className="btn-secondary btn-small" onClick={() => void choose('mirror')} disabled={busy !== null}>
              Browse…
            </button>
          </div>
          <p className="field-hint">
            Setting a destination here also adds a planned mirror to new versions created above.
          </p>
        </div>
        <div className="setting-item">
          <label className="checkbox-label">
            <input type="checkbox" checked={applyMirror} onChange={(event) => setApplyMirror(event.target.checked)} />
            Apply the mirror after saving a version (default: plan only)
          </label>
        </div>
        <div className="setting-item">
          <label className="checkbox-label">
            <input type="checkbox" checked={allowDeletes} onChange={(event) => setAllowDeletes(event.target.checked)} />
            Allow removals — move removed destination items into quarantine
          </label>
        </div>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmDeletes}
              onChange={(event) => setConfirmDeletes(event.target.checked)}
            />
            I understand this run may move a large number of files into quarantine
          </label>
          <p className="field-hint">With removals turned off, a mirror that would delete anything is refused.</p>
        </div>
        <div className="wizard-actions">
          <button
            className="btn-secondary"
            onClick={() => void perform('mirror-plan', () => runMirror(false))}
            disabled={busy !== null}
          >
            {busy === 'mirror-plan' ? 'Planning…' : 'Plan mirror — write nothing'}
          </button>
          <button
            className="btn-danger"
            onClick={() => void perform('mirror-apply', () => runMirror(true))}
            disabled={busy !== null}
          >
            {busy === 'mirror-apply' ? 'Applying…' : 'Apply mirror'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h2>Cleanup</h2>
        <p className="field-hint">
          Expired versions can be removed after their lock ends. Planning shows what would go; removal is a
          separate step and never touches a version still used as a mirror source.
        </p>
        <div className="setting-item">
          <label>Keep at least this many recent versions:</label>
          <input
            type="number"
            min={0}
            value={keep}
            onChange={(event) => setKeep(Number(event.target.value))}
            aria-label="Versions to keep"
          />
        </div>
        <div className="wizard-actions">
          <button
            className="btn-secondary"
            onClick={() => void perform('prune-plan', () => runPrune(false))}
            disabled={busy !== null}
          >
            {busy === 'prune-plan' ? 'Planning…' : 'Plan cleanup — remove nothing'}
          </button>
          <button
            className="btn-danger"
            onClick={() => void perform('prune-apply', () => runPrune(true))}
            disabled={busy !== null}
          >
            {busy === 'prune-apply' ? 'Cleaning up…' : 'Apply cleanup'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FileBackupView;
