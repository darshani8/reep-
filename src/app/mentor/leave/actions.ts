'use server';

/**
 * The three writes on the leave screens: apply, decide, withdraw.
 *
 * Each one re-runs the whole guard. A Server Action is reachable by a direct
 * POST, so the fact that the approvals page only draws a button for the approver
 * whose stage is open decides nothing — `decideLeave` in `@/lib/leave/rules` is
 * what decides, and it is called here with the row as the database holds it
 * rather than with anything the form claimed about it. The form sends an id and
 * a verdict; who may act, at which stage, and what that writes are all read back
 * from the row.
 *
 * A MENTOR session with no `Mentor` row throws rather than returning a message,
 * the same way `mentor/student/[id]/actions.ts` handles it: the returned message
 * is the vocabulary of "you filled the form in wrong", and a broken account is
 * not that. It should be fixed by the programme office, not worked around.
 */

import { revalidatePath } from 'next/cache';

import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  leaveActor,
  liveRequestsFor,
  loadApproverPool,
  loadRequestForDecision,
  secondApproverFor,
} from '@/lib/leave/queries';
import {
  cancelLeave,
  decideLeave,
  findOverlap,
  leaveRangeWords,
  resolveApprovers,
  validateLeaveDates,
} from '@/lib/leave/rules';
import type { LeaveDecision } from '@prisma/client';

export type LeaveActionState = { ok: boolean; message: string } | null;

const REASON_MIN_CHARS = 10;
const REASON_MAX_CHARS = 1000;
const NOTE_MAX_CHARS = 1000;

/// Both screens change whenever any of these run: a new request lands in
/// somebody's queue, and a decision changes what the requester is told.
function revalidateLeave() {
  revalidatePath('/mentor/leave');
  revalidatePath('/mentor/leave/approvals');
}

async function actor() {
  const session = await requireMentor();
  const standing = leaveActor(session);
  if (!standing.ok) throw new Error(standing.reason);
  return standing;
}

// ---------------------------------------------------------------------------

export async function applyForLeaveAction(
  _prev: LeaveActionState,
  formData: FormData,
): Promise<LeaveActionState> {
  const me = await actor();

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < REASON_MIN_CHARS) {
    return { ok: false, message: 'Say why, in a sentence an approver can act on.' };
  }
  if (reason.length > REASON_MAX_CHARS) {
    return { ok: false, message: `Keep the reason under ${REASON_MAX_CHARS} characters.` };
  }

  const dates = validateLeaveDates(
    String(formData.get('fromDate') ?? ''),
    String(formData.get('toDate') ?? ''),
  );
  if (!dates.ok) return { ok: false, message: dates.error };

  // Your own calendar, not the programme's: two people may be away the same
  // week, but one person may not be away twice.
  const clash = findOverlap(dates, await liveRequestsFor(me.userId));
  if (clash) {
    return {
      ok: false,
      message: `You already have a live request covering ${leaveRangeWords(clash.fromDate, clash.toDate)}.`,
    };
  }

  const routing = resolveApprovers(await loadApproverPool(me.userId));
  if (!routing.ok) return { ok: false, message: routing.reason };

  await prisma.leaveRequest.create({
    data: {
      requesterUserId: me.userId,
      fromDate: dates.from,
      toDate: dates.to,
      reason,
      status: 'SUBMITTED',
      firstApproverUserId: routing.firstApproverUserId,
      // May legitimately be null — see `ApproverRouting`. The second signatory is
      // named again when the first approval lands.
      secondApproverUserId: routing.secondApproverUserId,
    },
  });

  revalidateLeave();

  return {
    ok: true,
    message: `Applied for ${dates.days} day${dates.days === 1 ? '' : 's'} from ${leaveRangeWords(dates.from, dates.to)}. It is with your first approver.`,
  };
}

// ---------------------------------------------------------------------------

export async function decideLeaveAction(
  _prev: LeaveActionState,
  formData: FormData,
): Promise<LeaveActionState> {
  const me = await actor();

  const id = String(formData.get('requestId') ?? '').trim();
  const raw = String(formData.get('decision') ?? '');
  if (raw !== 'APPROVED' && raw !== 'REJECTED') {
    return { ok: false, message: 'Choose approve or reject.' };
  }
  const decision: LeaveDecision = raw;

  const note = String(formData.get('note') ?? '').slice(0, NOTE_MAX_CHARS);

  const request = await loadRequestForDecision(id);
  if (!request) return { ok: false, message: 'That request no longer exists.' };

  // Only asked when it can be used, and asked now rather than at submission: a
  // director may have been appointed since the request was filed.
  const secondApproverUserId =
    request.status === 'SUBMITTED' && decision === 'APPROVED'
      ? await secondApproverFor(request.requesterUserId, me.userId)
      : null;

  const transition = decideLeave(request, {
    actorUserId: me.userId,
    decision,
    note,
    secondApproverUserId,
  });
  if (!transition.ok) return { ok: false, message: transition.reason };

  await prisma.leaveRequest.update({ where: { id }, data: transition.patch });

  revalidateLeave();

  const who = request.requester.name.split(' ')[0] ?? request.requester.name;
  if (transition.patch.status === 'FIRST_APPROVED') {
    return {
      ok: true,
      message: transition.patch.secondApproverUserId
        ? `Recommended. ${who}'s request now goes to the second approver.`
        : `Recommended. There is no second signatory on record yet, so ${who}'s request waits for one.`,
    };
  }
  if (transition.patch.status === 'APPROVED') {
    return { ok: true, message: `Approved. ${who} has been granted the leave.` };
  }
  return {
    ok: true,
    message: `Rejected at the ${transition.stage === 'FIRST' ? 'first' : 'second'} stage. ${who}'s request is closed.`,
  };
}

// ---------------------------------------------------------------------------

export async function withdrawLeaveAction(
  _prev: LeaveActionState,
  formData: FormData,
): Promise<LeaveActionState> {
  const me = await actor();

  const id = String(formData.get('requestId') ?? '').trim();
  const request = await loadRequestForDecision(id);
  if (!request) return { ok: false, message: 'That request no longer exists.' };

  const result = cancelLeave(request, me.userId);
  if (!result.ok) return { ok: false, message: result.reason };

  await prisma.leaveRequest.update({ where: { id }, data: result.patch });

  revalidateLeave();
  return { ok: true, message: 'Withdrawn. Those days are free again.' };
}
