import { describe, it, expect } from 'vitest';
import {
  FLEET_SCHEMA_VERSION,
  fleetMachineId,
  validateCheckin,
  deriveMachineStatus,
  lastBackupAt,
  FleetCheckin,
  FleetDestinationReport
} from '../../src/main/fleet/schema';

function destination(overrides: Partial<FleetDestinationReport> = {}): FleetDestinationReport {
  return {
    directory: 'D:\\backups',
    exists: true,
    imageCount: 3,
    chainCount: 1,
    completeChains: 1,
    brokenChains: 0,
    unparseableImages: 0,
    lastBackupAt: Date.now() - 60 * 60 * 1000,
    lastBackupImage: 'D:\\backups\\pc-full.opbs',
    lastBackupBytes: 123456,
    lastBackupIncremental: true,
    anomalyOk: true,
    criticalAnomalies: 0,
    warningAnomalies: 0,
    drillTotal: 4,
    drillFailed: 0,
    drillLastAt: Date.now() - 24 * 60 * 60 * 1000,
    drillLastOk: true,
    ...overrides
  };
}

function checkin(overrides: Partial<FleetCheckin> = {}): FleetCheckin {
  return {
    schema: FLEET_SCHEMA_VERSION,
    machineId: 'abc123def456',
    hostname: 'WORKSTATION-01',
    os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
    appVersion: '0.6.67',
    sentAt: Date.now(),
    destinations: [destination()],
    media: [
      {
        diskIndex: 0,
        model: 'Samsung 990',
        serial: 'S6Z2NF0T',
        size: 1000204886016,
        driveLetters: ['C:', 'D:'],
        healthy: true,
        measured: true,
        warnings: []
      }
    ],
    ...overrides
  };
}

describe('fleetMachineId', () => {
  it('is deterministic for the same hostname/arch', () => {
    expect(fleetMachineId('PC-1', 'x64')).toBe(fleetMachineId('PC-1', 'x64'));
  });

  it('ignores hostname case but separates architectures', () => {
    expect(fleetMachineId('PC-1', 'x64')).toBe(fleetMachineId('pc-1', 'X64'));
    expect(fleetMachineId('PC-1', 'x64')).not.toBe(fleetMachineId('PC-1', 'arm64'));
    expect(fleetMachineId('PC-1', 'x64')).not.toBe(fleetMachineId('PC-2', 'x64'));
  });
});

describe('validateCheckin', () => {
  it('accepts a well-formed check-in and preserves unknown fields', () => {
    const doc = { ...checkin(), futureField: 'kept' };
    const result = validateCheckin(doc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkin.machineId).toBe('abc123def456');
      expect((result.checkin as unknown as Record<string, unknown>).futureField).toBe('kept');
    }
  });

  it('rejects non-objects', () => {
    expect(validateCheckin('nope')).toEqual({ ok: false, error: 'check-in is not a JSON object' });
    expect(validateCheckin(null).ok).toBe(false);
    expect(validateCheckin([]).ok).toBe(false);
  });

  it('rejects a wrong schema version with an explicit message', () => {
    const result = validateCheckin({ ...checkin(), schema: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unsupported schema version 2/);
  });

  it('rejects missing core fields', () => {
    const noId = { ...checkin() };
    delete (noId as Partial<FleetCheckin>).machineId;
    expect(validateCheckin(noId)).toEqual({ ok: false, error: 'machineId is missing' });
    expect(validateCheckin({ ...checkin(), sentAt: 'now' })).toEqual({ ok: false, error: 'sentAt is not a number' });
  });

  it('rejects malformed destinations with the offending path', () => {
    const result = validateCheckin({ ...checkin(), destinations: [destination({ chainCount: 'x' as never })] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/destinations\[0\]\.chainCount/);
  });

  it('rejects malformed media entries', () => {
    const bad = checkin();
    (bad.media[0] as { healthy: unknown }).healthy = 'yes';
    const result = validateCheckin(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/media\[0\]\.healthy/);
  });
});

describe('deriveMachineStatus', () => {
  const now = 1_700_000_000_000;

  it('reports ok for a healthy machine with a recent check-in', () => {
    const result = deriveMachineStatus(checkin({ sentAt: now }), { receivedAt: now, now, staleDays: 7 });
    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('flags broken restore chains as critical', () => {
    const doc = checkin({ destinations: [destination({ brokenChains: 1, completeChains: 0 })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('critical');
    expect(result.reasons.some((r) => /broken restore chain/.test(r))).toBe(true);
  });

  it('flags critical anomalies as critical', () => {
    const doc = checkin({ destinations: [destination({ criticalAnomalies: 2, anomalyOk: false })] });
    expect(deriveMachineStatus(doc, { receivedAt: now, now }).status).toBe('critical');
  });

  it('flags a failed latest restore drill as critical', () => {
    const doc = checkin({ destinations: [destination({ drillLastOk: false })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('critical');
    expect(result.reasons.some((r) => /drill FAILED/.test(r))).toBe(true);
  });

  it('flags a measured SMART problem as critical', () => {
    const doc = checkin({
      media: [
        {
          diskIndex: 1,
          model: 'WDC WD10',
          serial: 'WD-WCC',
          size: 1000204886016,
          driveLetters: ['E:'],
          healthy: false,
          measured: true,
          warnings: ['reallocated sectors']
        }
      ]
    });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('critical');
    expect(result.reasons.some((r) => /SMART reports problems/.test(r))).toBe(true);
  });

  it('does not treat unmeasurable SMART data as a problem', () => {
    const doc = checkin({
      media: [
        {
          diskIndex: 1,
          model: 'External',
          serial: 'EXT-1',
          size: 4000787030016,
          driveLetters: ['F:'],
          healthy: false,
          measured: false,
          warnings: []
        }
      ]
    });
    expect(deriveMachineStatus(doc, { receivedAt: now, now }).status).toBe('ok');
  });

  it('warns when a machine has never backed up', () => {
    const doc = checkin({ destinations: [destination({ lastBackupAt: null, imageCount: 0 })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('warning');
    expect(result.reasons.some((r) => /no backups yet/.test(r))).toBe(true);
  });

  it('warns when images exist but analytics history is missing', () => {
    const doc = checkin({ destinations: [destination({ lastBackupAt: null, imageCount: 3 })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('warning');
    expect(result.reasons.some((r) => /no backup history/.test(r))).toBe(true);
  });

  it('warns when the destination is unreachable', () => {
    const doc = checkin({ destinations: [destination({ exists: false })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('warning');
    expect(result.reasons.some((r) => /unreachable/.test(r))).toBe(true);
  });

  it('marks a machine stale after the threshold', () => {
    const receivedAt = now - 8 * 24 * 60 * 60 * 1000;
    const result = deriveMachineStatus(checkin(), { receivedAt, now, staleDays: 7 });
    expect(result.status).toBe('stale');
    expect(result.reasons.some((r) => /no check-in for more than 7 day/.test(r))).toBe(true);
  });

  it('lets critical outrank stale', () => {
    const doc = checkin({ destinations: [destination({ brokenChains: 2 })] });
    const receivedAt = now - 30 * 24 * 60 * 60 * 1000;
    const result = deriveMachineStatus(doc, { receivedAt, now, staleDays: 7 });
    expect(result.status).toBe('critical');
    expect(result.reasons.some((r) => /no check-in/.test(r))).toBe(true);
  });

  it('warns on warning-level anomalies', () => {
    const doc = checkin({ destinations: [destination({ warningAnomalies: 1, anomalyOk: false })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('warning');
    expect(result.reasons.some((r) => /anomal/.test(r))).toBe(true);
  });
});

describe('lastBackupAt', () => {
  it('is the newest across destinations', () => {
    const doc = checkin({
      destinations: [
        destination({ lastBackupAt: 1000 }),
        destination({ directory: 'E:\\offsite', lastBackupAt: 5000 }),
        destination({ directory: 'F:\\none', lastBackupAt: null, exists: false })
      ]
    });
    expect(lastBackupAt(doc)).toBe(5000);
  });

  it('is null when nothing ever backed up', () => {
    expect(lastBackupAt(checkin({ destinations: [destination({ lastBackupAt: null })] }))).toBeNull();
  });
});
