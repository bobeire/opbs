import { useCallback, useEffect, useState } from 'react';

/**
 * Startup preflight: if the Windows ADK (WinPE component) is not installed,
 * offer to download and silently install it behind a single UAC confirmation.
 */
type Phase = 'checking' | 'missing' | 'installing' | 'installed' | 'dismissed' | 'error';

function AdkPrompt() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .getSettings()
      .then((s) => (cancelled || s?.adkPromptDisabled ? null : window.electronAPI.mediaCheck()))
      .then((report) => {
        // null = suppressed by settings; keep the prompt hidden either way.
        if (!cancelled && report) setPhase(report?.ok ?? false ? 'installed' : 'missing');
      })
      .catch(() => {
        // Same as before: a failed check leaves the prompt hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(async () => {
    setPhase('installing');
    setError('');
    try {
      const result = await window.electronAPI.adkInstall({});
      setPhase(result.ok ? 'installed' : 'error');
      if (!result.ok) setError(result.error ?? 'ADK installation failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ADK installation failed.');
      setPhase('error');
    }
  }, []);

  const dismissForever = useCallback(async () => {
    try {
      await window.electronAPI.updateSettings({ adkPromptDisabled: true });
    } catch {
      // Fall back to a plain dismissal — the prompt may return next launch.
    }
    setPhase('dismissed');
  }, []);

  if (phase === 'checking' || phase === 'installed' || phase === 'dismissed') return null;

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <h2>Windows ADK not found</h2>
        <p>
          OPBS uses the Windows ADK to build recovery media, and it is not installed
          on this PC yet.
        </p>
        {phase === 'installing' && (
          <p className="modal-note">
            Downloading and installing the ADK (Deployment Tools + WinPE add-on).
            Confirm the UAC prompt, then wait — this downloads roughly a gigabyte and
            can take several minutes.
          </p>
        )}
        {phase === 'error' && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          {phase === 'missing' && (
            <>
              <button className="btn-primary" onClick={() => void install()}>
                Install now
              </button>
              <button className="btn-secondary" onClick={() => void dismissForever()}>
                Don't show again
              </button>
              <button className="btn-secondary" onClick={() => setPhase('dismissed')}>
                Later
              </button>
            </>
          )}
          {phase === 'installing' && (
            <button className="btn-secondary" disabled>Installing…</button>
          )}
          {phase === 'error' && (
            <>
              <button className="btn-primary" onClick={() => void install()}>
                Retry
              </button>
              <button className="btn-secondary" onClick={() => setPhase('dismissed')}>
                Later
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdkPrompt;