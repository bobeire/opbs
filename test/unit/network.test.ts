import { describe, it, expect } from 'vitest';
import { testNetworkDestination, enumerateShares, discoverNetworkMachines } from '../../src/main/utils/network';

describe('network destinations', () => {
  it('accepts smb:// URIs and normalises to UNC paths', async () => {
    const res = await testNetworkDestination('smb://server/share', false);
    expect(res.path).toBe('\\\\server\\share');
  });

  it('normalises forward-slash UNC input to backslashes', async () => {
    const res = await testNetworkDestination('//server/share', false);
    expect(res.path).toBe('\\\\server\\share');
  });

  it('reports a missing remote destination as not ok', async () => {
    const res = await testNetworkDestination('\\\\definitely-not-a-host-xyz\\C$\\opbs', false);
    expect(res.ok).toBe(false);
    expect(res.path).toBe('\\\\definitely-not-a-host-xyz\\C$\\opbs');
  });

  it('never crashes on empty input', async () => {
    const res = await testNetworkDestination('', false);
    expect(res.ok).toBe(false);
  });

  it('discovers machines without throwing', async () => {
    const machines = await discoverNetworkMachines();
    expect(Array.isArray(machines)).toBe(true);
    expect(machines.some((m) => m.name && m.name.length > 0)).toBe(true);
  });

  it('enumerates shares for the local host without throwing', async () => {
    const shares = await enumerateShares('localhost');
    expect(Array.isArray(shares)).toBe(true);
    expect(shares.some((s) => s.unc.startsWith('\\\\'))).toBe(true);
  });
});