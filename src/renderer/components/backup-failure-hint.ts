/**
 * The hint under a failed backup, chosen from what actually failed.
 *
 * A single generic line used to cover every non-snapshot failure and said
 * "The backup did not start ... check that the destination folder exists".
 * A field report (2026-11-06) showed that text beneath an error from the
 * post-backup filesystem check, where the backup had in fact run to the end
 * and produced an image. Telling someone it never started sends them to the
 * wrong place and reads as if their failure was not believed, so the stage is
 * part of the message.
 */
export type BackupFailureStage = 'snapshot-unsupported' | 'snapshot-busy' | 'ran' | 'not-started';

export function backupFailureHint(stage: BackupFailureStage): string {
  switch (stage) {
    case 'snapshot-unsupported':
      return (
        'Windows cannot take a shadow copy of this volume, so OPBS stopped before writing anything. ' +
        'Nothing is broken: FAT32 and exFAT volumes never support snapshots, and some USB flash devices ' +
        'refuse them even on NTFS. You can back it up live instead, accepting that the image has no ' +
        'single point in time.'
      );
    case 'snapshot-busy':
      return (
        'Another shadow copy is using VSS right now, so OPBS waited and then stopped before writing ' +
        'anything. Let the other operation finish and try again — a scheduled backup, a restore point, ' +
        'or another imaging tool may be running.'
      );
    case 'ran':
      return (
        'The backup ran but stopped before it produced an image OPBS could vouch for. The error above ' +
        'says what it found; the Logs page has the full report. If it left an image on disk, treat it as ' +
        'untrusted and do not restore from it until the cause is understood — the image being on disk ' +
        'does not mean the backup succeeded.'
      );
    case 'not-started':
      return (
        'The backup did not start. See the Logs page for details, then check that the destination ' +
        'folder exists and is writable.'
      );
  }
}
