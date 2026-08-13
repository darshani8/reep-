/**
 * Turning sign-in days into a streak.
 *
 * `LoginDay` stores one row per user per day they signed in, precisely so a
 * streak is answerable — `User.lastLoginAt` cannot tell thirty visits in one
 * evening from thirty consecutive days. What it does not store is which days
 * counted, and that is the whole difficulty:
 *
 *  - **Sunday is not a miss.** Campus is closed and the seed does not write a
 *    Sunday row for anybody. Counting consecutive calendar days would cap every
 *    student in the programme at six and make the board meaningless, so a
 *    Sunday is stepped over: it neither counts nor breaks.
 *  - **Today is not a miss either.** A student reading this at nine in the
 *    morning has not yet failed to sign in — except they have, because loading
 *    this page *is* a sign-in, so in practice today is present. The grace
 *    applies to the current day only, and yesterday's absence breaks the
 *    streak, which is the behaviour `consistency()` in `analytics.ts` already
 *    settled on for logged study days.
 *
 * `day` is a Postgres `date`, which Prisma hands back as midnight UTC. The
 * comparison is therefore done on UTC components throughout, and "today" is the
 * reader's local calendar date reinterpreted at UTC midnight — the same
 * conversion the seed does when it writes these rows. Doing it any other way
 * puts an IST evening on the wrong side of a date boundary and silently drops a
 * day off every streak in the cohort.
 *
 * Pure — no Prisma, no `server-only`. The database work is in `queries.ts`.
 */

/// Far enough back to cover any real streak, and a hard stop so a corrupt row
/// cannot spin the loop.
const MAX_LOOKBACK_DAYS = 400;

export type LoginStreak = {
  /// Consecutive teaching days signed in, counting back from today.
  length: number;
  /// The first day of the current run — the tie-break between two equal
  /// streaks, since the student who has held it longer got there first.
  since: Date | null;
};

export function currentLoginStreak(days: Date[], now = new Date()): LoginStreak {
  const present = new Set(days.map(utcDayKey));
  const start = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  let length = 0;
  let since: Date | null = null;

  for (let back = 0; back < MAX_LOOKBACK_DAYS; back++) {
    const cursor = new Date(start - back * 86_400_000);
    if (cursor.getUTCDay() === 0) continue; // Sunday — campus closed.

    if (present.has(utcDayKey(cursor))) {
      length += 1;
      since = cursor;
      continue;
    }

    // The current day is allowed to be empty; any earlier gap ends the run.
    if (back === 0) continue;
    break;
  }

  return { length, since };
}

function utcDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}
