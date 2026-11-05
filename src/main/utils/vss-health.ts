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
 *
 * Corrected a second time against the same header: 0x80042309 is not an
 * error at all (VSS_S_ASYNC_PENDING is 0x00042309, a success status), and
 * 0x80042310 is VSS_E_CORRUPT_XML_DOCUMENT, not a storage code. The codes
 * those two were standing in for are 0x8004230E (volume not supported by the
 * provider) and 0x80042317 (too many shadow copies).
 */
export function adviseVssFailure(message: string): string {
  const m = message.toLowerCase();

  // VSS_E_SNAPSHOT_SET_IN_PROGRESS (0x80042316): another shadow copy is
  // being created right now. Not damage — just busy. Wait and retry.
  //
  // The other operation is often this program's own previous attempt: a set
  // started by a backup that then failed stays "in progress" until it is
  // released, so the retry collides with the corpse. That is why the retry
  // delay matters, and why persistent 0x80042316 after a failed backup means
  // "clear the abandoned set", not "something else is running".
  if (/0x80042316|snapshot_set_in_progress|snapshot set in progress/.test(m)) {
    return (
      'Another shadow copy is already being created on this machine, so this one was refused. ' +
      'Nothing is broken. Wait for the other operation to finish and try again — a scheduled ' +
      'backup, a system restore point or another tool may be running, and a previous attempt ' +
      'of this backup that failed can also leave a set behind. If it keeps happening, an ' +
      'elevated `vssadmin list shadows` shows what is there and restarting the Volume Shadow ' +
      'Copy service clears an abandoned set.'
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

  // Writer errors 0x800423F0..0x800423F4, plus the three writer-side codes
  // 0x80042315 (unexpected writer error), 0x80042318 (writer infrastructure)
  // and 0x80042319 (writer not responding). These come from a specific
  // writer; only 0x800423F3 is worth retrying.
  if (/0x800423f[0-4]|0x8004231[589]|writererror|unexpected_writer_error|writer_infrastructure|writer_not_responding/.test(m)) {
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

  // VSS_E_PROVIDER_VETO (0x80042306): a provider refused to create the shadow
  // copy. Common causes are another backup or security product's provider,
  // too little shadow-copy storage, or a volume that was changing too fast.
  // This is not "the volume cannot be snapshotted", so it must not point
  // at --allow-inconsistent: that turns a fixable refusal into a live read.
  if (/0x80042306|provider_veto/.test(m)) {
    return (
      'A shadow copy provider refused to create the snapshot. Common causes are another backup or ' +
      'security product\'s VSS provider, too little shadow-copy storage, or a volume that was busy. ' +
      'Check `vssadmin list providers` (only the Microsoft Software Shadow Copy provider and ' +
      'products you know should be listed) and `vssadmin list shadowstorage`, look for VSS or ' +
      'VolSnap errors in the Application event log, and retry once. Do not work around this with ' +
      '--allow-inconsistent: fix the cause instead.'
    );
  }

  // VSS_E_PROVIDER_NOT_REGISTERED (0x80042304): damage to the VSS installation
  // itself, not a busy machine - the one case where repairing Windows is the
  // right advice.
  if (/0x80042304|provider_not_registered/.test(m)) {
    return (
      'The shadow copy provider is not registered with Windows, which points at damage to the VSS ' +
      'installation rather than a busy machine. `vssadmin list providers` should list \'Microsoft ' +
      'Software Shadow Copy provider\'. If it does not, repairing system files usually restores ' +
      'it: run `sfc /scannow`, then `DISM /Online /Cleanup-Image /RestoreHealth`, restart, and retry.'
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
  if (/0x8004230c|0x8004230e|volume_not_supported|unsupported_volume/.test(m)) {
    return (
      'This volume cannot be snapshot. FAT32 and exFAT volumes never can, and some storage ' +
      'controllers do not support it. For those volumes, only a live capture is possible: use ' +
      '--allow-inconsistent and accept that the image has no single point in time.'
    );
  }

  // VSS_E_INSUFFICIENT_STORAGE and snapshot-count exhaustion.
  if (/0x8004231f|0x80042317|0x8004231e|insufficient_storage|maximum_number_of_snapshots|maximum_diffarea/.test(m)) {
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
 * The message for a volume that cannot be snapshotted at all. Distinct from
 * "VSS is broken on this machine" — conflating them made a FAT32 boot
 * partition look like a damaged Windows install (field report 2026-11-04:
 * "VSS is not working on this machine: a shadow copy of OPBS-BOOT ... could
 * not be created (0x8004230c)"). VSS was fine; the filesystem cannot be
 * snapshotted and never could be.
 */
export function volumeNotSnapshotableMessage(label: string, error: string): string {
  return (
    `${label} cannot be snapshotted (${error}). That is a property of the volume or the device ` +
    `behind it, not a fault: FAT32 and exFAT volumes are never snapshot-able, and some USB flash ` +
    `devices and storage controllers do not support VSS snapshots even on NTFS. This volume was ` +
    `captured live, so it has no single point in time — the rest of the backup was frozen ` +
    `normally. If it is FAT32 or exFAT, converting it to NTFS may help; if it is already NTFS, ` +
    `the device does not support snapshots and --allow-inconsistent is the only way to include it.`
  );
}

/**
 * The message for "none of the selected volumes can be snapshotted".
 *
 * This must not reuse vssBrokenMessage: when every volume is FAT32 (a recovery
 * stick, the usual case) nothing is broken and nothing needs repairing. The
 * earlier code said "VSS is not working on this machine" for exactly this.
 */
export function noneSnapshotableMessage(labels: string[], error: string): string {
  return (
    `No selected volume can be snapshotted (${error}): ${labels.join(', ')}. That is a property ` +
    `of those volumes or the device behind them, not a fault: FAT32 and exFAT volumes are never ` +
    `snapshot-able, and some USB flash devices and storage controllers do not support VSS ` +
    `snapshots even on NTFS. Nothing was captured, because a backup with no snapshot has no ` +
    `single point in time. Retry with --allow-inconsistent to capture these volumes live and ` +
    `accept that. If a volume is FAT32 or exFAT, converting it to NTFS may help; if it is ` +
    `already NTFS, the device does not support snapshots.`
  );
}

/**
 * Failures that mean "this particular volume cannot be snapshotted", as
 * opposed to "VSS is broken". These are permanent: retrying will not help,
 * and refusing the whole backup because one small FAT32 boot partition
 * exists is the wrong answer.
 */
export function isVolumeNotSnapshotable(message: string): boolean {
  const m = message.toLowerCase();
  return /0x8004230c|0x80042309|volume_not_supported|unsupported_volume/.test(m);
}

/**
 * The message for a snapshot refused because another set is already in
 * progress (0x80042316), or another failure that is transient by nature.
 *
 * This must not reuse vssBrokenMessage: its first sentence is "VSS is not
 * working on this machine", which is exactly what the 2026-11-05 field report
 * showed to be false while the very same message went on to say "Nothing is
 * broken". A lock is a wait, not a diagnosis. (Field report 2026-11-05: a
 * failed attempt left its own set behind, the retry hit 0x80042316, and the
 * error accused a healthy machine of broken VSS.)
 */
export function vssBusyMessage(
  volumeLabel: string,
  error: string,
  attempts: number,
  waitedMs: number
): string {
  const waited = waitedMs > 0 ? `${Math.round(waitedMs / 1000)} second(s)` : 'no time';
  return (
    `Another shadow copy was still in progress, so a shadow copy of ${volumeLabel} could not be ` +
    `created (${error}). Nothing is broken and no partitions have been captured. OPBS waited ` +
    `${waited} and tried ${attempts} time(s). This is a wait, not a repair: a scheduled backup, ` +
    `a restore point, another imaging tool, or a snapshot set left by an earlier failed attempt ` +
    `can hold the lock. Let the other operation finish and try again. If it keeps happening, an ` +
    `elevated \`vssadmin list shadows\` shows what is there; a set left by OPBS 0.6.115 or older ` +
    `can also be cleared by restarting the Volume Shadow Copy service. OPBS 0.6.116 and later ` +
    `delete their own set when a snapshot attempt fails. If you accept an image with no single ` +
    `point in time, enable "Back up without a snapshot" in the backup options (or use ` +
    `--allow-inconsistent).`
  );
}

/**
 * Pick the honest message for a snapshot that never succeeded.
 *
 * Transient failures get the "wait, nothing is broken" text; everything else
 * gets the machine/volume diagnosis. Keeping the choice in one function makes
 * it testable without running VSS, and stops the two messages drifting apart.
 */
export function snapshotFailureMessage(
  volumeLabel: string,
  error: string,
  attempts: number,
  waitedMs: number
): string {
  return isTransientVssFailure(error)
    ? vssBusyMessage(volumeLabel, error, attempts, waitedMs)
    : vssBrokenMessage(volumeLabel, error);
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
