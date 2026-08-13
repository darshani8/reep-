import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { loggableWindow } from '@/lib/timesheet/queries';
import { parseSubmission, validateSheet } from '@/lib/timesheet/rules';
import { saveDaySheet } from '@/lib/timesheet/save';

/**
 * The five-bucket day sheet, saved.
 *
 * Its own route, deliberately **not** an extension of `/api/activity/bulk`.
 * That endpoint writes `LabSession` rows against the fifteen-value
 * `ActivityType`, and those rows drive pace, focus quality, the
 * LOW_FOCUS_QUALITY alert and the exports. The sheet answers a different
 * question with a different vocabulary and must not be able to move any of
 * those numbers — sharing a route is the first step towards sharing a write,
 * and then "sleeping" is quietly a study activity.
 *
 * The other difference is the shape of the write. `/api/activity/bulk` returns
 * per-row verdicts because its rows are independent; here the five buckets are
 * one statement about one day, so this is a single all-or-nothing save and one
 * verdict. See `save.ts` for why the replace is a transaction.
 *
 * The bounds are the ones the session log already uses — no future days, nothing
 * before the student was enrolled — read through `loggableWindow` rather than
 * restated, so the two screens cannot disagree about which days exist.
 */

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json(
      { ok: false, error: 'Sign in as a student to save a time sheet.' },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected a JSON body.' }, { status: 400 });
  }

  const parsed = parseSubmission(raw);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // Named `bounds` rather than `window`, which is a global this file would then
  // be shadowing — harmless on the server, confusing to read.
  const bounds = await loggableWindow(session.studentId);
  if (!bounds) {
    return NextResponse.json(
      { ok: false, error: 'That student record no longer exists.' },
      { status: 404 },
    );
  }

  // Both are `YYYY-MM-DD`, so a string comparison *is* the date comparison —
  // and it is the one comparison no timezone can shift.
  if (parsed.dayKey > bounds.todayKey) {
    return NextResponse.json(
      { ok: false, error: 'That day has not happened yet.' },
      { status: 400 },
    );
  }
  if (parsed.dayKey < bounds.earliestKey) {
    return NextResponse.json(
      { ok: false, error: 'That day is before you joined the programme.' },
      { status: 400 },
    );
  }

  // The one thing that blocks a save. Under 24 hours only warns — a sheet that
  // refuses to save is a sheet nobody fills — and the warning travels back with
  // the success so the screen can repeat it without recomputing it.
  const verdict = validateSheet(parsed.sheet);
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.error }, { status: 400 });
  }

  let saved: Awaited<ReturnType<typeof saveDaySheet>>;
  try {
    saved = await saveDaySheet(session.studentId, parsed.dayKey, parsed.sheet);
  } catch (error) {
    console.error('[timesheet] save failed', { day: parsed.dayKey }, error);
    return NextResponse.json(
      { ok: false, error: 'That did not save. Try again.' },
      { status: 500 },
    );
  }

  revalidatePath('/student/time-log');

  return NextResponse.json({
    ok: true,
    day: parsed.dayKey,
    rows: saved.rows,
    totalMinutes: saved.totalMinutes,
    warning: verdict.warning,
  });
}
