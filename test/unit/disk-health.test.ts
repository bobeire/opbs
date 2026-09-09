import { describe, it, expect } from 'vitest';
import { assessDiskHealth, queryReliability } from '../../src/main/utils/disk-health';

describe('disk-health assessment', () => {
  it('treats missing data as an unknown-but-usable disk', () => {
    const health = assessDiskHealth(2, null);
    expect(health.ok).toBe(true);
    expect(health.warnings.length).toBeGreaterThan(0);
  });

  it('flags unhealthy hardware status', () => {
    const health = assessDiskHealth(0, { healthStatus: 'Unhealthy' });
    expect(health.ok).toBe(false);
    expect(health.warnings.join(' ')).toMatch(/Unhealthy/);
  });

  it('flags high temperature and SSD wear', () => {
    const health = assessDiskHealth(0, { temperatureCelsius: 63, wear: 94 });
    expect(health.ok).toBe(false);
    expect(health.warnings.join(' ')).toMatch(/Temperature/);
    expect(health.warnings.join(' ')).toMatch(/wear/);
  });

  it('flags unreliable sectors as imminent failure risk', () => {
    const health = assessDiskHealth(0, { unreliableSectors: 3 });
    expect(health.ok).toBe(false);
    expect(health.warnings.join(' ')).toMatch(/unreliable/);
  });

  it('leaves a healthy disk with no warnings', () => {
    const health = assessDiskHealth(0, { healthStatus: 'Healthy', temperatureCelsius: 33, wear: 12, unreliableSectors: 0 });
    expect(health.ok).toBe(true);
    expect(health.warnings).toEqual([]);
  });

  it('queries reliability for an invalid disk index gracefully', () => {
    const data = queryReliability(9999);
    expect(data).toBeNull();
  });
});