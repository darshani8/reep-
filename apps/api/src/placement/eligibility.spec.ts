import { eligibleFor, type EligibilityCriteria, type StudentEligibilityFacts } from './eligibility';

/**
 * The gate is the one place a student is told they cannot apply, so every branch
 * that blocks them is asserted here — a silently-wrong rule would either bar an
 * eligible student or admit an ineligible one to a drive.
 */

const CRITERIA: EligibilityCriteria = { minCgpa: 6.0, maxLiveBacklogs: 0, maxGapMonths: 24 };

const CLEAR: StudentEligibilityFacts = {
  placementEligible: true,
  latestCgpa: 8.5,
  liveBacklogs: 0,
  totalGapMonths: 0,
  interestedInJobs: true,
  interestedInInternships: true,
};

const JOB = { roleType: 'FULL_TIME' as const };
const INTERN = { roleType: 'INTERNSHIP' as const };

describe('eligibleFor', () => {
  it('admits a clear student', () => {
    const r = eligibleFor(CLEAR, CRITERIA, JOB);
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('bars an account the placement office has not cleared', () => {
    const r = eligibleFor({ ...CLEAR, placementEligible: false }, CRITERIA, JOB);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toContain('placement office');
  });

  it('blocks a CGPA below the cut-off', () => {
    const r = eligibleFor({ ...CLEAR, latestCgpa: 5.4 }, CRITERIA, JOB);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('5.40') && x.includes('6.00'))).toBe(true);
  });

  it('treats a missing CGPA as unassessed, not disqualified', () => {
    // A fresher with no marks imported yet is not barred from the whole board;
    // the office flag, backlogs and gap are the hard gates.
    const r = eligibleFor({ ...CLEAR, latestCgpa: null }, CRITERIA, JOB);
    expect(r.eligible).toBe(true);
  });

  it('blocks a live backlog when the drive needs none', () => {
    const r = eligibleFor({ ...CLEAR, liveBacklogs: 1 }, CRITERIA, JOB);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('live backlog'))).toBe(true);
  });

  it('allows backlogs up to the ceiling and blocks past it', () => {
    const lenient = { ...CRITERIA, maxLiveBacklogs: 2 };
    expect(eligibleFor({ ...CLEAR, liveBacklogs: 2 }, lenient, JOB).eligible).toBe(true);
    expect(eligibleFor({ ...CLEAR, liveBacklogs: 3 }, lenient, JOB).eligible).toBe(false);
  });

  it('blocks an academic gap over the limit', () => {
    const r = eligibleFor({ ...CLEAR, totalGapMonths: 30 }, CRITERIA, JOB);
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('gap of 30'))).toBe(true);
  });

  it('respects role interest — an intern-only student is not eligible for a job', () => {
    const internOnly = { ...CLEAR, interestedInJobs: false };
    expect(eligibleFor(internOnly, CRITERIA, JOB).eligible).toBe(false);
    expect(eligibleFor(internOnly, CRITERIA, INTERN).eligible).toBe(true);
  });

  it('a combined offer needs interest in either half', () => {
    const combined = { roleType: 'FULL_TIME_PLUS_INTERNSHIP' as const };
    expect(
      eligibleFor({ ...CLEAR, interestedInJobs: false, interestedInInternships: true }, CRITERIA, combined).eligible,
    ).toBe(true);
    expect(
      eligibleFor({ ...CLEAR, interestedInJobs: false, interestedInInternships: false }, CRITERIA, combined).eligible,
    ).toBe(false);
  });

  it('reports every failing reason at once, not just the first', () => {
    const r = eligibleFor(
      { ...CLEAR, placementEligible: false, latestCgpa: 4, liveBacklogs: 3 },
      CRITERIA,
      JOB,
    );
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
