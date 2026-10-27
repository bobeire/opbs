import { describe, it, expect } from 'vitest';
import { LogLevel, normalizeLogLevel } from '../../src/main/utils/logger';

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
