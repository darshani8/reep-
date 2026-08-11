/**
 * Assertions over the progress and analytics formulas.
 *
 * These are the calculations the whole product is arguing from — if
 * `stageProgress` or `focusQuality` drifts, every screen lies at once. Plain
 * tsx, no test runner, so it can run anywhere the seed can.
 *
 * Usage: npx tsx scripts/verify-formulas.ts
 */

import {
  classifySession,
  consistency,
  focusQuality,
  forecastCompletion,
  paceCurve,
  type SessionRow,
} from '../src/lib/analytics';
import {
  courseCompletionPct,
  evaluatePace,
  evaluatePlacementReadiness,
  expectedPct,
  stageProgress,
  type CertProgressWithCert,
  type EnrollmentWithCourse,
} from '../src/lib/progress';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, tolerance = 0.51) {
  return Math.abs(a - b) <= tolerance;
}

const DAY = 86_400_000;
const NOW = new Date('2026-08-04T09:00:00Z');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function course(overrides: Partial<EnrollmentWithCourse['course']> = {}) {
  return {
    code: 'REE900',
    name: 'Test Course',
    stage: 'EXCEL' as const,
    dimension: 'TECHNICAL' as const,
    semester: 1,
    teachingHours: 20,
    selfLearningHoursRequired: 80,
    modelType: 'TEACHING_PLUS_SELF_LEARN' as const,
    durationWeeks: 20,
    description: null,
    ...overrides,
  };
}

function enrollment(
  overrides: Partial<EnrollmentWithCourse> = {},
): EnrollmentWithCourse {
  return {
    id: 'e1',
    studentId: 's1',
    courseCode: 'REE900',
    status: 'IN_PROGRESS',
    teachingHoursAttended: 10,
    selfLearningHoursLogged: 40,
    lecturesAttended: 0,
    lecturesTotal: 0,
    startedAt: new Date('2026-06-01T00:00:00Z'),
    completedAt: null,
    course: course(),
    ...overrides,
  } as EnrollmentWithCourse;
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'x',
    courseCode: 'REE900',
    module: 'Module',
    mode: 'SUPERVISED_LAB',
    checkInAt: new Date(NOW.getTime() - DAY),
    checkOutAt: new Date(NOW.getTime() - DAY + 2 * 3_600_000),
    durationMin: 120,
    progressAtCheckIn: 10,
    progressAtCheckOut: 15,
    progressDeltaPct: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// progress.ts
// ---------------------------------------------------------------------------

// No certifications attached: completion falls back to raw logged hours,
// (10 teaching + 40 self) / (20 + 80) = 50%.
check(
  'courseCompletionPct — hours only',
  near(courseCompletionPct(enrollment(), []), 50),
  `got ${courseCompletionPct(enrollment(), []).toFixed(1)}`,
);

// A pure lecture course has no hour denominator; it must use the lecture count
// rather than dividing by zero.
const lectureOnly = enrollment({
  course: course({
    teachingHours: 0,
    selfLearningHoursRequired: 0,
    modelType: 'INSTRUCTOR_LED',
  }),
  lecturesAttended: 5,
  lecturesTotal: 8,
});
check(
  'courseCompletionPct — lecture-count course',
  near(courseCompletionPct(lectureOnly, []), 62.5),
  `got ${courseCompletionPct(lectureOnly, []).toFixed(1)}`,
);

check(
  'courseCompletionPct — never exceeds 100 when hours overrun',
  courseCompletionPct(
    enrollment({ teachingHoursAttended: 999, selfLearningHoursLogged: 999 }),
    [],
  ) <= 100,
);

// Stage rail: a stage with no enrolments must read 0, not NaN.
const stages = stageProgress([enrollment()], []);
check('stageProgress — returns all four stages', stages.length === 4);
check(
  'stageProgress — empty stage is 0 not NaN',
  stages.every((s) => Number.isFinite(s.pct)),
);
check(
  'stageProgress — EXCEL picks up the enrolment',
  near(stages.find((s) => s.stage === 'EXCEL')!.pct, 50),
);

// Expected-completion curve.
const start = new Date('2026-06-01T00:00:00Z');
const due = new Date('2026-08-01T00:00:00Z');
check(
  'expectedPct — midpoint is 50%',
  near(expectedPct(start, due, new Date('2026-07-01T00:00:00Z')), 50, 2),
);
check('expectedPct — clamps past the due date', expectedPct(start, due, NOW) === 100);
check(
  'expectedPct — zero-length window does not divide by zero',
  expectedPct(due, due, NOW) === 100,
);

// Pace bands.
check('evaluatePace — on track when ahead', evaluatePace(80, 60).status === 'ON_TRACK');
check('evaluatePace — on track inside 10%', evaluatePace(55, 60).status === 'ON_TRACK');
check('evaluatePace — behind past 10%', evaluatePace(45, 60).status === 'BEHIND');
check('evaluatePace — at risk past 25%', evaluatePace(30, 60).status === 'AT_RISK');

// Placement composite.
const strict = {
  minReepCompletionPct: 80,
  minCertCompletionPct: 75,
  minAttendancePct: 85,
  requireCoreCerts: true,
};
check(
  'placement — all criteria met',
  evaluatePlacementReadiness(
    { reepCompletionPct: 85, certCompletionPct: 90, attendancePct: 92, coreCertsComplete: true },
    strict,
  ).ready,
);
const failing = evaluatePlacementReadiness(
  { reepCompletionPct: 85, certCompletionPct: 90, attendancePct: 60, coreCertsComplete: true },
  strict,
);
check('placement — one failure blocks readiness', !failing.ready);
check(
  'placement — names the failing criterion',
  failing.failed.length === 1 && failing.failed[0] === 'Attendance',
  failing.failed.join(','),
);
check(
  'placement — core-cert check drops out when not required',
  evaluatePlacementReadiness(
    { reepCompletionPct: 85, certCompletionPct: 90, attendancePct: 92, coreCertsComplete: false },
    { ...strict, requireCoreCerts: false },
  ).ready,
);

// ---------------------------------------------------------------------------
// analytics.ts
// ---------------------------------------------------------------------------

check(
  'classifySession — a 12-minute visit is abandoned',
  classifySession(session({ durationMin: 12, progressDeltaPct: 0 })) === 'ABANDONED',
);
check(
  'classifySession — two hours for 5 points is productive',
  classifySession(session({ durationMin: 120, progressDeltaPct: 5 })) === 'PRODUCTIVE',
);
check(
  'classifySession — two hours for 0.5 points is low yield',
  classifySession(session({ durationMin: 120, progressDeltaPct: 0.5 })) === 'SHALLOW',
);
check(
  'classifySession — an open session is unverified',
  classifySession(session({ checkOutAt: null, durationMin: null })) === 'UNVERIFIED',
);

// The whole point of focus tracking: long hours with no progress score badly.
const busywork = Array.from({ length: 6 }, (_, i) =>
  session({ id: `b${i}`, durationMin: 150, progressDeltaPct: 0.2 }),
);
const productive = Array.from({ length: 6 }, (_, i) =>
  session({ id: `p${i}`, durationMin: 150, progressDeltaPct: 7 }),
);
const busyScore = focusQuality(busywork).focusScore;
const goodScore = focusQuality(productive).focusScore;
check(
  'focusQuality — time on seat does not earn a good score',
  busyScore < 45,
  `busywork scored ${busyScore}`,
);
check(
  'focusQuality — real progress does',
  goodScore > 75,
  `productive scored ${goodScore}`,
);
check('focusQuality — ranks conversion above hours', goodScore > busyScore);
check(
  'focusQuality — empty input does not produce NaN',
  Number.isFinite(focusQuality([]).focusScore) && focusQuality([]).progressPerHour === 0,
);
check(
  'focusQuality — median session length',
  focusQuality([
    session({ durationMin: 30 }),
    session({ durationMin: 60 }),
    session({ durationMin: 180 }),
  ]).medianSessionMin === 60,
);

// Streaks.
const threeInARow = [0, 1, 2].map((d) =>
  session({ id: `s${d}`, checkInAt: new Date(NOW.getTime() - d * DAY) }),
);
const streak = consistency(threeInARow, 30, NOW);
check('consistency — counts a three-day streak', streak.currentStreakDays === 3, `got ${streak.currentStreakDays}`);
check('consistency — counts active days', streak.activeDays === 3);
check(
  'consistency — an empty history has no streak and a full gap',
  consistency([], 30, NOW).currentStreakDays === 0 &&
    consistency([], 30, NOW).longestGapDays === 30,
);

// Forecast.
const steady = Array.from({ length: 8 }, (_, i) =>
  session({
    id: `f${i}`,
    checkInAt: new Date(NOW.getTime() - i * 3 * DAY),
    durationMin: 120,
    progressDeltaPct: 5,
  }),
);
const forecast = forecastCompletion({
  sessions: steady,
  currentPct: 50,
  deadline: new Date(NOW.getTime() + 70 * DAY),
  now: NOW,
});
check('forecast — velocity is positive', forecast.velocityPctPerWeek > 0);
check(
  'forecast — projects a finish date when moving',
  forecast.projectedFinishDate !== null,
);
check(
  'forecast — a stalled student needs extra hours',
  forecastCompletion({
    sessions: [session({ durationMin: 120, progressDeltaPct: 0.2 })],
    currentPct: 20,
    deadline: new Date(NOW.getTime() + 14 * DAY),
    now: NOW,
  }).extraHoursPerWeekNeeded > 0,
);
check(
  'forecast — no sessions does not produce NaN',
  Number.isFinite(
    forecastCompletion({
      sessions: [],
      currentPct: 0,
      deadline: new Date(NOW.getTime() + 30 * DAY),
      now: NOW,
    }).velocityPctPerWeek,
  ),
);

// Pace curve.
const curve = paceCurve({
  sessions: steady,
  startedAt: new Date(NOW.getTime() - 28 * DAY),
  deadline: new Date(NOW.getTime() + 28 * DAY),
  currentPct: 42,
  now: NOW,
});
check('paceCurve — produces points', curve.length > 2);
check(
  'paceCurve — expected rises monotonically to 100',
  curve.every((p, i) => i === 0 || p.expected >= curve[i - 1].expected) &&
    curve.at(-1)!.expected === 100,
);
check(
  'paceCurve — future weeks have no actual value',
  curve.filter((p) => p.date > NOW).every((p) => p.actual === null),
);
const lastActual = [...curve].reverse().find((p) => p.actual != null);
check(
  'paceCurve — last observed point is anchored to the headline figure',
  lastActual != null && near(lastActual.actual!, 42),
  `got ${lastActual?.actual}`,
);

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('All formula assertions hold.\n');
