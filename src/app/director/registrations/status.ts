/**
 * How a registration status reads on screen.
 *
 * A module of its own because both the queue and the detail page render these,
 * and the two sit on opposite sides of the client boundary — the same reason
 * `tone.ts` exists apart from `kit.tsx`. Exhaustive `Record`s rather than a
 * switch with a default, so that adding a value to `RegistrationStatus` breaks
 * the build here instead of quietly rendering a raw enum name to a director.
 */

import type { RegistrationStatus } from '@prisma/client';

import type { Tone } from '@/components/tone';

export const STATUS_LABEL: Record<RegistrationStatus, string> = {
  DRAFT: 'Started, not submitted',
  PENDING_VERIFICATION: 'Waiting on the applicant',
  PENDING_REVIEW: 'Needs a decision',
  AUTO_APPROVED: 'Approved by rule',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/**
 * `AUTO_APPROVED` is `info`, not `good`.
 *
 * Both mean an account exists. The distinction the enum was given — which
 * admissions a rule waved through and which a human read — is only useful if it
 * is visible at a glance on the list, so the two do not share a colour.
 */
export const STATUS_TONE: Record<RegistrationStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_VERIFICATION: 'neutral',
  PENDING_REVIEW: 'warning',
  AUTO_APPROVED: 'info',
  APPROVED: 'good',
  REJECTED: 'critical',
};

/// Whether this application is still somebody's to act on.
export function isOpen(status: RegistrationStatus): boolean {
  return status === 'DRAFT' || status === 'PENDING_VERIFICATION' || status === 'PENDING_REVIEW';
}
