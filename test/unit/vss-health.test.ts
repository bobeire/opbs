import { describe, it, expect } from 'vitest';
import { probeVss, adviseVssFailure, vssBrokenMessage, isVolumeNotSnapshotable, volumeNotSnapshotableMessage, noneSnapshotableMessage, snapshotFailureMessage, vssBusyMessage } from '../../src/main/utils/vss-health';

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

  it('maps the codes the first two versions got wrong', () => {
    // 0x80042309 is not an error at all: VSS_S_ASYNC_PENDING is 0x00042309, a
    // success status. It used to be treated as "volume cannot be snapshot".
    expect(adviseVssFailure('0x80042309')).not.toContain('cannot be snapshot');
    // 0x80042310 is VSS_E_CORRUPT_XML_DOCUMENT, not a storage problem.
    expect(adviseVssFailure('0x80042310')).not.toContain('no room left');
    // The codes those two stood in for.
    expect(adviseVssFailure('0x8004230E')).toContain('cannot be snapshot');
    expect(adviseVssFailure('VSS_E_VOLUME_NOT_SUPPORTED_BY_PROVIDER')).toContain('cannot be snapshot');
    expect(adviseVssFailure('0x80042317')).toContain('too many');
    expect(adviseVssFailure('0x8004231E')).toContain('no room left');
  });

  it('does not send a refused snapshot to --allow-inconsistent', () => {
    // VSS_E_PROVIDER_VETO is a fixable refusal (another product's provider, too
    // little shadow storage), not a volume that cannot be snapshot. Pointing it
    // at a live capture would recreate the 2026-11-03 failure.
    const advice = adviseVssFailure('VSS operation failed with HRESULT 0x80042306');
    expect(advice).toContain('refused');
    expect(advice).toContain('vssadmin list providers');
    expect(advice).toContain('vssadmin list shadowstorage');
    expect(advice).toContain('Do not work around this');
    expect(advice).not.toContain('cannot be snapshot');
  });

  it('treats the three writer-side codes as writer problems', () => {
    // Asserted on the writer-specific wording, because the generic fallback also
    // mentions `vssadmin list writers` and would let a missing branch pass.
    for (const code of ['0x80042315', '0x80042318', '0x80042319']) {
      expect(adviseVssFailure(code)).toContain('A VSS writer reported a failure');
    }
    expect(adviseVssFailure('VSS_E_WRITER_NOT_RESPONDING')).toContain('A VSS writer reported a failure');
  });

  it('reserves "repair Windows" for the one code that means damage', () => {
    // Re-registering or repairing VSS because of a busy machine is the advice
    // that was wrong before. A missing provider is the case it belongs to.
    const advice = adviseVssFailure('0x80042304');
    expect(advice).toContain('not registered');
    expect(advice).toContain('sfc /scannow');
    expect(adviseVssFailure('0x80042316')).not.toContain('sfc');
    expect(adviseVssFailure('0x80042313')).not.toContain('sfc');
  });

  it('only treats the two unsupported-volume codes as a per-volume limit', () => {
    // This classifier decides whether a volume is captured live instead of
    // the backup being refused, so it must stay narrow.
    for (const supported of ['0x8004230c', '0x8004230E', 'VSS_E_VOLUME_NOT_SUPPORTED', 'VSS_E_VOLUME_NOT_SUPPORTED_BY_PROVIDER']) {
      expect(isVolumeNotSnapshotable(`VSS operation 'AddToSnapshotSet' failed with HRESULT ${supported}`)).toBe(true);
    }
    // 0x80042309 is not an error (VSS_S_ASYNC_PENDING is 0x00042309).
    expect(isVolumeNotSnapshotable('0x80042309')).toBe(false);
    // Fixable refusals must never degrade to a live capture.
    for (const fixable of ['0x80042306', '0x80042316', '0x8004231f', '0x80042304', '0x80042313', '0x800423f4']) {
      expect(isVolumeNotSnapshotable(`HRESULT ${fixable}`)).toBe(false);
    }
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
    // Field-verified on 2026-11-04: an NTFS volume on a USB flash device also
    // returned 0x8004230c. Advising "convert to NTFS" unconditionally would
    // send that user in a circle, so the message must name the device.
    expect(message).toContain('USB flash devices');
    expect(message).toContain('already NTFS');
  });
});

describe('when no selected volume can be snapshotted', () => {
  it('blames the volumes, not VSS, and offers both ways forward', () => {
    // A recovery stick is often all-FAT32. Nothing here is broken.
    const message = noneSnapshotableMessage(
      ['OPBS-BOOT', 'OPBS-DATA'],
      'VSS_E_VOLUME_NOT_SUPPORTED'
    );
    expect(message).toContain('OPBS-BOOT, OPBS-DATA');
    expect(message).not.toContain('not working on this machine');
    expect(message).toContain('property of those volumes');
    expect(message).toContain('--allow-inconsistent');
    expect(message).toContain('NTFS');
  });
});

describe('a snapshot refused because another one is in progress', () => {
  it('never opens with "VSS is not working on this machine"', () => {
    // Field report 2026-11-05: the retry collided with the previous attempt's
    // own abandoned set. The final message began "VSS is not working on this
    // machine" and then said "Nothing is broken" in the same paragraph. The
    // machine was healthy; the message was not.
    const message = snapshotFailureMessage(
      'OPBS-BOOT',
      "VSS operation 'StartSnapshotSet' failed with HRESULT 0x80042316",
      5,
      29_000
    );
    expect(message).not.toContain('not working on this machine');
    expect(message).toContain('Another shadow copy was still in progress');
    expect(message).toContain('Nothing is broken');
    expect(message).toContain('no partitions have been captured');
    // The wait is visible, so "it failed instantly" is not the impression.
    expect(message).toContain('29 second(s)');
    expect(message).toContain('5 time(s)');
    // And it points at the self-inflicted cause rather than blaming a ghost.
    expect(message).toContain('earlier failed attempt');
  });

  it('keeps the broken-machine diagnosis for non-transient failures', () => {
    const message = snapshotFailureMessage(
      'Real',
      'VSS_E_UNEXPECTED_PROVIDER_ERROR',
      1,
      0
    );
    expect(message).toContain('VSS is not working on this machine');
  });

  it('names the live-capture escape hatch without pretending it is safe', () => {
    const message = vssBusyMessage('OPBS-BOOT', '0x80042316', 5, 29_000);
    expect(message).toContain('Back up without a snapshot');
    expect(message).toContain('no single point in time');
  });
});

describe('a snapshot set abandoned by a failed attempt', () => {
  it('is named as a likely cause of "already in progress"', () => {
    // The 0.6.113 native helper called CoUninitialize() while the live VSS
    // requester object still held an in-progress set. The retry then hit
    // 0x80042316 and the message blamed some other program.
    const advice = adviseVssFailure('StartSnapshotSet failed with HRESULT 0x80042316');
    expect(advice).toContain('previous attempt');
    expect(advice).toContain('vssadmin list shadows');
  });
});
