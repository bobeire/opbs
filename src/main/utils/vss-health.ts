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
 * Turn a shadow-copy failure into something a person can act on. The codes
 * are Windows'; the causes are few and each has a different fix.
 */
export function adviseVssFailure(message: string): string {
  const m = message.toLowerCase();
  if (/vss_e_unexpected_provider_error|vss_e_writer_infrastructural|0x80042316|0x80042313/.test(m)) {
    return (
      'The shadow copy provider failed unexpectedly. That usually means a VSS writer is broken or a ' +
      'previous backup or restore interrupted one. Try the VSS diagnostics (re-register the VSS DLLs ' +
      'and restart the service), then run this check again.'
    );
  }
  if (/vss_e_volume_not_supported|vss_e_unsupported_volume|0x80042306|0x8004230c/.test(m)) {
    return (
      'This volume cannot be snapshot. FAT32 and exFAT volumes never can, and some storage ' +
      'controllers do not support it. For those volumes, only a live capture is possible: use ' +
      '--allow-inconsistent and accept that the image has no single point in time.'
    );
  }
  if (/vss_e_insufficient_storage|0x8004231f|vss_e_maximum_number_of_snapshots/.test(m)) {
    return (
      'There is no room left for shadow copies on this volume, or too many already exist. Free some ' +
      'space or delete old shadow copies with `vssadmin delete shadows`, then retry.'
    );
  }
  if (/service|not running|rpc|0x800706ba|0x80070422/.test(m)) {
    return (
      'The VSS service is not running or could not be reached. Start "Volume Shadow Copy" in ' +
      'services.msc (and "Microsoft Software Shadow Copy Provider"), then retry.'
    );
  }
  return (
    'A shadow copy could not be taken. Run the VSS diagnostics to test it directly and repair the ' +
    'subsystem, then run this check again. Without a shadow copy a backup cannot capture a running ' +
    'Windows consistently.'
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
