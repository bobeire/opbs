import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiskEnumerator, NativeDiskApi } from '../../src/main/utils/disk-enumerator';

function createMockNative(): NativeDiskApi {
  return {
    getDisks: vi.fn(),
    getPartitions: vi.fn(),
    getPhysicalDrivePath: vi.fn(),
    getVolumePath: vi.fn()
  };
}

describe('DiskEnumerator', () => {
  let mockNative: NativeDiskApi;
  let enumerator: DiskEnumerator;

  beforeEach(() => {
    mockNative = createMockNative();
    enumerator = new DiskEnumerator(mockNative);
  });

  describe('getDisks', () => {
    it('should return native disk list with partitions', async () => {
      (mockNative.getDisks as any).mockReturnValue([
        { index: 0, model: 'KINGSTON SSD', size: 1000204886016, serial: 'SER123' },
        { index: 1, model: 'WDC HDD', size: 2000398934016, serial: 'SER456' }
      ]);
      (mockNative.getPartitions as any).mockReturnValue([
        { diskIndex: 0, partitionIndex: 0, offset: 1048576, size: 104857600, type: 238 }
      ]);

      const disks = await enumerator.getDisks();

      expect(disks).toHaveLength(2);
      expect(disks[0]).toMatchObject({
        index: 0,
        model: 'KINGSTON SSD',
        size: 1000204886016,
        serial: 'SER123'
      });
      expect(mockNative.getPartitions).toHaveBeenCalledWith(0);
      expect(mockNative.getPartitions).toHaveBeenCalledWith(1);
      expect(disks[0].partitions).toHaveLength(1);
    });

    it('should handle empty disk list', async () => {
      (mockNative.getDisks as any).mockReturnValue([]);
      const disks = await enumerator.getDisks();
      expect(disks).toHaveLength(0);
    });

    it('should handle native errors gracefully', async () => {
      (mockNative.getDisks as any).mockImplementation(() => {
        throw new Error('native failure');
      });
      const disks = await enumerator.getDisks();
      expect(disks).toHaveLength(0);
    });

    it('should still return disks if partition enumeration fails', async () => {
      (mockNative.getDisks as any).mockReturnValue([
        { index: 0, model: 'KINGSTON SSD', size: 1000204886016, serial: 'SER123' }
      ]);
      (mockNative.getPartitions as any).mockImplementation(() => {
        throw new Error('no permission');
      });

      const disks = await enumerator.getDisks();

      expect(disks).toHaveLength(1);
      expect(disks[0].partitions).toHaveLength(0);
    });
  });

  describe('getPartitions', () => {
    it('should map native partitions with defaults', async () => {
      (mockNative.getPartitions as any).mockReturnValue([
        { diskIndex: 0, partitionIndex: 2, offset: 122683392, size: 998686136832, type: 238 }
      ]);

      const partitions = await enumerator.getPartitions(0);

      expect(partitions).toHaveLength(1);
      expect(partitions[0]).toMatchObject({
        diskIndex: 0,
        partitionIndex: 2,
        offset: 122683392,
        size: 998686136832,
        type: 238,
        driveLetter: null,
        fsType: 'Unknown',
        isSystem: false,
        isBoot: false
      });
      expect(partitions[0].label).toBe('Partition 2');
    });

    it('should handle errors gracefully', async () => {
      (mockNative.getPartitions as any).mockImplementation(() => {
        throw new Error('native failure');
      });
      const partitions = await enumerator.getPartitions(1);
      expect(partitions).toHaveLength(0);
    });
  });

  describe('getPhysicalDrivePath', () => {
    it('should return device path', () => {
      (mockNative.getPhysicalDrivePath as any).mockReturnValue('\\\\.\\PhysicalDrive3');
      const result = enumerator.getPhysicalDrivePath(3);
      expect(result).toBe('\\\\.\\PhysicalDrive3');
    });

    it('should return empty string on error', () => {
      (mockNative.getPhysicalDrivePath as any).mockImplementation(() => {
        throw new Error('access denied');
      });
      const result = enumerator.getPhysicalDrivePath(3);
      expect(result).toBe('');
    });
  });

  describe('getVolumePath', () => {
    it('should return volume device path when found', () => {
      (mockNative.getVolumePath as any).mockReturnValue('\\\\?\\Volume{abc}\\');
      const result = enumerator.getVolumePath(0, 122683392);
      expect(result).toBe('\\\\?\\Volume{abc}\\');
      expect(mockNative.getVolumePath).toHaveBeenCalledWith(0, 122683392);
    });

    it('should return null when native returns empty string', () => {
      (mockNative.getVolumePath as any).mockReturnValue('');
      expect(enumerator.getVolumePath(0, 0)).toBeNull();
    });

    it('should return null on error', () => {
      (mockNative.getVolumePath as any).mockImplementation(() => {
        throw new Error('native failure');
      });
      expect(enumerator.getVolumePath(0, 0)).toBeNull();
    });
  });
});