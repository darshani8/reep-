import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_MODE,
  ACTIVITY_ORDER,
  DIMENSION_ORDER,
  STAGE_ORDER,
  addDays,
  clamp,
  daysBetween,
  formatDuration,
  formatHours,
  formatPct,
  relativeDay,
  startOfWeek,
} from './reep';

describe('clamp', () => {
  it('bounds to 0–100 by default', () => {
    expect(clamp(-5)).toBe(0);
    expect(clamp(150)).toBe(100);
    expect(clamp(42.5)).toBe(42.5);
  });

  it('honours explicit bounds', () => {
    expect(clamp(5, 10, 20)).toBe(10);
    expect(clamp(25, 10, 20)).toBe(20);
  });

  it('passes NaN through rather than silently becoming zero', () => {
    // Worth pinning: every percentage in the app runs through clamp, so if a
    // NaN ever reaches it the display shows "NaN%" — visibly broken, which is
    // the intent. A clamp that mapped NaN to 0 would hide a division bug.
    expect(Number.isNaN(clamp(NaN))).toBe(true);
  });
});

describe('formatHours', () => {
  it('drops the minutes part when the hours are whole', () => {
    expect(formatHours(0)).toBe('0h');
    expect(formatHours(7)).toBe('7h');
  });

  it('spells a fraction as minutes rather than a decimal', () => {
    expect(formatHours(7.5)).toBe('7h 30m');
    expect(formatHours(1.25)).toBe('1h 15m');
  });

  it('rounds a fraction to the nearest minute', () => {
    // Note the ceiling on this: a fraction that rounds up to a full 60 minutes
    // is not carried into the hour. See `formatHours` in the defects suite.
    expect(formatHours(2.51)).toBe('2h 31m');
  });

  it('degrades to 0h rather than printing NaN', () => {
    expect(formatHours(NaN)).toBe('0h');
    expect(formatHours(Infinity)).toBe('0h');
  });
});

describe('formatDuration', () => {
  it('renders minutes under an hour', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(0)).toBe('0m');
  });

  it('zero-pads the minutes once there is an hour, so a column of times aligns', () => {
    expect(formatDuration(90)).toBe('1h 30m');
    expect(formatDuration(120)).toBe('2h 00m');
    expect(formatDuration(65)).toBe('1h 05m');
  });

  it('has a dash for an open or missing session rather than "0m"', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatPct', () => {
  it('rounds to whole percent by default', () => {
    expect(formatPct(42.4)).toBe('42%');
    expect(formatPct(42.6)).toBe('43%');
  });

  it('honours a digit count', () => {
    expect(formatPct(42.44, 1)).toBe('42.4%');
  });

  it('degrades to 0% rather than printing NaN into a card', () => {
    // The backstop for the division-by-zero paths in progress.ts: even if a NaN
    // escapes the maths, the reader sees 0% and not "NaN%".
    expect(formatPct(NaN)).toBe('0%');
    expect(formatPct(Infinity)).toBe('0%');
  });
});

describe('startOfWeek', () => {
  it('treats Monday as the first day of the week', () => {
    // 2026-08-05 is a Wednesday.
    expect(startOfWeek(new Date(2026, 7, 5, 15, 30))).toEqual(new Date(2026, 7, 3));
  });

  it('keeps a Monday on its own day rather than jumping back seven', () => {
    expect(startOfWeek(new Date(2026, 7, 3, 9, 0))).toEqual(new Date(2026, 7, 3));
  });

  it('pulls a Sunday back to the Monday that started that week', () => {
    // The off-by-one that a naive getDay() produces: Sunday is day 0, so an
    // unadjusted subtraction moves it forward a week instead of back six days.
    expect(startOfWeek(new Date(2026, 7, 9, 23, 0))).toEqual(new Date(2026, 7, 3));
  });

  it('zeroes the time and does not mutate its argument', () => {
    const input = new Date(2026, 7, 5, 15, 30);
    const week = startOfWeek(input);

    expect(week.getHours()).toBe(0);
    expect(input.getHours()).toBe(15);
  });
});

describe('addDays', () => {
  it('moves forward and backward', () => {
    expect(addDays(new Date(2026, 7, 3), 4)).toEqual(new Date(2026, 7, 7));
    expect(addDays(new Date(2026, 7, 3), -4)).toEqual(new Date(2026, 6, 30));
  });

  it('rolls over a month and a year boundary', () => {
    expect(addDays(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 1));
    expect(addDays(new Date(2026, 11, 31), 1)).toEqual(new Date(2027, 0, 1));
  });

  it('does not mutate its argument', () => {
    const input = new Date(2026, 7, 3);
    addDays(input, 10);

    expect(input).toEqual(new Date(2026, 7, 3));
  });
});

describe('relativeDay', () => {
  const now = new Date(2026, 7, 9, 9, 0);

  it('says Never for a student who has no such date', () => {
    expect(relativeDay(null, now)).toBe('Never');
    expect(relativeDay(undefined, now)).toBe('Never');
  });

  it('counts calendar days, so last night at 23:00 is Yesterday', () => {
    expect(relativeDay(new Date(2026, 7, 8, 23, 0), now)).toBe('Yesterday');
  });

  it('says Today for any time earlier the same day', () => {
    expect(relativeDay(new Date(2026, 7, 9, 0, 5), now)).toBe('Today');
  });

  it('treats a future timestamp as Today rather than a negative count', () => {
    expect(relativeDay(new Date(2026, 7, 10), now)).toBe('Today');
  });

  it('counts midnights, not elapsed hours', () => {
    // 23:00 to 09:00 six days later is 6d 10h of elapsed time but seven
    // midnights, and the roster copy is about calendar days.
    expect(relativeDay(new Date(2026, 7, 2, 23, 0), now)).toBe('7 days ago');
  });
});

describe('daysBetween', () => {
  it('is symmetric', () => {
    const a = new Date(2026, 7, 9);
    const b = new Date(2026, 7, 2);

    expect(daysBetween(a, b)).toBe(daysBetween(b, a));
  });

  it('counts whole elapsed days between two midnights', () => {
    expect(daysBetween(new Date(2026, 7, 9), new Date(2026, 7, 2))).toBe(7);
  });

  it('is zero for two times on the same day', () => {
    expect(daysBetween(new Date(2026, 7, 9, 1, 0), new Date(2026, 7, 9, 23, 0))).toBe(0);
  });

  it('floors a partial day — see the disagreement with relativeDay in the defects suite', () => {
    // 6d 10h of elapsed time. relativeDay calls the same pair "7 days ago".
    expect(daysBetween(new Date(2026, 7, 9, 9, 0), new Date(2026, 7, 2, 23, 0))).toBe(6);
  });
});

describe('REEP vocabulary', () => {
  it('orders the stages as the journey rail draws them', () => {
    expect(STAGE_ORDER).toEqual(['REBOOT', 'EXCEL', 'EXCEL_ADVANCED', 'ELEVATE']);
  });

  it('lists all four developmental dimensions exactly once', () => {
    expect(new Set(DIMENSION_ORDER).size).toBe(DIMENSION_ORDER.length);
    expect(DIMENSION_ORDER).toHaveLength(4);
  });

  it('assigns every activity a learning mode', () => {
    // ACTIVITY_MODE drives which sessions count as lab time in the alert rules;
    // an activity missing from the map would read as `undefined` and quietly
    // fall out of every mode filter.
    for (const activity of ACTIVITY_ORDER) {
      expect(ACTIVITY_MODE[activity]).toBeDefined();
    }
  });
});
