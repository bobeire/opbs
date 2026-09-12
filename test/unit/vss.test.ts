import { describe, it, expect } from 'vitest';
import {
  parseScQuery,
  parseScQc,
  parseVssadminWriters,
  parseVssadminProviders,
  normalizeVolumeRoot,
  enumerateVolumes,
  CORE_VSS_DLLS
} from '../../src/main/utils/vss';

const SC_QUERY_RUNNING = `SERVICE_NAME: vss
        TYPE               : 20  WIN32_SHARE_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0`;

const SC_QUERY_STOPPED = `SERVICE_NAME: vss
        TYPE               : 20  WIN32_SHARE_PROCESS
        STATE              : 1  STOPPED
        WIN32_EXIT_CODE    : 0  (0x0)`;

const SC_QC_AUTO = `SERVICE_NAME: vss
        TYPE               : 20  WIN32_SHARE_PROCESS
        START_TYPE         : 2   AUTO_START
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : C:\\WINDOWS\\System32\\vssvc.exe
        LOAD_ORDER_GROUP   : VSS`;

const SC_QC_DISABLED = `SERVICE_NAME: vss
        TYPE               : 20  WIN32_SHARE_PROCESS
        START_TYPE         : 4   DISABLED`;

const VSSADMIN_WRITERS = `Waiting for writer initialization...
Writer name: 'System Writer'
        Writer Id: {e8132975-6f93-4464-a53e-1050253ae220}
        Writer Instance Id: {7f4f7f34-0c0c-4a4a-8a8a-123456789abc}
        State: [1] Stable
        Last error: No error

Writer name: 'SqlServerWriter'
        Writer Id: {0b4a9f0d-3b1a-4b2a-9c2a-123456789abc}
        Writer Instance Id: {0b4a9f0d-3b1a-4b2a-9c2a-123456789abc}
        State: [3] Waiting for completion
        Last error: 0x800423f4, timed out
The writer has a snapshot status of: OK`;

const VSSADMIN_PROVIDERS = `Provider name: 'Microsoft Software Shadow Copy provider 1.0'
        Provider Type:    System
        Provider Id: {b5946137-7b9f-4925-af80-51abd60b20d5}
        Version: 1.0.0.7`;

describe('parseScQuery', () => {
  it('parses a running service', () => {
    const info = parseScQuery(SC_QUERY_RUNNING);
    expect(info.serviceName).toBe('vss');
    expect(info.stateCode).toBe(4);
    expect(info.state).toBe('RUNNING');
  });

  it('parses a stopped service', () => {
    expect(parseScQuery(SC_QUERY_STOPPED).state).toBe('STOPPED');
    expect(parseScQuery(SC_QUERY_STOPPED).stateCode).toBe(1);
  });

  it('falls back to unknown on garbage', () => {
    expect(parseScQuery('nonsense').state).toBe('UNKNOWN');
    expect(parseScQuery('nonsense').stateCode).toBe(0);
  });
});

describe('parseScQc', () => {
  it('parses auto start', () => {
    expect(parseScQc(SC_QC_AUTO).startType).toBe('AUTO_START');
  });

  it('parses disabled', () => {
    expect(parseScQc(SC_QC_DISABLED).startType).toBe('DISABLED');
  });
});

describe('parseVssadminWriters', () => {
  it('parses writer blocks with state codes and last errors', () => {
    const writers = parseVssadminWriters(VSSADMIN_WRITERS);
    expect(writers.length).toBe(2);

    const [system, sql] = writers;
    expect(system.name).toBe('System Writer');
    expect(system.id).toBe('{e8132975-6f93-4464-a53e-1050253ae220}');
    expect(system.instanceId).toBe('{7f4f7f34-0c0c-4a4a-8a8a-123456789abc}');
    expect(system.stateCode).toBe(1);
    expect(system.state).toBe('Stable');
    expect(system.lastError).toBe('No error');

    expect(sql.name).toBe('SqlServerWriter');
    expect(sql.stateCode).toBe(3);
    expect(sql.state).toBe('Waiting for completion');
    expect(sql.lastError).toContain('timed out');
  });

  it('returns an empty list for empty input', () => {
    expect(parseVssadminWriters('')).toEqual([]);
  });
});

describe('parseVssadminProviders', () => {
  it('parses a provider block', () => {
    const providers = parseVssadminProviders(VSSADMIN_PROVIDERS);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('Microsoft Software Shadow Copy provider 1.0');
    expect(providers[0].type).toBe('System');
    expect(providers[0].id).toBe('{b5946137-7b9f-4925-af80-51abd60b20d5}');
    expect(providers[0].version).toBe('1.0.0.7');
  });
});

describe('normalizeVolumeRoot', () => {
  it('normalizes drive letter forms', () => {
    expect(normalizeVolumeRoot('C')).toBe('C:\\');
    expect(normalizeVolumeRoot('c')).toBe('C:\\');
    expect(normalizeVolumeRoot('C:')).toBe('C:\\');
    expect(normalizeVolumeRoot('c:\\')).toBe('C:\\');
    expect(normalizeVolumeRoot(' C:\\ ')).toBe('C:\\');
  });

  it('passes volume GUID paths through with a trailing slash', () => {
    expect(normalizeVolumeRoot('\\\\?\\Volume{abc}\\')).toBe('\\\\?\\Volume{abc}\\');
    expect(normalizeVolumeRoot('\\\\?\\Volume{abc}')).toBe('\\\\?\\Volume{abc}\\');
  });

  it('returns empty for empty input and leaves other paths mostly intact', () => {
    expect(normalizeVolumeRoot('')).toBe('');
    expect(normalizeVolumeRoot('X:\\some\\dir')).toBe('X:\\some\\dir\\');
  });
});

describe('CORE_VSS_DLLS and enumerateVolumes', () => {
  it('keeps the standard re-registration set', () => {
    expect(CORE_VSS_DLLS).toEqual(['vssapi.dll', 'vss_ps.dll', 'vsscore.dll', 'vsstrace.dll']);
  });

  it('always includes the system drive on Windows', () => {
    const vols = enumerateVolumes();
    const expected = `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\`;
    expect(vols).toContain(expected);
  });
});