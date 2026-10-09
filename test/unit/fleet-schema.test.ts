import { describe, it, expect } from 'vitest';
import {
  FLEET_SCHEMA_VERSION,
  fleetMachineId,
  validateCheckin,
  validateBackupPolicy,
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

describe('backup-staleness (backupStaleDays)', () => {
  const now = 1_700_000_000_000;
  const old = now - 10 * 24 * 60 * 60 * 1000;

  it('marks a machine stale when its last backup is past the threshold', () => {
    const doc = checkin({ destinations: [destination({ lastBackupAt: old })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now, backupStaleDays: 7 });
    expect(result.status).toBe('stale');
    expect(result.reasons.some((r) => /last backup 10 day\(s\) ago \(threshold 7\)/.test(r))).toBe(true);
    // The check-in itself is fresh — no check-in reason should appear.
    expect(result.reasons.some((r) => /no check-in/.test(r))).toBe(false);
  });

  it('stays ok while the backup is inside the threshold', () => {
    const doc = checkin({ destinations: [destination({ lastBackupAt: now - 2 * 60 * 60 * 1000 })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now, backupStaleDays: 7 });
    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('is disabled when backupStaleDays is absent or zero', () => {
    const doc = checkin({ destinations: [destination({ lastBackupAt: old })] });
    expect(deriveMachineStatus(doc, { receivedAt: now, now }).status).toBe('ok');
    expect(deriveMachineStatus(doc, { receivedAt: now, now, backupStaleDays: 0 }).status).toBe('ok');
  });

  it('leaves never-backed-up machines in warning territory, not stale', () => {
    const doc = checkin({ destinations: [destination({ lastBackupAt: null, imageCount: 0 })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now, backupStaleDays: 7 });
    expect(result.status).toBe('warning');
    expect(result.reasons.some((r) => /no backups yet/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /last backup/.test(r))).toBe(false);
  });

  it('ignores unreachable destinations for backup age (already reported separately)', () => {
    const doc = checkin({ destinations: [destination({ exists: false, lastBackupAt: old })] });
    const result = deriveMachineStatus(doc, { receivedAt: now, now, backupStaleDays: 7 });
    expect(result.status).toBe('warning');
    expect(result.reasons.some((r) => /unreachable/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /last backup/.test(r))).toBe(false);
  });

  it('lets critical outrank backup-staleness', () => {
    const doc = checkin({
      destinations: [destination({ lastBackupAt: old, brokenChains: 1 })]
    });
    const result = deriveMachineStatus(doc, { receivedAt: now, now, backupStaleDays: 7 });
    expect(result.status).toBe('critical');
    expect(result.reasons.some((r) => /broken restore chain/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /last backup/.test(r))).toBe(true);
  });
});

describe('policy statuses in deriveMachineStatus', () => {
  const now = 1_700_000_000_000;

  it('warns on invalid and failed policies with the reason inline', () => {
    const doc = checkin({
      policies: [
        { name: 'nightly.json', status: 'invalid', reason: 'destinationPath must be a non-empty string' },
        { name: 'weekly.json', status: 'failed', reason: 'schtasks exited with code 1' }
      ]
    });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('warning');
    expect(result.reasons).toContain('policy nightly.json: destinationPath must be a non-empty string');
    expect(result.reasons).toContain('policy weekly.json failed: schtasks exited with code 1');
  });

  it('ignores applied/unchanged/removed policies', () => {
    const doc = checkin({
      policies: [
        { name: 'nightly.json', status: 'applied', task: 'OPBS Fleet nightly', appliedAt: now },
        { name: 'old.json', status: 'removed' }
      ]
    });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('lets critical outrank policy problems', () => {
    const doc = checkin({
      destinations: [destination({ brokenChains: 1 })],
      policies: [{ name: 'x.json', status: 'failed', reason: 'nope' }]
    });
    const result = deriveMachineStatus(doc, { receivedAt: now, now });
    expect(result.status).toBe('critical');
    expect(result.reasons.some((r) => r.includes('broken restore chain'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('policy x.json failed'))).toBe(true);
  });
});

describe('validateCheckin policies', () => {
  it('accepts a well-formed policies array', () => {
    const doc = checkin({
      policies: [
        { name: 'nightly.json', status: 'applied', task: 'OPBS Fleet nightly', appliedAt: 1_700_000_000_000 },
        { name: 'bad.json', status: 'invalid', reason: 'kind must be "backup"' },
        { name: 'gone.json', status: 'removed' }
      ]
    });
    expect(validateCheckin(doc).ok).toBe(true);
  });

  it('accepts check-ins without policies (machines that do not auto-apply)', () => {
    expect(validateCheckin(checkin()).ok).toBe(true);
  });

  it('rejects malformed policy entries with a path-precise message', () => {
    expect(validateCheckin(checkin({ policies: 'nope' } as never))).toEqual({
      ok: false,
      error: 'policies is not an array'
    });
    expect(validateCheckin(checkin({ policies: [{ name: '', status: 'applied' }] }))).toEqual({
      ok: false,
      error: 'policies[0].name is missing'
    });
    expect(validateCheckin(checkin({ policies: [{ name: 'a.json', status: 'exported' }] } as never))).toEqual({
      ok: false,
      error: 'policies[0].status must be applied|unchanged|removed|invalid|failed'
    });
    expect(validateCheckin(checkin({ policies: [{ name: 'a.json', status: 'applied', reason: 5 }] } as never))).toEqual({
      ok: false,
      error: 'policies[0].reason is not a string'
    });
  });
});

describe('validateBackupPolicy', () => {
  const minimal = { sourceDiskIndex: 0, sourcePartitions: [2], destinationPath: 'D:\\OPBS' };

  it('accepts a minimal backup job config', () => {
    const result = validateBackupPolicy(minimal);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(minimal);
  });

  it('accepts kind "backup" with a fleet schedule and unknown extra fields', () => {
    const config = {
      ...minimal,
      kind: 'backup',
      fleetSchedule: { time: '03:30', onLogin: false },
      resume: true,
      someFutureKnob: { deep: 1 }
    };
    expect(validateBackupPolicy(config).ok).toBe(true);
  });

  it('accepts kind absent (bare backup configs)', () => {
    expect(validateBackupPolicy({ ...minimal, kind: undefined }).ok).toBe(true);
  });

  it('never auto-applies non-backup jobs', () => {
    for (const kind of ['restore', 'clone', 'restore-drill']) {
      const result = validateBackupPolicy({ ...minimal, kind });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('only backup jobs can be auto-applied');
    }
  });

  it('rejects non-objects', () => {
    expect(validateBackupPolicy(null).ok).toBe(false);
    expect(validateBackupPolicy([]).ok).toBe(false);
    expect(validateBackupPolicy('backup').ok).toBe(false);
    expect(validateBackupPolicy(42).ok).toBe(false);
  });

  it('requires a non-negative integer sourceDiskIndex', () => {
    expect(validateBackupPolicy({ ...minimal, sourceDiskIndex: -1 })).toEqual({
      ok: false,
      error: 'sourceDiskIndex must be a non-negative integer'
    });
    expect(validateBackupPolicy({ ...minimal, sourceDiskIndex: 1.5 }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, sourceDiskIndex: '0' }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, sourceDiskIndex: undefined }).ok).toBe(false);
  });

  it('requires non-empty integer sourcePartitions', () => {
    expect(validateBackupPolicy({ ...minimal, sourcePartitions: [] }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, sourcePartitions: [-1] }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, sourcePartitions: ['2'] }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, sourcePartitions: 2 }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, sourcePartitions: [1, 3] }).ok).toBe(true);
  });

  it('requires a non-empty destinationPath', () => {
    expect(validateBackupPolicy({ ...minimal, destinationPath: '' })).toEqual({
      ok: false,
      error: 'destinationPath must be a non-empty string'
    });
    expect(validateBackupPolicy({ ...minimal, destinationPath: 5 }).ok).toBe(false);
  });

  it('type-checks the optional knobs it knows', () => {
    expect(validateBackupPolicy({ ...minimal, compressionLevel: '3' }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, compressionType: 1 }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, compressionThreads: '4' }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, verificationEnabled: 'yes' }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, compressionLevel: 3, verificationEnabled: true }).ok).toBe(true);
  });

  it('rejects malformed fleet schedules', () => {
    expect(validateBackupPolicy({ ...minimal, fleetSchedule: '02:00' })).toEqual({
      ok: false,
      error: 'fleetSchedule must be an object'
    });
    expect(validateBackupPolicy({ ...minimal, fleetSchedule: { time: '25:00' } })).toEqual({
      ok: false,
      error: 'fleetSchedule.time must be HH:MM (24h)'
    });
    expect(validateBackupPolicy({ ...minimal, fleetSchedule: { time: '3am' } }).ok).toBe(false);
    expect(validateBackupPolicy({ ...minimal, fleetSchedule: { onLogin: 'yes' } })).toEqual({
      ok: false,
      error: 'fleetSchedule.onLogin must be a boolean'
    });
    expect(validateBackupPolicy({ ...minimal, fleetSchedule: { time: '00:00', onLogin: true } }).ok).toBe(true);
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
