import { describe, expect, it } from 'vitest';

import {
  LATE_ENTRY_DAYS,
  MINUTES_IN_DAY,
  clockLabel,
  earliestLoggableDay,
  isBackdated,
  isoDay,
  loggedAfterDays,
  minutesBetween,
  parseClock,
  parseDay,
  standingFor,
  startOfDay,
} from './activity-rules';

/**
 * Every date here is built from parts (`new Date(2026, 7, 4)`) rather than from
 * an ISO string. These functions are deliberately *local*-time — the module
 * comment explains why — so `new Date('2026-08-04')` would be midnight UTC and
 * the assertions would pass or fail depending on the machine's timezone. Built
 * from parts, they mean the same calendar day everywhere.
 */

describe('standingFor', () => {
  it('marks a student-entered row self-reported and unconfirmed, with no audit note', () => {
    expect(standingFor({ kind: 'student' }, new Date(2026, 7, 4))).toEqual({
      source: 'SELF_REPORTED',
      mentorConfirmed: false,
      notes: null,
    });
  });

  it('marks a staff-entered row manual and confirmed, and names who entered it', () => {
    const standing = standingFor({ kind: 'staff', label: 'Dr Rao' }, new Date(2026, 7, 4));

    expect(standing.source).toBe('MANUAL');
    expect(standing.mentorConfirmed).toBe(true);
    expect(standing.notes).toContain('Dr Rao');
  });

  it('never lets a student entry claim mentor confirmation', () => {
    // The whole difference between the two forms. If this ever inverts, every
    // focus figure silently changes meaning.
    expect(standingFor({ kind: 'student' }, new Date()).mentorConfirmed).toBe(false);
  });
});

describe('earliestLoggableDay', () => {
  it('uses enrolment when the student joined before their cohort started', () => {
    const floor = earliestLoggableDay({
      enrolledAt: new Date(2026, 0, 5, 14, 30),
      cohort: { startDate: new Date(2026, 0, 12) },
    });

    expect(floor).toEqual(new Date(2026, 0, 5));
  });

  it('uses the cohort start when the student enrolled late', () => {
    const floor = earliestLoggableDay({
      enrolledAt: new Date(2026, 1, 20),
      cohort: { startDate: new Date(2026, 0, 12) },
    });

    expect(floor).toEqual(new Date(2026, 0, 12));
  });

  it('strips the time of day so the floor is a whole day', () => {
    const floor = earliestLoggableDay({
      enrolledAt: new Date(2026, 0, 5, 23, 59, 59),
      cohort: { startDate: new Date(2026, 0, 6) },
    });

    expect(floor.getHours()).toBe(0);
    expect(floor.getMinutes()).toBe(0);
  });

  it('does not mutate the dates it was handed', () => {
    const enrolledAt = new Date(2026, 0, 5, 14, 30);
    const startDate = new Date(2026, 0, 12, 9, 0);

    earliestLoggableDay({ enrolledAt, cohort: { startDate } });

    expect(enrolledAt).toEqual(new Date(2026, 0, 5, 14, 30));
    expect(startDate).toEqual(new Date(2026, 0, 12, 9, 0));
  });
});

describe('loggedAfterDays / isBackdated', () => {
  it('counts a same-day entry as zero days late', () => {
    expect(
      loggedAfterDays({
        checkInAt: new Date(2026, 7, 4, 19, 0),
        createdAt: new Date(2026, 7, 4, 22, 30),
      }),
    ).toBe(0);
  });

  it('counts calendar days, not elapsed hours, so last night logged at breakfast is one day', () => {
    // 21:00 to 08:00 is 11 elapsed hours but crosses one midnight.
    expect(
      loggedAfterDays({
        checkInAt: new Date(2026, 7, 4, 21, 0),
        createdAt: new Date(2026, 7, 5, 8, 0),
      }),
    ).toBe(1);
  });

  it('clamps a session that ran past midnight to zero rather than going negative', () => {
    expect(
      loggedAfterDays({
        checkInAt: new Date(2026, 7, 5, 0, 30),
        createdAt: new Date(2026, 7, 4, 23, 0),
      }),
    ).toBe(0);
  });

  it('does not flag an entry written exactly at the late-entry limit', () => {
    const session = {
      checkInAt: new Date(2026, 7, 4),
      createdAt: new Date(2026, 7, 4 + LATE_ENTRY_DAYS),
    };

    expect(loggedAfterDays(session)).toBe(LATE_ENTRY_DAYS);
    expect(isBackdated(session)).toBe(false);
  });

  it('flags an entry written one day past the limit', () => {
    expect(
      isBackdated({
        checkInAt: new Date(2026, 7, 4),
        createdAt: new Date(2026, 7, 4 + LATE_ENTRY_DAYS + 1),
      }),
    ).toBe(true);
  });
});

describe('parseDay', () => {
  it('reads YYYY-MM-DD as a local calendar day, not midnight UTC', () => {
    const day = parseDay('2026-08-04');

    expect(day).not.toBeNull();
    expect(day!.getFullYear()).toBe(2026);
    expect(day!.getMonth()).toBe(7);
    expect(day!.getDate()).toBe(4);
    expect(day!.getHours()).toBe(0);
  });

  it('round-trips through isoDay without the day shifting', () => {
    // The pairing that keeps a logged Tuesday in Tuesday's bucket.
    expect(isoDay(parseDay('2026-08-04')!)).toBe('2026-08-04');
  });

  it('rejects a date that does not exist rather than rolling it forward', () => {
    // Date would happily turn 2026-02-30 into 2026-03-02.
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('2026-13-01')).toBeNull();
  });

  it('accepts a real leap day and rejects one in a common year', () => {
    expect(parseDay('2028-02-29')).not.toBeNull();
    expect(parseDay('2026-02-29')).toBeNull();
  });

  it('returns null for text that is not a date', () => {
    expect(parseDay('')).toBeNull();
    expect(parseDay('not a date')).toBeNull();
  });

  it('tolerates surrounding whitespace and a trailing time component', () => {
    expect(isoDay(parseDay('  2026-08-04  ')!)).toBe('2026-08-04');
    expect(isoDay(parseDay('2026-08-04T13:45:00')!)).toBe('2026-08-04');
  });
});

describe('isoDay', () => {
  it('zero-pads month and day', () => {
    expect(isoDay(new Date(2026, 0, 9))).toBe('2026-01-09');
  });

  it('reports the local day even late in the evening', () => {
    // The bug this format exists to avoid: toISOString() would say 2026-08-05
    // here for any timezone east of UTC.
    expect(isoDay(new Date(2026, 7, 4, 23, 59))).toBe('2026-08-04');
  });
});

describe('startOfDay', () => {
  it('strips the time and leaves the calendar day alone', () => {
    expect(startOfDay(new Date(2026, 7, 4, 23, 59, 59, 999))).toEqual(new Date(2026, 7, 4));
  });

  it('returns a new Date rather than mutating its argument', () => {
    const original = new Date(2026, 7, 4, 13, 0);

    expect(startOfDay(original)).not.toBe(original);
    expect(original.getHours()).toBe(13);
  });
});

describe('parseClock', () => {
  it('reads HH:MM as minutes from midnight', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('23:59')).toBe(1_439);
  });

  it('accepts the single-digit hour and the HH:MM:SS some browsers emit', () => {
    expect(parseClock('9:30')).toBe(570);
    expect(parseClock('09:30:45')).toBe(570);
  });

  it('rejects an hour or minute out of range instead of wrapping it', () => {
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('99:99')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock('9:5')).toBeNull();
    expect(parseClock('half nine')).toBeNull();
    expect(parseClock('09:30 PM')).toBeNull();
  });

  it('is the inverse of clockLabel across the whole day', () => {
    for (let minute = 0; minute < MINUTES_IN_DAY; minute += 17) {
      expect(parseClock(clockLabel(minute))).toBe(minute);
    }
  });
});

describe('clockLabel', () => {
  it('always produces the two-digit form <input type="time"> requires', () => {
    expect(clockLabel(0)).toBe('00:00');
    expect(clockLabel(570)).toBe('09:30');
    expect(clockLabel(1_439)).toBe('23:59');
  });

  it('wraps out-of-range minutes into the day in both directions', () => {
    expect(clockLabel(MINUTES_IN_DAY)).toBe('00:00');
    expect(clockLabel(MINUTES_IN_DAY + 90)).toBe('01:30');
    expect(clockLabel(-30)).toBe('23:30');
  });
});

describe('minutesBetween', () => {
  it('measures an ordinary daytime session', () => {
    expect(minutesBetween(parseClock('09:00')!, parseClock('11:30')!)).toBe(150);
  });

  it('treats equal times as zero, not a full day', () => {
    expect(minutesBetween(600, 600)).toBe(0);
  });

  it('wraps a session that crosses midnight', () => {
    expect(minutesBetween(parseClock('22:00')!, parseClock('00:30')!)).toBe(150);
  });

  it('never returns a negative duration', () => {
    for (const [from, to] of [
      [0, 0],
      [1_439, 0],
      [720, 60],
      [60, 720],
    ]) {
      expect(minutesBetween(from, to)).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads a transposed pair as an overnight session, which the length rule then refuses', () => {
    // Documented behaviour, not an accident: 14:00 to 13:00 is 23 hours, and the
    // caller's "at most 12 hours" rule rejects it with one message rather than two.
    expect(minutesBetween(parseClock('14:00')!, parseClock('13:00')!)).toBe(23 * 60);
  });
});
