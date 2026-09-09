/**
 * Dissimilar-hardware restore support: derive a GPT or MBR partition-table
 * layout from the target placements, validate it, and hand the entries to the
 * native addon so the elevated helper can write the table before restoring the
 * partition contents.
 */

export const SECTOR_SIZE = 512;
/** First usable GPT LBA (34: header + 32 sectors of entries). */
export const GPT_FIRST_USABLE_LBA = 34;
export const GPT_MIN_OFFSET = GPT_FIRST_USABLE_LBA * SECTOR_SIZE;
/** Classic Windows MBR convention: first partition at or after LBA 63. */
export const MBR_MIN_OFFSET = 63 * SECTOR_SIZE;
export const MBR_MAX_ENTRIES = 4;
export const MBR_MAX_LBA_32 = 0xffffffff;
export const MBR_SIZE_END_LBA = 0x100000000;  // start + size may reach 2^32 exactly
/** 2 TiB limit for a signed-CHS-era MBR partition table. */
export const MBR_TWO_TIB = 2 * 1024 * 1024 * 1024 * 1024;

/** Microsoft basic-data partition type GUID (NTFS/exFAT data partitions). */
export const GPT_BASIC_DATA_GUID = 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7';
export const MBR_TYPE_BASIC_DATA = 0x07;

export type TableScheme = 'gpt' | 'mbr';

export interface TableEntry {
  offset: number;
  size: number;
  typeGuid?: string;
  name?: string;
  bootable?: boolean;
}

/**
 * Serializable part of the restore job. The elevated helper loads the native
 * addon and calls buildPartitionTable(scheme, lbaCount, entries, {diskGuid}).
 */
export interface RestoreTablePlan {
  scheme: TableScheme;
  /** Target disk size in bytes (drives the LBA count). */
  diskSize: number;
  diskGuid?: string;
  entries: TableEntry[];
}

export interface PartitionPlacement {
  partitionIndex: number;
  offset: number;
  size: number;
}

export interface RestoreTableOptions {
  /** Explicit scheme override; 'auto' selects MBR when representable. */
  scheme?: TableScheme | 'auto';
  diskGuid?: string;
  /** Per-partition GPT type GUIDs keyed by image partition index. */
  typeGuids?: Record<number, string>;
  /** Mark this image partition bootable (MBR only). */
  bootPartition?: number;
}

export function mbrProblem(entries: TableEntry[], diskSize: number): string | null {
  if (entries.length > MBR_MAX_ENTRIES) {
    return `MBR supports at most ${MBR_MAX_ENTRIES} partitions (got ${entries.length}); use GPT`;
  }
  if (diskSize > MBR_TWO_TIB) {
    return 'MBR is limited to 2 TiB disks; use GPT';
  }
  for (const e of entries) {
    const startLba = e.offset / SECTOR_SIZE;
    const sizeLba = e.size / SECTOR_SIZE;
    if (e.offset % SECTOR_SIZE !== 0 || e.size % SECTOR_SIZE !== 0) {
      return `Partition at offset ${e.offset} is not sector-aligned (512 bytes)`;
    }
    if (e.offset < MBR_MIN_OFFSET) {
      return `MBR partitions must start at or after LBA 63 (byte ${MBR_MIN_OFFSET}); offset ${e.offset} cannot be represented`;
    }
    if (startLba > MBR_MAX_LBA_32 || sizeLba > MBR_MAX_LBA_32) {
      return 'MBR partition exceeds the 32-bit LBA limit; use GPT';
    }
    if (startLba + sizeLba > MBR_SIZE_END_LBA) {
      return 'MBR partition extends past the 2 TiB LBA boundary; use GPT';
    }
  }
  return null;
}

export function gptProblem(entries: TableEntry[], diskSize: number): string | null {
  if (entries.length > 128) {
    return `GPT supports at most 128 partitions (got ${entries.length})`;
  }
  if (diskSize < GPT_MIN_OFFSET * 2) {
    return 'Target disk is too small for a GPT layout';
  }
  for (const e of entries) {
    if (e.offset % SECTOR_SIZE !== 0 || e.size % SECTOR_SIZE !== 0) {
      return `Partition at offset ${e.offset} is not sector-aligned (512 bytes)`;
    }
    if (e.offset < GPT_MIN_OFFSET) {
      return `GPT partitions must start at or after LBA 34 (byte ${GPT_MIN_OFFSET}); offset ${e.offset} cannot be represented`;
    }
  }
  return null;
}

export function commonProblem(entries: TableEntry[], diskSize: number): string | null {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.offset < 0 || e.size <= 0) {
      return `Invalid partition geometry at offset ${e.offset} size ${e.size}`;
    }
    if (e.offset + e.size > diskSize) {
      return `Partition at offset ${e.offset} (size ${e.size}) does not fit on a ${diskSize}-byte target disk`;
    }
    if (i > 0 && e.offset < entries[i - 1].offset + entries[i - 1].size) {
      return `Partition at offset ${e.offset} overlaps the previous partition`;
    }
  }
  return null;
}

export function validateTableEntries(
  entries: TableEntry[],
  scheme: TableScheme,
  diskSize: number
): string | null {
  const common = commonProblem(entries, diskSize);
  if (common) {
    return common;
  }
  return scheme === 'gpt' ? gptProblem(entries, diskSize) : mbrProblem(entries, diskSize);
}

export function resolveTableScheme(
  entries: TableEntry[],
  diskSize: number,
  preferred: TableScheme | 'auto' = 'auto'
): TableScheme {
  if (preferred === 'gpt' || preferred === 'mbr') {
    return preferred;
  }
  return mbrProblem(entries, diskSize) === null ? 'mbr' : 'gpt';
}

/**
 * Build a serializable partition-table plan for the given placements. Entries
 * are sorted by offset (partition tables must be in ascending LBA order).
 * Throws with a descriptive message when the layout cannot be represented.
 */
export function buildRestoreTablePlan(
  placements: PartitionPlacement[],
  diskSize: number,
  opts: RestoreTableOptions = {}
): RestoreTablePlan {
  const raw = [...placements].sort((a, b) => a.offset - b.offset);
  const scheme = resolveTableScheme(
    raw.map((p) => ({ offset: p.offset, size: p.size })),
    diskSize,
    opts.scheme ?? 'auto'
  );

  const entries: TableEntry[] = raw.map((p) => {
    const typeGuid =
      opts.typeGuids && opts.typeGuids[p.partitionIndex] !== undefined
        ? opts.typeGuids[p.partitionIndex]
        : scheme === 'gpt'
          ? GPT_BASIC_DATA_GUID
          : undefined;
    return {
      offset: p.offset,
      size: p.size,
      typeGuid,
      name: `Partition ${p.partitionIndex}`,
      bootable: scheme === 'mbr' && opts.bootPartition === p.partitionIndex
    };
  });

  const problem = validateTableEntries(entries, scheme, diskSize);
  if (problem) {
    throw new Error(`Cannot build a ${scheme.toUpperCase()} partition table: ${problem}`);
  }

  return { scheme, diskSize, diskGuid: opts.diskGuid, entries };
}