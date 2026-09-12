import { describe, it, expect } from 'vitest';
import { DiskHealth } from '../../src/main/utils/disk-health';
import {
  checkMediaHealth,
  inventoryMediaHealth,
  MediaHealthResult
} from '../../src/main/utils/media-health';

function diskHealth(overrides: Partial<DiskHealth> = {}): DiskHealth {
  return {
    diskIndex: 0,
    reliable: true,
    data: { model: 'Test', healthStatus: 'Healthy', temperatureCelsius: 30, wear: 5, unreliableSectors: 0 },
    ok: true,
    warnings: [],
    ...overrides
  };
}

describe('checkMediaHealth (pre-backup gate)', () => {
  it('passes without blocking a healthy drive', async () => {
    const result = (await checkMediaHealth('C:\\backup', {
      resolveDisk: async () => ({ diskIndex: 0, driveLetter: 'C' }),
      queryDisk: () => diskHealth()
    })) as MediaHealthResult;
    expect(result.blocked).toBe(false);
    expect(result.measured).toBe(true);
    expect(result.reliable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('blocks when the drive reports concrete SMART problems', async () => {
    const result = (await checkMediaHealth('D:\\backups', {
      resolveDisk: async () => ({ diskIndex: 1, driveLetter: 'D' }),
      queryDisk: () =>
        diskHealth({
          data: { model: 'Test', healthStatus: 'Warning', temperatureCelsius: 70, wear: 95, unreliableSectors: 8 },
          warnings: ['Temperature is high: 70°C (limit 55°C)', '8 unreliable sectors detected - imminent failure risk']
        })
    })) as MediaHealthResult;
    expect(result.blocked).toBe(true);
    expect(result.reliable).toBe(false);
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.join(' ')).toContain('unreliable sectors');
  });

  it('never blocks when SMART data cannot be read (no elevation)', async () => {
    const result = (await checkMediaHealth('E:\\data', {
      resolveDisk: async () => ({ diskIndex: 2, driveLetter: 'E' }),
      queryDisk: () => ({
        diskIndex: 2,
        reliable: false,
        data: null,
        ok: true,
        warnings: ['Unable to read SMART/health data (drive does not support it or requires elevation)']
      })
    })) as MediaHealthResult;
    expect(result.blocked).toBe(false);
    expect(result.measured).toBe(false);
    expect(result.reliable).toBe(false);
  });

  it('never blocks when the destination is off-machine (UNC/cloud)', async () => {
    const result = (await checkMediaHealth('\\\\nas\\backups')) as MediaHealthResult;
    expect(result.blocked).toBe(false);
    expect(result.measured).toBe(false);
  });

  it('never blocks when no physical disk can be resolved from the path', async () => {
    const result = (await checkMediaHealth('C:\\backup', {
      resolveDisk: async () => ({ driveLetter: 'C' })
    })) as MediaHealthResult;
    expect(result.blocked).toBe(false);
    expect(result.measured).toBe(false);
    expect(result.driveLetter).toBe('C');
  });
});

describe('inventoryMediaHealth (disk-wide)', () => {
  it('reports every disk with health state and flags only real problems', async () => {
    const entries = await inventoryMediaHealth({
      enumerate: async () => [
        { index: 0, model: 'GoodDrive', serial: 'A', size: 1e12, partitions: [] },
        { index: 1, model: 'BadDrive', serial: 'B', size: 2e12, partitions: [] },
        { index: 2, model: 'OldDrive', serial: 'C', size: 3e12, partitions: [] }
      ],
      queryDisk: (index) =>
        index === 1
          ? diskHealth({
              diskIndex: 1,
              data: { model: 'BadDrive', healthStatus: 'Warning', wear: 88 },
              warnings: ['SSD wear level is 88% (limit 80%)']
            })
          : index === 2
            ? ({ diskIndex: 2, reliable: false, data: null, ok: true, warnings: ['Unable to read SMART/health data'] } as DiskHealth)
            : diskHealth({ diskIndex: 0 }),
      listLetters: async (index) => (index === 0 ? ['C'] : index === 1 ? ['D', 'E'] : [])
    });

    expect(entries).toHaveLength(3);
    expect(entries[0].unhealthy).toBe(false);
    expect(entries[0].driveLetters).toEqual(['C']);
    expect(entries[0].health.data?.healthStatus).toBe('Healthy');
    expect(entries[1].unhealthy).toBe(true);
    expect(entries[1].driveLetters).toEqual(['D', 'E']);
    expect(entries[1].health.warnings.join(' ')).toContain('wear');
    expect(entries[2].unhealthy).toBe(false);
    expect(entries[2].health.data).toBeNull();
  });
});