import { useState } from 'react';
import { confirmStatus } from '../lib/passphrase';

/**
 * Shared passphrase entry: a roomy masked input with a show/hide (eye) toggle,
 * plus — in create mode — a confirm field so a passphrase cannot be set by
 * typing it once (discussion #8).
 *
 * Renders only the input row(s); the surrounding label and hint text stay in
 * the calling component so each site keeps its own layout.
 */
export interface PassphraseInputProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * 'create' renders a confirm field (needs confirmValue/onConfirmChange);
   * 'unlock' renders a single input for entering an existing secret.
   */
  mode?: 'create' | 'unlock';
  /** Create mode: the confirm field's value (controlled by the parent). */
  confirmValue?: string;
  /** Create mode: setter for the confirm field. */
  onConfirmChange?: (value: string) => void;
  placeholder?: string;
  /** Accessible name (the visible label lives in the parent and is not linked). */
  ariaLabel?: string;
  confirmAriaLabel?: string;
  disabled?: boolean;
  autoComplete?: string;
  /** Enter key in either field triggers this (e.g. submit a one-row form). */
  onEnter?: () => void;
  /** Inline-row sites (DiskTools, BitLocker unlock) pass sizing via style. */
  className?: string;
  style?: React.CSSProperties;
  /** Smaller height for dense inline rows. */
  compact?: boolean;
}

export function PassphraseInput({
  value,
  onChange,
  mode = 'unlock',
  confirmValue,
  onConfirmChange,
  placeholder,
  ariaLabel,
  confirmAriaLabel,
  disabled,
  autoComplete = 'off',
  onEnter,
  className,
  style,
  compact
}: PassphraseInputProps) {
  const [revealed, setRevealed] = useState(false);
  const status = mode === 'create' ? confirmStatus(value, confirmValue ?? '') : 'empty';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onEnter) onEnter();
  };

  return (
    <div
      className={`passphrase-field${compact ? ' passphrase-field-compact' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <div className="passphrase-input-wrap">
        <input
          className="passphrase-input"
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          aria-label={ariaLabel ?? 'Passphrase'}
        />
        <button
          type="button"
          className="passphrase-reveal"
          onClick={() => setRevealed(!revealed)}
          disabled={disabled}
          aria-label={revealed ? 'Hide passphrase' : 'Show passphrase'}
          title={revealed ? 'Hide passphrase' : 'Show passphrase'}
        >
          {revealed ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M12 6c5 0 9.27 3.11 11 7.5a11.79 11.79 0 0 1-2.16 3.19l1.42 1.42-1.41 1.41-17-17L3.31 2.1 5.1 3.88A13.36 13.36 0 0 0 1 13.5C2.73 17.89 7 21 12 21c1.36 0 2.66-.26 3.86-.72l1.9 1.9 1.41-1.41-1.42-1.42A11.79 11.79 0 0 0 23 13.5C21.27 9.1 17 6 12 6Zm-2.4 4.3 1.9 1.9a2 2 0 0 1 2.5 2.5l1.9 1.9a5 5 0 0 0-6.3-6.3ZM12 15a3 3 0 0 1-3-3c0-.47.11-.92.3-1.32l3.02 3.02A2.97 2.97 0 0 1 12 15Z"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5ZM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
              />
            </svg>
          )}
        </button>
      </div>

      {mode === 'create' && confirmValue !== undefined && onConfirmChange && (
        <div className="passphrase-confirm">
          <div className="passphrase-input-wrap">
            <input
              className="passphrase-input"
              type={revealed ? 'text' : 'password'}
              value={confirmValue}
              onChange={(e) => onConfirmChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Re-enter to confirm"
              disabled={disabled}
              autoComplete={autoComplete}
              aria-label={confirmAriaLabel ?? 'Confirm passphrase'}
            />
          </div>
          {status === 'incomplete' && (
            <p className="passphrase-status pending">Re-enter the passphrase to confirm.</p>
          )}
          {status === 'match' && value !== '' && (
            <p className="passphrase-status ok">Passphrases match.</p>
          )}
          {status === 'mismatch' && (
            <p className="passphrase-status err">Passphrases do not match.</p>
          )}
        </div>
      )}
    </div>
  );
}
