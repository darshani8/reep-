import 'server-only';

/**
 * The database half of leave.
 *
 * `rules.ts` decides; this loads what it needs to decide with and shapes the
 * result for the screens. The split is the one AGENTS.md asks for and the one
 * `activity-rules.ts` / `activity-log.ts` already keeps: the routing and the
 * state machine are testable without a database because nothing in them imports
 * `server-only`, and everything that does import it lives here.
 *
 * Two loading decisions are worth stating. First, the approval queue is filtered
 * by `visibleToApprover` in memory rather than by a `where` clause: the rule that
 * a second approver cannot see an unsigned request is the product clause, and it
 * belongs where its test is, not duplicated into a Prisma filter that can drift
 * from it. The query is already narrowed to rows naming this user, so the set
 * being filtered is small by construction.
 *
 * Second, a leave row carries a requester, not a student. Staff apply for leave
 * too — that is what `/mentor/leave` is — so the requester is resolved through
 * `User` and the student record is an optional decoration on top.
 */

import { prisma } from '@/lib/db';
import type { SessionPayload } from '@/lib/auth';
import { mentorScope } from '@/lib/mentor-scope';
import type { LeaveDecision, LeaveStatus, Prisma } from '@prisma/client';

import {
  awaitsDecisionFrom,
  leaveDaysInclusive,
  resolveApprovers,
  resolveSecondApprover,
  visibleToApprover,
  type ApproverPool,
  type ApproverRouting,
  type ExistingLeave,
} from './rules';

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * Staff standing on the leave screens.
 *
 * `requireMentor()` admits MENTOR, DIRECTOR and ADMIN, and a MENTOR account with
 * no `Mentor` row passes it while having no scope at all. Every other staff
 * surface fails that account closed, and this one has to as well — approving
 * somebody's absence is a write, and the account is broken rather than
 * privileged. The refusal is a value rather than a `notFound()` so the page can
 * say what is wrong in words; the Server Actions turn the same value into a
 * throw, because a broken account should never have reached a write path.
 */
export type LeaveActor =
  | { ok: true; userId: string; name: string }
  | { ok: false; reason: string };

export function leaveActor(session: SessionPayload): LeaveActor {
  if (mentorScope(session).kind === 'none') {
    return {
      ok: false,
      reason:
        'This account has the mentor role but no mentor group on record, so it has no standing to apply for leave or to sign anybody else’s. The programme office can attach a mentor group to it.',
    };
  }
  return { ok: true, userId: session.userId, name: session.name };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Load the people who could sign this user's leave.
 *
 * The mentor group is read from whichever side the requester sits on: a student
 * inherits their mentor's group, and a mentor *is* one. Directors are ordered by
 * name so that two runs of the router pick the same person.
 */
export async function loadApproverPool(userId: string): Promise<ApproverPool> {
  const [asMentor, asStudent, directors] = await Promise.all([
    prisma.mentor.findUnique({
      where: { userId },
      select: { userId: true, firstApproverUserId: true },
    }),
    prisma.student.findUnique({
      where: { userId },
      select: {
        mentor: { select: { userId: true, firstApproverUserId: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: 'DIRECTOR' },
      select: { id: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const group = asMentor ?? asStudent?.mentor ?? null;

  return {
    requesterUserId: userId,
    mentorGroup: group
      ? { mentorUserId: group.userId, firstApproverUserId: group.firstApproverUserId }
      : null,
    directorUserIds: directors.map((director) => director.id),
  };
}

export type ApproverPreview = {
  routing: ApproverRouting;
  firstName: string | null;
  secondName: string | null;
};

/// The two names as the form shows them before anything is submitted, so nobody
/// applies without knowing who reads it.
export async function previewApprovers(userId: string): Promise<ApproverPreview> {
  const routing = resolveApprovers(await loadApproverPool(userId));
  if (!routing.ok) return { routing, firstName: null, secondName: null };

  const ids = [routing.firstApproverUserId, routing.secondApproverUserId].filter(
    (id): id is string => Boolean(id),
  );
  const names = await namesFor(ids);

  return {
    routing,
    firstName: names.get(routing.firstApproverUserId) ?? null,
    secondName: routing.secondApproverUserId
      ? (names.get(routing.secondApproverUserId) ?? null)
      : null,
  };
}

/// The second signatory to name when a first approval lands, worked out fresh —
/// a director may have been appointed since the request was filed.
export async function secondApproverFor(
  requesterUserId: string,
  firstApproverUserId: string,
): Promise<string | null> {
  const pool = await loadApproverPool(requesterUserId);
  return resolveSecondApprover(pool, firstApproverUserId);
}

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

// ---------------------------------------------------------------------------
// Reading requests
// ---------------------------------------------------------------------------

const REQUEST_INCLUDE = {
  requester: {
    select: {
      id: true,
      name: true,
      role: true,
      student: { select: { usn: true } },
    },
  },
  firstApprover: { select: { name: true } },
  secondApprover: { select: { name: true } },
} as const;

/// One request, flattened for rendering. Dates stay `Date`s — the screens format
/// them in UTC through `leaveDayWords`, because the columns are `@db.Date`.
export type LeaveRow = {
  id: string;
  requesterUserId: string;
  requesterName: string;
  /// "Student · 1BG24MBA001" or "Faculty mentor" — who is asking, in one line.
  requesterMeta: string;
  fromDate: Date;
  toDate: Date;
  days: number;
  reason: string;
  status: LeaveStatus;
  firstApproverUserId: string | null;
  firstApproverName: string | null;
  firstDecision: LeaveDecision | null;
  firstDecidedAt: Date | null;
  firstNote: string | null;
  secondApproverUserId: string | null;
  secondApproverName: string | null;
  secondDecision: LeaveDecision | null;
  secondDecidedAt: Date | null;
  secondNote: string | null;
  createdAt: Date;
};

const ROLE_WORD: Record<string, string> = {
  STUDENT: 'Student',
  MENTOR: 'Faculty mentor',
  DIRECTOR: 'Programme director',
  ADMIN: 'Programme office',
};

/// The row as Prisma hands it back under `REQUEST_INCLUDE`, so a renamed column
/// breaks the mapper at compile time rather than at render time.
type RawRequest = Prisma.LeaveRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function toRow(row: RawRequest): LeaveRow {
  const role = ROLE_WORD[row.requester.role] ?? row.requester.role;

  return {
    id: row.id,
    requesterUserId: row.requesterUserId,
    requesterName: row.requester.name,
    requesterMeta: row.requester.student ? `${role} · ${row.requester.student.usn}` : role,
    fromDate: row.fromDate,
    toDate: row.toDate,
    days: leaveDaysInclusive(row.fromDate, row.toDate),
    reason: row.reason,
    status: row.status,
    firstApproverUserId: row.firstApproverUserId,
    firstApproverName: row.firstApprover?.name ?? null,
    firstDecision: row.firstDecision,
    firstDecidedAt: row.firstDecidedAt,
    firstNote: row.firstNote,
    secondApproverUserId: row.secondApproverUserId,
    secondApproverName: row.secondApprover?.name ?? null,
    secondDecision: row.secondDecision,
    secondDecidedAt: row.secondDecidedAt,
    secondNote: row.secondNote,
    createdAt: row.createdAt,
  };
}

/// Everything this user has ever asked for, newest first.
export async function listOwnRequests(userId: string): Promise<LeaveRow[]> {
  const rows = await prisma.leaveRequest.findMany({
    where: { requesterUserId: userId },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRow);
}

/// The live requests a new one has to be checked against — the same user's own
/// calendar, in the shape `findOverlap` reads.
export async function liveRequestsFor(userId: string): Promise<ExistingLeave[]> {
  return prisma.leaveRequest.findMany({
    where: { requesterUserId: userId },
    select: { id: true, fromDate: true, toDate: true, status: true },
  });
}

export type ApprovalQueue = {
  /// Waiting on this user's signature, oldest first — the queue is a to-do list,
  /// and the person who has waited longest goes first.
  awaiting: LeaveRow[];
  /// Requests where this user is the named *second* approver and the first has
  /// not signed. Deliberately a count, not rows: stage two does not get to read
  /// a request the mentor has not recommended yet.
  waitingOnFirst: number;
  /// Everything else this user is named on — settled, or signed by them and now
  /// with the other approver. Not "decided": a request a mentor has recommended
  /// is out of their hands without being finished, and calling that decided is
  /// how a two-stage approval starts reading as a one-stage one.
  history: LeaveRow[];
};

export async function loadApprovalQueue(userId: string): Promise<ApprovalQueue> {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      OR: [{ firstApproverUserId: userId }, { secondApproverUserId: userId }],
    },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });

  const awaiting: LeaveRow[] = [];
  const history: LeaveRow[] = [];
  let waitingOnFirst = 0;

  for (const raw of rows) {
    const row = toRow(raw);

    if (!visibleToApprover(row, userId)) {
      // The only way to be named on a request you cannot see is to be its second
      // approver before the first has signed.
      waitingOnFirst += 1;
      continue;
    }

    if (awaitsDecisionFrom(row, userId)) awaiting.push(row);
    else history.push(row);
  }

  // Newest first once it has left the queue: a trail is read backwards from the
  // last thing that happened.
  history.reverse();

  return { awaiting, waitingOnFirst, history: history.slice(0, 20) };
}

/// One request with everything a decision needs, or null. The caller still has
/// to run `decideLeave` — this only says which row is being decided.
export async function loadRequestForDecision(id: string) {
  return prisma.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true,
      requesterUserId: true,
      status: true,
      firstApproverUserId: true,
      secondApproverUserId: true,
      requester: { select: { name: true } },
      fromDate: true,
      toDate: true,
    },
  });
}
