import { EventEmitter } from 'events';
import * as fs from 'fs';
import { RestoreCoordinator, RestoreJobConfig, mapRestoreJobProgress, summarizeImage, ImageSummary } from '../imaging/restore-engine';
import { RestoreJobProgress, RestoreJobResult } from '../imaging/imaging-job';
import { DiskEnumerator, querySystemDiskIndex } from '../utils/disk-enumerator';
import { listBitlockerStatus } from '../utils/bitlocker';
import { sidecarPathFor } from '../utils/bitlocker-capture';
import {
  isVirtualDiskPath,
  readVirtualDiskInfo,
  roundToSector,
  validateVirtualSize,
  virtualDiskFormatFromPath
} from '../utils/virtual-disk';
import { logger } from '../utils/logger';

export type RestoreConfig = RestoreJobConfig;

export interface RestorePreflightResult {
  ok: boolean;
  error?: string;
  /** Total bytes required on the target disk (captured partition sizes). */
  requiredBytes?: number;
  /** Total size of the target physical disk. */
  targetDiskBytes?: number;
  targetDiskModel?: string;
  /** Existing partitions on the target disk that the restore will overwrite. */
  targetDiskPartitionCount?: number;
  targets?: Array<{ partitionIndex: number; offset: number; size: number }>;
  /** Partition-table scheme the restore would write when the layout deviates. */
  writeTableScheme?: string | null;
  /** Engine warnings from the layout/same-disk safety gates. */
  warnings?: string[];
  sameDisk?: boolean;
  encrypted?: boolean;
  passphraseRequired?: boolean;
  /** The image's volume is BitLocker-locked — the UI must offer an unlock
   *  box (recovery password) and re-run the check; the restore cannot start. */
  unlockRequired?: boolean;
  /** Drive letter of the locked volume (single character, e.g. "D"). */
  lockedLetter?: string;
  /** True when the target disk holds Windows (system/boot) — a reboot is
   *  required after restore; secondary disks do not need one. */
  targetIsSystemDisk?: boolean;
  /** VHD/VHDX target: an existing file at the target path will be
   *  overwritten — the UI must ask for an explicit acknowledgement. */
  targetFileExists?: boolean;
}

export interface RestoreProgress {
  phase: 'preparing' | 'reading_image' | 'restoring' | 'completed' | 'error';
  percentComplete: number;
  bytesProcessed: number;
  totalBytes: number;
  speed: number;
  estimatedTimeRemaining: number;
  currentPartition: string;
  error?: string;
}

export class RestoreManager extends EventEmitter {
  private isRunning = false;
  private shouldCancel = false;
  private lastJobResult: RestoreJobResult | null = null;

  constructor(private coordinator: RestoreCoordinator, private diskEnumerator = new DiskEnumerator()) {
    super();
  }

  get running(): boolean {
    return this.isRunning;
  }

  get lastResult(): RestoreJobResult | null {
    return this.lastJobResult;
  }

  async startRestore(config: RestoreConfig): Promise<RestoreJobResult> {
    if (this.isRunning) {
      throw new Error('Restore already in progress');
    }

    this.isRunning = true;
    this.shouldCancel = false;

    try {
      await this.validateConfig(config);

      this.emitProgress({
        phase: 'preparing',
        percentComplete: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: ''
      });

      const result = await this.coordinator.runRestore(config, (progress: RestoreJobProgress) => {
        if (this.shouldCancel) {
          void this.coordinator.cancel();
        }
        this.emitMapped(progress);
      });

      this.lastJobResult = result;

      if (!result.ok) {
        throw new Error(result.error ?? 'Restore failed');
      }

      logger.info(
        `Restore completed: ${result.targetsRestored} target(s), ${result.bytesWritten} bytes in ${result.durationMs}ms` +
          (result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '')
      );
      if (result.warnings.length > 0) {
        logger.warn(`Restore warnings: ${result.warnings.join('; ')}`);
      }

      this.emitProgress({
        phase: 'completed',
        percentComplete: 100,
        bytesProcessed: result.bytesWritten,
        totalBytes: result.totalBytes,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: '',
        error: result.warnings.length > 0 ? result.warnings.join('; ') : undefined
      });

      return result;
    } catch (error) {
      this.emitProgress({
        phase: 'error',
        percentComplete: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        speed: 0,
        estimatedTimeRemaining: 0,
        currentPartition: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async cancelRestore(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.shouldCancel = true;
    await this.coordinator.cancel();
  }

  getImageSummary(imagePath: string): ImageSummary {
    return summarizeImage(imagePath);
  }

  /**
   * Best-effort lock probe for the volume holding `imagePath`. Uses the
   * cached/WinPE status query only — it never triggers elevation, so the
   * wizard stays prompt-free; failure-driven checks below catch what this
   * misses (e.g. the volume locking between selection and restore).
   */
  private async imageLockState(imagePath: string): Promise<{ letter: string | null; locked: boolean }> {
    const match = /^([A-Za-z]):[\\/]/.exec(imagePath ?? '');
    const letter = match ? match[1].toUpperCase() : null;
    if (!letter) return { letter: null, locked: false };
    try {
      const status = await listBitlockerStatus({});
      if (status.ok) {
        const volume = status.volumes.find((v) => v.letter === letter);
        if (volume?.locked) return { letter, locked: true };
      }
    } catch {
      // detection is advisory; the failure-driven path still guards the read
    }
    return { letter, locked: false };
  }

  /**
   * Preflight / dry-run: builds the restore job (image check, chain resolution,
   * disk-size and layout safety gates) WITHOUT writing a single byte, then
   * reports the plan so the UI can warn about data loss and demand an
   * explicit acknowledgement before the real restore starts.
   */
  async preflight(config: RestoreConfig): Promise<RestorePreflightResult> {
    try {
      const lock = await this.imageLockState(config.imagePath);
      if (lock.locked && lock.letter) {
        return {
          ok: false,
          unlockRequired: true,
          lockedLetter: lock.letter,
          error: `The image is on locked BitLocker volume ${lock.letter}:. Unlock the volume to continue.`
        };
      }

      await this.validateConfig(config);

      const job = await this.coordinator.buildJob(config);

      const summary = this.getImageSummary(config.imagePath);
      const sizeByIndex = new Map<number, number>(summary.partitions.map((p) => [p.index, p.size]));

      let requiredBytes = 0;
      const targets = job.targets.map((t) => {
        const size = t.size ?? sizeByIndex.get(t.partitionIndex) ?? 0;
        requiredBytes += size;
        return { partitionIndex: t.partitionIndex, offset: t.offset, size };
      });

      const warnings = [...(job.warnings ?? [])];
      const encrypted = summary.encrypted;
      const passphraseRequired = encrypted && !(config.passphrase?.trim());
      if (passphraseRequired) {
        warnings.push('This image is encrypted; the passphrase is required to restore it.');
      }
      if (fs.existsSync(sidecarPathFor(config.imagePath))) {
        warnings.push(
          'A BitLocker recovery-key sidecar (.bitlocker.json) is stored next to this image. Keep it with the backup; restore does not read it.'
        );
      }

      // VHD/VHDX target: no physical disk exists yet — report the virtual
      // capacity and whether an existing file will be overwritten.
      if (config.targetVirtualDisk) {
        const vhd = config.targetVirtualDisk;
        const targetFileExists = fs.existsSync(vhd.path);
        let targetDiskBytes = typeof vhd.virtualSize === 'number' ? vhd.virtualSize : 0;
        if (targetFileExists) {
          warnings.push(`A file already exists at ${vhd.path} — restoring overwrites its contents.`);
          try {
            targetDiskBytes = readVirtualDiskInfo(vhd.path).virtualSize;
          } catch {
            /* keep the configured size as the reported capacity */
          }
        }
        return {
          ok: true,
          requiredBytes,
          targetDiskBytes,
          targetDiskModel: `Virtual disk (${virtualDiskFormatFromPath(vhd.path).toUpperCase()})`,
          targetDiskPartitionCount: 0,
          targetFileExists,
          targets,
          writeTableScheme: job.writeTable?.scheme ?? null,
          warnings,
          sameDisk: false,
          encrypted,
          passphraseRequired,
          targetIsSystemDisk: false
        };
      }

      const disks = await this.diskEnumerator.getDisks();
      const targetDisk = disks.find((d) => d.index === config.targetDiskIndex);
      const systemDrive = (process.env.SystemDrive || 'C:').replace(':', '').toUpperCase();
      let targetIsSystemDisk =
        (targetDisk?.partitions ?? []).some(
          (p) =>
            p.isSystem === true ||
            p.isBoot === true ||
            (p.driveLetter || '').replace(':', '').toUpperCase() === systemDrive
        ) ?? false;
      if (!targetIsSystemDisk) {
        const sysDisk = querySystemDiskIndex();
        targetIsSystemDisk = sysDisk !== null && sysDisk === config.targetDiskIndex;
      }

      return {
        ok: true,
        requiredBytes,
        targetDiskBytes: targetDisk?.size ?? 0,
        targetDiskModel: targetDisk?.model,
        targetDiskPartitionCount: targetDisk?.partitions.length ?? 0,
        targets,
        writeTableScheme: job.writeTable?.scheme ?? null,
        warnings,
        sameDisk: (job.warnings ?? []).some((w) => w.includes('same disk the image')),
        encrypted,
        passphraseRequired,
        targetIsSystemDisk
      };
    } catch (error) {
      // Failure-driven unlock path: a permission/absence failure whose volume
      // root is also unreachable is almost always a locked BitLocker volume.
      const err = error as NodeJS.ErrnoException & { bitlockerSuspect?: string };
      const match = /^([A-Za-z]):[\\/]/.exec(config?.imagePath ?? '');
      const letter = err.bitlockerSuspect ?? (match ? match[1].toUpperCase() : null);
      const permissionLike =
        err.bitlockerSuspect != null || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY';
      if (letter && permissionLike) {
        return {
          ok: false,
          unlockRequired: true,
          lockedLetter: letter,
          error: `The image's volume (${letter}:) is not accessible — it may be locked by BitLocker.`
        };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private emitMapped(progress: RestoreJobProgress): void {
    this.emit('progress', mapRestoreJobProgress(progress));
  }

  private emitProgress(progress: RestoreProgress): void {
    this.emit('progress', progress);
  }

  private async validateConfig(config: RestoreConfig): Promise<void> {
    if (!config.imagePath) {
      throw new Error('Image path is empty');
    }

    if (!fs.existsSync(config.imagePath)) {
      // Missing file vs missing volume: if the image's drive root is also
      // unreachable, the volume is likely locked (or absent) — flag it so
      // preflight can offer the BitLocker unlock box instead of a bare
      // "file does not exist".
      const match = /^([A-Za-z]):[\\/]/.exec(config.imagePath);
      const letter = match ? match[1].toUpperCase() : null;
      const rootMissing = letter !== null && !fs.existsSync(`${letter}:\\`);
      if (letter !== null && rootMissing) {
        const err = new Error(
          `The image's volume (${letter}:) is not accessible — it may be locked by BitLocker.`
        ) as NodeJS.ErrnoException & { bitlockerSuspect?: string };
        err.bitlockerSuspect = letter;
        throw err;
      }
      throw new Error('Image file does not exist');
    }

    if (!config.targetPartitions || config.targetPartitions.length === 0) {
      throw new Error('No target partitions selected');
    }

    if (config.targetVirtualDisk) {
      if (config.targetDiskIndex != null) {
        throw new Error('Set either a target disk or a virtual disk target, not both');
      }
      const vhd = config.targetVirtualDisk;
      const vpath = (vhd.path ?? '').trim();
      if (!vpath) {
        throw new Error('Virtual disk path is empty');
      }
      if (!isVirtualDiskPath(vpath)) {
        throw new Error('Virtual disk target must be a .vhd or .vhdx file');
      }
      config.targetVirtualDisk = { ...vhd, path: vpath };
      if (!fs.existsSync(vpath)) {
        if (typeof vhd.virtualSize !== 'number' || !Number.isFinite(vhd.virtualSize)) {
          throw new Error(`The virtual disk ${vpath} does not exist yet — set its size to create it`);
        }
        const problem = validateVirtualSize(
          virtualDiskFormatFromPath(vpath),
          roundToSector(Math.floor(vhd.virtualSize))
        );
        if (problem) {
          throw new Error(problem);
        }
      }
      return;
    }

    if (typeof config.targetDiskIndex !== 'number' || config.targetDiskIndex < 0) {
      throw new Error('Invalid target disk index');
    }
  }
}