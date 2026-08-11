/**
 * Which students a member of staff may see.
 *
 * `requireMentor()` admits MENTOR, DIRECTOR and ADMIN, and the staff screens
 * then have to narrow that to a set of students. Every one of them used to do
 * it the same way:
 *
 *     where: session.mentorId ? { student: { mentorId: session.mentorId } } : {}
 *
 * The intent is right — a director has no mentor group and should see the whole
 * programme — but the test is wrong. It asks whether a mentor group is *present*
 * when the question is which *role* is asking. A MENTOR whose token carries no
 * `mentorId` therefore lands in the director branch and reads the entire
 * programme, and `authenticate()` mints exactly that token for any user with
 * role MENTOR and no `Mentor` row.
 *
 * So the decision is made once, here, keyed on the role, and the broken-mentor
 * case fails closed rather than open. `upload-access.ts` already got this right;
 * this is the same rule for the screens that did not.
 */

import type { Prisma, Role } from '@prisma/client';

import type { SessionPayload } from './auth';

/// Staff who legitimately have no mentor group and are meant to see everyone.
const PROGRAMME_WIDE: Role[] = ['DIRECTOR', 'ADMIN'];

export type MentorScope =
  /// Every student in the programme.
  | { kind: 'programme' }
  /// Just this mentor's own mentees.
  | { kind: 'mentees'; mentorId: string }
  /// Nobody. A mentor account with no mentor record — a broken session, not a
  /// privileged one.
  | { kind: 'none' };

export function mentorScope(session: SessionPayload): MentorScope {
  if (PROGRAMME_WIDE.includes(session.role)) return { kind: 'programme' };
  if (session.role === 'MENTOR' && session.mentorId) {
    return { kind: 'mentees', mentorId: session.mentorId };
  }
  return { kind: 'none' };
}

/**
 * The scope as a `Student` filter, for the common case.
 *
 * The impossible-id sentinel matches `visibleStudentWhere` in
 * `ai/agent/scope.ts` — an empty object would mean "every student", which is
 * the bug this module exists to prevent, so the closed case has to be a filter
 * that cannot match rather than the absence of one.
 */
export function menteeWhere(session: SessionPayload): Prisma.StudentWhereInput {
  const scope = mentorScope(session);
  if (scope.kind === 'programme') return {};
  if (scope.kind === 'mentees') return { mentorId: scope.mentorId };
  return { id: '__none__' };
}

/**
 * The same rule for one student already in hand.
 *
 * The detail screen and the two Server Actions behind it have loaded the row
 * before they have to decide anything, so re-asking the database as a filter
 * would be a second round trip to prove what the row already answers. They used
 * to write that decision out by hand as
 *
 *     if (session.mentorId && student.mentorId !== session.mentorId) notFound();
 *
 * which is the module-level bug in its most direct form: the `&&` short-circuits
 * for a mentor carrying no group and the guard disappears entirely, on a read
 * *and* on the note-writing path.
 *
 * A student with no mentor at all is not a gap in the fence: they belong to no
 * mentor group, so only programme-wide staff can reach them.
 */
export function canSeeStudent(
  session: SessionPayload,
  studentMentorId: string | null,
): boolean {
  const scope = mentorScope(session);
  if (scope.kind === 'programme') return true;
  if (scope.kind === 'mentees') return studentMentorId === scope.mentorId;
  return false;
}
