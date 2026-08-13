import { describe, expect, it } from 'vitest';

import { currentDayKey, loginStreak } from './streak';

/// 2026-08-11 is a Tuesday; 2026-08-09 is the Sunday before it. Every fixture
/// below is anchored to that week so the weekend rule is exercised by real
/// calendar dates rather than by arithmetic on offsets.
const TUESDAY = '2026-08-11';

/// Every non-Sunday key in `[from, to]`, which is what a student who never
/// misses a day looks like.
function everyTeachingDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let cursor = new Date(`${from}T00:00:00Z`);
    cursor <= new Date(`${to}T00:00:00Z`);
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    if (cursor.getUTCDay() !== 0) out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}

describe('loginStreak', () => {
  it('reports nothing for a student who has never signed in', () => {
    expect(loginStreak([], TUESDAY)).toEqual({
      current: 0,
      longest: 0,
      activeDays: 0,
      currentSince: null,
      lastActive: null,
    });
  });

  it('counts a single day as a streak of one', () => {
    const streak = loginStreak([TUESDAY], TUESDAY);
    expect(streak.current).toBe(1);
    expect(streak.longest).toBe(1);
    expect(streak.currentSince).toBe(TUESDAY);
  });

  it('steps over Sunday rather than breaking on it', () => {
    // Mon 3rd to Sat 8th, then Mon 10th and Tue 11th. The Sunday in the middle
    // has no row and must not end the run.
    const days = [
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-10',
      '2026-08-11',
    ];
    const streak = loginStreak(days, TUESDAY);
    expect(streak.current).toBe(8);
    expect(streak.longest).toBe(8);
    expect(streak.currentSince).toBe('2026-08-03');
  });

  it('does not treat an empty today as a miss', () => {
    // Signed in Monday, not yet today. The run is still alive.
    const streak = loginStreak(['2026-08-07', '2026-08-08', '2026-08-10'], TUESDAY);
    expect(streak.current).toBe(3);
    expect(streak.lastActive).toBe('2026-08-10');
  });

  it('breaks on a missed weekday earlier than today', () => {
    // Monday the 10th is missing, so only today survives; Friday and Saturday
    // remain the longest run on record.
    const streak = loginStreak(['2026-08-07', '2026-08-08', '2026-08-11'], TUESDAY);
    expect(streak.current).toBe(1);
    expect(streak.longest).toBe(2);
  });

  it('keeps the longest run after the current one has broken', () => {
    const long = everyTeachingDay('2026-06-01', '2026-06-30'); // 26 teaching days
    const streak = loginStreak([...long, '2026-08-10', '2026-08-11'], TUESDAY);
    expect(streak.current).toBe(2);
    expect(streak.longest).toBe(long.length);
    expect(streak.longest).toBeGreaterThan(streak.current);
  });

  /**
   * The reason this module exists rather than a call to `consistency()`.
   *
   * That function counts over a hard-coded 30-day window, so a student with 90
   * unbroken teaching days behind them reports 30 — the same 30 as everybody
   * else who turned up all month, which is no ranking at all.
   */
  it('applies no window cap to the longest run', () => {
    const days = everyTeachingDay('2026-03-01', TUESDAY);
    const streak = loginStreak(days, TUESDAY);
    expect(days.length).toBeGreaterThan(120);
    expect(streak.longest).toBe(days.length);
    expect(streak.current).toBe(days.length);
  });

  it('ignores days dated after today', () => {
    const streak = loginStreak(['2026-08-11', '2026-09-01'], TUESDAY);
    expect(streak.activeDays).toBe(1);
    expect(streak.lastActive).toBe(TUESDAY);
  });

  it('ignores keys that are not calendar dates', () => {
    const streak = loginStreak(['not-a-day', '2026-02-31', TUESDAY], TUESDAY);
    expect(streak.activeDays).toBe(1);
    expect(streak.current).toBe(1);
  });

  it('never reports a longest shorter than the current run', () => {
    const days = everyTeachingDay('2026-08-01', TUESDAY);
    const streak = loginStreak(days, TUESDAY);
    expect(streak.longest).toBeGreaterThanOrEqual(streak.current);
  });

  it('counts distinct days rather than rows', () => {
    const streak = loginStreak([TUESDAY, TUESDAY, '2026-08-10'], TUESDAY);
    expect(streak.activeDays).toBe(2);
    expect(streak.current).toBe(2);
  });
});

describe('currentDayKey', () => {
  it('uses the local calendar date, not the UTC one', () => {
    // 05:30 IST on the 11th is 00:00 UTC on the 11th — same day either way.
    expect(currentDayKey(new Date('2026-08-11T00:00:00Z'))).toBe('2026-08-11');
  });

  it('keeps an evening in IST on the day the reader is living', () => {
    // 23:30 IST on the 11th is 18:00 UTC on the 11th. A local-parts conversion
    // must stay on the 11th; the failure mode this guards is a key of the 12th
    // or the 10th appearing for readers either side of Greenwich.
    const evening = new Date('2026-08-11T18:00:00Z');
    const key = currentDayKey(evening);
    expect(key).toBe(
      `${evening.getFullYear()}-${String(evening.getMonth() + 1).padStart(2, '0')}-${String(
        evening.getDate(),
      ).padStart(2, '0')}`,
    );
  });
});
