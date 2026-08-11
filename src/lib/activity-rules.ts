/**
 * What a hand-entered hour is worth, and which days one may be entered for.
 *
 * These are the judgements behind the time log — how far back a student may
 * reach, when an entry stops being contemporaneous, what standing a row written
 * by a mentor has that one written by a student does not. They are separated
 * from the write in `activity-log.ts` for the same reason `progress.ts` is
 * separated from the pages: a rule that takes plain values and returns plain
 * values can be read, argued with and tested on its own, and there is then
 * exactly one definition of it.
 *
 * Nothing here touches the database or the request, so unlike `activity-log.ts`
 * this module carries no `server-only` and runs anywhere.
 */

import type { CheckInSource } from '@prisma/client';

/**
 * How long after the fact an entry has to be written before it is worth
 * flagging. Logging last night's reading over breakfast is the normal case and
 * marking it would make the mark meaningless; a fortnight of study entered in
 * one sitting is a different kind of claim, and a mentor should be able to see
 * which one they are reading.
 */
export const LATE_ENTRY_DAYS = 2;

/**
 * Who is writing the row.
 *
 * A student's own account of their evening is `SELF_REPORTED` and unconfirmed.
 * A mentor or director entering it has looked at something — a register, a
 * conversation — so it is `MANUAL` and confirmed, and it carries a line naming
 * who entered it so the claim stays attributable after they have moved on.
 */
export type EnteredBy =
  | { kind: 'student' }
  | { kind: 'staff'; label: string };

export type Standing = {
  source: CheckInSource;
  mentorConfirmed: boolean;
  /// The audit line, or null when the person logging is the subject.
  notes: string | null;
};

/**
 * The standing of a row, from who wrote it.
 *
 * This is the *whole* difference between the student's form and the mentor's.
 * Keeping it in one function is what stops the two paths drifting into "the
 * mentor's entry also counts as progress" or "the student's is confirmed too",
 * either of which would quietly change what every focus figure means.
 */
export function standingFor(enteredBy: EnteredBy, on: Date): Standing {
  if (enteredBy.kind === 'student') {
    return { source: 'SELF_REPORTED', mentorConfirmed: false, notes: null };
  }
  return {
    source: 'MANUAL',
    mentorConfirmed: true,
    notes: `Entered by ${enteredBy.label} on ${dayWords(on)} on the student's behalf.`,
  };
}

// ---------------------------------------------------------------------------
// The window a day may fall in
// ---------------------------------------------------------------------------

export type StudentWindow = {
  enrolledAt: Date;
  cohort: { startDate: Date };
};

/**
 * The earliest day a student may log.
 *
 * There used to be a flat 30-day floor, on the reasoning that an older memory
 * is not worth much. That is true of the *detail* and false of the *hours*: a
 * student back from an internship with six weeks of unlogged evenings was
 * simply unable to record them, and the programme lost the data rather than
 * gaining accuracy. The real floor is the one fact that cannot be argued with —
 * nobody studied for this programme before they were on it — so the bound is the
 * earlier of their enrolment and their cohort's start, and anything written long
 * after the fact is marked rather than refused.
 */
export function earliestLoggableDay(student: StudentWindow): Date {
  const enrolled = startOfDay(student.enrolledAt);
  const cohortStart = startOfDay(student.cohort.startDate);
  return enrolled <= cohortStart ? enrolled : cohortStart;
}

/// How long after the studying a row was written. Negative values are clamped:
/// a session that ran past midnight is not evidence of time travel.
export function loggedAfterDays(session: { checkInAt: Date; createdAt: Date }): number {
  const gap = startOfDay(session.createdAt).getTime() - startOfDay(session.checkInAt).getTime();
  return Math.max(0, Math.round(gap / 86_400_000));
}

/// Whether a row should carry the "entered later" mark on a grid or a timeline.
export function isBackdated(session: { checkInAt: Date; createdAt: Date }): boolean {
  return loggedAfterDays(session) > LATE_ENTRY_DAYS;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Read a calendar day out of a request in *server-local* time.
 *
 * `new Date('2026-08-04')` is midnight UTC, which is the previous evening in
 * half the world — building the day from its parts keeps a logged Tuesday in
 * Tuesday's bucket on every screen that groups by day.
 */
export function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const date = Number(match[3]);
    const day = new Date(year, month, date);
    // Date rolls 2026-02-31 forward rather than failing, so round-trip it.
    if (day.getFullYear() !== year || day.getMonth() !== month || day.getDate() !== date) {
      return null;
    }
    return day;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return null;
  return startOfDay(parsedDate);
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/// `YYYY-MM-DD` in server-local time — what an `<input type="date">` wants, and
/// what `parseDay` reads back without a timezone shifting the day.
export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function dayWords(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Clock times
// ---------------------------------------------------------------------------

/// Minutes in a day. A clock time is stored as minutes from midnight rather
/// than as a Date, because it is a time *within* a day the row already names —
/// pairing it with a date too early is how a timezone gets a chance to move it.
export const MINUTES_IN_DAY = 24 * 60;

/**
 * `"HH:MM"` to minutes from midnight, or null if it is not a time.
 *
 * Accepts exactly what `<input type="time">` produces, including the `HH:MM:SS`
 * some browsers emit when the step allows seconds — the seconds are dropped
 * rather than rejected, because a student who typed a valid time should not be
 * told it is invalid by their choice of browser.
 */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/// Minutes from midnight back to `"HH:MM"`, which is also the only format
/// `<input type="time">` will accept as a value.
export function clockLabel(minutes: number): string {
  const wrapped = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/**
 * How long a session that ran from one clock time to another lasted.
 *
 * An end before the start means the session crossed midnight — 22:00 to 00:30
 * is a real and unremarkable way to study — so it wraps rather than returning a
 * negative. That does make a transposed pair (14:00 to 13:00) come back as 23
 * hours instead of an error, which is deliberate: the caller's existing
 * "at most 12 hours" rule already refuses it, and refusing it there gives the
 * student one rule to understand rather than two.
 *
 * Equal times are zero, not a full day: nobody means "24 hours" by typing the
 * same time twice, and the minimum-length rule then rejects it.
 */
export function minutesBetween(fromMin: number, toMin: number): number {
  if (toMin === fromMin) return 0;
  return toMin > fromMin ? toMin - fromMin : toMin + MINUTES_IN_DAY - fromMin;
}
