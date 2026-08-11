import 'server-only';

/**
 * Recording a day that has already happened.
 *
 * `/api/checkin` records time that is happening *now* — you check in when you
 * sit down and out when you stop. This is the other half: a student writing down
 * the evening they have already spent, or a mentor entering the two hours a
 * student did in a room with no lab PC in it.
 *
 * Both paths land here rather than in their own route, because the rules that
 * make the number trustworthy must not have two implementations that agree
 * today and drift next month. The judgements themselves live in
 * `activity-rules.ts`, which holds no database and no request; what is left here
 * is the write — validate the shape, resolve the enrolment, insert the row.
 *
 * Nothing here writes progress. Somebody's word about their hours is not
 * evidence that a course provider recorded any completion, so `progressDeltaPct`
 * stays null and every focus and velocity figure on the dashboard keeps meaning
 * what it says.
 */

import { z } from 'zod';

import {
  MINUTES_IN_DAY,
  dayWords,
  earliestLoggableDay,
  loggedAfterDays,
  parseDay,
  standingFor,
  startOfDay,
  type EnteredBy,
} from '@/lib/activity-rules';
import { prisma } from '@/lib/db';
import { ACTIVITY_LABEL, ACTIVITY_MODE, ACTIVITY_ORDER, formatDuration } from '@/lib/reep';
import type { ActivityType, LearningMode } from '@prisma/client';

export type { EnteredBy };

/**
 * Where in the day a hand-entered block is placed **when nobody said**.
 *
 * If the row carries a start time we use it; this is the fallback for rows that
 * only name a day. Timetabled things sit in campus hours and self-directed
 * study in the evening, which is both the likeliest truth and what keeps the
 * "best time of day" profile from being told that every hand-entered hour
 * happened at one implausible moment.
 *
 * It is still only a guess, which is the whole reason the grid now asks for
 * From and To: a real clock time makes that profile evidence rather than an
 * assumption restated.
 */
const START_HOUR: Record<LearningMode, number> = {
  INSTRUCTOR_LED: 10,
  SUPERVISED_LAB: 14,
  INDEPENDENT: 19,
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const activityInputSchema = z.object({
  /// Either a plain YYYY-MM-DD (what the forms send) or a full ISO timestamp.
  date: z.string().min(1, 'Pick the day you are logging.'),
  activity: z.enum(ACTIVITY_ORDER, 'Pick what you were doing.'),
  courseCode: z.string().max(32).optional(),
  durationMin: z
    .number()
    .int('Give the time in whole minutes.')
    .min(5, 'Log at least 5 minutes.')
    .max(720, 'A single entry cannot be longer than 12 hours.'),
  /**
   * What time of day the block started, as minutes from midnight.
   *
   * Optional, and the duration stays the source of truth for *how long* — this
   * only says *when*. A row that carries it is placed at the time it actually
   * happened instead of at the mode's guessed hour, which is what turns the
   * time-of-day profile from an assumption into a measurement. Rows without it
   * keep the old behaviour exactly.
   */
  startMin: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_IN_DAY - 1, 'Give a start time within the day.')
    .optional(),
  note: z.string().max(500).optional(),
});

export type ActivityInput = z.infer<typeof activityInputSchema>;

export type RecordActivityResult =
  | { ok: true; session: RecordedSession }
  | { ok: false; error: string; status: number };

export type RecordedSession = {
  id: string;
  courseCode: string;
  activity: ActivityType;
  activityLabel: string;
  activityNote: string | null;
  module: string;
  mode: LearningMode;
  source: string;
  checkInAt: string;
  checkOutAt: string | null;
  durationMin: number | null;
  creditedToCourse: boolean;
  /// Days between the study and this row being written — 0 for same-day.
  loggedAfterDays: number;
};

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

export async function recordActivity(
  studentId: string,
  raw: unknown,
  enteredBy: EnteredBy,
): Promise<RecordActivityResult> {
  const parsed = activityInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'Invalid request.', 400);
  }

  const { activity, durationMin } = parsed.data;
  const note = parsed.data.note?.trim() || null;
  const courseCode = parsed.data.courseCode?.trim().toUpperCase() || null;

  // "Something else" is the escape hatch for everything the catalogue missed,
  // so without the note the row records nothing at all.
  if (activity === 'OTHER' && !note) {
    return fail('Tell us what you worked on.', 400);
  }

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { enrolledAt: true, cohort: { select: { startDate: true } } },
  });
  if (!student) return fail('That student record no longer exists.', 404);

  const day = parseDay(parsed.data.date);
  if (!day) return fail('Give a valid date.', 400);

  const now = new Date();
  const todayStart = startOfDay(now);

  if (day > todayStart) {
    return fail('You cannot log a day that has not happened yet.', 400);
  }

  const earliest = earliestLoggableDay(student);
  if (day < earliest) {
    return fail(
      `You can only log days from ${dayWords(earliest)} onwards — that is when this cohort started.`,
      400,
    );
  }

  // Today is only partly over, and a block longer than the day so far cannot
  // have happened. Catching it here is what lets the session be placed entirely
  // in the past below.
  const isToday = day.getTime() === todayStart.getTime();
  const elapsedToday = Math.floor((now.getTime() - todayStart.getTime()) / 60_000);
  if (isToday && durationMin > elapsedToday) {
    return fail(
      `Only ${formatDuration(elapsedToday)} has passed today — pick an earlier day or a shorter time.`,
      400,
    );
  }

  // A LabSession always belongs to a course, but the person logging cannot
  // always say which — "read a book on negotiation" belongs to the programme,
  // not a module. When a course is named it must be one the student is enrolled
  // on; when it is not, the row is filed against their most recent enrolment and
  // deliberately earns that enrolment no self-learning credit, so course pages
  // stay truthful.
  let resolvedCourseCode: string;
  let creditEnrollment = false;

  if (courseCode) {
    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_courseCode: { studentId, courseCode } },
      select: { courseCode: true },
    });
    if (!enrollment) {
      return fail(`Not enrolled in ${courseCode}.`, 400);
    }
    resolvedCourseCode = enrollment.courseCode;
    creditEnrollment = true;
  } else {
    const fallback = await prisma.enrollment.findFirst({
      where: { studentId },
      orderBy: { startedAt: 'desc' },
      select: { courseCode: true },
    });
    if (!fallback) {
      return fail(
        'There are no course enrolments yet, so there is nothing to log against.',
        400,
      );
    }
    resolvedCourseCode = fallback.courseCode;
  }

  const mode = ACTIVITY_MODE[activity];
  const standing = standingFor(enteredBy, now);
  const checkInAt = anchorStart({
    day,
    mode,
    durationMin,
    now,
    isToday,
    startMin: parsed.data.startMin,
  });
  const checkOutAt = new Date(checkInAt.getTime() + durationMin * 60_000);

  // A stated start time is taken at its word, so it is the one path that can
  // put a session in the future: "today, 23:00 to 23:45" typed at nine in the
  // evening is a plan, not a record. The duration check above cannot catch it —
  // 45 minutes fits inside a day that is 21 hours old.
  if (checkOutAt > now) {
    return fail('That block has not finished yet — log it once it has.', 400);
  }

  const created = await prisma.labSession.create({
    data: {
      studentId,
      courseCode: resolvedCourseCode,
      // The grid's Module column is what a mentor scans; the words somebody
      // actually typed beat a generic label whenever there are any.
      module: note ?? ACTIVITY_LABEL[activity],
      activity,
      activityNote: note,
      mode,
      checkInAt,
      checkOutAt,
      durationMin,
      progressDeltaPct: null,
      ...standing,
    },
  });

  // Mirrors the check-out path in /api/checkin: lecture blocks are attendance,
  // not self-learning, so they earn no hours here either. updateMany because a
  // session can outlive an enrolment.
  const credited = creditEnrollment && mode !== 'INSTRUCTOR_LED';
  if (credited) {
    await prisma.enrollment.updateMany({
      where: { studentId, courseCode: resolvedCourseCode },
      data: { selfLearningHoursLogged: { increment: round1(durationMin / 60) } },
    });
  }

  return {
    ok: true,
    session: {
      id: created.id,
      courseCode: created.courseCode,
      activity: created.activity,
      activityLabel: ACTIVITY_LABEL[created.activity],
      activityNote: created.activityNote,
      module: created.module,
      mode: created.mode,
      source: created.source,
      checkInAt: created.checkInAt.toISOString(),
      checkOutAt: created.checkOutAt?.toISOString() ?? null,
      durationMin: created.durationMin,
      creditedToCourse: credited,
      loggedAfterDays: loggedAfterDays(created),
    },
  };
}

// ---------------------------------------------------------------------------

function fail(error: string, status: number): RecordActivityResult {
  return { ok: false, error, status };
}

/// A hand-entered block must never sit in the future, so today's entry is
/// pinned to end at this moment rather than at its nominal hour.
function anchorStart({
  day,
  mode,
  durationMin,
  now,
  isToday,
  startMin,
}: {
  day: Date;
  mode: LearningMode;
  durationMin: number;
  now: Date;
  isToday: boolean;
  startMin?: number;
}): Date {
  // Somebody told us when. Nothing here second-guesses it — the caller checks
  // that the block has finished, and a session that ran past midnight simply
  // ends on the following day, which is what happened.
  if (startMin != null) {
    const stated = new Date(day);
    stated.setHours(0, startMin, 0, 0);
    return stated;
  }

  const start = new Date(day);
  start.setHours(START_HOUR[mode], 0, 0, 0);
  if (!isToday) return start;

  const latest = new Date(now.getTime() - durationMin * 60_000);
  return start.getTime() <= latest.getTime() ? start : latest;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
