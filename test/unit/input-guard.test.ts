import { describe, it, expect } from 'vitest';
import { toDiskIndex, toChkdskVolume } from '../../src/main/utils/input-guard';
import { queryReliability } from '../../src/main/utils/disk-health';
import { getMbrInfo, getMbrRaw, chkdskScan } from '../../src/main/utils/disk-tools';

/**
 * IPC handlers receive untrusted argument shapes despite their TS
 * annotations: every sink that interpolates a value into PowerShell text
 * must reject non-integers/non-drive-letters at runtime.
 */
describe('toDiskIndex', () => {
  it('accepts non-negative integers', () => {
    expect(toDiskIndex(0)).toBe(0);
    expect(toDiskIndex(3)).toBe(3);
    expect(toDiskIndex(1024)).toBe(1024);
  });

  it('rejects injection payloads and non-integers', () => {
    for (const bad of ['0; Start-Process calc', '1; calc', -1, 1.5, NaN, Infinity, null, undefined, {}, [], true, '']) {
      expect(() => toDiskIndex(bad), `expected reject for ${JSON.stringify(bad)}`).toThrow(/Invalid disk index/);
    }
  });
});

describe('toChkdskVolume', () => {
  it('accepts bare drive letters with optional trailing slash', () => {
    expect(toChkdskVolume('C:')).toBe('C:');
    expect(toChkdskVolume('c:\\')).toBe('c:\\');
    expect(toChkdskVolume('D:\\')).toBe('D:\\');
  });

  it('rejects injection payloads and multi-segment paths', () => {
    for (const bad of ['C: & calc', 'C:\\ & calc', 'C:\\Windows', '$(calc)', '; calc', 'C', 0, null, undefined, {}]) {
      expect(() => toChkdskVolume(bad), `expected reject for ${JSON.stringify(bad)}`).toThrow(/Invalid volume/);
    }
  });
});

describe('PowerShell sinks reject invalid disk indexes before spawning', () => {
  it('queryReliability returns null without running a command', () => {
    expect(queryReliability('0; Start-Process calc' as unknown as number)).toBeNull();
    expect(queryReliability(-1)).toBeNull();
  });

  it('getMbrInfo returns ok:false with the guard error', () => {
    const result = getMbrInfo('0; Start-Process calc' as unknown as number);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid disk index/);
  });

  it('getMbrRaw returns ok:false with the guard error', async () => {
    const result = await getMbrRaw('0; Start-Process calc' as unknown as number);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid disk index/);
  });

  it('chkdskScan returns ok:false for a tampered volume', () => {
    const result = chkdskScan('C: & calc');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid volume/);
  });
});
