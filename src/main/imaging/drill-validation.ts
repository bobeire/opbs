import { parseNtfsBootSector } from './fs/ntfs-resize';
import type { NativeImagingApi } from './imaging-job';

export interface FsValidation {
  partitionIndex: number;
  label: string;
  ok: boolean;
  checks: Record<string, boolean | string | number>;
  error?: string;
}

/** Round up to the nearest power-of-two; returns `fallback` when `n` is not a
 *  valid power-of-two. */
function roundPow2(n: number, fallback: number): number {
  if (n <= 0) return fallback;
  return ((n - 1) & n) === 0 ? n : fallback;
}

/**
 * Read back a freshly-written partition and check the on-disk boot sector
 * (0x55AA, OEM id) plus the first $MFT record for an NTFS volume.  FAT
 * volumes get a shallow structural sanity-check only — a true boot-guarantee
 * would require chkdsk, so the check is intentionally "non-destructive read +
 * structural plausibility".
 */
export function validateRestoredFilesystem(
  native: Pick<NativeImagingApi, 'readBlocks' | 'getPhysicalDrivePath'>,
  devicePath: string,
  options: {
    partitionIndex: number;
    label: string;
    offset: number;
    capturedSize: number;
  }
): FsValidation {
  const { partitionIndex, label, offset, capturedSize } = options;
  const checks: Record<string, boolean | string | number> = {};

  const read = (byteOffset: number, bytes: number): Buffer => {
    return native.readBlocks(devicePath, BigInt(offset + byteOffset), BigInt(bytes));
  };

  try {
    if (capturedSize < 512) {
      return { partitionIndex, label, ok: false, checks, error: 'partition too small for a boot sector' };
    }

    const boot = read(0, 512);
    if (!boot || boot.length < 512) {
      return { partitionIndex, label, ok: false, checks, error: 'boot sector unreadable' };
    }

    // BIOS Parameter Block (BPB) signature at 0x1FE–0x1FF.
    checks.bootSignature = boot.readUInt16LE(0x1fe) === 0x55aa;

    const oem = boot.toString('ascii', 3, 11).trimEnd();
    checks.oemId = oem;

    if (oem === 'NTFS') {
      const layout = parseNtfsBootSector(boot);
      checks.bytesPerSector = layout.bytesPerSector;
      checks.sectorsPerCluster = layout.sectorsPerCluster;
      checks.totalSectors = layout.totalSectors;
      checks.mftLcn = layout.mftLcn;

      if (layout.bytesPerSector === 0 || layout.sectorsPerCluster === 0) {
        return { partitionIndex, label, ok: false, checks, error: 'invalid boot sector parameters' };
      }

      const clusterSize = layout.bytesPerSector * layout.sectorsPerCluster;
      const mftByteOffset = layout.mftLcn * clusterSize;
      if (mftByteOffset < 0 || mftByteOffset >= capturedSize) {
        return { partitionIndex, label, ok: false, checks, error: `$MFT start LCN ${layout.mftLcn} lies outside the partition` };
      }
      checks.mftOffset = mftByteOffset;

      // Read just enough of $MFT record 0 to verify the FILE magic and
      // record-header size fields.
      const mftReadSize = Math.min(layout.fileRecordSize, clusterSize);
      const mft = read(mftByteOffset, Math.max(8, mftReadSize));
      if (!mft || mft.length < 4) {
        return { partitionIndex, label, ok: false, checks, error: 'could not read $MFT record 0' };
      }
      const magic = mft.toString('ascii', 0, 4);
      checks.mftMagic = magic;
      if (magic !== 'FILE') {
        return { partitionIndex, label, ok: false, checks, error: `$MFT record 0 magic mismatch ("${magic}")` };
      }

      // Record flags at offset 0x16 (little-endian u16).
      if (mft.length > 0x17) {
        const flags = mft.readUInt16LE(0x16);
        checks.mftInUse = (flags & 0x01) === 1;
      }

      return { partitionIndex, label, ok: true, checks };
    }

    // ----- FAT (shallow structural checks) -----
    if (oem.startsWith('FAT') || oem === 'MSDOS5.0' || oem === 'MSWIN4.1') {
      const bytesPerSector = boot.readUInt16LE(0x0b);
      const sectorsPerCluster = boot.readUInt8(0x0d);
      checks.bytesPerSector = bytesPerSector;
      checks.sectorsPerCluster = sectorsPerCluster;

      // Plausible sector sizes used by every FAT implementation.
      if (![512, 1024, 2048, 4096].includes(bytesPerSector)) {
        return { partitionIndex, label, ok: false, checks, error: `unexpected bytesPerSector ${bytesPerSector} for FAT` };
      }
      const validSpc = roundPow2(sectorsPerCluster, -1);
      if (validSpc <= 0 || validSpc !== sectorsPerCluster || sectorsPerCluster > 128) {
        return { partitionIndex, label, ok: false, checks, error: `unexpected sectorsPerCluster ${sectorsPerCluster} for FAT` };
      }

      checks.shallowCheck = 'FAT (structural only)';
      return { partitionIndex, label, ok: true, checks };
    }

    return { partitionIndex, label, ok: false, checks, error: `unrecognised filesystem OEM "${oem}"` };
  } catch (error) {
    return {
      partitionIndex,
      label,
      ok: false,
      checks,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}