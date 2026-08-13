import 'server-only';

/**
 * Writing a day sheet.
 *
 * **Re-saving a day replaces it.** A sheet is a statement about one whole day —
 * "this is where my 24 hours went" — not a stream of events, so the second
 * submission for a Tuesday is a *correction* of the first, never an addition to
 * it. Appending would make a corrected day read as 34 hours, and the student
 * would have no way to fix it short of asking someone with database access.
 *
 * The replace is one transaction for the same reason. Between the delete and the
 * insert the day is empty; if the process died there, an unlucky student would
 * find yesterday wiped by the act of correcting it. `$transaction` with an array
 * is the narrowest form that closes that window — the two statements run inside
 * one transaction and neither is visible without the other.
 *
 * The rules this obeys live in `rules.ts` and are checked by the caller, so this
 * module is only the write. It is separated from `queries.ts` the way
 * `activity-log.ts` is separated from `queries.ts`: reads and writes for one
 * feature, but never in the same file.
 */

import { prisma } from '@/lib/db';

import { DAY_ACTIVITIES, dayFromKey, sheetTotal, type DaySheet } from './rules';

export type SaveResult = {
  /// Rows actually written — between 0 and 5.
  rows: number;
  totalMinutes: number;
};

/**
 * Replace one student's sheet for one day.
 *
 * `dayKey` is `YYYY-MM-DD`; the caller has already bounded it against the
 * student's enrolment and validated the sheet. A zero bucket is written as *no
 * row* rather than as a row of zero: absence and zero say the same thing, and
 * five zero rows a day for a student who logs only sleep would be four fifths of
 * this table saying nothing.
 *
 * That also makes clearing a day fall out for free — an empty sheet deletes the
 * day's rows and inserts none, which is how a student undoes a day they filled
 * in wrongly.
 */
export async function saveDaySheet(
  studentId: string,
  dayKey: string,
  sheet: DaySheet,
): Promise<SaveResult> {
  const day = dayFromKey(dayKey);
  if (!day) throw new Error(`saveDaySheet: ${dayKey} is not a calendar day`);

  const rows = DAY_ACTIVITIES.filter((def) => sheet[def.activity] > 0).map((def) => ({
    studentId,
    day,
    activity: def.activity,
    minutes: Math.round(sheet[def.activity]),
  }));

  await prisma.$transaction([
    prisma.timeSheetEntry.deleteMany({ where: { studentId, day } }),
    // `createMany` with an empty array is a valid statement, but skipping it
    // keeps the transaction to the one statement a cleared day actually needs.
    ...(rows.length > 0 ? [prisma.timeSheetEntry.createMany({ data: rows })] : []),
  ]);

  return { rows: rows.length, totalMinutes: sheetTotal(sheet) };
}
