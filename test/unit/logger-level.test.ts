import { describe, it, expect } from 'vitest';
import { LogLevel, normalizeLogLevel, logTimestamp } from '../../src/main/utils/logger';

describe('logTimestamp', () => {
  it('is local wall-clock time with no UTC claim', () => {
    // toISOString() appends "Z" and claims UTC. In a recovery environment the
    // clock is the hardware clock read as-is, so the printed time looked "in
    // the future" to a user comparing it with theirs (field report 2026-10-31).
    const stamp = logTimestamp(new Date(2026, 9, 31, 18, 27, 32, 455));
    expect(stamp).toBe('2026-10-31 18:27:32.455');
    expect(stamp).not.toContain('Z');
    expect(stamp).not.toContain('T');
  });

  it('pads every field so lines sort chronologically', () => {
    expect(logTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04:05.006');
  });
});

describe('normalizeLogLevel', () => {
  it('accepts the enum values as-is', () => {
    expect(normalizeLogLevel(LogLevel.DEBUG)).toBe(LogLevel.DEBUG);
    expect(normalizeLogLevel(LogLevel.ERROR)).toBe(LogLevel.ERROR);
  });

  it('normalizes the lowercase strings AppSettings stores', () => {
    expect(normalizeLogLevel('debug')).toBe(LogLevel.DEBUG);
    expect(normalizeLogLevel('info')).toBe(LogLevel.INFO);
    expect(normalizeLogLevel('warn')).toBe(LogLevel.WARN);
    expect(normalizeLogLevel('error')).toBe(LogLevel.ERROR);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeLogLevel('  Debug ')).toBe(LogLevel.DEBUG);
    expect(normalizeLogLevel('WARN')).toBe(LogLevel.WARN);
  });

  it('falls back to INFO on anything unknown', () => {
    expect(normalizeLogLevel('verbose')).toBe(LogLevel.INFO);
    expect(normalizeLogLevel('')).toBe(LogLevel.INFO);
    expect(normalizeLogLevel('nonsense')).toBe(LogLevel.INFO);
  });
});
