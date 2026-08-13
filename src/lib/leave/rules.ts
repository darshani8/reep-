/**
 * Leave, and the two signatures that decide it.
 *
 * A leave request is not a boolean. It is a request that two named people sign
 * in order, and the ordering is the clause: the first approver — the mentor of
 * the group the request comes out of, or whoever is standing in for them — reads
 * it first, and the programme office only ever sees a request that a mentor has
 * already recommended. Collapsing that into `approved: boolean` would lose the
 * three things a leave record is actually kept for: who decided, in what order,
 * and when. So every transition here produces a stamped patch rather than a flag.
 *
 * Everything in this file is pure, and deliberately so. The routing rule ("who
 * signs this?") and the transition rule ("may this person sign it now?") are the
 * parts worth testing exhaustively, and neither needs a database to answer — the
 * caller loads the rows, this decides. `queries.ts` next door is the half that
 * touches Prisma, and it imports `server-only`; keeping the two apart is the
 * same split as `activity-rules.ts` / `activity-log.ts`.
 *
 * On dates: `LeaveRequest.fromDate` and `toDate` are `@db.Date` columns, which
 * Postgres stores and Prisma hands back as **UTC** midnight. So the day helpers
 * here work in UTC rather than reusing `activity-rules.parseDay`, which is
 * deliberately server-local for lab check-ins. Mixing the two shifts a leave day
 * by one for any server west of Greenwich, and a leave record that names the
 * wrong day is worse than no record.
 */

import type { LeaveDecision, LeaveStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Calendar days
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/// `YYYY-MM-DD` from an `<input type="date">` to UTC midnight, or null if it is
/// not a real calendar day. `Date` rolls 2026-02-31 forward rather than failing,
/// so the parts are round-tripped before the value is trusted.
export function parseLeaveDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const day = new Date(Date.UTC(year, month, date));

  if (
    day.getUTCFullYear() !== year ||
    day.getUTCMonth() !== month ||
    day.getUTCDate() !== date
  ) {
    return null;
  }
  return day;
}

/// The UTC calendar day a moment falls on — the value a `@db.Date` column holds.
export function leaveDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/// What `<input type="date">` wants back.
export function leaveDayISO(date: Date): string {
  return leaveDay(date).toISOString().slice(0, 10);
}

/// Rendered in UTC for the same reason it is parsed in UTC: the column has no
/// time in it, so applying a local offset can only move the day.
export function leaveDayWords(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/// Both ends count. One day off is `from === to`, which is one day, not zero.
export function leaveDaysInclusive(from: Date, to: Date): number {
  return Math.round((leaveDay(to).getTime() - leaveDay(from).getTime()) / MS_PER_DAY) + 1;
}

// ---------------------------------------------------------------------------
// The dates on the form
// ---------------------------------------------------------------------------

/// A single request longer than this is a semester break, not leave, and should
/// go through the programme office as a written case.
export const MAX_LEAVE_DAYS = 30;

/// How far back a request may start. Leave is normally asked for in advance, but
/// medical leave is written up afterwards, so backdating is allowed — bounded,
/// so nobody papers over an absence from last semester.
export const MAX_BACKDATED_DAYS = 14;

export type LeaveDates =
  | { ok: true; from: Date; to: Date; days: number }
  | { ok: false; error: string };

export function validateLeaveDates(
  fromValue: string,
  toValue: string,
  now: Date = new Date(),
): LeaveDates {
  const from = parseLeaveDay(fromValue);
  const to = parseLeaveDay(toValue);

  if (!from) return { ok: false, error: 'Pick a first day of leave.' };
  if (!to) return { ok: false, error: 'Pick a last day of leave.' };

  if (to.getTime() < from.getTime()) {
    return { ok: false, error: 'Leave cannot end before it starts.' };
  }

  const days = leaveDaysInclusive(from, to);
  if (days > MAX_LEAVE_DAYS) {
    return {
      ok: false,
      error: `That is ${days} days. Anything longer than ${MAX_LEAVE_DAYS} goes to the programme office as a written case.`,
    };
  }

  const earliest = new Date(leaveDay(now).getTime() - MAX_BACKDATED_DAYS * MS_PER_DAY);
  if (from.getTime() < earliest.getTime()) {
    return {
      ok: false,
      error: `Leave can be backdated by at most ${MAX_BACKDATED_DAYS} days, and that starts ${leaveDayWords(from)}.`,
    };
  }

  return { ok: true, from, to, days };
}

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

/**
 * Statuses that still hold the calendar.
 *
 * A rejected or cancelled request releases its days — asking again for the same
 * week after a rejection is a normal thing to do, and refusing it as a duplicate
 * would be wrong. Everything else, including a request only half signed, is a
 * claim on those days and must not be double-booked.
 */
export const BLOCKING_LEAVE_STATUSES: LeaveStatus[] = [
  'SUBMITTED',
  'FIRST_APPROVED',
  'APPROVED',
];

export function holdsCalendar(status: LeaveStatus): boolean {
  return BLOCKING_LEAVE_STATUSES.includes(status);
}

export type ExistingLeave = {
  id: string;
  fromDate: Date;
  toDate: Date;
  status: LeaveStatus;
};

/**
 * The first live request that shares a day with this range, or null.
 *
 * Inclusive on both ends: leave that ends on the 8th and leave that starts on
 * the 8th are the same day asked for twice.
 */
export function findOverlap(
  range: { from: Date; to: Date },
  existing: ExistingLeave[],
): ExistingLeave | null {
  const from = leaveDay(range.from).getTime();
  const to = leaveDay(range.to).getTime();

  for (const row of existing) {
    if (!holdsCalendar(row.status)) continue;
    if (leaveDay(row.fromDate).getTime() <= to && leaveDay(row.toDate).getTime() >= from) {
      return row;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Who signs it
// ---------------------------------------------------------------------------

export type ApproverPool = {
  requesterUserId: string;
  /// The mentor group the request comes out of, if the requester is in one.
  /// `firstApproverUserId` is the substitution recorded on `Mentor`; it is null
  /// in the ordinary case, where the group's own mentor signs.
  mentorGroup: { mentorUserId: string; firstApproverUserId: string | null } | null;
  /// Programme-wide signatories, in a stable order. There is no per-cohort
  /// director column in the schema, so "the cohort's director" is in practice
  /// the programme's director, and the caller passes them in a fixed order so
  /// that routing is reproducible rather than whatever the query returned first.
  directorUserIds: string[];
};

export type ApproverRouting =
  | {
      ok: true;
      firstApproverUserId: string;
      /// Null when no distinct second signatory exists *yet*. That is not a
      /// failure: `Mentor` groups outnumber directors, and a request must not be
      /// refused at submission because stage two has nobody in it today. The
      /// second approver is resolved again when the first signature lands.
      secondApproverUserId: string | null;
    }
  | { ok: false; reason: string };

/**
 * The first signature: the mentor group's recorded approver, else its own
 * mentor, else a director.
 *
 * The one rule that overrides all three is that nobody signs their own leave.
 * That is not a hypothetical: this screen is where a *mentor* applies, and the
 * ordinary routing for their group points straight back at them. Falling through
 * to a director is exactly what `Mentor.firstApproverUserId` documents for the
 * mentor on sabbatical — the same escalation, reached by a different door.
 */
export function resolveFirstApprover(pool: ApproverPool): string | null {
  const candidates = [
    pool.mentorGroup?.firstApproverUserId,
    pool.mentorGroup?.mentorUserId,
    ...pool.directorUserIds,
  ];

  for (const candidate of candidates) {
    if (candidate && candidate !== pool.requesterUserId) return candidate;
  }
  return null;
}

/**
 * The second signature: any director who is neither the requester nor the person
 * who signed first.
 *
 * Returning null is a real outcome, not an error — see `ApproverRouting`.
 */
export function resolveSecondApprover(
  pool: Pick<ApproverPool, 'requesterUserId' | 'directorUserIds'>,
  firstApproverUserId: string | null,
): string | null {
  return (
    pool.directorUserIds.find(
      (userId) => userId !== pool.requesterUserId && userId !== firstApproverUserId,
    ) ?? null
  );
}

export function resolveApprovers(pool: ApproverPool): ApproverRouting {
  const firstApproverUserId = resolveFirstApprover(pool);
  if (!firstApproverUserId) {
    return {
      ok: false,
      reason:
        'There is nobody on record who can sign the first approval for this request — the mentor group has no mentor and the programme has no director other than you.',
    };
  }

  return {
    ok: true,
    firstApproverUserId,
    secondApproverUserId: resolveSecondApprover(pool, firstApproverUserId),
  };
}

// ---------------------------------------------------------------------------
// The two decisions
// ---------------------------------------------------------------------------

export type LeaveStage = 'FIRST' | 'SECOND';

/// The fields a transition reads. Deliberately narrower than the Prisma row, so
/// a test can state a case in five lines and so nothing here can quietly start
/// depending on the reason text or the requester.
export type LeaveState = {
  status: LeaveStatus;
  firstApproverUserId: string | null;
  secondApproverUserId: string | null;
};

/// Which stage is open, or null when the request is closed. `SUBMITTED` means
/// nobody has signed; `FIRST_APPROVED` means one signature is on it.
export function openStage(status: LeaveStatus): LeaveStage | null {
  if (status === 'SUBMITTED') return 'FIRST';
  if (status === 'FIRST_APPROVED') return 'SECOND';
  return null;
}

/**
 * May this person act on this request right now?
 *
 * Both halves matter. Being the named second approver is not permission to sign
 * a request the mentor has not read yet, and being the first approver is not
 * permission to sign it twice.
 */
export function awaitsDecisionFrom(state: LeaveState, userId: string): boolean {
  const stage = openStage(state.status);
  if (stage === 'FIRST') return state.firstApproverUserId === userId;
  if (stage === 'SECOND') return state.secondApproverUserId === userId;
  return false;
}

/**
 * May this person *see* this request in their queue?
 *
 * The second approver cannot, until the first has signed. That is the clause the
 * screen exists for, and it is enforced here rather than in the query so that
 * the rule and its test sit together: a director scrolling their queue must not
 * be able to read a request the mentor has not yet recommended.
 *
 * A decided request stays visible to everyone who was named on it — that is the
 * audit trail, and hiding it the moment it closes would make the record useless.
 */
export function visibleToApprover(state: LeaveState, userId: string): boolean {
  if (state.status === 'SUBMITTED') return state.firstApproverUserId === userId;
  return state.firstApproverUserId === userId || state.secondApproverUserId === userId;
}

export type LeavePatch = {
  status: LeaveStatus;
  firstDecision?: LeaveDecision;
  firstDecidedAt?: Date;
  firstNote?: string | null;
  secondApproverUserId?: string | null;
  secondDecision?: LeaveDecision;
  secondDecidedAt?: Date;
  secondNote?: string | null;
};

export type LeaveTransition =
  | { ok: false; reason: string }
  | { ok: true; stage: LeaveStage; patch: LeavePatch };

/**
 * One approver's verdict, as the exact set of columns it writes.
 *
 * Returning a patch rather than mutating a row keeps the whole state machine
 * testable and keeps the write in one place — the action hands the patch
 * straight to `prisma.leaveRequest.update`, so there is no second copy of
 * "rejection ends it" to drift.
 *
 * The transitions:
 *   SUBMITTED       + first APPROVED  → FIRST_APPROVED, stamped, second named
 *   SUBMITTED       + first REJECTED  → REJECTED, stamped. It ends here.
 *   FIRST_APPROVED  + second APPROVED → APPROVED, stamped
 *   FIRST_APPROVED  + second REJECTED → REJECTED, stamped
 *
 * A rejection at either stage ends the request, and the first approver's stamp
 * is never overwritten by the second's — the record has to show that the mentor
 * recommended it and the office did not.
 */
export function decideLeave(
  state: LeaveState,
  input: {
    actorUserId: string;
    decision: LeaveDecision;
    note?: string;
    now?: Date;
    /// Who to name as second approver when the first signature lands. Resolved
    /// late on purpose: at submission "any director" is a role, not a person,
    /// and half of these requests never reach stage two at all.
    secondApproverUserId?: string | null;
  },
): LeaveTransition {
  const stage = openStage(state.status);
  if (!stage) {
    return { ok: false, reason: 'That request has already been decided.' };
  }

  if (!awaitsDecisionFrom(state, input.actorUserId)) {
    return {
      ok: false,
      reason:
        stage === 'FIRST'
          ? 'That request is with its first approver, and you are not them.'
          : 'You are not the second approver named on that request.',
    };
  }

  const now = input.now ?? new Date();
  const note = input.note?.trim() ? input.note.trim() : null;

  if (stage === 'FIRST') {
    if (input.decision === 'REJECTED') {
      return {
        ok: true,
        stage,
        patch: {
          status: 'REJECTED',
          firstDecision: 'REJECTED',
          firstDecidedAt: now,
          firstNote: note,
        },
      };
    }

    return {
      ok: true,
      stage,
      patch: {
        status: 'FIRST_APPROVED',
        firstDecision: 'APPROVED',
        firstDecidedAt: now,
        firstNote: note,
        // Keep whoever was already named rather than re-pointing a request
        // mid-flight; only fill the gap when submission could not route it.
        secondApproverUserId:
          state.secondApproverUserId ?? input.secondApproverUserId ?? null,
      },
    };
  }

  return {
    ok: true,
    stage,
    patch: {
      status: input.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      secondDecision: input.decision,
      secondDecidedAt: now,
      secondNote: note,
    },
  };
}

/**
 * Withdrawing your own request.
 *
 * Only the requester, and only while it is still live. A decided request is a
 * record of a decision, and letting the subject of it delete the answer they did
 * not like is the one thing an approval trail must not allow.
 */
export function cancelLeave(
  state: LeaveState & { requesterUserId: string },
  actorUserId: string,
): { ok: true; patch: { status: LeaveStatus } } | { ok: false; reason: string } {
  if (state.requesterUserId !== actorUserId) {
    return { ok: false, reason: 'Only the person who applied can withdraw a request.' };
  }
  if (!openStage(state.status)) {
    return { ok: false, reason: 'That request has already been decided.' };
  }
  return { ok: true, patch: { status: 'CANCELLED' } };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/// Status as a person would say it. `FIRST_APPROVED` is the one that has to earn
/// its wording: it is not "approved", and a requester reading it as approved and
/// getting on a train is the failure this label exists to prevent.
export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
  SUBMITTED: 'Awaiting first approval',
  FIRST_APPROVED: 'Awaiting second approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
};

export const LEAVE_DECISION_LABEL: Record<LeaveDecision, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/// The dates as one phrase — "17 Aug 2026" for a single day, a range otherwise.
export function leaveRangeWords(from: Date, to: Date): string {
  const days = leaveDaysInclusive(from, to);
  if (days === 1) return leaveDayWords(from);
  return `${leaveDayWords(from)} — ${leaveDayWords(to)}`;
}
