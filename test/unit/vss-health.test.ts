import { describe, it, expect } from 'vitest';
import { probeVss, adviseVssFailure, vssBrokenMessage } from '../../src/main/utils/vss-health';

/**
 * A raw VSS error code is not an answer. The 2026-11-03 field report spent
 * three days going through wrong explanations because nothing distinguished
 * "VSS is broken on this machine" from "this volume cannot be snapshotted" —
 * the two need completely different fixes.
 */
describe('VSS diagnosis', () => {
  it('reports success and cleans up its probe snapshot', () => {
    let deleted = '';
    const native = {
      createSnapshot: () => ({ id: 'probe-1', devicePath: '\\\\.\\ShadowCopy9' }),
      deleteSnapshot: (id: string) => {
        deleted = id;
        return true;
      }
    };
    const result = probeVss(native, '\\\\.\\Volume{x}\\');
    expect(result.ok).toBe(true);
    // A probe that leaves a snapshot behind is a leak.
    expect(deleted).toBe('probe-1');
  });

  it('reports failure with advice, and still releases what it made', () => {
    let deleted = '';
    const native = {
      createSnapshot: () => {
        throw new Error('VSS_E_UNEXPECTED_PROVIDER_ERROR');
      },
      deleteSnapshot: (id: string) => {
        deleted = id;
        return true;
      }
    };
    const result = probeVss(native, '\\\\.\\Volume{x}\\');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('VSS_E_UNEXPECTED_PROVIDER_ERROR');
    expect(result.advice).toContain('VSS diagnostics');
    expect(deleted).toBe('');
  });

  it('distinguishes a broken provider from an unsupported volume', () => {
    // Different causes, different fixes — conflating them is what made this
    // hard to diagnose.
    expect(adviseVssFailure('VSS_E_UNEXPECTED_PROVIDER_ERROR')).toContain('writer is broken');
    expect(adviseVssFailure('VSS_E_VOLUME_NOT_SUPPORTED')).toContain('FAT32 and exFAT');
    expect(adviseVssFailure('VSS_E_INSUFFICIENT_STORAGE')).toContain('vssadmin');
    expect(adviseVssFailure('The service is not running')).toContain('services.msc');
  });

  it('always offers a way forward for an unrecognised failure', () => {
    // Never a dead end: some failure we have not seen before still has to
    // tell the user what to do next.
    const advice = adviseVssFailure('something entirely new went wrong');
    expect(advice.length).toBeGreaterThan(20);
    expect(advice).toContain('diagnostics');
  });

  it('says plainly that the backup was stopped and why it matters', () => {
    const message = vssBrokenMessage('Real', 'VSS_E_UNEXPECTED_PROVIDER_ERROR');
    expect(message).toContain('VSS is not working on this machine');
    expect(message).toContain('Real');
    expect(message).toContain('no single point in time');
    // And it does not pretend the work was done.
    expect(message).toContain('no partitions have been captured');
    expect(message).toContain('--allow-inconsistent');
  });
});
