/**
 * Browse-view passphrase gating.
 *
 * Encrypted Macrium v7 (.mrimg) images are readable once unlocked, so they use
 * the same passphrase field and debounced re-open as Reflect X (.mrimgx).
 * Keeping the predicates here (rather than in JSX) lets them be unit-tested
 * without a DOM renderer.
 */

/** Whether an encrypted image should show the passphrase field. */
export function needsBrowsePassphrase(encrypted: boolean | undefined): boolean {
  return Boolean(encrypted);
}

/**
 * Whether a passphrase change should re-open the image to unlock it.
 * OPBS images keep their existing explicit-open flow; both Macrium formats
 * re-open so a correct passphrase can be applied without re-selecting a file.
 */
export function shouldReopenForPassphrase(
  imagePath: string | undefined,
  encrypted: boolean | undefined,
  imageFormat: string | undefined
): boolean {
  return Boolean(
    imagePath &&
      encrypted &&
      (imageFormat === 'mrimg' || imageFormat === 'mrimgx')
  );
}

/** Identity of one unlock attempt, used to avoid re-opening after the result lands. */
export function browsePassphraseAttemptKey(imagePath: string, passphrase: string): string {
  return `${imagePath}\u0000${passphrase}`;
}

/** Hint shown for a partition that cannot be browsed. Prefer the exact reason. */
export function browsePartitionHint(partition: {
  partitionIndex: number;
  fsType?: string;
  reason?: string;
}): string {
  if (partition.reason) return partition.reason;
  return `Partition ${partition.partitionIndex} uses ${partition.fsType ?? 'an unsupported'} — only NTFS, FAT32 and exFAT partitions can be browsed.`;
}
