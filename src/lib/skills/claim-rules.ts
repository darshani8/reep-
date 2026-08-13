/**
 * What a skill claim means, and when it becomes a fact.
 *
 * A badge is only worth something if it cannot be minted by uploading any file.
 * That is the whole design constraint here, and it produces one rule that the
 * rest of the feature is arranged around:
 *
 *   **Only a VERIFIED claim sets `StudentSkill.verified`.**
 *
 * Everything else — a pending claim, a rejected one, a self-declared skill with
 * no evidence behind it at all — is the student's word, shown to the student as
 * their word, and never counted towards a badge or a leaderboard score.
 *
 * The second decision is where the verdict comes from. There is exactly one
 * approval mechanism in this product: a mentor working the queue at
 * `/mentor/uploads`, deciding on the *file*. A claim does not get its own
 * review screen, its own reviewer role or its own set of buttons — it inherits
 * the verdict of the upload attached to it. `promotionFor` is that inheritance
 * written down: given the file's status and the claim's, what should happen to
 * the claim. A second queue would mean two places to grant a badge and, in
 * time, two answers to the same question.
 *
 * No `server-only` import and no Prisma import: this is the decision, and
 * `queries.ts` next door is the part that talks to the database. That split is
 * why the rule can be tested from a bare Node process.
 */

import type { UploadStatus } from '@prisma/client';

import type { Tone } from '@/components/tone';

/// The 1–5 ladder `StudentSkill.level` and `SkillClaim.claimedLevel` are drawn
/// on. Words rather than bare numbers, because "3" means nothing on a form and
/// "Working knowledge" means something a student can honestly answer.
export const SKILL_LEVELS: readonly { value: number; label: string; help: string }[] = [
  { value: 1, label: 'Aware', help: 'You know what it is and have seen it used.' },
  { value: 2, label: 'Beginner', help: 'You have followed a tutorial or a course module.' },
  { value: 3, label: 'Working', help: 'You can use it on coursework without help.' },
  { value: 4, label: 'Proficient', help: 'You use it confidently and can explain it to others.' },
  { value: 5, label: 'Expert', help: 'You have applied it on a real project or internship.' },
];

export const MIN_SKILL_LEVEL = 1;
export const MAX_SKILL_LEVEL = 5;

/// Level as a word, for anywhere a number would be read as a score out of five.
export function levelLabel(level: number): string {
  return SKILL_LEVELS.find((row) => row.value === clampLevel(level))?.label ?? 'Working';
}

/**
 * A level that is inside the ladder.
 *
 * The claim form posts this, so it is attacker-controlled — and a level of 900
 * would sort to the top of every skill list on the profile. Clamped rather than
 * rejected because the number is a detail of a request whose real payload is
 * the certificate; refusing the whole upload over it would lose the file.
 */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 3;
  return Math.max(MIN_SKILL_LEVEL, Math.min(MAX_SKILL_LEVEL, Math.round(level)));
}

/// How each status is spoken about to the *student*. A mentor's queue says
/// "Pending"; a student is owed a sentence that says who they are waiting for.
export const CLAIM_STATUS_LABEL: Record<UploadStatus, string> = {
  PENDING_REVIEW: 'Awaiting verification',
  VERIFIED: 'Verified',
  REJECTED: 'Not accepted',
};

export const CLAIM_STATUS_TONE: Record<UploadStatus, Tone> = {
  PENDING_REVIEW: 'warning',
  VERIFIED: 'good',
  REJECTED: 'critical',
};

/**
 * What should happen to a claim, given the verdict on the file behind it.
 *
 * Two guards, both of which matter:
 *
 *  - a claim that has already been decided is never re-decided. Re-running this
 *    over the whole table has to be safe, because it runs on every load of
 *    `/student/skilling`, and a mentor who rejected a claim should not have
 *    that overturned by a later edit to the upload row.
 *  - a file still in the queue promotes nothing. This is the rule that stops a
 *    badge being minted by uploading a file: the student controls the upload,
 *    the mentor controls its status, and only the latter moves anything.
 */
export type ClaimPromotion =
  /// Leave the claim alone.
  | { kind: 'unchanged' }
  /// Grant it: mark the claim VERIFIED and light the badge at this level.
  | { kind: 'verify'; level: number }
  /// Refuse it: mark the claim REJECTED and touch no skill.
  | { kind: 'reject' };

export function promotionFor(
  claim: { status: UploadStatus; claimedLevel: number },
  upload: { status: UploadStatus },
): ClaimPromotion {
  if (claim.status !== 'PENDING_REVIEW') return { kind: 'unchanged' };
  if (upload.status === 'PENDING_REVIEW') return { kind: 'unchanged' };
  if (upload.status === 'REJECTED') return { kind: 'reject' };
  return { kind: 'verify', level: clampLevel(claim.claimedLevel) };
}

/**
 * Whether a claim may be filed for this skill at all.
 *
 * A second pending claim for the same skill is not a stronger case, it is two
 * files in a mentor's queue saying the same thing. A student who uploaded the
 * wrong certificate deletes it from `/student/uploads` — the claim cascades
 * with it — and files again.
 */
export function claimBlockedReason(existing: {
  hasPendingClaim: boolean;
  alreadyVerified: boolean;
}): string | null {
  if (existing.alreadyVerified) {
    return 'That skill is already verified on your profile.';
  }
  if (existing.hasPendingClaim) {
    return 'You already have a claim for that skill waiting with your mentor.';
  }
  return null;
}
