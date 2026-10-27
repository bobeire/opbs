import { useEffect, useRef, useState } from 'react';
import { PassphraseInput } from './PassphraseInput';

type Step = 'source' | 'target' | 'plan' | 'options' | 'run' | 'done';
const STEP_ORDER: Step[] = ['source', 'target', 'plan', 'options', 'run'];

interface MigrateWizardProps {
  onComplete: () => void;
}

interface ImagePartitionInfo {
  index: number;
  size: number;
  fsType?: string;
}

interface ImageInfo {
  partitions: ImagePartitionInfo[];
  encrypted?: boolean;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function MigrateWizard({ onComplete }: MigrateWizardProps) {
  const [step, setStep] = useState<Step>('source');
  const [mode, setMode] = useState<'live' | 'image'>('live');

  // Image source
  const [imagePath, setImagePath] = useState('');
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [partitionIndex, setPartitionIndex] = useState(0);
  const [passphrase, setPassphrase] = useState('');

  // Profile picker
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState('');
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);

  const [target, setTarget] = useState('');
  const [targetError, setTargetError] = useState<string | null>(null);
  const [checkingTarget, setCheckingTarget] = useState(false);

  // Plan
  const [planResult, setPlanResult] = useState<MigratePlanResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Options
  const [execute, setExecute] = useState(true);
  const [registry, setRegistry] = useState(false);
  const [rewriteOwner, setRewriteOwner] = useState(true);
  const [merge, setMerge] = useState(false);
  const [resume, setResume] = useState(false);
  const [noVerify, setNoVerify] = useState(false);

  // Run
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<MigrateRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [journal, setJournal] = useState<{ copied: number; bytes: number }>({ copied: 0, bytes: 0 });
  const [logs, setLogs] = useState<string[]>([]);
  const logsRef = useRef<HTMLPreElement | null>(null);

  const spec = (): MigrateSourceSpec =>
    mode === 'live'
      ? { live: true }
      : { imagePath, partitionIndex, ...(passphrase ? { passphrase } : {}) };

  const plan = planResult?.plan;
  const refusalCount = planResult?.refusals ?? plan?.refusals?.length ?? 0;
  const elevated = !!planResult?.elevated;

  const resetPlan = (): void => {
    setPlanResult(null);
    setPlanError(null);
    setRunResult(null);
    setRunError(null);
  };

  // Live progress: journal counts during execute, CLI stderr lines any time.
  useEffect(() => {
    const cleanup = window.electronAPI.onMigrateProgress((event) => {
      if (event.kind === 'journal') {
        setJournal({ copied: event.copied, bytes: event.bytes });
      } else if (event.kind === 'log') {
        setLogs((prev) => [...prev, event.line].slice(-400));
      }
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const loadProfiles = async (source: MigrateSourceSpec): Promise<void> => {
    setProfilesLoading(true);
    setProfilesError(null);
    try {
      const res = await window.electronAPI.migrateProfiles(source);
      if (res.ok) {
        setProfiles(res.profiles);
        if (res.profiles.length > 0 && !res.profiles.includes(profile)) {
          setProfile(res.profiles[0]);
        }
      } else {
        setProfiles([]);
        setProfilesError(res.error ?? 'Could not list user profiles.');
      }
    } catch (error: unknown) {
      setProfiles([]);
      setProfilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setProfilesLoading(false);
    }
  };

  useEffect(() => {
    // Deferred so the initial profile load never sets state synchronously
    // inside the effect body (react-hooks/setState-in-effect).
    const timer = setTimeout(() => {
      void loadProfiles({ live: true });
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickImage = async (): Promise<void> => {
    const file = await window.electronAPI.selectFile({
      title: 'Select backup image',
      filters: [{ name: 'Backup images', extensions: ['opbs', 'mrimg', 'mrimgx'] }]
    });
    if (!file) return;
    setImagePath(file);
    setImageInfo(null);
    setImageError(null);
    setPartitionIndex(0);
    resetPlan();
    setImageLoading(true);
    try {
      const info: ImageInfo = await window.electronAPI.getImageInfo(file);
      setImageInfo(info);
      const parts: ImagePartitionInfo[] = info?.partitions ?? [];
      if (parts.length > 0) setPartitionIndex(Number(parts[0].index ?? 0));
      if (parts.length === 0) setImageError('No partitions found in this image.');
    } catch (error: unknown) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageLoading(false);
    }
  };

  const runPlan = async (): Promise<void> => {
    setPlanning(true);
    setPlanError(null);
    setPlanResult(null);
    try {
      const res = await window.electronAPI.migratePlan({
        source: spec(),
        profile,
        ...(target ? { target } : {})
      });
      if (res.ok && res.plan) {
        setPlanResult(res);
      } else {
        setPlanError(res.error ?? 'Planning failed.');
      }
    } catch (error: unknown) {
      setPlanError(error instanceof Error ? error.message : String(error));
    } finally {
      setPlanning(false);
    }
  };

  // Build the plan as soon as the plan step is reached (once). Deferred so
  // runPlan's first setState isn't synchronous inside the effect body.
  useEffect(() => {
    if (step !== 'plan' || planResult || planning || planError) return;
    const timer = setTimeout(() => {
      void runPlan();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, planResult, planError]);

  const cancelPlanning = async (): Promise<void> => {
    await window.electronAPI.migrateCancel();
  };

  const startRun = async (): Promise<void> => {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    setLogs([]);
    setJournal({ copied: 0, bytes: 0 });
    try {
      const res = await window.electronAPI.migrateRun({
        source: spec(),
        profile,
        target,
        ...(plan?.planHash ? { planHash: plan.planHash } : {}),
        execute: true,
        registry: registry && elevated,
        noOwner: !rewriteOwner,
        ...(merge ? { merge: true } : {}),
        ...(resume ? { resume: true } : {}),
        ...(noVerify ? { noVerify: true } : {})
      });
      setRunResult(res);
      if (!res.ok && res.error) setRunError(res.error);
    } catch (error: unknown) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const openArtifact = (p?: string): void => {
    if (p) void window.electronAPI.openPath(p);
  };

  const renderProfilePicker = (autoLoadLabel?: string) => (
    <div className="setting-item">
      <label>User profile:</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select
          value={profile}
          onChange={(e) => {
            setProfile(e.target.value);
            resetPlan();
          }}
          disabled={profilesLoading || profiles.length === 0}
          style={{ flex: 1 }}
        >
          {profiles.length === 0 && <option value="">{profilesLoading ? 'Loading…' : 'No profiles loaded'}</option>}
          {profiles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          className="btn-secondary"
          onClick={() => void loadProfiles(spec())}
          disabled={profilesLoading}
        >
          {profilesLoading ? 'Loading…' : autoLoadLabel ?? 'Refresh'}
        </button>
      </div>
      {profilesError && <div className="error-message">{profilesError}</div>}
      {!profilesLoading && profiles.length === 0 && !profilesError && (
        <p className="field-hint">No user profiles found under Users/.</p>
      )}
    </div>
  );

  const renderSourceStep = () => (
    <div className="wizard-step">
      <h2>Migration source</h2>
      <p className="field-hint">
        Choose where the user state comes from: the live system drive, or a backup
        image (mounts the partition read-only, no elevation needed).
      </p>

      <div className="setting-item">
        <label className="checkbox-label">
          <input
            type="radio"
            checked={mode === 'live'}
            onChange={() => {
              setMode('live');
              resetPlan();
            }}
          />{' '}
          This machine (live system drive)
        </label>
        <label className="checkbox-label">
          <input
            type="radio"
            checked={mode === 'image'}
            onChange={() => {
              setMode('image');
              resetPlan();
            }}
          />{' '}
          Backup image
        </label>
      </div>

      {mode === 'image' && (
        <>
          <div className="setting-item">
            <label>Image file:</label>
            <div className="path-input">
              <input
                type="text"
                value={imagePath}
                readOnly
                placeholder="Select an .opbs / .mrimg / .mrimgx image…"
              />
              <button onClick={() => void pickImage()} disabled={imageLoading}>
                Browse
              </button>
            </div>
            {imageLoading && <p className="field-hint">Reading image header…</p>}
            {imageError && <div className="error-message">{imageError}</div>}
          </div>
          {(imageInfo?.partitions?.length ?? 0) > 0 && (
            <div className="setting-item">
              <label>Partition with the Windows volume:</label>
              <select
                value={partitionIndex}
                onChange={(e) => {
                  setPartitionIndex(Number(e.target.value));
                  resetPlan();
                }}
              >
                {imageInfo!.partitions.map((p) => (
                  <option key={p.index} value={p.index}>
                    Partition {p.index} — {formatSize(Number(p.size) || 0)}
                    {p.fsType ? ` — ${p.fsType}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {imageInfo?.encrypted && (
            <div className="setting-item">
              <label>Image passphrase:</label>
              <PassphraseInput
                value={passphrase}
                onChange={setPassphrase}
                placeholder="Required for encrypted images"
                ariaLabel="Image passphrase"
              />
            </div>
          )}
        </>
      )}

      {renderProfilePicker(mode === 'image' ? 'List profiles' : undefined)}

      <div className="wizard-actions">
        <button
          className="btn-primary"
          disabled={!profile || (mode === 'image' && (!imagePath || profilesLoading))}
          onClick={() => setStep('target')}
        >
          Next
        </button>
      </div>
    </div>
  );

  const renderTargetStep = () => (
    <div className="wizard-step">
      <h2>Target profile</h2>
      <p className="field-hint">
        The <strong>existing</strong> user profile directory the state is copied into —
        typically <code>C:\Users\&lt;name&gt;</code> on the machine you are migrating to.
        Nothing is written yet; the plan step validates everything first.
      </p>
      <div className="setting-item">
        <label>Target profile directory:</label>
        <div className="path-input">
          <input
            type="text"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setTargetError(null);
              resetPlan();
            }}
            placeholder="C:\Users\Alice"
          />
          <button
            onClick={() =>
              void window.electronAPI.selectDirectory({ title: 'Select target profile directory' }).then((dir) => {
                if (dir) {
                  setTarget(dir);
                  setTargetError(null);
                  resetPlan();
                }
              })
            }
          >
            Browse
          </button>
        </div>
      </div>
      {targetError && (
        <div className="error-message">
          <p>[target-profile-missing] {targetError}</p>
        </div>
      )}
      <div className="wizard-actions">
        <button className="btn-secondary" onClick={() => setStep('source')}>
          Back
        </button>
        <button
          className="btn-primary"
          disabled={!target.trim() || checkingTarget}
          onClick={() => {
            const candidate = target.trim().replace(/^"|"$/g, '');
            setCheckingTarget(true);
            setTargetError(null);
            void window.electronAPI
              .pathIsDirectory(candidate)
              .then((ok) => {
                setCheckingTarget(false);
                if (!ok) {
                  setTargetError(
                    `Target profile directory does not exist: ${candidate}. Create the Windows account first; OPBS does not create accounts.`
                  );
                  return;
                }
                setStep('plan');
              })
              .catch(() => {
                setCheckingTarget(false);
                setTargetError(`Could not check ${candidate}. Verify the path and try again.`);
              });
          }}
        >
          {checkingTarget ? 'Checking…' : 'Next'}
        </button>
      </div>
    </div>
  );

  const renderPlanStep = () => (
    <div className="wizard-step">
      <h2>Plan</h2>
      {planError && (
        <>
          <div className="error-message">{planError}</div>
          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep('target')}>
              Back
            </button>
            <button className="btn-primary" onClick={() => void runPlan()}>
              Try again
            </button>
          </div>
        </>
      )}
      {planning && (
        <>
          <p className="field-hint">
            Building the plan — walking the profile and matching known app data stores.
            This can take a minute on large profiles…
          </p>
          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => void cancelPlanning()}>
              Cancel
            </button>
          </div>
        </>
      )}
      {plan && !planning && (
        <>
          <div className="summary">
            <ul>
              <li>
                {plan.totalItems} file(s), {formatSize(plan.totalBytes)} planned
              </li>
              <li>
                Source: {plan.sourceLabel} — profile <strong>{plan.profile}</strong> ({plan.profileRelPath})
              </li>
              <li>
                Plan hash: <span className="mono-value">{plan.planHash ?? '(missing)'}</span>
              </li>
              <li>
                {elevated
                  ? 'Running as administrator — registry transplants available.'
                  : 'Not elevated — file copy only (start OPBS as administrator for registry transplants).'}
              </li>
            </ul>
          </div>

          {refusalCount > 0 && (
            <>
              <div className="error-message">
                <strong>
                  {refusalCount} refusal(s) — execution will be blocked until they are resolved:
                </strong>
                {plan.refusals.map((r, i) => (
                  <p key={i}>
                    [{r.reason}] {r.detail}
                  </p>
                ))}
              </div>
            </>
          )}

          <table className="backup-table">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Files</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {plan.entries.map((entry) => (
                <tr key={entry.sourceRelPath}>
                  <td>
                    {entry.sourceRelPath}
                    {entry.category === 'app-store' && entry.appId ? ` · ${entry.appId}` : ''}
                    {entry.capped ? ' [capped]' : ''}
                  </td>
                  <td>{entry.itemCount}</td>
                  <td>{formatSize(entry.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {plan.stores.some((s) => (s.registry?.length ?? 0) > 0) && (
            <div className="summary">
              <h3>Registry keys planned (tier 2)</h3>
              <ul>
                {plan.stores
                  .filter((s) => (s.registry?.length ?? 0) > 0)
                  .map((s) => (
                    <li key={s.appId}>
                      {s.appName}: {s.registry!.length} key(s)
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {plan.reinstallHints.length > 0 && (
            <div className="summary">
              <h3>Reinstall on target (winget)</h3>
              <ul>
                {plan.reinstallHints.map((hint) => (
                  <li key={hint.appId}>
                    <code>{hint.winget ? `winget install ${hint.winget}` : `${hint.name} (no winget package)`}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.phaseNotes.length > 0 && (
            <div className="summary">
              <h3>Notes</h3>
              <ul>
                {plan.phaseNotes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep('target')}>
              Back
            </button>
            <button className="btn-secondary" onClick={() => void runPlan()}>
              Rebuild plan
            </button>
            <button className="btn-primary" onClick={() => setStep('options')}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderOptionsStep = () => (
    <div className="wizard-step">
      <h2>Options</h2>

      {refusalCount > 0 && (
        <div className="error-message">
          The plan has {refusalCount} refusal(s) — execution is blocked. Finish with a
          plan-only run, or go back and adjust the source/target.
        </div>
      )}

      <div className="setting-item">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={execute && refusalCount === 0}
            disabled={refusalCount > 0}
            onChange={(e) => setExecute(e.target.checked)}
          />
          Execute the migration after validation
        </label>
      </div>

      <div className="setting-item">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={registry && elevated}
            disabled={!elevated}
            onChange={(e) => setRegistry(e.target.checked)}
          />
          Transplant registry keys too (tier 2)
        </label>
        {!elevated && (
          <p className="field-hint">
            Requires OPBS running as administrator (registry hive loading). Restart
            elevated to enable this.
          </p>
        )}
      </div>

      <div className="setting-item">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={rewriteOwner}
            onChange={(e) => setRewriteOwner(e.target.checked)}
          />
          Rewrite file owners to the target profile SID
        </label>
        <p className="field-hint">Recommended — the copied tree stays owned by the target user.</p>
      </div>

      <details>
        <summary>Advanced options</summary>
        <div className="setting-item">
          <label className="checkbox-label">
            <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
            Merge (keep existing same-name files instead of overwriting)
          </label>
        </div>
        <div className="setting-item">
          <label className="checkbox-label">
            <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
            Resume (skip files a previous run already copied)
          </label>
        </div>
        <div className="setting-item">
          <label className="checkbox-label">
            <input type="checkbox" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} />
            Skip post-copy verification (faster, not recommended)
          </label>
        </div>
      </details>

      <div className="field-hint">
        Target: <code>{target}</code> — every planned file is copied into this directory
        (existing same-path files are overwritten unless merge is checked).
      </div>

      <div className="wizard-actions">
        <button className="btn-secondary" onClick={() => setStep('plan')}>
          Back
        </button>
        {execute && refusalCount === 0 ? (
          <button
            className="btn-primary"
            onClick={() => {
              setStep('run');
              void startRun();
            }}
          >
            Start migration
          </button>
        ) : (
          <button className="btn-primary" onClick={() => setStep('done')}>
            Finish (plan only)
          </button>
        )}
      </div>
    </div>
  );

  const renderReportBody = (report: MigrateReportInfo) => (
    <>
      <div className="summary">
        <ul>
          <li>
            Copied: {report.summary.copied} file(s), {formatSize(report.summary.bytesCopied)}
          </li>
          <li>
            Verify: {report.summary.verifyChecked} checked, {report.summary.verifyMismatches} mismatch(es)
          </li>
          {report.summary.skippedResume > 0 && <li>Resume-skipped: {report.summary.skippedResume}</li>}
          {report.summary.failed > 0 && <li>Failed: {report.summary.failed}</li>}
          {(report.registry?.length ?? 0) > 0 && (
            <li>
              Registry: {report.summary.registryCopied} transplanted, {report.summary.registryFailed} failed
            </li>
          )}
          {report.owner && (
            <li>
              Owner rewrite: {report.owner.status}
              {report.owner.sid ? ` (sid ${report.owner.sid}, ${report.owner.roots} root(s))` : ''}
              {report.owner.detail ? ` — ${report.owner.detail}` : ''}
            </li>
          )}
        </ul>
      </div>

      {(report.registry?.length ?? 0) > 0 && (
        <table className="backup-table">
          <thead>
            <tr>
              <th>Registry key</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {report.registry!.map((outcome, i) => (
              <tr key={i}>
                <td>
                  {outcome.appName ?? outcome.appId ?? 'app'}: {outcome.key}
                </td>
                <td>
                  {outcome.status}
                  {outcome.detail ? ` — ${outcome.detail}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.notes.length > 0 && (
        <div className="summary">
          <h3>Notes</h3>
          <ul>
            {report.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {(report.artifacts.reportPath || report.artifacts.wingetPath) && (
        <div className="setting-item">
          <label>Artifacts:</label>
          {report.artifacts.reportPath && (
            <p className="field-hint">
              <button className="btn-secondary btn-small" onClick={() => openArtifact(report.artifacts.reportPath)}>
                Open report.json
              </button>{' '}
              <code>{report.artifacts.reportPath}</code>
            </p>
          )}
          {report.artifacts.wingetPath && (
            <p className="field-hint">
              <button className="btn-secondary btn-small" onClick={() => openArtifact(report.artifacts.wingetPath)}>
                Open winget-import.json
              </button>{' '}
              Apply app reinstalls with <code>winget import</code> on the target machine.
            </p>
          )}
        </div>
      )}
    </>
  );

  const renderRunStep = () => {
    const report = runResult?.kind === 'report' ? (runResult.result as MigrateReportInfo) : null;
    if (running || (!runResult && !runError)) {
      return (
        <div className="wizard-step">
          <h2>Migrating</h2>
          <div className="summary">
            <ul>
              <li>
                {journal.copied} file(s) copied — {formatSize(journal.bytes)}
              </li>
              <li>Every copied file is journaled and verified; you can safely cancel (use --resume to continue).</li>
            </ul>
          </div>
          <pre
            ref={logsRef}
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              background: 'var(--bg-inset, #111)',
              color: 'var(--text-secondary, #aaa)',
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: 'pre-wrap'
            }}
          >
            {logs.length > 0 ? logs.join('\n') : 'Starting…'}
          </pre>
          <div className="wizard-actions">
            <button
              className="btn-secondary"
              onClick={() => void window.electronAPI.migrateCancel()}
              disabled={!running}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    if (runResult?.ok && report) {
      return (
        <div className="wizard-step">
          <h2>Migration complete</h2>
          <div className="success-message">
            <p>
              Migration executed — plan {report.planHash.slice(0, 16)}…
            </p>
          </div>
          {renderReportBody(report)}
          <div className="wizard-actions">
            <button className="btn-primary" onClick={onComplete}>
              Done
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="wizard-step">
        <h2>Migration failed</h2>
        <div className="error-message">
          {runError ?? runResult?.error ?? 'The migration did not complete.'}
          {runResult?.cancelled ? ' (cancelled)' : ''}
        </div>
        {report && renderReportBody(report)}
        {runResult?.stderr && (
          <pre style={{ maxHeight: 160, overflowY: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {runResult.stderr}
          </pre>
        )}
        <div className="wizard-actions">
          <button className="btn-secondary" onClick={() => setStep('options')}>
            Back
          </button>
          <button className="btn-primary" onClick={() => void startRun()}>
            Retry
          </button>
        </div>
      </div>
    );
  };

  const renderDoneStep = () => (
    <div className="wizard-step">
      <h2>Plan ready</h2>
      <div className="success-message">
        <p>
          Plan built for <strong>{plan?.profile}</strong> — {plan?.totalItems} file(s),{' '}
          {plan ? formatSize(plan.totalBytes) : ''}.
        </p>
        <p>
          Plan hash: <span className="mono-value">{plan?.planHash}</span>
        </p>
        <p>Nothing was written. Re-run the wizard with “Execute” to apply it.</p>
      </div>
      <div className="wizard-actions">
        <button className="btn-primary" onClick={onComplete}>
          Done
        </button>
      </div>
    </div>
  );

  const renderStep = () => {
    switch (step) {
      case 'source':
        return renderSourceStep();
      case 'target':
        return renderTargetStep();
      case 'plan':
        return renderPlanStep();
      case 'options':
        return renderOptionsStep();
      case 'run':
        return renderRunStep();
      case 'done':
        return renderDoneStep();
      default:
        return null;
    }
  };

  const activeIndex = STEP_ORDER.indexOf(step === 'done' ? 'run' : step);

  return (
    <div className="migrate-wizard">
      <div className="wizard-header">
        <h1>Migrate User State</h1>
        <div className="step-indicator">
          {STEP_ORDER.map((s, i) => (
            <span key={s} style={{ display: 'contents' }}>
              {i > 0 && <span className="step-line" />}
              <span className={`step ${i === activeIndex ? 'active' : ''}`}>{i + 1}</span>
            </span>
          ))}
        </div>
      </div>

      {renderStep()}
    </div>
  );
}

export default MigrateWizard;
