import { describe, it, expect } from 'vitest';
import { ConsecutiveFailureTracker } from '../../src/main/utils/failure-tracker';

describe('ConsecutiveFailureTracker', () => {
  it('resets the count on a success', () => {
    const t = new ConsecutiveFailureTracker();
    t.record(false);
    t.record(false);
    expect(t.shouldAlert(2)).toBe(true);
    expect(t.record(true)).toBe(0);
    expect(t.shouldAlert(2)).toBe(false);
  });

  it('alerts only after the consecutive-failure threshold', () => {
    const t = new ConsecutiveFailureTracker();
    expect(t.record(false)).toBe(1);
    expect(t.shouldAlert(2)).toBe(false); // one failure: no alert yet
    expect(t.record(false)).toBe(2);
    expect(t.shouldAlert(2)).toBe(true); // second consecutive failure: alert
  });

  it('respects a custom threshold', () => {
    const t = new ConsecutiveFailureTracker();
    t.record(false);
    t.record(false);
    t.record(false);
    expect(t.shouldAlert(3)).toBe(true);
    expect(t.shouldAlert(5)).toBe(false);
  });

  it('reset clears the count so the next alert needs the threshold again', () => {
    const t = new ConsecutiveFailureTracker();
    t.record(false);
    t.record(false);
    t.reset();
    expect(t.shouldAlert(2)).toBe(false);
    expect(t.record(false)).toBe(1);
    expect(t.shouldAlert(2)).toBe(false);
  });
});
