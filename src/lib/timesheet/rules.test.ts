import { describe, expect, it } from 'vitest';

import {
  DAY_ACTIVITIES,
  MINUTES_IN_DAY,
  STEP_MINUTES,
  dayFromKey,
  dayKey,
  daysBetweenKeys,
  durationWords,
  emptySheet,
  parseSubmission,
  remainingLabel,
  remainingMinutes,
  sheetFromEntries,
  sheetTotal,
  sheetsEqual,
  shiftKey,
  stepMinutes,
  validateSheet,
  type DaySheet,
} from './rules';

/**
 * The first block is the one that matters most.
 *
 * "5 activities only" is the entire reason a student fills this sheet, and it is
 * exactly the kind of constraint that erodes one well-meaning pull request at a
 * time. Asserting the length — not just the contents — means a sixth bucket
 * cannot be added without deleting a line that says why not.
 */
describe('DAY_ACTIVITIES', () => {
  it('is exactly five buckets', () => {
    expect(DAY_ACTIVITIES).toHaveLength(5);
  });

  it("carries the spec's own labels", () => {
    expect(DAY_ACTIVITIES.map((def) => def.label)).toEqual([
      'Sleeping',
      'Engaged in leisure',
      'Engaged in lectures',
      'Engaged in coursework',
      'Engaged in skilling',
    ]);
  });

  it('names each DayActivity value once', () => {
    const activities = DAY_ACTIVITIES.map((def) => def.activity);
    expect(new Set(activities).size).toBe(activities.length);
    expect([...activities].sort()).toEqual([
      'COURSEWORK',
      'LECTURES',
      'LEISURE',
      'SKILLING',
      'SLEEPING',
    ]);
  });

  it('gives every bucket a hint, so no bucket is a guess', () => {
    for (const def of DAY_ACTIVITIES) {
      expect(def.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('emptySheet / sheetFromEntries', () => {
  it('starts every bucket at zero rather than absent', () => {
    const sheet = emptySheet();
    expect(Object.keys(sheet).sort()).toEqual([
      'COURSEWORK',
      'LECTURES',
      'LEISURE',
      'SKILLING',
      'SLEEPING',
    ]);
    expect(sheetTotal(sheet)).toBe(0);
  });

  it('fills the buckets a day has rows for and leaves the rest at zero', () => {
    const sheet = sheetFromEntries([
      { activity: 'SLEEPING', minutes: 450 },
      { activity: 'SKILLING', minutes: 90 },
    ]);
    expect(sheet.SLEEPING).toBe(450);
    expect(sheet.SKILLING).toBe(90);
    expect(sheet.LEISURE).toBe(0);
    expect(sheetTotal(sheet)).toBe(540);
  });

  it('sums a repeated activity rather than dropping minutes', () => {
    // The unique key makes this impossible in the database; losing time
    // silently would be the worse failure if it ever happened anyway.
    const sheet = sheetFromEntries([
      { activity: 'LECTURES', minutes: 60 },
      { activity: 'LECTURES', minutes: 30 },
    ]);
    expect(sheet.LECTURES).toBe(90);
  });
});

describe('validateSheet', () => {
  function sheet(partial: Partial<DaySheet>): DaySheet {
    return { ...emptySheet(), ...partial };
  }

  it('blocks a day that adds up to more than 24 hours', () => {
    const verdict = validateSheet(sheet({ SLEEPING: 600, LEISURE: 600, LECTURES: 400 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('more than a day holds');
    expect(verdict.remainingMinutes).toBeLessThan(0);
  });

  it('warns but never blocks a day that adds up to less than 24 hours', () => {
    const verdict = validateSheet(sheet({ SLEEPING: 480, COURSEWORK: 120 }));
    expect(verdict.ok).toBe(true);
    expect(verdict.error).toBeNull();
    expect(verdict.warning).toContain('unaccounted for');
    expect(verdict.remainingMinutes).toBe(MINUTES_IN_DAY - 600);
  });

  it('says nothing at all when the day balances', () => {
    const verdict = validateSheet(
      sheet({ SLEEPING: 480, LEISURE: 480, LECTURES: 240, COURSEWORK: 120, SKILLING: 120 }),
    );
    expect(verdict).toEqual({
      ok: true,
      error: null,
      warning: null,
      totalMinutes: MINUTES_IN_DAY,
      remainingMinutes: 0,
    });
  });

  it('lets a blank sheet through, because that is how a wrong day is cleared', () => {
    const verdict = validateSheet(emptySheet());
    expect(verdict.ok).toBe(true);
    expect(verdict.warning).toContain('empties the day');
  });

  it('refuses a negative bucket', () => {
    const verdict = validateSheet(sheet({ LEISURE: -30 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('negative');
  });
});

describe('stepMinutes', () => {
  it('moves by the half-hour step', () => {
    expect(stepMinutes(0, 1)).toBe(STEP_MINUTES);
    expect(stepMinutes(450, 1)).toBe(480);
    expect(stepMinutes(450, -1)).toBe(420);
  });

  it('snaps an off-grid value onto the grid rather than carrying it', () => {
    expect(stepMinutes(437, 1)).toBe(450);
    expect(stepMinutes(437, -1)).toBe(420);
  });

  it('stops at zero and at a full day', () => {
    expect(stepMinutes(0, -1)).toBe(0);
    expect(stepMinutes(20, -1)).toBe(0);
    expect(stepMinutes(MINUTES_IN_DAY, 1)).toBe(MINUTES_IN_DAY);
  });
});

describe('remainingMinutes / remainingLabel', () => {
  it('counts down from 24 and reads as a sentence', () => {
    const sheet = { ...emptySheet(), SLEEPING: 480 };
    expect(remainingMinutes(sheet)).toBe(960);
    expect(remainingLabel(sheet)).toBe('16 hours remaining of 24');
  });

  it('names the overshoot rather than a negative number', () => {
    const sheet = { ...emptySheet(), SLEEPING: 1440, LEISURE: 90 };
    expect(remainingLabel(sheet)).toBe('1h 30m over 24');
  });

  it('says so when the day balances', () => {
    const sheet = { ...emptySheet(), SLEEPING: 1440 };
    expect(remainingLabel(sheet)).toBe('The full 24 hours accounted for');
  });
});

describe('durationWords', () => {
  it('spells the units out for a sentence', () => {
    expect(durationWords(60)).toBe('1 hour');
    expect(durationWords(120)).toBe('2 hours');
    expect(durationWords(150)).toBe('2h 30m');
    expect(durationWords(30)).toBe('30 min');
  });
});

describe('sheetsEqual', () => {
  it('is true only when every bucket matches', () => {
    const a = { ...emptySheet(), SLEEPING: 480 };
    expect(sheetsEqual(a, { ...emptySheet(), SLEEPING: 480 })).toBe(true);
    expect(sheetsEqual(a, { ...emptySheet(), SLEEPING: 450 })).toBe(false);
  });
});

/**
 * `day` is a `@db.Date`, which Prisma hands back as UTC midnight — so these keys
 * are built from UTC parts, and the assertions are written with UTC instants to
 * match. A local-time formatter here would pass in India and fail in Chicago.
 */
describe('day keys', () => {
  it('round-trips a key through the instant the column stores', () => {
    const date = dayFromKey('2026-08-11');
    expect(date?.toISOString()).toBe('2026-08-11T00:00:00.000Z');
    expect(dayKey(date as Date)).toBe('2026-08-11');
  });

  it('reads a UTC-midnight value back as the same calendar day', () => {
    expect(dayKey(new Date('2026-08-11T00:00:00.000Z'))).toBe('2026-08-11');
  });

  it('refuses a date that does not exist instead of rolling it forward', () => {
    expect(dayFromKey('2026-02-31')).toBeNull();
    expect(dayFromKey('not-a-day')).toBeNull();
    expect(dayFromKey('2026-8-1')).toBeNull();
  });

  it('shifts and subtracts days without leaving the key space', () => {
    expect(shiftKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetweenKeys('2026-08-04', '2026-08-11')).toBe(7);
    expect(daysBetweenKeys('2026-08-11', '2026-08-04')).toBe(-7);
  });
});

describe('parseSubmission', () => {
  it('reads a well-formed body', () => {
    const parsed = parseSubmission({
      day: '2026-08-11',
      minutes: { SLEEPING: 480, LEISURE: 360, LECTURES: 180, COURSEWORK: 120, SKILLING: 90 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dayKey).toBe('2026-08-11');
    expect(sheetTotal(parsed.sheet)).toBe(1230);
  });

  it('treats an absent bucket as zero', () => {
    const parsed = parseSubmission({ day: '2026-08-11', minutes: { SLEEPING: 480 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.LEISURE).toBe(0);
    expect(sheetTotal(parsed.sheet)).toBe(480);
  });

  it('ignores a bucket that is not one of the five', () => {
    const parsed = parseSubmission({
      day: '2026-08-11',
      minutes: { SLEEPING: 480, COMMUTING: 90 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sheetTotal(parsed.sheet)).toBe(480);
  });

  it('refuses a body with no usable day', () => {
    expect(parseSubmission({ minutes: {} })).toEqual({
      ok: false,
      error: 'Expected a day as YYYY-MM-DD.',
    });
    expect(parseSubmission({ day: '2026-02-31', minutes: {} }).ok).toBe(false);
    expect(parseSubmission(null).ok).toBe(false);
    expect(parseSubmission('a day').ok).toBe(false);
  });

  it('refuses minutes that are not numbers, are negative, or exceed a day', () => {
    expect(parseSubmission({ day: '2026-08-11', minutes: { SLEEPING: '480' } }).ok).toBe(false);
    expect(parseSubmission({ day: '2026-08-11', minutes: { SLEEPING: -30 } }).ok).toBe(false);
    expect(parseSubmission({ day: '2026-08-11', minutes: { SLEEPING: 1500 } }).ok).toBe(false);
    expect(parseSubmission({ day: '2026-08-11', minutes: { SLEEPING: Number.NaN } }).ok).toBe(
      false,
    );
  });

  it('refuses a body with no minutes object at all', () => {
    expect(parseSubmission({ day: '2026-08-11' }).ok).toBe(false);
  });
});
