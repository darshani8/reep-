import 'server-only';

/**
 * Everything the day sheet screen reads.
 *
 * It is deliberately not in `src/lib/queries.ts`. That module assembles the
 * screens built on `LabSession` — pace, focus, forecast — and the whole point of
 * the five-bucket sheet is that it is a *separate* record answering a separate
 * question. Keeping its reads here means the two never quietly start sharing a
 * `select`, which is how "the time sheet feeds pace" would become true by
 * accident rather than by decision.
 *
 * Two rules shape every query below:
 *
 *  - **A day is a key, not an instant.** `TimeSheetEntry.day` is a `@db.Date`,
 *    so it is filtered and read back through `dayKey`/`dayFromKey` in
 *    `rules.ts`, never through a local-time formatter.
 *  - **The screen must render for a student with nothing.** Every function here
 *    returns a full `DaySheet` of zeroes and an empty list rather than null, so
 *    the page has no branch that can produce a blank screen or a stack trace.
 */

import { earliestLoggableDay, isoDay } from '@/lib/activity-rules';
import { prisma } from '@/lib/db';
import type { DayActivity } from '@prisma/client';

import {
  DAY_ACTIVITIES,
  dayFromKey,
  dayKey,
  daysBetweenKeys,
  sheetFromEntries,
  sheetTotal,
  shiftKey,
  type DaySheet,
} from './rules';

/// How far back the "recent days" strip looks. Two weeks is long enough to show
/// a habit forming and short enough that every bar is still legible.
const RECENT_DAYS = 14;

/// One row per bucket per day, so the read is bounded by the number of days it
/// is allowed to show rather than by how long the student has been enrolled.
const RECENT_ROW_LIMIT = RECENT_DAYS * DAY_ACTIVITIES.length;

/// A day already on the record, as the strip below the sheet needs it.
export type RecentDay = {
  key: string;
  /// "Tue 11 Aug" — formatted here so no Date crosses into a client component.
  label: string;
  sheet: DaySheet;
  totalMinutes: number;
};

export type TimeSheetScreen = {
  firstName: string;
  /// Server-local today, as a key. The page compares against this rather than
  /// asking the browser, so the first paint cannot disagree about the date.
  todayKey: string;
  /// The floor `/api/timesheet` validates against — the same one the session log
  /// uses, so the two screens cannot offer different pasts.
  earliestKey: string;
  dayKey: string;
  dayLabel: string;
  /// "Today", "Yesterday", "4 days ago".
  dayRelative: string;
  /// Null at the ends of the allowed range, which is what greys the arrows out.
  previousKey: string | null;
  nextKey: string | null;
  /// The day as it currently stands on the record. All zeroes for a day nobody
  /// has filled in, which is also the editor's starting point.
  sheet: DaySheet;
  /// Whether anything is stored for this day at all.
  alreadySaved: boolean;
  /**
   * What the copy button copies.
   *
   * Yesterday when yesterday has a sheet — that is the spec's "one tap to copy
   * yesterday" and the overwhelmingly common case. When it does not, this is the
   * most recent day that *does*, and the button names it. A student coming back
   * after a gap is exactly who needs the shortcut most, and a button that is
   * disabled precisely then is a button that is never there when it matters.
   */
  copyFrom: { key: string; label: string; relative: string; sheet: DaySheet } | null;
  /// Newest first, most recent `RECENT_DAYS` days that carry anything.
  recent: RecentDay[];
  /// Hours per bucket across `recent` plus the day on screen, for the chart.
  bucketHours: { label: string; value: number }[];
};

/**
 * The window a student may write a sheet for.
 *
 * Same floor as the session log — nobody studied for this programme before they
 * were on it — read through `earliestLoggableDay` rather than restated, so the
 * two paths cannot drift. Both bounds come back as keys because that is what the
 * route and the page compare against, and comparing `YYYY-MM-DD` strings is the
 * one date comparison a timezone cannot spoil.
 */
export async function loggableWindow(
  studentId: string,
): Promise<{ earliestKey: string; todayKey: string } | null> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { enrolledAt: true, cohort: { select: { startDate: true } } },
  });
  if (!student) return null;

  return {
    earliestKey: isoDay(earliestLoggableDay(student)),
    todayKey: isoDay(new Date()),
  };
}

export async function getTimeSheetScreen(
  studentId: string,
  requestedDay?: string,
): Promise<TimeSheetScreen | null> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      enrolledAt: true,
      cohort: { select: { startDate: true } },
      user: { select: { name: true } },
    },
  });
  if (!student) return null;

  const todayKey = isoDay(new Date());
  const earliestKey = isoDay(earliestLoggableDay(student));

  // A `?day=` that is malformed, in the future, or before the student existed
  // falls back to today rather than 404ing. The URL is a control on this screen,
  // not an identifier — landing on today is what the student meant.
  const asked = requestedDay && dayFromKey(requestedDay) ? requestedDay.trim() : todayKey;
  const selectedKey = asked > todayKey ? todayKey : asked < earliestKey ? earliestKey : asked;
  const selectedDay = dayFromKey(selectedKey);
  if (!selectedDay) return null; // unreachable — both bounds are valid keys

  const [dayRows, earlierRows] = await Promise.all([
    prisma.timeSheetEntry.findMany({
      where: { studentId, day: selectedDay },
      select: { activity: true, minutes: true },
    }),
    // Strictly earlier days, newest first. One query serves both the copy source
    // and the strip: the copy source is simply the first day in it.
    prisma.timeSheetEntry.findMany({
      where: { studentId, day: { lt: selectedDay } },
      orderBy: { day: 'desc' },
      take: RECENT_ROW_LIMIT,
      select: { day: true, activity: true, minutes: true },
    }),
  ]);

  const sheet = sheetFromEntries(dayRows);

  // Group the earlier rows by day, preserving the newest-first order the query
  // returned rather than re-sorting keys as strings.
  const byDay = new Map<string, { activity: DayActivity; minutes: number }[]>();
  for (const row of earlierRows) {
    const key = dayKey(row.day);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }

  const recent: RecentDay[] = [...byDay.entries()]
    .slice(0, RECENT_DAYS)
    .map(([key, rows]) => {
      const daySheet = sheetFromEntries(rows);
      return { key, label: dayLabel(key), sheet: daySheet, totalMinutes: sheetTotal(daySheet) };
    });

  const source = recent[0] ?? null;

  const previousKey = shiftKey(selectedKey, -1);
  const nextKey = shiftKey(selectedKey, 1);

  // Hours per bucket over everything on screen — the day plus the strip. Rounded
  // to one decimal here so the chart is handed numbers, not a formatting job.
  const bucketHours = DAY_ACTIVITIES.map((def) => {
    const minutes =
      sheet[def.activity] + recent.reduce((sum, day) => sum + day.sheet[def.activity], 0);
    return { label: def.label, value: Math.round((minutes / 60) * 10) / 10 };
  }).filter((row) => row.value > 0);

  return {
    firstName: student.user.name.split(' ')[0],
    todayKey,
    earliestKey,
    dayKey: selectedKey,
    dayLabel: dayLabel(selectedKey),
    dayRelative: relativeDayWords(selectedKey, todayKey),
    previousKey: previousKey && previousKey >= earliestKey ? previousKey : null,
    nextKey: nextKey && nextKey <= todayKey ? nextKey : null,
    sheet,
    alreadySaved: dayRows.length > 0,
    copyFrom: source
      ? {
          key: source.key,
          label: source.label,
          relative: relativeDayWords(source.key, todayKey),
          sheet: source.sheet,
        }
      : null,
    recent,
    bucketHours,
  };
}

// --- formatting -------------------------------------------------------------
// Every label leaves this module as a string. `timeZone: 'UTC'` on both is not
// decoration: the key was built from a `@db.Date`, so the instant behind it is
// UTC midnight, and formatting it in a westward local zone would print the day
// before the one the key names.

function dayLabel(key: string): string {
  const date = dayFromKey(key);
  if (!date) return key;
  return date.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/// Computed from the keys rather than from two Dates, because both keys are
/// already the calendar days in question and re-parsing them is where an offset
/// would get its chance.
function relativeDayWords(key: string, todayKey: string): string {
  const gap = daysBetweenKeys(key, todayKey);
  if (gap === null) return '';
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Yesterday';
  if (gap < 0) return 'A future day';
  return `${gap} days ago`;
}
