import { describe, expect, it } from 'vitest';

import {
  MAX_BACKDATED_DAYS,
  MAX_LEAVE_DAYS,
  awaitsDecisionFrom,
  cancelLeave,
  decideLeave,
  findOverlap,
  leaveDaysInclusive,
  openStage,
  parseLeaveDay,
  resolveApprovers,
  resolveSecondApprover,
  validateLeaveDates,
  visibleToApprover,
  type ApproverPool,
  type ExistingLeave,
  type LeaveState,
} from './rules';

/**
 * The property every case here is really defending: two different people sign a
 * leave request, in order, and the record says which of them said what and when.
 *
 * The tempting simplification is a single `approved` boolean set by whoever gets
 * there first. These tests are written so that it cannot be reintroduced without
 * several of them going red — the ordering cases, the "not your stage" cases and
 * the stamping cases all fail against a one-signature model.
 */

const TODAY = new Date('2026-08-11T09:30:00Z');

function state(overrides: Partial<LeaveState> = {}): LeaveState {
  return {
    status: 'SUBMITTED',
    firstApproverUserId: 'usr_mentor',
    secondApproverUserId: null,
    ...overrides,
  };
}

function pool(overrides: Partial<ApproverPool> = {}): ApproverPool {
  return {
    requesterUserId: 'usr_student',
    mentorGroup: { mentorUserId: 'usr_mentor', firstApproverUserId: null },
    directorUserIds: ['usr_director'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('parseLeaveDay', () => {
  it('reads a date input as UTC midnight, which is what a @db.Date column holds', () => {
    const day = parseLeaveDay('2026-08-17');

    expect(day?.toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('refuses a day that does not exist rather than rolling it forward', () => {
    // `new Date(2026, 1, 31)` is 3 March. A leave request must not silently
    // move to a different day than the one that was typed.
    expect(parseLeaveDay('2026-02-31')).toBeNull();
    expect(parseLeaveDay('2026-13-01')).toBeNull();
  });

  it('refuses anything that is not a bare calendar day', () => {
    for (const value of ['', 'tomorrow', '17-08-2026', '2026-08-17T00:00:00Z']) {
      expect(parseLeaveDay(value)).toBeNull();
    }
  });
});

describe('leaveDaysInclusive', () => {
  it('counts a single-day leave as one day, not zero', () => {
    const day = parseLeaveDay('2026-08-17')!;

    expect(leaveDaysInclusive(day, day)).toBe(1);
  });

  it('counts both ends', () => {
    expect(
      leaveDaysInclusive(parseLeaveDay('2026-08-17')!, parseLeaveDay('2026-08-19')!),
    ).toBe(3);
  });

  it('is unmoved by a daylight-saving boundary, because it works in UTC', () => {
    expect(
      leaveDaysInclusive(parseLeaveDay('2026-03-28')!, parseLeaveDay('2026-03-30')!),
    ).toBe(3);
  });
});

describe('validateLeaveDates', () => {
  it('accepts a normal forward-looking range', () => {
    const result = validateLeaveDates('2026-08-17', '2026-08-19', TODAY);

    expect(result).toMatchObject({ ok: true, days: 3 });
  });

  it('accepts leave that starts today', () => {
    expect(validateLeaveDates('2026-08-11', '2026-08-11', TODAY).ok).toBe(true);
  });

  it('refuses a range that ends before it starts', () => {
    const result = validateLeaveDates('2026-08-19', '2026-08-17', TODAY);

    expect(result.ok).toBe(false);
  });

  it('refuses a range longer than the cap', () => {
    const result = validateLeaveDates('2026-08-01', '2026-10-01', TODAY);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(String(MAX_LEAVE_DAYS));
  });

  it('allows medical leave to be written up after the fact, within the window', () => {
    // Backdating is a real need, so it is bounded rather than banned.
    expect(validateLeaveDates('2026-08-05', '2026-08-06', TODAY).ok).toBe(true);
  });

  it('refuses backdating beyond the window', () => {
    const result = validateLeaveDates('2026-06-01', '2026-06-02', TODAY);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(String(MAX_BACKDATED_DAYS));
  });

  it('refuses an unparseable day rather than defaulting to today', () => {
    expect(validateLeaveDates('', '2026-08-19', TODAY).ok).toBe(false);
    expect(validateLeaveDates('2026-08-17', 'soon', TODAY).ok).toBe(false);
  });
});

describe('findOverlap', () => {
  const existing = (overrides: Partial<ExistingLeave> = {}): ExistingLeave => ({
    id: 'lv_1',
    fromDate: parseLeaveDay('2026-08-17')!,
    toDate: parseLeaveDay('2026-08-19')!,
    status: 'SUBMITTED',
    ...overrides,
  });

  const range = {
    from: parseLeaveDay('2026-08-19')!,
    to: parseLeaveDay('2026-08-21')!,
  };

  it('catches a request that shares only its first day with a live one', () => {
    expect(findOverlap(range, [existing()])?.id).toBe('lv_1');
  });

  it('catches a request wholly inside a live one', () => {
    const inner = {
      from: parseLeaveDay('2026-08-18')!,
      to: parseLeaveDay('2026-08-18')!,
    };

    expect(findOverlap(inner, [existing()])?.id).toBe('lv_1');
  });

  it('treats a half-signed request as holding the calendar', () => {
    // FIRST_APPROVED is not a decision yet, but it is still a claim on those
    // days — asking for them twice while one is in flight is a mistake.
    expect(findOverlap(range, [existing({ status: 'FIRST_APPROVED' })])).not.toBeNull();
    expect(findOverlap(range, [existing({ status: 'APPROVED' })])).not.toBeNull();
  });

  it('lets a rejected or withdrawn request release its days', () => {
    // Re-applying for the same week after a rejection is a normal thing to do.
    for (const status of ['REJECTED', 'CANCELLED'] as const) {
      expect(findOverlap(range, [existing({ status })])).toBeNull();
    }
  });

  it('finds nothing when the ranges merely touch across a gap', () => {
    const later = {
      from: parseLeaveDay('2026-08-20')!,
      to: parseLeaveDay('2026-08-21')!,
    };

    expect(findOverlap(later, [existing()])).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('resolveApprovers', () => {
  it("routes a student's request to their own mentor, then to a director", () => {
    expect(resolveApprovers(pool())).toEqual({
      ok: true,
      firstApproverUserId: 'usr_mentor',
      secondApproverUserId: 'usr_director',
    });
  });

  it('prefers the stand-in recorded on the mentor group', () => {
    // The mentor on sabbatical: their group's requests route to whoever is
    // covering, without inventing a Role for it.
    const routed = resolveApprovers(
      pool({
        mentorGroup: { mentorUserId: 'usr_mentor', firstApproverUserId: 'usr_cover' },
      }),
    );

    expect(routed).toMatchObject({ firstApproverUserId: 'usr_cover' });
  });

  it('never lets anybody sign their own leave', () => {
    // The mentor applying for their own leave, which is what /mentor/leave is
    // for. Ordinary routing points straight back at them, so it escalates.
    const routed = resolveApprovers(pool({ requesterUserId: 'usr_mentor' }));

    expect(routed).toEqual({
      ok: true,
      firstApproverUserId: 'usr_director',
      secondApproverUserId: null,
    });
  });

  it('skips a stand-in who is the requester', () => {
    const routed = resolveApprovers(
      pool({
        requesterUserId: 'usr_cover',
        mentorGroup: { mentorUserId: 'usr_mentor', firstApproverUserId: 'usr_cover' },
      }),
    );

    expect(routed).toMatchObject({ firstApproverUserId: 'usr_mentor' });
  });

  it('routes a requester with no mentor group to a director', () => {
    expect(resolveApprovers(pool({ mentorGroup: null }))).toMatchObject({
      ok: true,
      firstApproverUserId: 'usr_director',
    });
  });

  it('leaves the second signature unrouted rather than refusing the request', () => {
    // One director in the programme, and they are signing first. Stage two has
    // nobody in it *today*; that is not a reason to refuse the application.
    expect(resolveApprovers(pool({ requesterUserId: 'usr_mentor' }))).toMatchObject({
      secondApproverUserId: null,
    });
  });

  it('picks the second director deterministically when there are several', () => {
    const routed = resolveApprovers(
      pool({ directorUserIds: ['usr_director', 'usr_director_2'] }),
    );

    expect(routed).toMatchObject({ secondApproverUserId: 'usr_director' });
  });

  it('never names the same person twice', () => {
    const routed = resolveApprovers(
      pool({
        requesterUserId: 'usr_mentor',
        directorUserIds: ['usr_director', 'usr_director_2'],
      }),
    );

    expect(routed).toEqual({
      ok: true,
      firstApproverUserId: 'usr_director',
      secondApproverUserId: 'usr_director_2',
    });
  });

  it('refuses when there is nobody at all to sign first', () => {
    const routed = resolveApprovers(
      pool({ requesterUserId: 'usr_director', mentorGroup: null, directorUserIds: ['usr_director'] }),
    );

    expect(routed.ok).toBe(false);
  });
});

describe('resolveSecondApprover', () => {
  it('excludes the requester and the first approver', () => {
    expect(
      resolveSecondApprover(
        { requesterUserId: 'usr_a', directorUserIds: ['usr_a', 'usr_b', 'usr_c'] },
        'usr_b',
      ),
    ).toBe('usr_c');
  });
});

// ---------------------------------------------------------------------------

describe('openStage', () => {
  it('reports the stage waiting on a signature, and nothing for a closed request', () => {
    expect(openStage('SUBMITTED')).toBe('FIRST');
    expect(openStage('FIRST_APPROVED')).toBe('SECOND');
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(openStage(status)).toBeNull();
    }
  });
});

describe('visibleToApprover', () => {
  it('shows a fresh request to its first approver only', () => {
    const fresh = state({ secondApproverUserId: 'usr_director' });

    expect(visibleToApprover(fresh, 'usr_mentor')).toBe(true);
    // The clause this screen exists for: the second approver cannot read a
    // request the mentor has not recommended yet.
    expect(visibleToApprover(fresh, 'usr_director')).toBe(false);
  });

  it('shows it to the second approver once the first has signed', () => {
    const signed = state({
      status: 'FIRST_APPROVED',
      secondApproverUserId: 'usr_director',
    });

    expect(visibleToApprover(signed, 'usr_director')).toBe(true);
    // And stays visible to the first, who has an interest in the outcome.
    expect(visibleToApprover(signed, 'usr_mentor')).toBe(true);
  });

  it('shows a decided request to both, because that is the audit trail', () => {
    const decided = state({
      status: 'APPROVED',
      secondApproverUserId: 'usr_director',
    });

    expect(visibleToApprover(decided, 'usr_mentor')).toBe(true);
    expect(visibleToApprover(decided, 'usr_director')).toBe(true);
  });

  it('shows it to nobody else at any stage', () => {
    for (const status of ['SUBMITTED', 'FIRST_APPROVED', 'APPROVED', 'REJECTED'] as const) {
      expect(
        visibleToApprover(state({ status, secondApproverUserId: 'usr_director' }), 'usr_other'),
      ).toBe(false);
    }
  });
});

describe('awaitsDecisionFrom', () => {
  it('is true only for the approver whose stage is open', () => {
    const fresh = state({ secondApproverUserId: 'usr_director' });

    expect(awaitsDecisionFrom(fresh, 'usr_mentor')).toBe(true);
    expect(awaitsDecisionFrom(fresh, 'usr_director')).toBe(false);

    const signed = { ...fresh, status: 'FIRST_APPROVED' as const };

    expect(awaitsDecisionFrom(signed, 'usr_mentor')).toBe(false);
    expect(awaitsDecisionFrom(signed, 'usr_director')).toBe(true);
  });

  it('is false for everyone once the request is closed', () => {
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      const closed = state({ status, secondApproverUserId: 'usr_director' });

      expect(awaitsDecisionFrom(closed, 'usr_mentor')).toBe(false);
      expect(awaitsDecisionFrom(closed, 'usr_director')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('decideLeave', () => {
  const now = new Date('2026-08-11T10:00:00Z');

  it('moves a first approval to FIRST_APPROVED rather than to APPROVED', () => {
    // The whole point. One signature is not an approval.
    const result = decideLeave(state(), {
      actorUserId: 'usr_mentor',
      decision: 'APPROVED',
      note: 'Genuine, and she is ahead of pace.',
      now,
      secondApproverUserId: 'usr_director',
    });

    expect(result).toEqual({
      ok: true,
      stage: 'FIRST',
      patch: {
        status: 'FIRST_APPROVED',
        firstDecision: 'APPROVED',
        firstDecidedAt: now,
        firstNote: 'Genuine, and she is ahead of pace.',
        secondApproverUserId: 'usr_director',
      },
    });
  });

  it('names the second approver only when submission could not route one', () => {
    const alreadyRouted = decideLeave(
      state({ secondApproverUserId: 'usr_director' }),
      {
        actorUserId: 'usr_mentor',
        decision: 'APPROVED',
        now,
        secondApproverUserId: 'usr_someone_else',
      },
    );

    expect(alreadyRouted).toMatchObject({
      patch: { secondApproverUserId: 'usr_director' },
    });
  });

  it('ends the request on a first-stage rejection, without reaching stage two', () => {
    const result = decideLeave(state(), {
      actorUserId: 'usr_mentor',
      decision: 'REJECTED',
      note: 'Third week running.',
      now,
    });

    expect(result).toEqual({
      ok: true,
      stage: 'FIRST',
      patch: {
        status: 'REJECTED',
        firstDecision: 'REJECTED',
        firstDecidedAt: now,
        firstNote: 'Third week running.',
      },
    });
    // No second-stage column is touched, so the record shows the mentor stopped
    // it rather than implying the office was involved.
    expect(result.ok === true && 'secondDecision' in result.patch).toBe(false);
  });

  it('approves on the second signature and stamps it separately', () => {
    const result = decideLeave(
      state({ status: 'FIRST_APPROVED', secondApproverUserId: 'usr_director' }),
      { actorUserId: 'usr_director', decision: 'APPROVED', now },
    );

    expect(result).toEqual({
      ok: true,
      stage: 'SECOND',
      patch: {
        status: 'APPROVED',
        secondDecision: 'APPROVED',
        secondDecidedAt: now,
        secondNote: null,
      },
    });
    // The first approver's stamp is never rewritten — the trail has to keep
    // showing that the mentor recommended it.
    expect(result.ok === true && 'firstDecision' in result.patch).toBe(false);
  });

  it('lets the second approver reject what the first recommended', () => {
    const result = decideLeave(
      state({ status: 'FIRST_APPROVED', secondApproverUserId: 'usr_director' }),
      { actorUserId: 'usr_director', decision: 'REJECTED', now },
    );

    expect(result).toMatchObject({
      stage: 'SECOND',
      patch: { status: 'REJECTED', secondDecision: 'REJECTED' },
    });
  });

  it('refuses the second approver before the first has signed', () => {
    const result = decideLeave(state({ secondApproverUserId: 'usr_director' }), {
      actorUserId: 'usr_director',
      decision: 'APPROVED',
      now,
    });

    expect(result.ok).toBe(false);
  });

  it('refuses the first approver a second bite', () => {
    const result = decideLeave(
      state({ status: 'FIRST_APPROVED', secondApproverUserId: 'usr_director' }),
      { actorUserId: 'usr_mentor', decision: 'APPROVED', now },
    );

    expect(result.ok).toBe(false);
  });

  it('refuses a stranger at either stage, however senior', () => {
    // The named approver, not the role, is what may sign. A director who is not
    // on this request has no standing on it.
    for (const status of ['SUBMITTED', 'FIRST_APPROVED'] as const) {
      const result = decideLeave(
        state({ status, secondApproverUserId: 'usr_director' }),
        { actorUserId: 'usr_other_director', decision: 'APPROVED', now },
      );

      expect(result.ok).toBe(false);
    }
  });

  it('refuses to reopen a decided request', () => {
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      const result = decideLeave(
        state({ status, secondApproverUserId: 'usr_director' }),
        { actorUserId: 'usr_mentor', decision: 'APPROVED', now },
      );

      expect(result.ok).toBe(false);
    }
  });

  it('stores an empty note as null rather than as blank text', () => {
    const result = decideLeave(state(), {
      actorUserId: 'usr_mentor',
      decision: 'APPROVED',
      note: '   ',
      now,
    });

    expect(result).toMatchObject({ patch: { firstNote: null } });
  });

  it('reaches APPROVED only through both signatures', () => {
    // Walk the whole machine: no single call can produce APPROVED from a fresh
    // request, whoever makes it.
    const fresh = state({ secondApproverUserId: 'usr_director' });

    for (const actorUserId of ['usr_mentor', 'usr_director', 'usr_other']) {
      const result = decideLeave(fresh, { actorUserId, decision: 'APPROVED', now });

      expect(result.ok === true && result.patch.status).not.toBe('APPROVED');
    }
  });
});

describe('cancelLeave', () => {
  const requested = { ...state(), requesterUserId: 'usr_student' };

  it('lets the requester withdraw a live request', () => {
    expect(cancelLeave(requested, 'usr_student')).toEqual({
      ok: true,
      patch: { status: 'CANCELLED' },
    });
  });

  it('lets nobody else withdraw it, including the approver', () => {
    expect(cancelLeave(requested, 'usr_mentor').ok).toBe(false);
  });

  it('refuses to withdraw a request that has already been decided', () => {
    // Otherwise the subject of a rejection can delete the answer they did not
    // like and re-apply as if it never happened.
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(cancelLeave({ ...requested, status }, 'usr_student').ok).toBe(false);
    }
  });
});
