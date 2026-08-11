import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { fetchProviderProgress } from '@/lib/providers';

/**
 * Lab check-in / check-out.
 *
 * In production the caller is a badge reader or the lab-PC login shim; the
 * Time Log form is the manual fallback for rooms without that hardware. Both
 * hit this one endpoint, which is why `source` is derived from the mode rather
 * than trusted from the body.
 *
 * Guards here return JSON 401/409 rather than redirecting the way the pages do:
 * a `fetch` that silently follows a redirect to /login gets HTML back and the
 * client can't tell what went wrong.
 */

const bodySchema = z.object({
  action: z.enum(['in', 'out']),
  courseCode: z.string().max(32).optional(),
  module: z.string().max(160).optional(),
  mode: z.enum(['SUPERVISED_LAB', 'INDEPENDENT']).optional(),
});

/// A badge tap knows the room, not the module, so an absent module degrades to
/// a generic label instead of failing the check-in.
const DEFAULT_MODULE = 'Self-study';

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json(
      { ok: false, error: 'Sign in as a student to record lab time.' },
      { status: 401 },
    );
  }
  const studentId = session.studentId;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const open = await prisma.labSession.findFirst({
    where: { studentId, checkOutAt: null },
    orderBy: { checkInAt: 'desc' },
  });

  return body.action === 'in'
    ? checkIn({ studentId, body, open })
    : checkOut({ studentId, open });
}

// ---------------------------------------------------------------------------

type Body = z.infer<typeof bodySchema>;
type OpenSession = Awaited<ReturnType<typeof prisma.labSession.findFirst>>;

async function checkIn({
  studentId,
  body,
  open,
}: {
  studentId: string;
  body: Body;
  open: OpenSession;
}) {
  // One open session at a time — otherwise a forgotten check-out silently
  // inflates every hours figure on the screen.
  if (open) {
    return NextResponse.json(
      {
        ok: false,
        error: `You are already checked in to ${open.courseCode} · ${open.module}. Check out first.`,
        openSessionId: open.id,
      },
      { status: 409 },
    );
  }

  const courseCode = body.courseCode?.trim().toUpperCase();
  if (!courseCode) {
    return NextResponse.json(
      { ok: false, error: 'Pick a course to check in to.' },
      { status: 400 },
    );
  }

  const enrollment = await prisma.enrollment.findUnique({
    where: { studentId_courseCode: { studentId, courseCode } },
    include: { course: { select: { code: true, name: true } } },
  });
  if (!enrollment) {
    return NextResponse.json(
      { ok: false, error: `You are not enrolled in ${courseCode}.` },
      { status: 400 },
    );
  }

  const mode = body.mode ?? 'SUPERVISED_LAB';
  const checkInAt = new Date();
  const progressAtCheckIn = await fetchProviderProgress(studentId, courseCode);

  const created = await prisma.labSession.create({
    data: {
      studentId,
      courseCode,
      module: body.module?.trim() || DEFAULT_MODULE,
      mode,
      // Supervised time is machine-witnessed; independent study is the
      // student's own word until a mentor confirms it.
      source: mode === 'SUPERVISED_LAB' ? 'LAB_PC' : 'SELF_REPORTED',
      checkInAt,
      progressAtCheckIn,
    },
  });

  revalidatePath('/student/time-log');

  return NextResponse.json(
    {
      ok: true,
      action: 'in',
      session: {
        id: created.id,
        courseCode: created.courseCode,
        courseName: enrollment.course.name,
        module: created.module,
        mode: created.mode,
        source: created.source,
        checkInAt: created.checkInAt.toISOString(),
        progressAtCheckIn: created.progressAtCheckIn,
      },
    },
    { status: 201 },
  );
}

async function checkOut({
  studentId,
  open,
}: {
  studentId: string;
  open: OpenSession;
}) {
  if (!open) {
    return NextResponse.json(
      { ok: false, error: 'You are not checked in to anything right now.' },
      { status: 409 },
    );
  }

  const checkOutAt = new Date();
  const durationMin = Math.max(
    1,
    Math.round((checkOutAt.getTime() - open.checkInAt.getTime()) / 60_000),
  );

  // Close the session *before* reading the provider: the adapter credits hours
  // that are already on the record, so this session has to be on the record for
  // its own time to count towards the check-out figure.
  await prisma.labSession.update({
    where: { id: open.id },
    data: { checkOutAt, durationMin },
  });

  const progressAtCheckOut = await fetchProviderProgress(studentId, open.courseCode);
  const progressDeltaPct =
    progressAtCheckOut != null && open.progressAtCheckIn != null
      ? Math.max(round1(progressAtCheckOut - open.progressAtCheckIn), 0)
      : null;

  const closed = await prisma.labSession.update({
    where: { id: open.id },
    data: { progressAtCheckOut, progressDeltaPct },
  });

  // Credit the hours to the enrollment so "self-learning hours logged" on the
  // course cards agrees with the Time Log. Lecture blocks are attendance, not
  // self-learning, so they are excluded. updateMany because a session can
  // outlive an enrolment.
  if (closed.mode !== 'INSTRUCTOR_LED') {
    await prisma.enrollment.updateMany({
      where: { studentId, courseCode: closed.courseCode },
      data: { selfLearningHoursLogged: { increment: round1(durationMin / 60) } },
    });
  }

  revalidatePath('/student/time-log');

  return NextResponse.json({
    ok: true,
    action: 'out',
    session: {
      id: closed.id,
      courseCode: closed.courseCode,
      module: closed.module,
      mode: closed.mode,
      checkInAt: closed.checkInAt.toISOString(),
      checkOutAt: checkOutAt.toISOString(),
      durationMin,
      progressAtCheckIn: closed.progressAtCheckIn,
      progressAtCheckOut: closed.progressAtCheckOut,
      progressDeltaPct: closed.progressDeltaPct,
    },
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
