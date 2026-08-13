/**
 * The login streak, as the landing page states it: current *and* longest.
 *
 * There is already a streak function in this codebase and it is the wrong one
 * to call here. `consistency()` in `analytics.ts` measures *study* days over a
 * hard-coded 30-day window, which is a different fact about a different table —
 * and the window is not an implementation detail. A cap of 30 means every
 * student who has shown up since term began reports the same "longest: 30", so
 * the number a landing page is meant to be proud of is exactly the number that
 * stops distinguishing anybody. This module has no window: it walks from the
 * first recorded sign-in to today and reports what it finds.
 *
 * Two rules decide what counts, and both are inherited from
 * `leaderboard/streak.ts` deliberately — the streak in the tile and the streak
 * on the board have to be the same integer or one of them is lying:
 *
 *  - **Sunday is not a miss.** Campus is closed and no row is written for one.
 *    Counting consecutive calendar days would cap the whole programme at six,
 *    so a Sunday is stepped over: it neither counts nor breaks.
 *  - **Today is not a miss.** A student reading this at nine in the morning has
 *    not yet failed to sign in — and in practice cannot have, because loading
 *    the page *is* a sign-in. Yesterday's absence still breaks the run.
 *
 * The input is `YYYY-MM-DD` day keys rather than `Date`s. `LoginDay.day` is a
 * `@db.Date` that Prisma hands back as UTC midnight, and every timezone bug in
 * this area comes from re-deriving a calendar day from an instant somewhere
 * downstream. Keys are compared as strings, sort chronologically for free, and
 * cannot drift. `dayKey`/`dayFromKey`/`shiftKey` come from
 * `timesheet/rules.ts`, which solved the same problem for the time sheet.
 *
 * Pure — no Prisma, no `server-only`, no clock of its own.
 */

import { dayFromKey, dayKey, shiftKey } from './timesheet/rules';

/**
 * A guard, not a window.
 *
 * The metric is uncapped by design, but the walk is a loop over calendar days
 * and one corrupt row dated 1970 would spin it twenty thousand times. Five
 * years is longer than any programme a student can be enrolled on, so nothing
 * real is ever truncated by it.
 */
const MAX_SPAN_DAYS = 1830;

/// Sunday, as `Date.getUTCDay()` numbers it.
const SUNDAY = 0;

export type LoginStreak = {
  /// Consecutive teaching days signed in, counting back from today.
  current: number;
  /// The best run ever recorded. Always >= `current`.
  longest: number;
  /// Distinct days signed in, all-time. The denominator behind "you have been
  /// here 43 days" when the current run is short.
  activeDays: number;
  /// First day of the current run, so the tile can say when it started rather
  /// than only how long it is. Null when the run is zero.
  currentSince: string | null;
  /// Most recent day signed in, for the "last seen" line on a broken streak.
  lastActive: string | null;
};

const NO_STREAK: LoginStreak = {
  current: 0,
  longest: 0,
  activeDays: 0,
  currentSince: null,
  lastActive: null,
};

/**
 * Fold sign-in days into current and longest runs.
 *
 * `today` is passed in rather than read from the clock so that a test can pin
 * it and so two tiles rendered from the same request cannot straddle midnight.
 */
export function loginStreak(days: Iterable<string>, today: string): LoginStreak {
  if (!dayFromKey(today)) return NO_STREAK;

  // A key dated after today is a clock skew or a bad import, not a streak the
  // student has earned; dropping it here keeps it out of both numbers.
  const present = new Set<string>();
  for (const raw of days) {
    const key = raw.trim();
    if (dayFromKey(key) && key <= today) present.add(key);
  }
  if (present.size === 0) return NO_STREAK;

  const observed = [...present].sort();
  const earliest = observed[0];
  const floor = shiftKey(today, -MAX_SPAN_DAYS) ?? earliest;
  // Nullable because `shiftKey` refuses to build a key it cannot parse, and the
  // walk ends rather than looping on a bad one.
  let cursor: string | null = earliest < floor ? floor : earliest;

  let run = 0;
  let runStart: string | null = null;
  let longest = 0;

  while (cursor && cursor <= today) {
    // `dayFromKey` cannot fail here — `cursor` came from `shiftKey`, which
    // round-trips through the same parser — but the weekday is the only thing
    // needed, so the null case simply skips rather than throwing.
    const asDate = dayFromKey(cursor);

    if (asDate && asDate.getUTCDay() !== SUNDAY) {
      if (present.has(cursor)) {
        if (run === 0) runStart = cursor;
        run += 1;
        if (run > longest) longest = run;
      } else if (cursor !== today) {
        // The grace above applies to the current day alone. Any earlier gap is
        // a day the student was expected and did not come.
        run = 0;
        runStart = null;
      }
    }

    cursor = shiftKey(cursor, 1);
  }

  return {
    current: run,
    longest,
    activeDays: observed.length,
    currentSince: run > 0 ? runStart : null,
    lastActive: observed[observed.length - 1],
  };
}

/**
 * Today, as a key this module will compare correctly.
 *
 * The reader's *local* calendar date reinterpreted at UTC midnight — the same
 * conversion the seed performs when it writes `LoginDay.day`, and the same one
 * `authenticate()` performs when it upserts one. Formatting the instant in UTC
 * instead would put an IST evening on the wrong side of the boundary and dock a
 * day off every streak on campus.
 */
export function currentDayKey(now: Date = new Date()): string {
  return dayKey(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
