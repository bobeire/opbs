import { describe, it, expect } from 'vitest';
import { flagValue, positionals, VALUE_FLAGS } from '../../src/main/cli/flags';

describe('flagValue', () => {
  it('reads the following token for a space-separated flag', () => {
    expect(flagValue(['repo', 'init', '/r', '--remote', 's3://b/x'], '--remote')).toBe('s3://b/x');
  });

  it('reads the equals form', () => {
    expect(flagValue(['--remote=s3://b/x', '--remote-lock=GOVERNANCE'], '--remote')).toBe('s3://b/x');
    expect(flagValue(['--remote=s3://b/x', '--remote-lock=GOVERNANCE'], '--remote-lock')).toBe('GOVERNANCE');
  });

  it('prefers the first occurrence', () => {
    expect(flagValue(['--lock-days=5', '--lock-days', '9'], '--lock-days')).toBe('5');
    expect(flagValue(['--lock-days', '9', '--lock-days=5'], '--lock-days')).toBe('9');
  });

  it('keeps "=" characters inside the value', () => {
    expect(flagValue(['--passphrase=a=b=c'], '--passphrase')).toBe('a=b=c');
  });

  it('does not match longer flag names', () => {
    expect(flagValue(['--remote-lock=G'], '--remote')).toBeUndefined();
    expect(flagValue(['--remotex=s3://b'], '--remote')).toBeUndefined();
  });

  it('returns undefined when absent', () => {
    expect(flagValue([], '--remote')).toBeUndefined();
    expect(flagValue(['--anchor=/x'], '--remote')).toBeUndefined();
  });
});

describe('positionals', () => {
  it('skips space-separated value flags and their values', () => {
    expect(positionals(['init', '/r', '--lock-days', '5'])).toEqual(['init', '/r']);
  });

  it('skips equals-form value flags without consuming the next token', () => {
    expect(positionals(['init', '/r', '--remote=s3://b/x', 'extra'])).toEqual(['init', '/r', 'extra']);
  });

  it('skips a stray -- separator', () => {
    expect(positionals(['prune', '/r', '--', '--remote', 's3://b/x'])).toEqual(['prune', '/r']);
  });

  it('does not treat unknown boolean flags as value flags', () => {
    expect(positionals(['verify', '/r', '--fast'], VALUE_FLAGS)).toEqual(['verify', '/r']);
  });
});
