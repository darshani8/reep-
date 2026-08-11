import 'server-only';

import { notFound, redirect } from 'next/navigation';

import type { SessionPayload } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { mentorScope } from '@/lib/mentor-scope';

export type ResolvedMentor = {
  mentorId: string;
  /// True when a director/admin is standing in someone else's shoes.
  borrowed: boolean;
};

/**
 * Every mentor screen is keyed on a mentorId, but only a MENTOR session carries
 * one — `requireMentor()` deliberately lets directors and admins through so they
 * can see the roster exactly as a mentor sees it. For them we borrow the first
 * mentor group alphabetically and label the view, rather than 404-ing on a
 * missing id. A programme with no mentors at all has nothing to show here, so
 * that case goes back to the director dashboard.
 *
 * Borrowing is a *director's* privilege, and keying it on a missing `mentorId`
 * handed it to any MENTOR account with no `Mentor` row: the overview then drew
 * the first mentor group in the programme — every name, every alert, every
 * percentage — for somebody entitled to none of it. So the decision comes from
 * `mentorScope()`, and the broken-mentor case gets a 404 instead of a stranger's
 * roster.
 */
export async function resolveMentorId(
  session: SessionPayload,
): Promise<ResolvedMentor> {
  const scope = mentorScope(session);
  if (scope.kind === 'mentees') return { mentorId: scope.mentorId, borrowed: false };
  if (scope.kind === 'none') notFound();

  const first = await prisma.mentor.findFirst({
    orderBy: { mentorGroup: 'asc' },
    select: { id: true },
  });
  if (!first) redirect('/director');

  return { mentorId: first.id, borrowed: true };
}
