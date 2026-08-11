import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

import { recordActivity } from '@/lib/activity-log';
import { getSession } from '@/lib/auth';

/**
 * A week of study, entered in one go.
 *
 * The single-entry endpoint next door is for "I did this yesterday". This one
 * backs the spreadsheet grid, where a student fills a screen of rows and saves
 * them together — catching up after an off-campus block, or just doing a week
 * on Sunday evening.
 *
 * **Rows succeed and fail independently, and that is the point.** A transaction
 * would be the wrong shape here: rejecting nine good rows because the tenth
 * names a course the student dropped would make the grid worse than the form it
 * replaced. Each row is attempted in order, and the response says exactly which
 * ones landed, so the grid can clear those and leave the rest on screen with
 * their reasons attached.
 *
 * Every row still goes through `recordActivity`, so a row entered here is
 * validated identically to one typed into the single form or entered by a
 * mentor — there is no bulk path that skips a rule.
 */

/// Enough for a month of catching up, small enough that one request cannot tie
/// up a connection indefinitely.
const MAX_ROWS = 60;

export type BulkActivityRowResult = {
  /// Index in the submitted array, so the client can match a result to a row it
  /// still has on screen.
  index: number;
  ok: boolean;
  error?: string;
  durationMin?: number;
  activityLabel?: string;
  creditedToCourse?: boolean;
};

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json(
      { ok: false, error: 'Sign in as a student to log activities.' },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected a JSON body.' }, { status: 400 });
  }

  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    return NextResponse.json(
      { ok: false, error: 'Expected { entries: [...] }.' },
      { status: 400 },
    );
  }
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, error: 'Nothing to save.' }, { status: 400 });
  }
  if (entries.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: `Save at most ${MAX_ROWS} rows at a time.` },
      { status: 400 },
    );
  }

  const results: BulkActivityRowResult[] = [];

  // Sequential rather than parallel: each row's "has this much of today even
  // happened yet" check reads the clock, and a burst of concurrent writes
  // against the same enrolment would race on the logged-hours increment.
  for (const [index, entry] of entries.entries()) {
    // A throw here used to escape the handler and turn the whole request into a
    // 500, which is the one outcome this endpoint exists to avoid: the rows
    // before it are already written, the rows after it are not, and the per-row
    // verdicts that would say which is which are gone. The client can only fall
    // back to "we cannot tell whether these saved" and ask for a reload. Caught,
    // a failed write is just one row's verdict and the rest of the batch still
    // reports honestly.
    let outcome: Awaited<ReturnType<typeof recordActivity>>;
    try {
      outcome = await recordActivity(session.studentId, entry, { kind: 'student' });
    } catch (error) {
      console.error('[activity/bulk] row failed', { index }, error);
      outcome = { ok: false, error: 'That row could not be saved. Try it again.', status: 500 };
    }

    results.push(
      outcome.ok
        ? {
            index,
            ok: true,
            durationMin: outcome.session.durationMin ?? 0,
            activityLabel: outcome.session.activityLabel,
            creditedToCourse: outcome.session.creditedToCourse,
          }
        : { index, ok: false, error: outcome.error },
    );
  }

  const savedCount = results.filter((row) => row.ok).length;
  if (savedCount > 0) revalidatePath('/student/time-log');

  return NextResponse.json(
    { ok: true, savedCount, failedCount: results.length - savedCount, results },
    // 207 is the honest code for "some of these worked": a blanket 201 hides
    // failures from anything that only checks the status, and a 400 would throw
    // away the rows that did save.
    { status: savedCount === results.length ? 201 : 207 },
  );
}
