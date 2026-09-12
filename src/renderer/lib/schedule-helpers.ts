/**
 * Friendly schedule builder for the Scheduled Backups form.
 *
 * Backs the day-picker UI: users pick a frequency (daily / chosen weekdays /
 * a day of month) plus a time, and we translate that into the 5-field cron
 * expression the in-app scheduler runs on. Existing cron expressions are
 * parsed back into the friendly fields when they can be represented.
 */

export type FriendlyScheduleType = 'daily' | 'weekly' | 'monthly';

export interface FriendlySchedule {
  type: FriendlyScheduleType;
  /** 24-hour HH:MM. */
  time: string;
  /** 0=Sunday .. 6=Saturday; used when type === 'weekly'. */
  weekDays: number[];
  /** 1..31; used when type === 'monthly'. */
  monthDay: number;
}

export const WEEKDAY_ABBREVS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec((time || '').trim());
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Build a cron expression from friendly schedule fields, or null when invalid. */
export function buildCronFromFriendly(schedule: FriendlySchedule): string | null {
  const t = parseTime(schedule.time);
  if (!t) return null;

  if (schedule.type === 'daily') {
    return `${t.minute} ${t.hour} * * *`;
  }

  if (schedule.type === 'weekly') {
    const days = [...new Set(schedule.weekDays ?? [])]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (days.length === 0) return null;
    return `${t.minute} ${t.hour} * * ${days.join(',')}`;
  }

  const dom = schedule.monthDay;
  if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
  return `${t.minute} ${t.hour} ${dom} * *`;
}

function literalNum(field: string): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = parseInt(field, 10);
  return Number.isInteger(n) ? n : null;
}

/**
 * Parse a cron expression into friendly schedule fields. Returns null for
 * Expressions the simple picker cannot represent (e.g. step values like an
 * every-30-minute schedule, second fields, complex lists) parse to null so
 * the form falls back to the raw cron editor.
 */
export function parseCronToFriendly(expression: string): FriendlySchedule | null {
  const fields = (expression || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== '*') return null;

  const minute = literalNum(minuteField);
  const hour = literalNum(hourField);
  if (minute === null || hour === null || minute > 59 || hour > 23) return null;
  const time = `${pad2(hour)}:${pad2(minute)}`;

  if (dowField !== '*') {
    const days = dowField.split(',').map(literalNum);
    if (days.length === 0 || days.some((d) => d === null || (d as number) < 0 || (d as number) > 6)) {
      return null;
    }
    return { type: 'weekly', time, weekDays: days as number[], monthDay: 1 };
  }

  const dom = literalNum(domField);
  if (dom !== null && dom >= 1 && dom <= 31) {
    return { type: 'monthly', time, weekDays: [], monthDay: dom };
  }

  if (domField === '*') {
    return { type: 'daily', time, weekDays: [], monthDay: 1 };
  }

  return null;
}

/** Human-readable summary of a friendly schedule, or of a cron expression. */
export function describeCron(expression: string): string {
  if (!expression) return 'not set';
  const friendly = parseCronToFriendly(expression);
  if (friendly) {
    if (friendly.type === 'daily') return `Every day at ${friendly.time}`;
    if (friendly.type === 'monthly') return `On the ${friendly.monthDay}${ordinal(friendly.monthDay)} of every month at ${friendly.time}`;
    const days = friendly.weekDays.map((d) => WEEKDAY_ABBREVS[d]).join(', ');
    return `${days} at ${friendly.time}`;
  }
  return expression;
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  const rem = n % 10;
  return rem === 1 ? 'st' : rem === 2 ? 'nd' : rem === 3 ? 'rd' : 'th';
}