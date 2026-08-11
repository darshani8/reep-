/**
 * The REEP progress formulas, in one place.
 *
 * Everything the wireframes call out in "Notes for tech team" is implemented
 * here so that the screens stay dumb and the maths stays testable:
 *
 *  - stage %          = weighted avg of (teaching-hours attended +
 *                       certification-hours completed) across that stage's courses
 *  - dimension score  = rolls up from each course's tagged Developmental Dimension
 *  - pace status      = actual-vs-expected completion curve
 *  - 'Overdue'        = hours-per-week pace below the expected completion curve
 */

import type {
  Certification,
  CertificationProgress,
  Course,
  Dimension,
  Enrollment,
  PaceStatus,
  Stage,
} from '@prisma/client';

import { DIMENSION_ORDER, STAGE_ORDER, clamp } from './reep';

export type EnrollmentWithCourse = Enrollment & { course: Course };
export type CertProgressWithCert = CertificationProgress & {
  cert: Certification & { course: Course };
};

/// How far below the expected curve a student may drift before each label.
export const DEFAULT_PACE_THRESHOLDS = {
  behindDeviationPct: 10,
  atRiskDeviationPct: 25,
} as const;

export type PaceThresholds = typeof DEFAULT_PACE_THRESHOLDS;

// ---------------------------------------------------------------------------
// Course-level completion
// ---------------------------------------------------------------------------

/**
 * A single course's completion, blending the two things a REEP course is made
 * of: instructor-led hours attended and self-learning (certification) hours.
 *
 * Courses that carry no teaching hours (pure supervised self-learn) collapse to
 * the self-learning term, and vice versa — no divide-by-zero, no fake credit.
 */
export function courseCompletionPct(
  enrollment: EnrollmentWithCourse,
  certs: CertProgressWithCert[],
): number {
  const { course } = enrollment;

  const teachingRequired = course.teachingHours;
  const selfRequired = course.selfLearningHoursRequired;

  const teachingDone = Math.min(enrollment.teachingHoursAttended, teachingRequired);

  // Certification hours *earned*, i.e. required hours scaled by provider %.
  const courseCerts = certs.filter((c) => c.cert.courseCode === course.code);
  const certHoursEarned = courseCerts.reduce(
    (sum, c) => sum + (c.cert.requiredHours * c.progressPct) / 100,
    0,
  );
  const certHoursRequired = courseCerts.reduce((sum, c) => sum + c.cert.requiredHours, 0);

  // Prefer certification hours as the self-learning measure when the course has
  // certifications attached; otherwise fall back to raw logged hours.
  const selfDone =
    certHoursRequired > 0
      ? Math.min(certHoursEarned, selfRequired || certHoursRequired)
      : Math.min(enrollment.selfLearningHoursLogged, selfRequired);
  const selfDenominator =
    certHoursRequired > 0 ? selfRequired || certHoursRequired : selfRequired;

  const numerator = teachingDone + selfDone;
  const denominator = teachingRequired + selfDenominator;

  if (denominator <= 0) {
    // Pure lecture-count course (e.g. "Lecture 5/8").
    if (enrollment.lecturesTotal > 0) {
      return clamp((enrollment.lecturesAttended / enrollment.lecturesTotal) * 100);
    }
    return 0;
  }

  return clamp((numerator / denominator) * 100);
}

/// Total hours a course is worth — used as the weight in the stage average.
export function courseWeight(course: Course): number {
  const total = course.teachingHours + course.selfLearningHoursRequired;
  return total > 0 ? total : 1;
}

// ---------------------------------------------------------------------------
// Stage-level completion (the journey rail on Screen 1)
// ---------------------------------------------------------------------------

export type StageProgress = {
  stage: Stage;
  pct: number;
  courseCount: number;
  completedCourses: number;
};

export function stageProgress(
  enrollments: EnrollmentWithCourse[],
  certs: CertProgressWithCert[],
): StageProgress[] {
  return STAGE_ORDER.map((stage) => {
    const inStage = enrollments.filter((e) => e.course.stage === stage);
    if (inStage.length === 0) {
      return { stage, pct: 0, courseCount: 0, completedCourses: 0 };
    }

    let weighted = 0;
    let weight = 0;
    let completed = 0;

    for (const enrollment of inStage) {
      const w = courseWeight(enrollment.course);
      const pct = courseCompletionPct(enrollment, certs);
      weighted += pct * w;
      weight += w;
      if (enrollment.status === 'COMPLETED' || pct >= 99.5) completed += 1;
    }

    return {
      stage,
      pct: weight > 0 ? clamp(weighted / weight) : 0,
      courseCount: inStage.length,
      completedCourses: completed,
    };
  });
}

/// Single "Overall %" figure for the mentor roster and director analytics.
export function overallCompletionPct(
  enrollments: EnrollmentWithCourse[],
  certs: CertProgressWithCert[],
): number {
  if (enrollments.length === 0) return 0;
  let weighted = 0;
  let weight = 0;
  for (const enrollment of enrollments) {
    const w = courseWeight(enrollment.course);
    weighted += courseCompletionPct(enrollment, certs) * w;
    weight += w;
  }
  return weight > 0 ? clamp(weighted / weight) : 0;
}

// ---------------------------------------------------------------------------
// Developmental Dimensions (Screen 1, left card)
// ---------------------------------------------------------------------------

export type DimensionScore = { dimension: Dimension; pct: number; courseCount: number };

export function dimensionScores(
  enrollments: EnrollmentWithCourse[],
  certs: CertProgressWithCert[],
): DimensionScore[] {
  return DIMENSION_ORDER.map((dimension) => {
    const inDim = enrollments.filter((e) => e.course.dimension === dimension);
    if (inDim.length === 0) return { dimension, pct: 0, courseCount: 0 };

    let weighted = 0;
    let weight = 0;
    for (const enrollment of inDim) {
      const w = courseWeight(enrollment.course);
      weighted += courseCompletionPct(enrollment, certs) * w;
      weight += w;
    }
    return {
      dimension,
      pct: weight > 0 ? clamp(weighted / weight) : 0,
      courseCount: inDim.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Expected completion curve → pace status
// ---------------------------------------------------------------------------

/**
 * Expected completion % at `now` for something that starts at `startedAt` and
 * is due at `dueDate`. Linear ramp — deliberately simple so a coordinator can
 * explain it to a student without hand-waving.
 */
export function expectedPct(startedAt: Date, dueDate: Date, now = new Date()): number {
  const total = dueDate.getTime() - startedAt.getTime();
  if (total <= 0) return 100;
  const elapsed = now.getTime() - startedAt.getTime();
  return clamp((elapsed / total) * 100);
}

export type PaceEvaluation = {
  actualPct: number;
  expectedPct: number;
  deviationPct: number;
  status: PaceStatus;
};

export function evaluatePace(
  actual: number,
  expected: number,
  thresholds: PaceThresholds = DEFAULT_PACE_THRESHOLDS,
): PaceEvaluation {
  const deviation = actual - expected;
  let status: PaceStatus = 'ON_TRACK';
  if (deviation < -thresholds.atRiskDeviationPct) status = 'AT_RISK';
  else if (deviation < -thresholds.behindDeviationPct) status = 'BEHIND';
  return {
    actualPct: clamp(actual),
    expectedPct: clamp(expected),
    deviationPct: deviation,
    status,
  };
}

/**
 * Cohort-wide certification pace for one student: weight every required
 * certification by its hours so a 40-hour specialisation counts more than a
 * 4-hour short course.
 */
export function certificationPace(
  certs: CertProgressWithCert[],
  now = new Date(),
  thresholds: PaceThresholds = DEFAULT_PACE_THRESHOLDS,
): PaceEvaluation {
  const required = certs.filter((c) => !c.cert.isOptional);
  if (required.length === 0) {
    return { actualPct: 0, expectedPct: 0, deviationPct: 0, status: 'ON_TRACK' };
  }

  let actualWeighted = 0;
  let expectedWeighted = 0;
  let weight = 0;

  for (const c of required) {
    const w = c.cert.requiredHours || 1;
    // Certs the student has not opened yet still count against the curve; we
    // assume they were assigned `dueWeek` weeks before their due date.
    const startedAt =
      c.startedAt ?? new Date(c.dueDate.getTime() - c.cert.dueWeek * 7 * 86_400_000);
    actualWeighted += c.progressPct * w;
    expectedWeighted += expectedPct(startedAt, c.dueDate, now) * w;
    weight += w;
  }

  return evaluatePace(actualWeighted / weight, expectedWeighted / weight, thresholds);
}

/**
 * Status for a single certification row on Screen 2.
 * 'Overdue' means the pace has fallen below the expected completion curve —
 * not merely that the date passed, which is what the wireframe note specifies.
 */
export function certificationStatus(
  cert: CertProgressWithCert,
  now = new Date(),
  thresholds: PaceThresholds = DEFAULT_PACE_THRESHOLDS,
): { status: CertificationProgress['status']; pace: PaceEvaluation } {
  const startedAt =
    cert.startedAt ??
    new Date(cert.dueDate.getTime() - cert.cert.dueWeek * 7 * 86_400_000);
  const pace = evaluatePace(
    cert.progressPct,
    expectedPct(startedAt, cert.dueDate, now),
    thresholds,
  );

  if (cert.progressPct >= 99.5 || cert.completedAt) {
    return { status: 'COMPLETED', pace };
  }
  if (now > cert.dueDate || pace.status === 'AT_RISK') {
    return { status: 'OVERDUE', pace };
  }
  if (cert.progressPct > 0) return { status: 'IN_PROGRESS', pace };
  return { status: 'NOT_STARTED', pace };
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export function attendancePct(records: { present: boolean }[]): number {
  if (records.length === 0) return 100;
  const present = records.filter((r) => r.present).length;
  return clamp((present / records.length) * 100);
}

// ---------------------------------------------------------------------------
// Placement readiness (director-configurable composite)
// ---------------------------------------------------------------------------

export type PlacementInputs = {
  reepCompletionPct: number;
  certCompletionPct: number;
  attendancePct: number;
  coreCertsComplete: boolean;
};

export type PlacementCriteriaShape = {
  minReepCompletionPct: number;
  minCertCompletionPct: number;
  minAttendancePct: number;
  requireCoreCerts: boolean;
};

export type PlacementEvaluation = {
  ready: boolean;
  failed: string[];
  checks: { label: string; passed: boolean; actual: string; required: string }[];
};

export function evaluatePlacementReadiness(
  inputs: PlacementInputs,
  criteria: PlacementCriteriaShape,
): PlacementEvaluation {
  const checks = [
    {
      label: 'REEP completion',
      passed: inputs.reepCompletionPct >= criteria.minReepCompletionPct,
      actual: `${inputs.reepCompletionPct.toFixed(0)}%`,
      required: `≥ ${criteria.minReepCompletionPct}%`,
    },
    {
      label: 'Certification completion',
      passed: inputs.certCompletionPct >= criteria.minCertCompletionPct,
      actual: `${inputs.certCompletionPct.toFixed(0)}%`,
      required: `≥ ${criteria.minCertCompletionPct}%`,
    },
    {
      label: 'Attendance',
      passed: inputs.attendancePct >= criteria.minAttendancePct,
      actual: `${inputs.attendancePct.toFixed(0)}%`,
      required: `≥ ${criteria.minAttendancePct}%`,
    },
    ...(criteria.requireCoreCerts
      ? [
          {
            label: 'Core certifications',
            passed: inputs.coreCertsComplete,
            actual: inputs.coreCertsComplete ? 'All complete' : 'Incomplete',
            required: 'All complete',
          },
        ]
      : []),
  ];

  return {
    ready: checks.every((c) => c.passed),
    failed: checks.filter((c) => !c.passed).map((c) => c.label),
    checks,
  };
}
