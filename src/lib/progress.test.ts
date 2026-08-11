import { describe, expect, it } from 'vitest';

import { makeCertProgress, makeEnrollment } from '../../test/fixtures';
import type { PaceThresholds } from './progress';
import {
  DEFAULT_PACE_THRESHOLDS,
  attendancePct,
  certificationPace,
  certificationStatus,
  courseCompletionPct,
  courseWeight,
  dimensionScores,
  evaluatePace,
  evaluatePlacementReadiness,
  expectedPct,
  overallCompletionPct,
  stageProgress,
} from './progress';

describe('courseCompletionPct', () => {
  it('blends attended teaching hours with logged self-learning hours', () => {
    const enrollment = makeEnrollment({
      teachingHoursAttended: 10,
      selfLearningHoursLogged: 10,
      course: { teachingHours: 20, selfLearningHoursRequired: 20 },
    });

    expect(courseCompletionPct(enrollment, [])).toBe(50);
  });

  it('is zero for a student who has done nothing', () => {
    expect(courseCompletionPct(makeEnrollment(), [])).toBe(0);
  });

  it('caps at 100 when a student over-attends', () => {
    const enrollment = makeEnrollment({
      teachingHoursAttended: 40,
      selfLearningHoursLogged: 40,
      course: { teachingHours: 20, selfLearningHoursRequired: 20 },
    });

    expect(courseCompletionPct(enrollment, [])).toBe(100);
  });

  it('collapses to the self-learning term for a course with no teaching hours', () => {
    const enrollment = makeEnrollment({
      selfLearningHoursLogged: 15,
      course: { teachingHours: 0, selfLearningHoursRequired: 30 },
    });

    expect(courseCompletionPct(enrollment, [])).toBe(50);
  });

  it('collapses to the teaching term for a course with no self-learning', () => {
    const enrollment = makeEnrollment({
      teachingHoursAttended: 15,
      course: { teachingHours: 30, selfLearningHoursRequired: 0 },
    });

    expect(courseCompletionPct(enrollment, [])).toBe(50);
  });

  it('prefers certification progress over raw logged hours when certs are attached', () => {
    const enrollment = makeEnrollment({
      // Raw logged hours claim the full 20; the certificate says otherwise.
      selfLearningHoursLogged: 20,
      teachingHoursAttended: 20,
      course: { teachingHours: 20, selfLearningHoursRequired: 20 },
    });
    const certs = [makeCertProgress({ progressPct: 50, cert: { requiredHours: 20 } })];

    // 20 teaching + (20 required cert hours × 50%) = 30 of 40.
    expect(courseCompletionPct(enrollment, certs)).toBe(75);
  });

  it('ignores certifications belonging to another course', () => {
    const enrollment = makeEnrollment({
      teachingHoursAttended: 20,
      course: { code: 'REE101', teachingHours: 20, selfLearningHoursRequired: 20 },
    });
    const certs = [
      makeCertProgress({
        progressPct: 100,
        certCode: 'C-OTHER',
        cert: { courseCode: 'REE202', requiredHours: 20 },
      }),
    ];

    // The other course's certificate must not credit this one.
    expect(courseCompletionPct(enrollment, certs)).toBe(50);
  });

  it('falls back to the lecture count for a pure lecture course', () => {
    const enrollment = makeEnrollment({
      lecturesAttended: 5,
      lecturesTotal: 8,
      course: { teachingHours: 0, selfLearningHoursRequired: 0 },
    });

    expect(courseCompletionPct(enrollment, [])).toBeCloseTo(62.5, 5);
  });

  it('returns 0 rather than NaN when a course carries no hours and no lectures', () => {
    // The divide-by-zero guard. A course seeded with nothing must not put NaN%
    // on a student's dashboard.
    const enrollment = makeEnrollment({
      lecturesTotal: 0,
      course: { teachingHours: 0, selfLearningHoursRequired: 0 },
    });
    const pct = courseCompletionPct(enrollment, []);

    expect(Number.isNaN(pct)).toBe(false);
    expect(pct).toBe(0);
  });

  it('never returns a value outside 0–100 for any plausible input', () => {
    const cases = [
      makeEnrollment({ teachingHoursAttended: -5, course: { teachingHours: 10 } }),
      makeEnrollment({ selfLearningHoursLogged: 1e6, course: { selfLearningHoursRequired: 1 } }),
      makeEnrollment({ lecturesAttended: 12, lecturesTotal: 8, course: { teachingHours: 0, selfLearningHoursRequired: 0 } }),
    ];

    for (const enrollment of cases) {
      const pct = courseCompletionPct(enrollment, []);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});

describe('courseWeight', () => {
  it('weighs a course by its total hours', () => {
    expect(courseWeight(makeEnrollment({ course: { teachingHours: 20, selfLearningHoursRequired: 30 } }).course)).toBe(50);
  });

  it('gives an hour-less course weight 1 so it cannot zero out a stage average', () => {
    expect(courseWeight(makeEnrollment({ course: { teachingHours: 0, selfLearningHoursRequired: 0 } }).course)).toBe(1);
  });
});

describe('stageProgress', () => {
  it('returns every stage in journey order, even those with no courses', () => {
    const stages = stageProgress([], []);

    expect(stages.map((s) => s.stage)).toEqual([
      'REBOOT',
      'EXCEL',
      'EXCEL_ADVANCED',
      'ELEVATE',
    ]);
    expect(stages.every((s) => s.pct === 0 && s.courseCount === 0)).toBe(true);
  });

  it('weights the average by course hours rather than treating courses as equal', () => {
    const enrollments = [
      makeEnrollment({
        id: 'a',
        courseCode: 'BIG',
        teachingHoursAttended: 0,
        course: { code: 'BIG', stage: 'REBOOT', teachingHours: 90, selfLearningHoursRequired: 0 },
      }),
      makeEnrollment({
        id: 'b',
        courseCode: 'SMALL',
        teachingHoursAttended: 10,
        course: { code: 'SMALL', stage: 'REBOOT', teachingHours: 10, selfLearningHoursRequired: 0 },
      }),
    ];
    const reboot = stageProgress(enrollments, [])[0];

    // 100% of a 10-hour course against 0% of a 90-hour one is 10%, not 50%.
    expect(reboot.pct).toBe(10);
    expect(reboot.courseCount).toBe(2);
  });

  it('counts a course complete on status even when the hours do not add up', () => {
    const enrollments = [
      makeEnrollment({ status: 'COMPLETED', course: { stage: 'REBOOT' } }),
    ];

    expect(stageProgress(enrollments, [])[0].completedCourses).toBe(1);
  });

  it('counts a course complete at 99.5% so floating-point dust does not withhold it', () => {
    const enrollments = [
      makeEnrollment({
        teachingHoursAttended: 99.9,
        course: { stage: 'REBOOT', teachingHours: 100, selfLearningHoursRequired: 0 },
      }),
    ];

    expect(stageProgress(enrollments, [])[0].completedCourses).toBe(1);
  });
});

describe('overallCompletionPct', () => {
  it('is 0 for a student with no enrolments rather than NaN', () => {
    expect(overallCompletionPct([], [])).toBe(0);
  });

  it('weights across stages by hours', () => {
    const enrollments = [
      makeEnrollment({
        id: 'a',
        courseCode: 'A',
        teachingHoursAttended: 20,
        course: { code: 'A', stage: 'REBOOT', teachingHours: 20, selfLearningHoursRequired: 0 },
      }),
      makeEnrollment({
        id: 'b',
        courseCode: 'B',
        teachingHoursAttended: 0,
        course: { code: 'B', stage: 'EXCEL', teachingHours: 60, selfLearningHoursRequired: 0 },
      }),
    ];

    expect(overallCompletionPct(enrollments, [])).toBe(25);
  });
});

describe('dimensionScores', () => {
  it('reports all four dimensions even when a student has none of them', () => {
    const scores = dimensionScores([], []);

    expect(scores).toHaveLength(4);
    expect(scores.every((s) => s.pct === 0 && s.courseCount === 0)).toBe(true);
  });

  it('rolls a course up under its tagged dimension only', () => {
    const enrollments = [
      makeEnrollment({
        teachingHoursAttended: 20,
        course: { dimension: 'TECHNICAL', teachingHours: 20, selfLearningHoursRequired: 0 },
      }),
    ];
    const byDimension = new Map(dimensionScores(enrollments, []).map((s) => [s.dimension, s]));

    expect(byDimension.get('TECHNICAL')!.pct).toBe(100);
    expect(byDimension.get('PROFESSIONAL')!.pct).toBe(0);
    expect(byDimension.get('PROFESSIONAL')!.courseCount).toBe(0);
  });
});

describe('expectedPct', () => {
  const startedAt = new Date(2026, 0, 1);
  const dueDate = new Date(2026, 0, 11); // ten days

  it('is 0 at the start and 100 at the deadline', () => {
    expect(expectedPct(startedAt, dueDate, startedAt)).toBe(0);
    expect(expectedPct(startedAt, dueDate, dueDate)).toBe(100);
  });

  it('ramps linearly in between', () => {
    expect(expectedPct(startedAt, dueDate, new Date(2026, 0, 6))).toBe(50);
  });

  it('clamps to 0 before the start and 100 after the deadline', () => {
    expect(expectedPct(startedAt, dueDate, new Date(2025, 11, 1))).toBe(0);
    expect(expectedPct(startedAt, dueDate, new Date(2026, 5, 1))).toBe(100);
  });

  it('returns 100 rather than dividing by zero when the window is empty or inverted', () => {
    expect(expectedPct(startedAt, startedAt, startedAt)).toBe(100);
    expect(expectedPct(dueDate, startedAt, startedAt)).toBe(100);
  });
});

describe('evaluatePace', () => {
  it('is ON_TRACK when actual matches or beats expected', () => {
    expect(evaluatePace(80, 80).status).toBe('ON_TRACK');
    expect(evaluatePace(95, 80).status).toBe('ON_TRACK');
  });

  it('stays ON_TRACK exactly at the behind threshold', () => {
    // Strictly-less-than: a student exactly 10 points down is not yet "behind".
    const { behindDeviationPct } = DEFAULT_PACE_THRESHOLDS;

    expect(evaluatePace(80 - behindDeviationPct, 80).status).toBe('ON_TRACK');
  });

  it('is BEHIND one point past the behind threshold', () => {
    expect(evaluatePace(69, 80).status).toBe('BEHIND');
  });

  it('stays BEHIND exactly at the at-risk threshold and tips over one point later', () => {
    const { atRiskDeviationPct } = DEFAULT_PACE_THRESHOLDS;

    expect(evaluatePace(80 - atRiskDeviationPct, 80).status).toBe('BEHIND');
    expect(evaluatePace(80 - atRiskDeviationPct - 1, 80).status).toBe('AT_RISK');
  });

  it('reports the raw deviation but clamps the two percentages it echoes back', () => {
    const pace = evaluatePace(120, -20);

    expect(pace.actualPct).toBe(100);
    expect(pace.expectedPct).toBe(0);
    expect(pace.deviationPct).toBe(140);
  });

  it('honours custom thresholds at runtime', () => {
    // The cast is not incidental. `PaceThresholds` is `typeof
    // DEFAULT_PACE_THRESHOLDS` on an `as const` object, so the exported type is
    // the *literal* pair {10, 25} and no caller can pass anything else without
    // going around the type. The function is perfectly general; the type is what
    // makes the parameter unusable. See the defects suite.
    const strict = { behindDeviationPct: 1, atRiskDeviationPct: 25 } as unknown as PaceThresholds;

    expect(evaluatePace(78, 80, strict).status).toBe('BEHIND');
  });
});

describe('certificationPace', () => {
  const now = new Date(2026, 1, 1);

  it('is ON_TRACK at zero for a student with no required certifications', () => {
    expect(certificationPace([], now)).toEqual({
      actualPct: 0,
      expectedPct: 0,
      deviationPct: 0,
      status: 'ON_TRACK',
    });
  });

  it('ignores optional certifications entirely', () => {
    const optionalOnly = [
      makeCertProgress({ progressPct: 0, cert: { isOptional: true, requiredHours: 40 } }),
    ];

    expect(certificationPace(optionalOnly, now).status).toBe('ON_TRACK');
    expect(certificationPace(optionalOnly, now).actualPct).toBe(0);
  });

  it('weights a long specialisation above a short course', () => {
    const certs = [
      makeCertProgress({
        id: 'long',
        certCode: 'LONG',
        progressPct: 0,
        cert: { code: 'LONG', requiredHours: 40 },
        startedAt: new Date(2026, 0, 1),
        dueDate: new Date(2026, 2, 1),
      }),
      makeCertProgress({
        id: 'short',
        certCode: 'SHORT',
        progressPct: 100,
        cert: { code: 'SHORT', requiredHours: 4 },
        startedAt: new Date(2026, 0, 1),
        dueDate: new Date(2026, 2, 1),
      }),
    ];

    // 100% of 4 hours against 0% of 40 is 9.09%, not 50%.
    expect(certificationPace(certs, now).actualPct).toBeCloseTo(9.09, 1);
  });

  it('counts an unopened certification against the curve rather than skipping it', () => {
    const certs = [
      makeCertProgress({
        progressPct: 0,
        startedAt: null,
        dueDate: new Date(2026, 2, 1),
        cert: { requiredHours: 20, dueWeek: 8 },
      }),
    ];

    // startedAt is inferred as dueWeek before the deadline, so by 1 Feb the
    // student is expected to have made progress and has made none.
    expect(certificationPace(certs, now).expectedPct).toBeGreaterThan(0);
    expect(certificationPace(certs, now).deviationPct).toBeLessThan(0);
  });

  it('does not divide by zero when a certification is worth no hours', () => {
    const certs = [makeCertProgress({ progressPct: 50, cert: { requiredHours: 0 } })];

    expect(Number.isNaN(certificationPace(certs, now).actualPct)).toBe(false);
  });
});

describe('certificationStatus', () => {
  const dueDate = new Date(2026, 2, 1);

  it('is NOT_STARTED at zero progress inside the window', () => {
    const cert = makeCertProgress({
      progressPct: 0,
      startedAt: new Date(2026, 1, 20),
      dueDate,
    });

    expect(certificationStatus(cert, new Date(2026, 1, 21)).status).toBe('NOT_STARTED');
  });

  it('is IN_PROGRESS once there is any progress and the pace holds', () => {
    const cert = makeCertProgress({
      progressPct: 60,
      startedAt: new Date(2026, 1, 1),
      dueDate,
    });

    expect(certificationStatus(cert, new Date(2026, 1, 15)).status).toBe('IN_PROGRESS');
  });

  it('is COMPLETED at 99.5% without waiting for a completedAt', () => {
    const cert = makeCertProgress({ progressPct: 99.5, dueDate });

    expect(certificationStatus(cert, new Date(2026, 1, 1)).status).toBe('COMPLETED');
  });

  it('is COMPLETED on a recorded completion even if the percentage lags', () => {
    const cert = makeCertProgress({
      progressPct: 80,
      completedAt: new Date(2026, 1, 10),
      dueDate,
    });

    expect(certificationStatus(cert, new Date(2026, 1, 15)).status).toBe('COMPLETED');
  });

  it('is OVERDUE once the deadline passes with work outstanding', () => {
    const cert = makeCertProgress({ progressPct: 40, dueDate });

    expect(certificationStatus(cert, new Date(2026, 2, 2)).status).toBe('OVERDUE');
  });

  it('is OVERDUE before the deadline when the pace has fallen far enough behind', () => {
    // The wireframe note this implements: "Overdue" means below the curve, not
    // merely past the date.
    const cert = makeCertProgress({
      progressPct: 0,
      startedAt: new Date(2026, 0, 1),
      dueDate,
    });

    expect(certificationStatus(cert, new Date(2026, 1, 20)).status).toBe('OVERDUE');
  });

  it('does not call a finished certification overdue after its date', () => {
    const cert = makeCertProgress({
      progressPct: 100,
      completedAt: new Date(2026, 1, 1),
      dueDate,
    });

    expect(certificationStatus(cert, new Date(2026, 6, 1)).status).toBe('COMPLETED');
  });
});

describe('attendancePct', () => {
  it('is 100 for an empty register — nothing has been missed yet', () => {
    // Deliberate, and load-bearing for placement readiness: see the defects
    // suite for what it means for a student with no records at all.
    expect(attendancePct([])).toBe(100);
  });

  it('counts present against total', () => {
    expect(attendancePct([{ present: true }, { present: false }])).toBe(50);
    expect(attendancePct([{ present: true }, { present: true }])).toBe(100);
    expect(attendancePct([{ present: false }])).toBe(0);
  });
});

describe('evaluatePlacementReadiness', () => {
  const passing = {
    reepCompletionPct: 85,
    certCompletionPct: 90,
    attendancePct: 80,
    coreCertsComplete: true,
  };
  const criteria = {
    minReepCompletionPct: 80,
    minCertCompletionPct: 80,
    minAttendancePct: 75,
    requireCoreCerts: true,
  };

  it('passes a student who clears every bar', () => {
    const result = evaluatePlacementReadiness(passing, criteria);

    expect(result.ready).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.checks).toHaveLength(4);
  });

  it('treats each threshold as inclusive, so exactly on the bar is a pass', () => {
    const exact = {
      reepCompletionPct: 80,
      certCompletionPct: 80,
      attendancePct: 75,
      coreCertsComplete: true,
    };

    expect(evaluatePlacementReadiness(exact, criteria).ready).toBe(true);
  });

  it('fails one point under any single bar and names which', () => {
    const result = evaluatePlacementReadiness({ ...passing, attendancePct: 74 }, criteria);

    expect(result.ready).toBe(false);
    expect(result.failed).toEqual(['Attendance']);
  });

  it('names every failing criterion, not just the first', () => {
    const result = evaluatePlacementReadiness(
      { reepCompletionPct: 10, certCompletionPct: 10, attendancePct: 10, coreCertsComplete: false },
      criteria,
    );

    expect(result.failed).toHaveLength(4);
  });

  it('drops the core-certification check entirely when the director turns it off', () => {
    const result = evaluatePlacementReadiness(
      { ...passing, coreCertsComplete: false },
      { ...criteria, requireCoreCerts: false },
    );

    expect(result.checks).toHaveLength(3);
    expect(result.ready).toBe(true);
  });

  it('passes everyone when every bar is set to zero', () => {
    const result = evaluatePlacementReadiness(
      { reepCompletionPct: 0, certCompletionPct: 0, attendancePct: 0, coreCertsComplete: false },
      {
        minReepCompletionPct: 0,
        minCertCompletionPct: 0,
        minAttendancePct: 0,
        requireCoreCerts: false,
      },
    );

    expect(result.ready).toBe(true);
  });

  it('reports the actual and required figures alongside each verdict', () => {
    const check = evaluatePlacementReadiness(passing, criteria).checks[0];

    expect(check.actual).toBe('85%');
    expect(check.required).toBe('≥ 80%');
  });
});
