import { describe, expect, it } from 'vitest';

import { currentLoginStreak } from './streak';

/**
 * The two rules that make this harder than counting backwards: Sunday is not a
 * miss, and today is not a miss either. Get either wrong and every streak in
 * the programme is capped at six, or reset every morning.
 *
 * Dates are written as UTC midnight because that is what Postgres `date` hands
 * back through Prisma, and `now` is passed explicitly so the suite does not
 * change meaning depending on the day it runs.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// 2026-08-11 is a Tuesday. 2026-08-09 is the Sunday before it.
const TUESDAY = day('2026-08-11');

describe('currentLoginStreak', () => {
  it('counts consecutive days back from today', () => {
    const streak = currentLoginStreak(
      [day('2026-08-11'), day('2026-08-10'), day('2026-08-08')],
      TUESDAY,
    );

    // Mon and Tue, then Sunday is stepped over, then Saturday the 8th.
    expect(streak.length).toBe(3);
    expect(streak.since).toEqual(day('2026-08-08'));
  });

  it('steps over Sunday rather than breaking on it', () => {
    // Nobody signs in on a Sunday — campus is closed and the seed writes no
    // Sunday rows. Counting calendar days would cap the whole cohort at six.
    const days = [
      day('2026-08-11'),
      day('2026-08-10'),
      day('2026-08-08'),
      day('2026-08-07'),
      day('2026-08-06'),
      day('2026-08-05'),
      day('2026-08-04'),
      day('2026-08-03'),
      day('2026-08-01'),
    ];
    expect(currentLoginStreak(days, TUESDAY).length).toBe(9);
  });

  it('does not break because today is still empty', () => {
    const streak = currentLoginStreak([day('2026-08-10'), day('2026-08-08')], TUESDAY);
    expect(streak.length).toBe(2);
    expect(streak.since).toEqual(day('2026-08-08'));
  });

  it('breaks on a missed teaching day that is not today', () => {
    // Monday absent. Tuesday alone is the whole streak.
    const streak = currentLoginStreak([day('2026-08-11'), day('2026-08-08')], TUESDAY);
    expect(streak.length).toBe(1);
    expect(streak.since).toEqual(day('2026-08-11'));
  });

  it('gives a student who has never signed in a streak of zero', () => {
    expect(currentLoginStreak([], TUESDAY)).toEqual({ length: 0, since: null });
  });

  it('gives a student whose last sign-in was weeks ago a streak of zero', () => {
    expect(currentLoginStreak([day('2026-07-01')], TUESDAY).length).toBe(0);
  });

  it('ignores rows in the future and duplicates', () => {
    const streak = currentLoginStreak(
      [day('2026-09-01'), day('2026-08-11'), day('2026-08-11'), day('2026-08-10')],
      TUESDAY,
    );
    expect(streak.length).toBe(2);
  });

  it('reads a local calendar date the same way the row was written', () => {
    // An IST evening is still the same day. Prisma round-trips `date` at UTC
    // midnight, so "today" has to be the reader's local Y/M/D reinterpreted
    // there — read any other way, every streak in the cohort loses a day after
    // 05:30 IST or before it, depending on which direction the slip goes.
    const istEvening = new Date(2026, 7, 11, 21, 30);
    expect(currentLoginStreak([day('2026-08-11')], istEvening).length).toBe(1);

    const istMorning = new Date(2026, 7, 11, 6, 15);
    expect(currentLoginStreak([day('2026-08-11')], istMorning).length).toBe(1);
  });

  it('terminates on a long unbroken history', () => {
    const days: Date[] = [];
    for (let back = 0; back < 500; back++) {
      days.push(new Date(Date.UTC(2026, 7, 11) - back * 86_400_000));
    }
    // Bounded by the lookback window, not by the data.
    expect(currentLoginStreak(days, TUESDAY).length).toBeGreaterThan(300);
  });
});
