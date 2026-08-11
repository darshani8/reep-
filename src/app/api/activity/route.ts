import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

import { recordActivity } from '@/lib/activity-log';
import { getSession } from '@/lib/auth';

/**
 * A student logging their own day.
 *
 * Every rule that makes the row trustworthy lives in `@/lib/activity-log`, which
 * the mentor's "log on a student's behalf" action also calls — so the two paths
 * cannot validate a date differently or credit an enrolment differently. What is
 * left here is the part that is genuinely about being an HTTP endpoint: who is
 * asking, is the body JSON, and which page needs re-rendering afterwards.
 */

export async function POST(request: Request) {
  // JSON rather than a redirect: a fetch that follows a redirect to /login gets
  // HTML back and the form cannot tell the student what went wrong.
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json(
      { ok: false, error: 'Sign in as a student to log an activity.' },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected a JSON body.' }, { status: 400 });
  }

  const result = await recordActivity(session.studentId, raw, { kind: 'student' });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  revalidatePath('/student/time-log');

  return NextResponse.json({ ok: true, session: result.session }, { status: 201 });
}
