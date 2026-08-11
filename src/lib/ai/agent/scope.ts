import 'server-only';

/**
 * Who the assistant is allowed to read for.
 *
 * There is one agent, one tool registry and one loop for all three roles. The
 * only thing that differs between a student asking "am I behind?" and a
 * director asking "which cohort is behind?" is the scope resolved here, before
 * the model is given anything at all.
 *
 * Three rules make that safe, and they are the whole of this file:
 *
 *  1. **Scope comes from the session cookie, never from the conversation.** The
 *     model cannot widen it, because nothing it emits is an input to this
 *     function. A jailbreak in the question is still confined to whatever the
 *     signed-in user could have read by clicking around the dashboard.
 *
 *  2. **A `self` scope resolves to exactly one student id, fixed at run start.**
 *     Tools do not take a student id — they take a USN, and every USN goes
 *     through `resolveStudent` below, which refuses anything that is not the
 *     caller's own. A student who asks about a classmate gets a refusal in the
 *     transcript, not that classmate's marks.
 *
 *  3. **Staff reach is `mentorScope()`'s answer, not a second opinion.** This
 *     file used to keep its own `SCOPE_BY_ROLE` table mapping MENTOR to
 *     `programme`, so the assistant read the entire roster for a mentor whose
 *     `/mentor` screens show them fifteen mentees — and read it for a MENTOR
 *     account with no `Mentor` row at all, which `mentor-scope.ts` deliberately
 *     resolves to nobody. Two modules answering the same question differently is
 *     the whole bug: the wider answer is the one that decides what leaves the
 *     database, so the narrower one may as well not exist. `resolveScope` now
 *     derives from `mentorScope(session)` and nothing else.
 *
 * That makes the assistant *restrictive by default*: faculty discuss their own
 * mentor group, not the programme. If the programme decides faculty should be
 * able to ask about any student, that is a written decision to be made in
 * `mentor-scope.ts` — where the mentor screens, the alert scan and the uploads
 * queue would widen with it — or by giving the account the DIRECTOR role. It is
 * not something to reintroduce here as a special case for the chat box, because
 * then the dashboard and the assistant disagree again.
 *
 * The refusal path is deliberately *visible* rather than silent. Quietly
 * swapping in the asker's own record would leave a student believing they had
 * read someone else's, and would leave no trace for an administrator.
 */

import type { Prisma } from '@prisma/client';

import type { SessionPayload } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { mentorScope } from '@/lib/mentor-scope';

import type { ScopeKind } from './types';

export type { ScopeKind };

export type AgentScope = {
  kind: ScopeKind;
  actor: SessionPayload;
  /// The single student a `self` scope may read. Null for every other kind.
  selfStudentId: string | null;
  /// The mentor group a `mentees` scope is confined to. Null for every other
  /// kind — never a `Mentor` id the session did not carry.
  mentorId: string | null;
  /// Shown to the reader and written into the prompt, so the model states its
  /// own reach honestly rather than guessing at it.
  label: string;
};

/**
 * The scope a session gets, or null if it gets nothing.
 *
 * Null is a refusal, and both callers render it as one — `/api/agent` returns
 * 403 and `AssistantScreen` shows a banner instead of a chat box. It is the
 * right answer for a STUDENT session with no `studentId` and for the
 * `{ kind: 'none' }` that `mentorScope()` gives a MENTOR with no `Mentor` row:
 * in both cases there is no set of students to read, and a scope object with an
 * empty set would mean building a run, a prompt and an audit row for a question
 * that cannot be answered.
 */
export async function resolveScope(
  session: SessionPayload,
): Promise<AgentScope | null> {
  if (session.role === 'STUDENT') {
    // A STUDENT session without a studentId is a broken session, not a
    // programme-wide one. Failing closed matters more here than anywhere else
    // in this file.
    if (!session.studentId) return null;
    return {
      kind: 'self',
      actor: session,
      selfStudentId: session.studentId,
      mentorId: null,
      label: 'your own REEP record only',
    };
  }

  const staff = mentorScope(session);

  if (staff.kind === 'mentees') {
    return {
      kind: 'mentees',
      actor: session,
      selfStudentId: null,
      mentorId: staff.mentorId,
      label: 'the students assigned to you as their mentor',
    };
  }

  if (staff.kind === 'programme') {
    return {
      kind: 'programme',
      actor: session,
      selfStudentId: null,
      mentorId: null,
      label: 'every student in the programme',
    };
  }

  // `{ kind: 'none' }` — a MENTOR whose token carries no mentorId, or a role
  // that is in the schema but in nobody's table. Before this, that session was
  // the *widest* one in the product: it fell through to `programme` here while
  // its own screens showed it nothing.
  return null;
}

/**
 * The `where` clause every roster-shaped tool must apply.
 *
 * Centralised so a new tool cannot forget it, and written as an exhaustive
 * switch so a new `ScopeKind` cannot quietly inherit the unfiltered branch. The
 * closed cases are an impossible id rather than `{}`, matching `menteeWhere()`:
 * an empty object here means "every student", which is the failure this whole
 * file is about.
 */
export function visibleStudentWhere(scope: AgentScope): Prisma.StudentWhereInput {
  switch (scope.kind) {
    case 'programme':
      return {};
    case 'mentees':
      // Not `{ mentorId: scope.mentorId }` unguarded: a null there is not "no
      // filter", it is a filter matching every student who has no mentor
      // assigned — a real set of rows, and the wrong one.
      return scope.mentorId ? { mentorId: scope.mentorId } : { id: '__none__' };
    case 'self':
      return { id: scope.selfStudentId ?? '__none__' };
    default:
      return { id: '__none__' };
  }
}

// ---------------------------------------------------------------------------
// Naming a student
// ---------------------------------------------------------------------------

export type StudentRef = { id: string; usn: string; name: string; cohort: string };

export type Resolution =
  | { ok: true; student: StudentRef }
  | { ok: false; denied: boolean; reason: string };

/**
 * Turn whatever the model said into a student it is allowed to read.
 *
 * `usn` is the only handle the model is ever given — internal cuids never reach
 * it, so it cannot enumerate the table by guessing ids, and a USN it invents
 * simply fails to resolve.
 *
 * Every lookup goes through `visibleStudentWhere(scope)`, so the scope is part
 * of the query rather than a check performed on the row afterwards. A mentor
 * naming a USN from another mentor's group gets no row at all — there is no
 * moment where the record is in memory and a missing `if` would hand it over.
 */
export async function resolveStudent(
  scope: AgentScope,
  usn?: string | null,
): Promise<Resolution> {
  const wanted = usn?.trim().toUpperCase() || null;

  if (scope.kind === 'self') {
    const self = await load(visibleStudentWhere(scope));
    if (!self) {
      return { ok: false, denied: false, reason: 'Your student record was not found.' };
    }
    // Asking about someone else is refused by name, not silently redirected.
    if (wanted && wanted !== self.usn.toUpperCase()) {
      return {
        ok: false,
        denied: true,
        reason:
          `Access denied. This assistant can only read ${self.name}'s own record ` +
          `(USN ${self.usn}). It cannot look up USN ${wanted} or any other student.`,
      };
    }
    return { ok: true, student: self };
  }

  if (!wanted) {
    return {
      ok: false,
      denied: false,
      reason:
        'This tool needs a USN. Use find_students first to look one up by name, ' +
        'stage or risk.',
    };
  }

  const found = await load({ usn: wanted, ...visibleStudentWhere(scope) });
  if (!found) {
    // A miss means two different things to the two staff scopes, and saying the
    // wrong one is worse than saying nothing. To a director there is genuinely
    // no such student. To a mentor the student may well exist in another
    // mentor's group — claiming "no student found" would be the assistant
    // stating a fact about the database it did not read, which is exactly what
    // rule 1 of the system prompt forbids. So the mentor is told what the limit
    // is, without either confirming or denying that the USN exists.
    if (scope.kind === 'mentees') {
      return {
        ok: false,
        denied: true,
        reason:
          `Access denied. USN ${wanted} is not one of your mentees. This assistant reads ` +
          `only the students assigned to you as their mentor — use find_students to list them.`,
      };
    }
    return { ok: false, denied: false, reason: `No student found with USN ${wanted}.` };
  }
  return { ok: true, student: found };
}

async function load(where: Prisma.StudentWhereInput): Promise<StudentRef | null> {
  // `findFirst` rather than `findUnique` even though `id` and `usn` are both
  // @unique: the scope clause is ANDed in above, and a unique lookup cannot
  // carry it.
  const student = await prisma.student.findFirst({
    where,
    select: {
      id: true,
      usn: true,
      user: { select: { name: true } },
      cohort: { select: { name: true } },
    },
  });
  if (!student) return null;
  return {
    id: student.id,
    usn: student.usn,
    name: student.user.name,
    cohort: student.cohort.name,
  };
}
