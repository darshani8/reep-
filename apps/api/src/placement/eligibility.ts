/**
 * Whether a student may apply to an opportunity — the gate pod.ai's
 * Opportunities tab puts in front of every posting, ported to REEP's own rules.
 *
 * Pure and total: facts + criteria + opportunity in, a decision and its reasons
 * out. No Prisma, no request — so the rule is testable on its own and cannot
 * drift into a query, the same discipline as the leaderboard scope and the
 * time-sheet rules. `reasons` lists why a student is BLOCKED (empty when
 * eligible), so the UI can tell them exactly what to fix rather than a bare
 * "not eligible".
 *
 * The four gates are the ones Indian campus recruiters actually filter on, and
 * the same ones the decoded pod.ai academic model exists to answer: an
 * admin/placement-office flag, a CGPA floor, a live-backlog ceiling, and an
 * academic-gap ceiling — plus the student's own interest in the role type.
 */

export type OfferRoleType = 'FULL_TIME' | 'FULL_TIME_PLUS_INTERNSHIP' | 'INTERNSHIP';

/// Director-set thresholds, from the active `PlacementCriteria` row.
export interface EligibilityCriteria {
  minCgpa: number;
  maxLiveBacklogs: number;
  maxGapMonths: number;
}

/// What the engine needs to know about a student, gathered by the caller.
export interface StudentEligibilityFacts {
  /// The placement office's own gate. False bars the student outright, whatever
  /// their marks — a backlog, a disciplinary hold, a policy opt-out.
  placementEligible: boolean;
  /// The most recent published CGPA, or null when none is on record yet.
  latestCgpa: number | null;
  /// Backlogs not yet cleared. A "no live backlogs" posting gates on this.
  liveBacklogs: number;
  /// Total months of academic gap across all stages.
  totalGapMonths: number;
  interestedInJobs: boolean;
  interestedInInternships: boolean;
}

/// The opportunity being tested. Kept minimal; extend with an eligible-courses
/// list if per-branch rules are ever needed.
export interface Opportunity {
  roleType: OfferRoleType;
}

export interface EligibilityResult {
  eligible: boolean;
  /// Why the student is blocked. Empty exactly when `eligible` is true.
  reasons: string[];
}

/// True when the role calls for a job the student wants, an internship they
/// want, or a combined offer they want either half of.
function interestMatches(role: OfferRoleType, facts: StudentEligibilityFacts): boolean {
  switch (role) {
    case 'FULL_TIME':
      return facts.interestedInJobs;
    case 'INTERNSHIP':
      return facts.interestedInInternships;
    case 'FULL_TIME_PLUS_INTERNSHIP':
      return facts.interestedInJobs || facts.interestedInInternships;
  }
}

export function eligibleFor(
  facts: StudentEligibilityFacts,
  criteria: EligibilityCriteria,
  opportunity: Opportunity,
): EligibilityResult {
  const reasons: string[] = [];

  if (!facts.placementEligible) {
    reasons.push('The placement office has not cleared this account for placements.');
  }

  // A missing CGPA means "not assessed yet", not "disqualified" — REEP imports
  // marks from the office, and a fresher with none on record should not be
  // barred from the whole board. Only an actual below-cut-off CGPA blocks; the
  // hard gates are the office flag, backlogs and gap.
  if (facts.latestCgpa != null && facts.latestCgpa < criteria.minCgpa) {
    reasons.push(
      `CGPA ${facts.latestCgpa.toFixed(2)} is below the ${criteria.minCgpa.toFixed(2)} cut-off.`,
    );
  }

  if (facts.liveBacklogs > criteria.maxLiveBacklogs) {
    reasons.push(
      criteria.maxLiveBacklogs === 0
        ? `${facts.liveBacklogs} live backlog${facts.liveBacklogs === 1 ? '' : 's'} — this drive needs none.`
        : `${facts.liveBacklogs} live backlogs exceed the limit of ${criteria.maxLiveBacklogs}.`,
    );
  }

  if (facts.totalGapMonths > criteria.maxGapMonths) {
    reasons.push(
      `Academic gap of ${facts.totalGapMonths} months exceeds the ${criteria.maxGapMonths}-month limit.`,
    );
  }

  if (!interestMatches(opportunity.roleType, facts)) {
    reasons.push('You have marked yourself not interested in this kind of role.');
  }

  return { eligible: reasons.length === 0, reasons };
}
