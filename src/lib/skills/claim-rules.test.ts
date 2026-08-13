import { describe, expect, it } from 'vitest';

import {
  CLAIM_STATUS_LABEL,
  MAX_SKILL_LEVEL,
  SKILL_LEVELS,
  claimBlockedReason,
  clampLevel,
  levelLabel,
  promotionFor,
} from './claim-rules';

describe('promotionFor', () => {
  it('promotes a pending claim once its file is verified', () => {
    expect(
      promotionFor({ status: 'PENDING_REVIEW', claimedLevel: 4 }, { status: 'VERIFIED' }),
    ).toEqual({ kind: 'verify', level: 4 });
  });

  it('rejects a pending claim whose file was refused, and touches no skill', () => {
    expect(
      promotionFor({ status: 'PENDING_REVIEW', claimedLevel: 4 }, { status: 'REJECTED' }),
    ).toEqual({ kind: 'reject' });
  });

  it('grants nothing while the file is still in the mentor queue', () => {
    // The load-bearing case. If this ever returns `verify`, every badge in the
    // product is mintable by uploading any file that passes the type sniff.
    expect(
      promotionFor({ status: 'PENDING_REVIEW', claimedLevel: 5 }, { status: 'PENDING_REVIEW' }),
    ).toEqual({ kind: 'unchanged' });
  });

  it('does not re-decide a claim a mentor has already settled', () => {
    // This runs over the whole table on every page load, so it has to be
    // idempotent — and a rejection must not be overturned by a later edit to
    // the upload row.
    expect(
      promotionFor({ status: 'REJECTED', claimedLevel: 3 }, { status: 'VERIFIED' }),
    ).toEqual({ kind: 'unchanged' });
    expect(
      promotionFor({ status: 'VERIFIED', claimedLevel: 3 }, { status: 'REJECTED' }),
    ).toEqual({ kind: 'unchanged' });
  });

  it('grants a clamped level rather than whatever the form posted', () => {
    expect(
      promotionFor({ status: 'PENDING_REVIEW', claimedLevel: 900 }, { status: 'VERIFIED' }),
    ).toEqual({ kind: 'verify', level: MAX_SKILL_LEVEL });
  });
});

describe('clampLevel', () => {
  it('keeps a level that is already on the ladder', () => {
    expect(clampLevel(1)).toBe(1);
    expect(clampLevel(5)).toBe(5);
  });

  it('pulls an out-of-range level back onto it', () => {
    expect(clampLevel(0)).toBe(1);
    expect(clampLevel(-4)).toBe(1);
    expect(clampLevel(99)).toBe(5);
  });

  it('rounds a fractional level', () => {
    expect(clampLevel(3.4)).toBe(3);
    expect(clampLevel(3.6)).toBe(4);
  });

  it('falls back to Working rather than NaN when the form posts nonsense', () => {
    expect(clampLevel(Number.NaN)).toBe(3);
    expect(clampLevel(Number.parseInt('not a number', 10))).toBe(3);
  });
});

describe('SKILL_LEVELS', () => {
  it('covers the whole 1–5 ladder with no gaps', () => {
    expect(SKILL_LEVELS.map((row) => row.value)).toEqual([1, 2, 3, 4, 5]);
  });

  it('names every level it can be asked about', () => {
    expect(levelLabel(3)).toBe('Working');
    expect(levelLabel(5)).toBe('Expert');
    // Clamped first, so a stored level outside the ladder still gets a word.
    expect(levelLabel(42)).toBe('Expert');
  });
});

describe('CLAIM_STATUS_LABEL', () => {
  it('tells a student who they are waiting for rather than just "pending"', () => {
    expect(CLAIM_STATUS_LABEL.PENDING_REVIEW).toBe('Awaiting verification');
  });
});

describe('claimBlockedReason', () => {
  it('allows a first claim', () => {
    expect(claimBlockedReason({ hasPendingClaim: false, alreadyVerified: false })).toBeNull();
  });

  it('refuses a second claim for a skill already waiting in the queue', () => {
    expect(claimBlockedReason({ hasPendingClaim: true, alreadyVerified: false })).toContain(
      'waiting with your mentor',
    );
  });

  it('refuses a claim for a skill that is already verified', () => {
    expect(claimBlockedReason({ hasPendingClaim: false, alreadyVerified: true })).toContain(
      'already verified',
    );
  });

  it('leads with the verified message when both are true', () => {
    // A student re-uploading against a verified skill should be told it is
    // already done, not that they are queued behind themselves.
    expect(claimBlockedReason({ hasPendingClaim: true, alreadyVerified: true })).toContain(
      'already verified',
    );
  });
});
