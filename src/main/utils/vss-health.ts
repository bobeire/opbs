/**
 * VSS health, checked before it matters.
 *
 * A backup cannot be consistent without a shadow copy, so "is VSS working on
 * this machine?" is a question worth answering *before* someone relies on an
 * answer. The 2026-11-03 field report found a machine where the subsystem was
 * damaged (two DLLs that would not re-register, one missing) and every backup
 * had silently read the live disk instead. The failure was discovered three
 * days later by a chkdsk on a restore.
 *
 * Two jobs: probe it, and explain a failure in terms a person can act on. A
 * raw `VSS_E_...` code is not an answer.
 */

export interface VssProbeResult {
  ok: boolean;
  /** The raw failure, when there is one. */
  error?: string;
  /** What to do about it. */
  advice?: string;
}

/**
 * Try to take and release a shadow copy of a volume. That is the whole
 * capability a backup needs, so it is the honest thing to test — not the
 * state of a service, which can be running while snapshotting is broken.
 */
export function probeVss(
  native: {
    createSnapshot(volumePath: string): { id: string; devicePath: string };
    deleteSnapshot(id: string): boolean;
  },
  volumePath: string
): VssProbeResult {
  let id: string | null = null;
  try {
    const snapshot = native.createSnapshot(volumePath);
    id = snapshot.id;
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, advice: adviseVssFailure(message) };
  } finally {
    if (id !== null) {
      try {
        native.deleteSnapshot(id);
      } catch {
        // A probe snapshot we cannot delete is worth reporting but does not
        // make the probe itself a failure — the capability was proven.
      }
    }
  }
}

/**
 * Turn a shadow-copy failure into something a person can act on.
 *
 * Corrected against the SDK (vsserror.h) on 2026-11-04: the first version
 * mapped 0x80042316 to "a writer is broken, re-register the DLLs" and
 * lumped 0x80042313/0x80042314 in with provider failure. All three are
 * transient. Telling someone to reinstall VSS because a snapshot was already
 * in progress is the worst kind of advice: authoritative, confident, wrong.
 */
export function adviseVssFailure(message: string): string {
  const m = message.toLowerCase();

  // VSS_E_SNAPSHOT_SET_IN_PROGRESS (0x80042316): another shadow copy is
  // being created right now. Not damage — just busy. Wait and retry.
  if (/0x80042316|snapshot_set_in_progress|snapshot set in progress/.test(m)) {
    return (
      'Another shadow copy is already being created on this machine, so this one was refused. ' +
      'Nothing is broken. Wait for the other operation to finish and try again — a scheduled ' +
      'backup, a system restore point or another tool may be running.'
    );
  }

  // VSS_E_FLUSH_WRITES_TIMEOUT (0x80042313) / VSS_E_HOLD_WRITES_TIMEOUT
  // (0x80042314): the volume was too busy to freeze in time. Transient.
  if (/0x80042313|0x80042314|flush_writes_timeout|hold_writes_timeout/.test(m)) {
    return (
      'The volume was too busy to freeze in time — heavy disk activity when the snapshot was ' +
      'requested. This is a timeout, not damage. Try again when the machine is quieter, or just ' +
      'retry: it usually succeeds on a second attempt.'
    );
  }

  // Writer errors 0x800423F0..0x800423F4. These come from a specific writer;
  // only 0x800423F3 is worth retrying.
  if (/0x800423f[0-4]|writererror/.test(m)) {
    const nonRetryable = /0x800423f4|writererror_nonretryable/.test(m);
    return (
      'A VSS writer reported a failure while preparing the snapshot. Run `vssadmin list writers` ' +
      'to see which one and what state it is in — a writer stuck in a failed state is the usual ' +
      'cause, and restarting that writer (or the machine) clears it.' +
      (nonRetryable
        ? ' This particular code is marked non-retryable by VSS, so the writer itself needs attention.'
        : ' Retrying is reasonable; some of these clear on their own.')
    );
  }

  // VSS_E_UNEXPECTED_PROVIDER_ERROR (0x8004230F). Often a third-party
  // provider rather than Windows' own.
  if (/0x8004230f|unexpected_provider_error/.test(m)) {
    return (
      'A shadow copy provider failed unexpectedly. That is often a third-party provider rather ' +
      'than the Windows system one — check `vssadmin list providers`. If one you do not recognise ' +
      'is present, that is a likely cause.'
    );
  }

  // VSS_E_VOLUME_NOT_SUPPORTED (0x8004230C) and friends.
  if (/0x8004230c|0x80042309|volume_not_supported|unsupported_volume/.test(m)) {
    return (
      'This volume cannot be snapshot. FAT32 and exFAT volumes never can, and some storage ' +
      'controllers do not support it. For those volumes, only a live capture is possible: use ' +
      '--allow-inconsistent and accept that the image has no single point in time.'
    );
  }

  // VSS_E_INSUFFICIENT_STORAGE and snapshot-count exhaustion.
  if (/0x8004231f|0x80042310|insufficient_storage|maximum_number_of_snapshots/.test(m)) {
    return (
      'There is no room left for shadow copies on this volume, or too many already exist. Free ' +
      'some space or delete old shadow copies with `vssadmin delete shadows`, then retry.'
    );
  }

  if (/service|not running|rpc|0x800706ba|0x80070422/.test(m)) {
    return (
      'The VSS service is not running or could not be reached. Start "Volume Shadow Copy" in ' +
      'services.msc (and "Microsoft Software Shadow Copy Provider"), then retry.'
    );
  }

  return (
    'A shadow copy could not be taken. Run `vssadmin list writers` and `vssadmin list providers` ' +
    'to see whether a writer or a provider is in a failed state, and retry — many of these are ' +
    'transient. Without a shadow copy a backup cannot capture a running Windows consistently.'
  );
}

/**
 * Failures that are worth retrying, and failures that are not.
 *
 * A shadow copy is a read-only operation from the user's point of view, so
 * retrying is safe where it can work. The three below are transient by
 * nature: a snapshot already in progress (0x80042316), and the two freeze
 * timeouts (0x80042313 / 0x80042314) that mean the volume was too busy to
 * freeze in time. Retrying those with a short backoff turns a lot of "the
 * backup failed" into "the backup worked on the second try".
 *
 * Everything else is a decision, not a wait: a volume that cannot be
 * snapshotted, or a writer that has failed, will fail again.
 */
export function isTransientVssFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /0x80042316|snapshot_set_in_progress/.test(m) ||
    /0x80042313|0x80042314|flush_writes_timeout|hold_writes_timeout/.test(m) ||
    /0x800423f3|writererror_retryable/.test(m)
  );
}

/**
 * The message for a machine where VSS is broken outright. Distinct from "this
 * volume cannot be snapshotted", which is a property of the volume rather than
 * of the machine — the two need different fixes, and conflating them was part
 * of why the field report took three days to understand.
 */
export function vssBrokenMessage(volumeLabel: string, error: string): string {
  return (
    `VSS is not working on this machine: a shadow copy of ${volumeLabel} could not be created ` +
    `(${error}). Without one, a backup would read the disk while Windows is still writing to it and ` +
    `produce an image with no single point in time - it restores as a filesystem that looks corrupt, ` +
    `even though every block verifies. The backup has been stopped and no partitions have been ` +
    `captured. ${adviseVssFailure(error)} Retry with --allow-inconsistent if you accept an image ` +
    `captured without a point in time.`
  );
}
