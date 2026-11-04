import { describe, it, expect } from 'vitest';
import { probeVss, adviseVssFailure, vssBrokenMessage, isVolumeNotSnapshotable, volumeNotSnapshotableMessage } from '../../src/main/utils/vss-health';

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
    expect(result.advice).toContain('vssadmin');
    expect(deleted).toBe('');
  });

  it('distinguishes the causes, and does not call a busy machine broken', () => {
    // Corrected against vsserror.h on 2026-11-04. The first version told
    // someone to re-register VSS DLLs because a snapshot was already in
    // progress — authoritative, confident, and wrong.
    expect(adviseVssFailure('VSS_E_SNAPSHOT_SET_IN_PROGRESS')).toContain('already being created');
    expect(adviseVssFailure('VSS_E_SNAPSHOT_SET_IN_PROGRESS')).toContain('Nothing is broken');
    // Both of these are timeouts from heavy activity: retry, do not reinstall.
    expect(adviseVssFailure('VSS_E_FLUSH_WRITES_TIMEOUT')).toContain('too busy');
    expect(adviseVssFailure('0x80042314')).toContain('retry');
    expect(adviseVssFailure('VSS_E_UNEXPECTED_PROVIDER_ERROR')).toContain('third-party provider');
    expect(adviseVssFailure('VSS_E_VOLUME_NOT_SUPPORTED')).toContain('FAT32 and exFAT');
    expect(adviseVssFailure('VSS_E_INSUFFICIENT_STORAGE')).toContain('vssadmin');
    expect(adviseVssFailure('The service is not running')).toContain('services.msc');
  });

  it('tells a retryable writer error from a non-retryable one', () => {
    // 0x800423F3 is retryable, 0x800423F4 explicitly is not.
    expect(adviseVssFailure('0x800423F3')).toContain('Retrying is reasonable');
    expect(adviseVssFailure('0x800423F4')).toContain('non-retryable');
    // And both point at the tool that names the writer.
    expect(adviseVssFailure('0x800423F0')).toContain('vssadmin list writers');
  });

  it('always offers a way forward for an unrecognised failure', () => {
    // Never a dead end: some failure we have not seen before still has to
    // tell the user what to do next.
    const advice = adviseVssFailure('something entirely new went wrong');
    expect(advice.length).toBeGreaterThan(20);
    expect(advice).toContain('vssadmin');
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

describe('a volume that cannot be snapshotted is not a broken machine', () => {
  it('says it is the volume, not VSS', () => {
    // Field report 2026-11-04: backing up a dual-partition USB, whose boot
    // partition is FAT32, produced "VSS is not working on this machine" —
    // which was both wrong and alarming. VSS was fine; FAT32 cannot be
    // snapshotted and never could be.
    expect(isVolumeNotSnapshotable('VSS operation failed with HRESULT 0x8004230c')).toBe(true);
    expect(isVolumeNotSnapshotable('VSS_E_VOLUME_NOT_SUPPORTED')).toBe(true);
    // Transient and systemic failures are a different matter.
    expect(isVolumeNotSnapshotable('VSS_E_SNAPSHOT_SET_IN_PROGRESS')).toBe(false);
    expect(isVolumeNotSnapshotable('VSS_E_UNEXPECTED_PROVIDER_ERROR')).toBe(false);

    const message = volumeNotSnapshotableMessage('OPBS-BOOT', 'VSS_E_VOLUME_NOT_SUPPORTED');
    expect(message).toContain('OPBS-BOOT');
    // It must not claim the machine is broken.
    expect(message).not.toContain('not working on this machine');
    expect(message).toContain('property of the volume');
    expect(message).toContain('captured live');
  });
});
