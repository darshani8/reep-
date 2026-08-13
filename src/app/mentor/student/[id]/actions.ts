'use server';

/**
 * The four buttons on the mentor action bar.
 *
 * Every one of them writes a MentorNote, because the note log *is* the audit
 * trail: a student who is flagged or nudged can be shown exactly what was
 * recorded about them and when. Nothing here fires an email or a push — those
 * belong to a notification service, and the note is the durable record either
 * way.
 */

import { revalidatePath } from 'next/cache';

import { recordActivity } from '@/lib/activity-log';
import { requireMentor, type SessionPayload } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canSeeStudent, mentorScope, type MentorScope } from '@/lib/mentor-scope';
import { addDays, formatDuration } from '@/lib/reep';
import type { MentorAction, Role } from '@prisma/client';

export type MentorActionResult = { ok: boolean; message: string };

const NOTE_MAX_CHARS = 2000;

/**
 * The scope a write is allowed to run under, or nothing at all.
 *
 * `{ kind: 'none' }` throws rather than returning `{ ok: false }` on purpose. A
 * returned message is the vocabulary of "you picked the wrong student", and the
 * action bar renders it as advice to the mentor. A MENTOR session with no
 * `Mentor` row is not that: it is an account that should never have reached a
 * write path, and it must fail loudly enough that somebody fixes the account
 * rather than quietly enough that it looks like a permissions quirk.
 */
function writeScope(session: SessionPayload): Exclude<MentorScope, { kind: 'none' }> {
  const scope = mentorScope(session);
  if (scope.kind === 'none') {
    throw new Error(
      'This mentor account has no mentor group, so no student is in scope for it.',
    );
  }
  return scope;
}

type Author =
  | { ok: false; message: string }
  | { ok: true; mentorId: string; studentName: string };

/**
 * Work out who is writing, and whether they are allowed to.
 *
 * A mentor may only act on their own mentees. A director or admin has
 * programme-wide scope but carries no mentor row, so their note is attributed
 * to the student's assigned mentor — the person who actually has to follow it
 * up. Which of those two a caller is, is a question about their *role*: asking
 * whether the session carries a `mentorId` put every mentor account with no
 * `Mentor` row on the director path, holding the pen over the whole programme.
 * Render-time gating is not a security boundary; this runs on every call.
 */
async function resolveAuthor(studentId: string): Promise<Author> {
  const session = await requireMentor();
  const scope = writeScope(session);

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { mentorId: true, user: { select: { name: true } } },
  });
  if (!student) {
    return { ok: false, message: 'That student record no longer exists.' };
  }

  if (!canSeeStudent(session, student.mentorId)) {
    return { ok: false, message: 'That student is not in your mentor group.' };
  }

  // A mentor's note is their own; a director's or admin's is attributed to the
  // student's assigned mentor. Read off the scope rather than off
  // `session.mentorId ?? student.mentorId`, so the attribution follows the same
  // role decision as the permission above it.
  const mentorId = scope.kind === 'mentees' ? scope.mentorId : student.mentorId;
  if (!mentorId) {
    return {
      ok: false,
      message: 'This student has no assigned mentor to attribute the note to.',
    };
  }

  return { ok: true, mentorId, studentName: student.user.name };
}

async function writeNote(
  studentId: string,
  mentorId: string,
  linkedAction: MentorAction,
  noteText: string,
  /// When the conversation happened, if it was not now. Left off by the one-tap
  /// actions, which are recording something that is happening as they are
  /// clicked, and `meetingAt` defaults to now in the schema for exactly them.
  meetingAt?: Date,
) {
  await prisma.mentorNote.create({
    data: { studentId, mentorId, linkedAction, noteText, ...(meetingAt ? { meetingAt } : {}) },
  });
}

/// How far either side of now a meeting timestamp is believable. A note about a
/// conversation two years ago, or one booked for 2206, is a typo in a
/// `datetime-local` field rather than a record anybody meant to write.
const MEETING_WINDOW_DAYS = 365;

/**
 * Read the meeting timestamp off the form.
 *
 * `datetime-local` submits `YYYY-MM-DDTHH:mm` with no offset, which JavaScript
 * parses as *local* time — which is what is wanted here, since the mentor typed
 * a wall-clock time in the room they were sitting in.
 *
 * An empty field is not an error: it means "now", which is what the column
 * defaults to. A field with something unparseable in it is an error, because
 * silently filing it as now would date the conversation wrongly and there would
 * be nothing on the screen to say so.
 */
function parseMeetingAt(
  raw: string,
  now: Date,
): { ok: true; meetingAt?: Date } | { ok: false; message: string } {
  const value = raw.trim();
  if (!value) return { ok: true };

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, message: 'That is not a date and time. Leave it alone to record now.' };
  }

  const windowMs = MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (Math.abs(parsed.getTime() - now.getTime()) > windowMs) {
    return {
      ok: false,
      message: `Meetings are recorded within a year either side of today — check the year on that date.`,
    };
  }

  return { ok: true, meetingAt: parsed };
}

function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

// ---------------------------------------------------------------------------

export async function flagForFollowUp(studentId: string): Promise<MentorActionResult> {
  const author = await resolveAuthor(studentId);
  if (!author.ok) return author;

  await writeNote(
    studentId,
    author.mentorId,
    'FLAGGED',
    'Flagged for follow-up from the Focus Log — pace against the expected curve and the recent check-in pattern both need intervention.',
  );

  revalidatePath(`/mentor/student/${studentId}`);
  return {
    ok: true,
    message: `${firstName(author.studentName)} flagged. The note is on the timeline below.`,
  };
}

export async function sendNudge(studentId: string): Promise<MentorActionResult> {
  const author = await resolveAuthor(studentId);
  if (!author.ok) return author;

  await writeNote(
    studentId,
    author.mentorId,
    'NUDGE_SENT',
    'Nudge sent — asked to resume lab check-ins this week and close the gap against the expected certification pace.',
  );

  revalidatePath(`/mentor/student/${studentId}`);
  return {
    ok: true,
    message: `Nudge logged for ${firstName(author.studentName)}.`,
  };
}

export async function scheduleOneOnOne(studentId: string): Promise<MentorActionResult> {
  const author = await resolveAuthor(studentId);
  if (!author.ok) return author;

  const meetingAt = nextOneOnOneSlot(new Date());
  const when = meetingAt.toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // The note and the calendar entry are one fact, so they land together or not
  // at all — a note promising a meeting that was never scheduled is worse than
  // no note.
  await prisma.$transaction([
    prisma.mentorNote.create({
      data: {
        studentId,
        mentorId: author.mentorId,
        linkedAction: 'ONE_ON_ONE_SCHEDULED',
        noteText: `1:1 review scheduled for ${when} to walk through the pace gap and agree a weekly hour commitment.`,
        // The one action whose meeting is in the future. `meetingAt` is the slot,
        // `createdAt` is now, and the note log shows both — which is how a
        // mentor scanning it can tell a booking from a write-up.
        meetingAt,
      },
    }),
    prisma.scheduleItem.create({
      data: {
        studentId,
        type: 'MENTOR_MEETING',
        title: '1:1 mentor review — REEP pace check',
        startsAt: meetingAt,
        location: 'Mentor Cabin, MBA Block',
      },
    }),
  ]);

  revalidatePath(`/mentor/student/${studentId}`);
  return { ok: true, message: `1:1 scheduled for ${when}. It is on the student's Upcoming list.` };
}

export async function addNote(
  _prev: MentorActionResult | null,
  formData: FormData,
): Promise<MentorActionResult> {
  // FormData is untrusted even though the form only renders on a guarded page.
  const studentId = String(formData.get('studentId') ?? '').trim();
  const noteText = String(formData.get('noteText') ?? '').trim();

  if (!studentId) return { ok: false, message: 'Missing student reference.' };
  if (noteText.length < 3) return { ok: false, message: 'Write the note before saving it.' };
  if (noteText.length > NOTE_MAX_CHARS) {
    return { ok: false, message: `Notes are capped at ${NOTE_MAX_CHARS} characters.` };
  }

  const now = new Date();
  const meeting = parseMeetingAt(String(formData.get('meetingAt') ?? ''), now);
  if (!meeting.ok) return meeting;

  const author = await resolveAuthor(studentId);
  if (!author.ok) return author;

  await writeNote(studentId, author.mentorId, 'NONE', noteText, meeting.meetingAt);

  revalidatePath(`/mentor/student/${studentId}`);

  // Say which meeting was recorded whenever it is not simply now, so a mentor
  // who mistyped the date finds out from the confirmation rather than from the
  // log three weeks later.
  const when = meeting.meetingAt;
  if (!when || Math.abs(when.getTime() - now.getTime()) < 60_000) {
    return { ok: true, message: 'Note saved.' };
  }
  return {
    ok: true,
    message: `Note saved against your meeting on ${when.toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })}.`,
  };
}

// ---------------------------------------------------------------------------
// Logging time on a student's behalf
// ---------------------------------------------------------------------------

/**
 * How the person entering the row is named on it.
 *
 * The audit line has to survive the author leaving, so it records what they were
 * as well as who — "Prof. Rakesh Iyer" a year later is a name; "Prof. Rakesh
 * Iyer (Faculty Mentor)" is a reason the row exists.
 */
const ROLE_SUFFIX: Partial<Record<Role, string>> = {
  MENTOR: 'Faculty Mentor',
  DIRECTOR: 'Programme Director',
  ADMIN: 'Programme Office',
};

type Logger =
  | { ok: false; message: string }
  | { ok: true; label: string; studentName: string };

/**
 * A lighter guard than `resolveAuthor`.
 *
 * A mentor may only log for their own mentees; a director or admin has
 * programme-wide scope. Unlike a note, this does not need the student to have a
 * mentor at all — the hours a student has already put in are a fact about them,
 * not about whose caseload they are on, and refusing to record them until
 * somebody is assigned would lose real data for an administrative reason.
 */
async function resolveLogger(studentId: string): Promise<Logger> {
  const session = await requireMentor();
  writeScope(session);

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { mentorId: true, user: { select: { name: true } } },
  });
  if (!student) {
    return { ok: false, message: 'That student record no longer exists.' };
  }

  // The guard that used to sit here read a missing mentor group as programme
  // scope, so a MENTOR account with no `Mentor` row could write lab hours onto
  // any student in the programme. Hours are a claim about a named student, and
  // once written they move that student's pace, focus score and alerts.
  if (!canSeeStudent(session, student.mentorId)) {
    return { ok: false, message: 'That student is not in your mentor group.' };
  }

  const suffix = ROLE_SUFFIX[session.role];
  return {
    ok: true,
    label: suffix ? `${session.name} (${suffix})` : session.name,
    studentName: student.user.name,
  };
}

/**
 * Record study time a student did but never logged.
 *
 * The student's own form and this one write through the same
 * `recordActivity()`, so a mentor cannot enter a day the student would have been
 * refused, and the hours land in the same place with the same crediting rules.
 * What differs is standing: the row is `MANUAL` rather than `SELF_REPORTED`,
 * arrives already mentor-confirmed, and carries a line naming who entered it.
 */
export async function logActivityForStudent(input: {
  studentId: string;
  date: string;
  activity: string;
  courseCode?: string;
  durationMin: number;
  note?: string;
}): Promise<MentorActionResult> {
  const studentId = String(input?.studentId ?? '').trim();
  if (!studentId) return { ok: false, message: 'Missing student reference.' };

  const logger = await resolveLogger(studentId);
  if (!logger.ok) return logger;

  const result = await recordActivity(
    studentId,
    {
      date: input.date,
      activity: input.activity,
      courseCode: input.courseCode || undefined,
      durationMin: input.durationMin,
      note: input.note || undefined,
    },
    { kind: 'staff', label: logger.label },
  );

  if (!result.ok) return { ok: false, message: result.error };

  // Both the mentor's view of this student and the student's own Time Log now
  // disagree with the database until they re-render.
  revalidatePath(`/mentor/student/${studentId}`);
  revalidatePath(`/director/student/${studentId}`);
  revalidatePath('/student/time-log');

  const { session } = result;
  const credited = session.creditedToCourse
    ? ` Credited to ${session.courseCode}.`
    : '';

  return {
    ok: true,
    message: `Recorded ${formatDuration(session.durationMin ?? 0)} of ${session.activityLabel.toLowerCase()} for ${firstName(logger.studentName)}.${credited}`,
  };
}

// ---------------------------------------------------------------------------

/// Three days out at 10:00 — far enough to be bookable, near enough to matter.
/// The programme runs Mon–Sat, so a Sunday slot rolls to the Monday.
function nextOneOnOneSlot(now: Date): Date {
  const slot = addDays(now, 3);
  slot.setHours(10, 0, 0, 0);
  if (slot.getDay() === 0) slot.setDate(slot.getDate() + 1);
  return slot;
}
