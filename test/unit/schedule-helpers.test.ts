import { describe, it, expect } from 'vitest';
import {
  buildCronFromFriendly,
  parseCronToFriendly,
  describeCron,
  WEEKDAY_ABBREVS,
  FriendlySchedule
} from '../../src/renderer/lib/schedule-helpers';

describe('buildCronFromFriendly', () => {
  it('builds a daily schedule', () => {
    expect(buildCronFromFriendly({ type: 'daily', time: '02:00', weekDays: [], monthDay: 1 })).toBe('0 2 * * *');
    expect(buildCronFromFriendly({ type: 'daily', time: '23:41', weekDays: [], monthDay: 1 })).toBe('41 23 * * *');
  });

  it('builds a weekly schedule with a single day', () => {
    expect(buildCronFromFriendly({ type: 'weekly', time: '18:30', weekDays: [0], monthDay: 1 })).toBe('30 18 * * 0');
  });

  it('builds a weekly schedule with multiple days sorted', () => {
    expect(buildCronFromFriendly({ type: 'weekly', time: '02:00', weekDays: [5, 1], monthDay: 1 })).toBe('0 2 * * 1,5');
  });

  it('deduplicates weekday selections', () => {
    expect(buildCronFromFriendly({ type: 'weekly', time: '02:00', weekDays: [2, 2, 3], monthDay: 1 })).toBe('0 2 * * 2,3');
  });

  it('refuses weekly schedules with no days selected', () => {
    expect(buildCronFromFriendly({ type: 'weekly', time: '02:00', weekDays: [], monthDay: 1 })).toBeNull();
  });

  it('builds a monthly schedule', () => {
    expect(buildCronFromFriendly({ type: 'monthly', time: '08:15', weekDays: [], monthDay: 31 })).toBe('15 8 31 * *');
  });

  it('rejects invalid times', () => {
    expect(buildCronFromFriendly({ type: 'daily', time: '24:00', weekDays: [], monthDay: 1 })).toBeNull();
    expect(buildCronFromFriendly({ type: 'daily', time: '02:60', weekDays: [], monthDay: 1 })).toBeNull();
    expect(buildCronFromFriendly({ type: 'daily', time: 'garbage', weekDays: [], monthDay: 1 })).toBeNull();
  });

  it('rejects out-of-range days of month', () => {
    expect(buildCronFromFriendly({ type: 'monthly', time: '02:00', weekDays: [], monthDay: 0 })).toBeNull();
    expect(buildCronFromFriendly({ type: 'monthly', time: '02:00', weekDays: [], monthDay: 32 })).toBeNull();
  });
});

describe('parseCronToFriendly', () => {
  it('parses daily schedules', () => {
    expect(parseCronToFriendly('0 2 * * *')).toEqual({ type: 'daily', time: '02:00', weekDays: [], monthDay: 1 });
    expect(parseCronToFriendly('41 23 * * *')).toEqual({ type: 'daily', time: '23:41', weekDays: [], monthDay: 1 });
  });

  it('parses weekly schedules', () => {
    expect(parseCronToFriendly('0 2 * * 0')).toEqual({ type: 'weekly', time: '02:00', weekDays: [0], monthDay: 1 });
    expect(parseCronToFriendly('30 18 * * 1,5')).toEqual({ type: 'weekly', time: '18:30', weekDays: [1, 5], monthDay: 1 });
  });

  it('parses monthly schedules', () => {
    expect(parseCronToFriendly('15 8 31 * *')).toEqual({ type: 'monthly', time: '08:15', weekDays: [], monthDay: 31 });
  });

  it('round-trips friendly schedules through cron', () => {
    const cases: FriendlySchedule[] = [
      { type: 'daily', time: '02:00', weekDays: [], monthDay: 1 },
      { type: 'weekly', time: '02:00', weekDays: [0, 3, 6], monthDay: 1 },
      { type: 'monthly', time: '09:30', weekDays: [], monthDay: 15 }
    ];
    for (const c of cases) {
      expect(parseCronToFriendly(buildCronFromFriendly(c) as string)).toEqual(c);
    }
  });

  it('falls back for expressions the picker cannot represent', () => {
    expect(parseCronToFriendly('*/30 * * * *')).toBeNull();
    expect(parseCronToFriendly('0 2 1,15 * *')).toBeNull();
    expect(parseCronToFriendly('0 2 * 1 *')).toBeNull();
    expect(parseCronToFriendly('')).toBeNull();
    expect(parseCronToFriendly('* * * * *')).toBeNull();
  });
});

describe('describeCron', () => {
  it('describes friendly schedules in plain English', () => {
    expect(describeCron('0 2 * * *')).toBe('Every day at 02:00');
    expect(describeCron('0 2 * * 1,4')).toBe('Mon, Thu at 02:00');
    expect(describeCron('15 8 3 * *')).toBe('On the 3rd of every month at 08:15');
  });

  it('passes through raw cron for complex expressions', () => {
    expect(describeCron('*/6 * * * *')).toBe('*/6 * * * *');
    expect(describeCron('')).toBe('not set');
  });

  it('exposes weekday abbreviations for the picker', () => {
    expect(WEEKDAY_ABBREVS).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });
});