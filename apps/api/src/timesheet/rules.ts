/**
 * What a day is made of, and the arithmetic that keeps a day sheet honest.
 *
 * The request behind this module is one sentence long — *"must be easy to fill:
 * 5 activities only"* — and every judgement here exists to protect that
 * sentence from the natural drift of a tracking product. Five buckets is not a
 * starting point to be extended: it is the reason a student fills the sheet at
 * all, so `DAY_ACTIVITIES` is a fixed list of exactly five, the test beside this
 * file asserts that length, and a sixth bucket therefore cannot be added by
 * accident — only by someone deleting an assertion that says why not.
 *
 * These five are deliberately *not* `ActivityType`, which has fifteen values and
 * answers a different question: what kind of study a block was, which is what
 * pace, focus quality and the LOW_FOCUS_QUALITY alert read. This one answers
 * "where did the day go?", including the two thirds of it that are not study at
 * all. The two tables live side by side and neither replaces the other.
 *
 * Validation follows from the same sentence. A total over 24 hours is an
 * arithmetic mistake and is blocked, because the sheet would otherwise record a
 * day that did not happen. A total *under* 24 hours is only ever warned about:
 * a student who logs six hours and stops has told us something true, and a sheet
 * that refuses to save until it balances is a sheet nobody fills — they either
 * abandon it or pad it, and padded numbers are worse than missing ones.
 *
 * Nothing here touches the database or the request, so — like `activity-rules.ts`
 * next door — this module carries no `server-only` and can be imported by the
 * client component, the route handler and the test alike. That is the whole
 * point of splitting it out.
 */

import type { DayActivity } from '@prisma/client';

// One definition of the number, shared with the session log rather than
// restated: a day is 1440 minutes on both screens or the two disagree.
const MINUTES_IN_DAY = 1440; // minutes in a day, shared constant

export { MINUTES_IN_DAY };

/**
 * The increment every control on the sheet moves by.
 *
 * Thirty minutes is the coarsest step that can still describe a real day — a
 * 90-minute lecture, a 7½-hour night — and coarse is the point: at 5-minute
 * granularity the student is being asked to *remember* rather than to
 * *estimate*, and the sheet stops taking thirty seconds to fill.
 */
export const STEP_MINUTES = 30;

/// One of the five buckets, as the UI needs it.
export type DayActivityDef = {
  /// The value written to `TimeSheetEntry.activity`.
  activity: DayActivity;
  /// The spec's own wording, verbatim. Not "Sleep", not "Rest" — the words the
  /// programme asked for are the words the student was told to expect.
  label: string;
  /// One line under the label, so nobody has to guess which bucket a thing
  /// belongs in. The boundary between coursework and skilling is the only one
  /// students actually ask about, so those two say it explicitly.
  hint: string;
};

/**
 * The five buckets, in the order the spec lists them.
 *
 * Sleeping leads because it is the largest and least ambiguous number in the
 * day, so it anchors the remaining-hours readout immediately; leisure follows
 * because naming it early stops students treating the sheet as a study log they
 * have to justify. The three study buckets then sit together at the bottom.
 *
 * Exactly five. See the module comment, and `rules.test.ts`.
 */
export const DAY_ACTIVITIES: readonly DayActivityDef[] = [
  {
    activity: 'SLEEPING',
    label: 'Sleeping',
    hint: 'Including naps',
  },
  {
    activity: 'LEISURE',
    label: 'Engaged in leisure',
    hint: 'Meals, travel, family, phone, rest — everything that is not the four below',
  },
  {
    activity: 'LECTURES',
    label: 'Engaged in lectures',
    hint: 'Timetabled classes, seminars, guest sessions',
  },
  {
    activity: 'COURSEWORK',
    label: 'Engaged in coursework',
    hint: 'Assignments, reading, revision — work your course set you',
  },
  {
    activity: 'SKILLING',
    label: 'Engaged in skilling',
    hint: 'Excel, Power BI, certifications, mock interviews — work you chose',
  },
] as const;

/// A whole day, as minutes against each bucket. Every bucket is always present;
/// "nothing" is 0, never a missing key, so no reader has to handle undefined.
export type DaySheet = Record<DayActivity, number>;

export function emptySheet(): DaySheet {
  return {
    SLEEPING: 0,
    LEISURE: 0,
    LECTURES: 0,
    COURSEWORK: 0,
    SKILLING: 0,
  };
}

/**
 * The stored rows for one day, as a sheet.
 *
 * A bucket with no row is zero rather than absent — see `DaySheet`. Duplicate
 * activities are summed rather than last-one-wins: the unique key on
 * `(student, day, activity)` means they cannot occur, and if they somehow do,
 * losing minutes silently is the worse of the two failures.
 */
export function sheetFromEntries(
  entries: readonly { activity: DayActivity; minutes: number }[],
): DaySheet {
  const sheet = emptySheet();
  for (const entry of entries) {
    sheet[entry.activity] += entry.minutes;
  }
  return sheet;
}

export function sheetTotal(sheet: DaySheet): number {
  return DAY_ACTIVITIES.reduce((sum, def) => sum + (sheet[def.activity] || 0), 0);
}

/// How much of the 24 hours is still unaccounted for. Negative when the sheet
/// has been over-filled, which is what the readout turns red on.
export function remainingMinutes(sheet: DaySheet): number {
  return MINUTES_IN_DAY - sheetTotal(sheet);
}

export function sheetsEqual(a: DaySheet, b: DaySheet): boolean {
  return DAY_ACTIVITIES.every((def) => (a[def.activity] || 0) === (b[def.activity] || 0));
}

/**
 * The next value up or down from where a bucket currently sits.
 *
 * It snaps to the grid rather than adding 30 to whatever is there, so a value
 * that arrived from somewhere else — a sheet seeded with 437 minutes, a row a
 * script wrote — is pulled onto the half-hours by the first tap instead of
 * carrying its odd 7 minutes forever. Up from 437 is 450, down from 437 is 420.
 *
 * Values already on the grid behave the obvious way: up from 450 is 480.
 */
export function stepMinutes(current: number, direction: 1 | -1): number {
  const safe = Number.isFinite(current) ? Math.max(0, Math.round(current)) : 0;
  const next =
    direction === 1
      ? Math.floor(safe / STEP_MINUTES) * STEP_MINUTES + STEP_MINUTES
      : Math.ceil(safe / STEP_MINUTES) * STEP_MINUTES - STEP_MINUTES;
  return Math.min(MINUTES_IN_DAY, Math.max(0, next));
}

export type SheetVerdict = {
  /// Whether the sheet may be written. False *only* for a day that does not fit
  /// in a day — see the module comment.
  ok: boolean;
  /// Why it may not be saved. Null whenever `ok`.
  error: string | null;
  /// Said out loud but never in the way — an unbalanced day is a normal thing
  /// to record.
  warning: string | null;
  totalMinutes: number;
  /// Signed: negative means over-filled.
  remainingMinutes: number;
};

/**
 * Whether this sheet can be written, and what to say about it either way.
 *
 * The asymmetry is the decision: over 24 hours blocks, under 24 hours warns.
 * A blank sheet is deliberately savable — it is how a student corrects a day
 * they filled in wrongly, and the write path treats it as "clear this day"
 * rather than as an error to argue with.
 */
export function validateSheet(sheet: DaySheet): SheetVerdict {
  const total = sheetTotal(sheet);
  const remaining = MINUTES_IN_DAY - total;

  if (DAY_ACTIVITIES.some((def) => !Number.isFinite(sheet[def.activity]) || sheet[def.activity] < 0)) {
    return {
      ok: false,
      error: 'A bucket cannot hold a negative amount of time.',
      warning: null,
      totalMinutes: total,
      remainingMinutes: remaining,
    };
  }

  if (remaining < 0) {
    return {
      ok: false,
      error: `That is ${durationWords(-remaining)} more than a day holds. Take it off a bucket before saving.`,
      warning: null,
      totalMinutes: total,
      remainingMinutes: remaining,
    };
  }

  if (total === 0) {
    return {
      ok: true,
      error: null,
      warning: 'Nothing is filled in — saving this empties the day.',
      totalMinutes: total,
      remainingMinutes: remaining,
    };
  }

  if (remaining > 0) {
    return {
      ok: true,
      error: null,
      // Phrased as a fact, not as a correction. The student may genuinely not
      // know where four hours went, and saying so is more useful than a blank.
      warning: `${durationWords(remaining)} of the day is unaccounted for. Save anyway if that is right.`,
      totalMinutes: total,
      remainingMinutes: remaining,
    };
  }

  return { ok: true, error: null, warning: null, totalMinutes: total, remainingMinutes: remaining };
}

/**
 * Minutes as words, for a sentence rather than a table.
 *
 * `formatDuration` in `reep.ts` renders "7h 30m", which is right in a grid cell
 * and wrong mid-sentence — "That is 2h 30m more than a day holds" reads as
 * markup. This spells the units out and drops a zero minutes entirely.
 */
export function durationWords(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${hours}h ${mins}m`;
}

/// The live counter the acceptance bar names. Kept here rather than in the
/// component so the wording is the same in the button's aria-live region, in the
/// heading, and in any test that asserts on it.
export function remainingLabel(sheet: DaySheet): string {
  const remaining = remainingMinutes(sheet);
  if (remaining === 0) return 'The full 24 hours accounted for';
  if (remaining < 0) return `${durationWords(-remaining)} over 24`;
  return `${durationWords(remaining)} remaining of 24`;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/**
 * `TimeSheetEntry.day` is a `@db.Date`, which Prisma reads back as UTC midnight.
 *
 * So the key is built from the *UTC* parts, unlike `isoDay` in
 * `activity-rules.ts`, which formats a local instant. Using the local formatter
 * on a value from that column moves the whole sheet a day backwards for anyone
 * west of Greenwich, and — worse — only for them, which is the kind of bug that
 * is never reproduced on the machine it is reported to.
 */
export function dayKey(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/// The inverse: a `YYYY-MM-DD` key as the UTC-midnight instant the column
/// stores. Returns null for anything that is not a real calendar date, so a
/// hand-typed `?day=` cannot become an `Invalid Date` in a query.
export function dayFromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const value = new Date(Date.UTC(year, month, date));
  // Date rolls 2026-02-31 forward rather than failing, so round-trip it.
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month ||
    value.getUTCDate() !== date
  ) {
    return null;
  }
  return value;
}

/// Days between two `YYYY-MM-DD` keys. String keys rather than Dates because
/// every day on this screen is already a key, and re-parsing them into instants
/// is where a timezone gets its chance.
export function daysBetweenKeys(from: string, to: string): number | null {
  const a = dayFromKey(from);
  const b = dayFromKey(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function shiftKey(key: string, days: number): string | null {
  const date = dayFromKey(key);
  if (!date) return null;
  return dayKey(new Date(date.getTime() + days * 86_400_000));
}

// ---------------------------------------------------------------------------
// Reading a request body
// ---------------------------------------------------------------------------

export type ParsedSubmission =
  | { ok: true; dayKey: string; sheet: DaySheet }
  | { ok: false; error: string };

/**
 * A posted sheet, checked without the database.
 *
 * Pure so the route handler is left with only the things it alone can do —
 * authenticate, bound the day against the student's enrolment, write — and so
 * the shape rules are testable without a request. Unknown activity keys are
 * *ignored* rather than rejected: the five buckets are the contract, and a
 * client that sends a sixth has a bug the server should not adopt.
 */
export function parseSubmission(raw: unknown): ParsedSubmission {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Expected a JSON object.' };
  }

  const body = raw as { day?: unknown; minutes?: unknown };

  if (typeof body.day !== 'string' || dayFromKey(body.day) === null) {
    return { ok: false, error: 'Expected a day as YYYY-MM-DD.' };
  }

  if (typeof body.minutes !== 'object' || body.minutes === null) {
    return { ok: false, error: 'Expected { minutes: { … } } with the five buckets.' };
  }

  const minutes = body.minutes as Record<string, unknown>;
  const sheet = emptySheet();

  for (const def of DAY_ACTIVITIES) {
    const value = minutes[def.activity];
    if (value === undefined || value === null) continue; // absent means zero
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `${def.label} must be a number of minutes.` };
    }
    if (value < 0) {
      return { ok: false, error: `${def.label} cannot be negative.` };
    }
    if (value > MINUTES_IN_DAY) {
      return { ok: false, error: `${def.label} cannot be more than 24 hours.` };
    }
    sheet[def.activity] = Math.round(value);
  }

  return { ok: true, dayKey: body.day.trim(), sheet };
}
