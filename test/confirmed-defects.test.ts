/**
 * The bugs, written as the tests that will pass once they are fixed.
 *
 * Every case here asserts the **correct** behaviour, and every case therefore
 * fails against the code as it stands today. `it.fails` is what keeps that from
 * turning `npm test` red: it inverts the result, so a known-broken case is green
 * while it is broken — and the moment somebody fixes the underlying defect,
 * Vitest reports "expected test to fail but passed" and the case has to be
 * un-inverted. A bug cannot be fixed here without the suite noticing.
 *
 * That is the property a TODO list does not have. Each block below is a defect
 * that survived an adversarial second pass, with the reproduction reduced to the
 * smallest input that shows it.
 *
 * WHEN YOU FIX ONE: delete the `.fails`, move the case into the module's own
 * test file next to the behaviour it belongs with, and delete the block here.
 *
 * Two defects have no entry that can be written honestly, because the logic is
 * inline in a `server-only` module and there is no seam to call. They are
 * `it.todo` at the bottom rather than a test of a copy-pasted predicate, which
 * would prove nothing about the code that actually runs.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  classifySession,
  dailyBuckets,
  focusQuality,
  forecastCompletion,
  paceCurve,
} from '@/lib/analytics';
import { extractJson } from '@/lib/ai/llm-parse';
import { renderResumeMarkdown } from '@/lib/ai/markdown';
import { canSeeStudent, menteeWhere, mentorScope } from '@/lib/mentor-scope';
import { courseCompletionPct } from '@/lib/progress';
import { daysBetween, formatHours, relativeDay } from '@/lib/reep';
import type { AlertRuleKey, AlertSeverity } from '@prisma/client';

import {
  makeCertProgress,
  makeEnrollment,
  makeResumeContent,
  makeSession,
  makeStaffSession,
} from './fixtures';

process.env.DATABASE_URL ??= 'postgresql://unit:test@127.0.0.1:5432/unit_test';

type RulesModule = typeof import('@/lib/rules');
let rules: RulesModule;

type QueriesModule = typeof import('@/lib/queries');
let queries: QueriesModule;

beforeAll(async () => {
  rules = await import('@/lib/rules');
  // Imported here rather than at the top for the same reason as `rules`: the
  // module pulls in the Prisma client, and the client wants DATABASE_URL set —
  // which the assignment above only does after the static imports have run.
  queries = await import('@/lib/queries');
});

// ---------------------------------------------------------------------------

describe('DEFECT progress.courseCompletionPct counts optional certifications', () => {
  /**
   * `courseCompletionPct` is the only completion-math consumer that does not
   * filter `isOptional`. `certificationPace`, `queries.ts` and `rules.ts` all
   * do. The result flows into `overallCompletionPct` and from there into the
   * "REEP completion ≥ 80%" placement gate.
   *
   * FIX: progress.ts:62 —
   *   certs.filter((c) => c.cert.courseCode === course.code && !c.cert.isOptional)
   */

  it.fails('does not credit a course for work on an explicitly optional certification', () => {
    const enrollment = makeEnrollment({
      teachingHoursAttended: 0,
      selfLearningHoursLogged: 0,
      course: { code: 'REE101', teachingHours: 0, selfLearningHoursRequired: 20 },
    });
    const certs = [
      makeCertProgress({
        id: 'req',
        certCode: 'REQUIRED',
        progressPct: 0,
        cert: { code: 'REQUIRED', courseCode: 'REE101', requiredHours: 20, isOptional: false },
      }),
      makeCertProgress({
        id: 'opt',
        certCode: 'OPTIONAL',
        progressPct: 100,
        cert: { code: 'OPTIONAL', courseCode: 'REE101', requiredHours: 40, isOptional: true },
      }),
    ];

    // The student has done 0% of the only required certification.
    // Today this returns 100.
    expect(courseCompletionPct(enrollment, certs)).toBe(0);
  });

  it.fails('lets a student reach 100% by finishing everything that is required', () => {
    // The other half of the same defect: optional hours pad the denominator, so
    // completing all required work caps the course below 100.
    const enrollment = makeEnrollment({
      teachingHoursAttended: 20,
      course: { code: 'REE101', teachingHours: 20, selfLearningHoursRequired: 0 },
    });
    const certs = [
      makeCertProgress({
        id: 'req',
        certCode: 'REQUIRED',
        progressPct: 100,
        cert: { code: 'REQUIRED', courseCode: 'REE101', requiredHours: 20, isOptional: false },
      }),
      makeCertProgress({
        id: 'opt',
        certCode: 'OPTIONAL',
        progressPct: 0,
        cert: { code: 'OPTIONAL', courseCode: 'REE101', requiredHours: 40, isOptional: true },
      }),
    ];

    expect(courseCompletionPct(enrollment, certs)).toBe(100);
  });
});

describe('DEFECT reep.daysBetween disagrees with reep.relativeDay', () => {
  /**
   * `daysBetween` floors elapsed 24-hour blocks; `relativeDay` counts local
   * midnights. The same pair of timestamps therefore produces two different
   * day counts, and the mentor roster prints one next to a filter that uses the
   * other — "7 days ago" on a row excluded from "no check-in for 7 days or
   * more". `src/app/mentor/page.tsx` already carries a private midnight-based
   * helper written to dodge this.
   *
   * FIX: make daysBetween count midnights, and delete the private helper.
   */

  const lastActiveAt = new Date(2026, 7, 2, 23, 0);
  const now = new Date(2026, 7, 9, 9, 0);

  it.fails('counts the same number of days the roster copy prints', () => {
    expect(relativeDay(lastActiveAt, now)).toBe('7 days ago');

    // Today this is 6: 6 days and 10 hours of elapsed time.
    expect(daysBetween(now, lastActiveAt)).toBe(7);
  });

  it.fails('raises the idle alert on the day the label says the student went quiet', () => {
    const idle = rules.evaluateStudent(
      {
        studentId: 'stu_1',
        studentName: 'Asha Nair',
        sessions: [makeSession({ checkInAt: lastActiveAt })],
        certs: [],
        attendance: [],
      },
      rules.resolveRules([
        { ruleKey: 'NO_CHECKIN_N_DAYS', enabled: true, severity: 'WARNING', params: { days: 7 } },
      ]),
      now,
    );

    expect(idle.map((a) => a.ruleTriggered)).toContain('NO_CHECKIN_N_DAYS');
  });
});

describe('DEFECT analytics.focusQuality dilutes yield with unmeasured hours', () => {
  /**
   * `totalHours` sums every closed session, but `progressGained` reads a null
   * `progressDeltaPct` as zero. Hours the provider never reported on therefore
   * enter the denominator contributing nothing to the numerator, so hand-logged
   * study time drives the headline focus score down. "No data" is being scored
   * as "no progress".
   *
   * FIX: compute progressPerHour over the hours that carry a delta.
   */

  it.fails('measures yield over the hours that have a progress figure', () => {
    const sessions = [
      makeSession({ durationMin: 60, progressDeltaPct: 3 }),
      // Three hours of reading, logged by hand. No provider to report on it.
      makeSession({ durationMin: 180, progressDeltaPct: null }),
    ];

    // Today this is 0.75 — the student is penalised for the hours they logged.
    expect(focusQuality(sessions).progressPerHour).toBeCloseTo(3, 5);
  });

  it.fails('does not lower a student focus score for logging unmeasured study time', () => {
    const measuredOnly = [makeSession({ durationMin: 60, progressDeltaPct: 3 })];
    const withHandLogged = [
      ...measuredOnly,
      makeSession({ durationMin: 180, progressDeltaPct: null }),
    ];

    expect(focusQuality(withHandLogged).focusScore).toBeGreaterThanOrEqual(
      focusQuality(measuredOnly).focusScore,
    );
  });
});

describe('DEFECT analytics.classifySession calls a short unmeasured session abandoned', () => {
  /**
   * The length check runs before the "is there any provider data?" check, so a
   * legitimately hand-logged 15-minute block is labelled ABANDONED — printed to
   * a mentor as "Left early", a factual claim about check-in behaviour that
   * never happened — and it docks the discipline half of the focus score.
   *
   * FIX: test `progressDeltaPct == null` before the duration floor.
   */

  it.fails('is UNVERIFIED, not ABANDONED, when there is no provider data to judge', () => {
    const handLogged = makeSession({ durationMin: 15, progressDeltaPct: null });

    expect(classifySession(handLogged)).toBe('UNVERIFIED');
  });

  it('still calls a short session with provider data abandoned', () => {
    // The rule this defect is hiding inside is correct and must survive the fix.
    expect(classifySession(makeSession({ durationMin: 15, progressDeltaPct: 0 }))).toBe(
      'ABANDONED',
    );
  });
});

describe('DEFECT analytics.dailyBuckets renders six days of a seven-day week', () => {
  /**
   * `dailyBuckets` defaults to 6 days (Mon–Sat) but `getStudentTimeLog` selects
   * a 7-day window and passes it straight in. Sunday hours are counted in the
   * week total, the mode split and the target meter, and then never drawn — the
   * bars do not add up to the number above them.
   *
   * FIX: either pass 7 from queries.ts:195, or narrow the selection to Mon–Sat.
   * Not both, and the daily target divisor has to follow whichever is chosen.
   */

  const monday = new Date(2026, 7, 3);

  it.fails('accounts for a Sunday session somewhere in the week it renders', () => {
    const sunday = [makeSession({ checkInAt: new Date(2026, 7, 9, 10, 0), durationMin: 120 })];
    const buckets = dailyBuckets(sunday, monday, 12);

    expect(buckets.reduce((sum, b) => sum + b.hours, 0)).toBe(2);
  });
});

describe('DEFECT analytics.paceCurve sums per-course deltas as an overall percentage', () => {
  /**
   * The "actual" line accumulates `progressDeltaPct` across sessions belonging
   * to different courses and clamps the running total to 100, treating a sum of
   * per-course deltas as an overall completion figure. On any real history it
   * saturates weeks early, then drops to the authoritative `currentPct` at the
   * final point — a chart that says a student finished and then un-finished.
   *
   * FIX: scale the cumulative deltas against the total available progress, or
   * plot the recomputed overall percentage per week rather than a raw sum.
   */

  it.fails('never draws the actual line going backwards', () => {
    const startedAt = new Date(2026, 0, 5);
    const deadline = new Date(2026, 3, 6);
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession({
        courseCode: `REE${100 + i}`,
        checkInAt: new Date(2026, 0, 5 + i * 7 + 1),
        durationMin: 120,
        progressDeltaPct: 15,
      }),
    );

    const points = paceCurve({ sessions, startedAt, deadline, currentPct: 40, now: deadline });
    const actual = points.map((p) => p.actual).filter((v): v is number => v != null);

    for (let i = 1; i < actual.length; i += 1) {
      expect(actual[i]).toBeGreaterThanOrEqual(actual[i - 1]);
    }
  });

  it.fails('does not reach 100% for a student who is 40% complete', () => {
    const startedAt = new Date(2026, 0, 5);
    const deadline = new Date(2026, 3, 6);
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession({
        courseCode: `REE${100 + i}`,
        checkInAt: new Date(2026, 0, 5 + i * 7 + 1),
        durationMin: 120,
        progressDeltaPct: 15,
      }),
    );

    const points = paceCurve({ sessions, startedAt, deadline, currentPct: 40, now: deadline });

    expect(Math.max(...points.map((p) => p.actual ?? 0))).toBeLessThanOrEqual(40);
  });
});

describe('DEFECT analytics.forecastCompletion asks nothing of a student gaining nothing', () => {
  /**
   * `extraHoursPerWeekNeeded` is computed from the student's observed yield, and
   * a student with no measured progress has a yield of zero — so the guard
   * `yieldPerHour > 0.05` returns 0 extra hours. The agent then renders that as
   * "No additional weekly hours required" on the line directly after telling the
   * student they are projected to finish short. The most disengaged students get
   * the most reassuring message.
   *
   * FIX: distinguish "no shortfall" from "cannot compute a shortfall". The
   * caller in `tools.ts:145` must say "not enough data" for the second.
   */

  it.fails('does not report zero extra hours for a student projected to finish short', () => {
    const now = new Date(2026, 7, 3);
    const forecast = forecastCompletion({
      sessions: [
        makeSession({ checkInAt: new Date(2026, 7, 1), durationMin: 120, progressDeltaPct: 0 }),
        makeSession({ checkInAt: new Date(2026, 7, 2), durationMin: 120, progressDeltaPct: 0 }),
      ],
      currentPct: 20,
      deadline: new Date(2026, 9, 3),
      now,
    });

    expect(forecast.willFinishOnTime).toBe(false);
    // Today: 0, which the assistant words as "no additional hours required".
    expect(forecast.extraHoursPerWeekNeeded).toBeGreaterThan(0);
  });
});

describe('DEFECT rules.LOW_FOCUS_QUALITY reads missing data as zero progress', () => {
  /**
   * The rule divides progress gained by hours logged, and a null
   * `progressDeltaPct` counts as zero gained. Every student who hand-logs lab
   * hours is therefore guaranteed to trip it — an alert is persisted against a
   * student who has done nothing wrong, and the mentor is told their hours are
   * not converting when in truth nothing measured them.
   *
   * FIX: require some measured progress before the rule can fire. Downstream of
   * the focusQuality fix above, this may resolve with it — verify both.
   */

  it.fails('does not flag a student whose lab hours were never measured', () => {
    const handLogged = Array.from({ length: 3 }, (_, i) =>
      makeSession({
        mode: 'SUPERVISED_LAB',
        durationMin: 120,
        checkInAt: new Date(2026, 7, 3 + i, 10, 0),
        progressDeltaPct: null,
      }),
    );

    const alerts = rules.evaluateStudent(
      {
        studentId: 'stu_1',
        studentName: 'Asha Nair',
        sessions: handLogged,
        certs: [],
        attendance: [],
      },
      rules.resolveRules([
        {
          ruleKey: 'LOW_FOCUS_QUALITY',
          enabled: true,
          severity: 'INFO' as AlertSeverity,
          params: { minProgressPerHour: 1, minSessions: 3 },
        },
      ]),
      new Date(2026, 7, 9),
    );

    expect(alerts.map((a) => a.ruleTriggered)).not.toContain('LOW_FOCUS_QUALITY');
  });

  it('still flags a student whose measured lab hours are not converting', () => {
    // Must survive the fix.
    const measured = Array.from({ length: 3 }, (_, i) =>
      makeSession({
        mode: 'SUPERVISED_LAB',
        durationMin: 120,
        checkInAt: new Date(2026, 7, 3 + i, 10, 0),
        progressDeltaPct: 0.1,
      }),
    );

    const alerts = rules.evaluateStudent(
      {
        studentId: 'stu_1',
        studentName: 'Asha Nair',
        sessions: measured,
        certs: [],
        attendance: [],
      },
      rules.resolveRules([
        {
          ruleKey: 'LOW_FOCUS_QUALITY',
          enabled: true,
          severity: 'INFO' as AlertSeverity,
          params: { minProgressPerHour: 1, minSessions: 3 },
        },
      ]),
      new Date(2026, 7, 9),
    );

    expect(alerts.map((a) => a.ruleTriggered)).toContain('LOW_FOCUS_QUALITY');
  });
});

describe('DEFECT rules.NO_CHECKIN_N_DAYS is reset by a lecture', () => {
  /**
   * The rule scans every LabSession regardless of mode, so sitting in a lecture
   * resets the idle clock for a rule that is worded, labelled and understood as
   * being about lab check-ins. A student who attends class and never opens the
   * lab looks active. `LOW_FOCUS_QUALITY` in the same function filters to
   * `SUPERVISED_LAB`; this branch does not.
   *
   * FIX: filter to the lab modes before reducing to the last check-in — or
   * change the rule's label and help text to match what it measures.
   */

  it.fails('still counts a student as quiet when their only attendance is a lecture', () => {
    const now = new Date(2026, 7, 9, 12, 0);
    const alerts = rules.evaluateStudent(
      {
        studentId: 'stu_1',
        studentName: 'Asha Nair',
        sessions: [
          makeSession({ mode: 'INSTRUCTOR_LED', checkInAt: new Date(2026, 7, 9, 9, 0) }),
        ],
        certs: [],
        attendance: [],
      },
      rules.resolveRules([
        { ruleKey: 'NO_CHECKIN_N_DAYS', enabled: true, severity: 'WARNING', params: { days: 5 } },
      ]),
      now,
    );

    expect(alerts.map((a) => a.ruleTriggered)).toContain('NO_CHECKIN_N_DAYS');
  });
});

describe('DEFECT llm-parse.extractJson gives up on the first brace group', () => {
  /**
   * The scanner walks to the first balanced `{...}`, parses it, and returns
   * whatever that produced — including `undefined`. It never resumes to look for
   * the next candidate. So a preamble containing any brace pair defeats it, which
   * is precisely the case the function's own comment claims to survive.
   *
   * FIX: on a failed parse, continue the scan from the next `{` instead of
   * returning.
   */

  it.fails('finds the JSON after a preamble that contains braces of its own', () => {
    const reply = 'First I will {check the record}, then answer.\n{"summary":"ok"}';

    expect(extractJson(reply)).toEqual({ summary: 'ok' });
  });

  it.fails('finds the JSON after a template placeholder in the prose', () => {
    const reply = 'Filling in {name} now: {"name":"Asha"}';

    expect(extractJson(reply)).toEqual({ name: 'Asha' });
  });
});

describe('DEFECT markdown.renderResumeMarkdown prints a fabricated 0h', () => {
  /**
   * `${cert.hours}h` is a template literal, so it is always a non-empty string
   * and always survives `.filter(Boolean)`. A certification whose hours the
   * model omitted is printed as "0h" — a number the student never earned,
   * asserted on a document they will send to an employer. The on-screen renderer
   * guards this exact case; the markdown copy does not.
   *
   * FIX: build the metadata list with the hours entry omitted when there are no
   * hours, e.g. `cert.hours ? `${cert.hours}h` : null`.
   */

  it.fails('omits the hours entirely when a certification has none', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        certifications: [
          {
            name: 'Interpersonal Communication',
            provider: 'Coursera',
            hours: 0,
            completedOn: 'Mar 2026',
            courseCode: 'REE101',
            dimension: 'PROFESSIONAL',
            evidenceIds: [],
          },
        ],
      }),
    );

    expect(md).toContain('Coursera · Mar 2026 · REE101');
    expect(md).not.toContain('0h');
  });
});

describe('DEFECT reep.formatHours can render "2h 60m"', () => {
  /**
   * The hours part is floored and the minutes part is rounded independently, so
   * a fraction of at least 59.5/60 rounds the minutes up to a full 60 without
   * carrying into the hour.
   *
   * Found by this suite rather than by review. Reachable wherever a total is not
   * already minute-aligned — a Float `requiredHours` column, or any average.
   *
   * FIX: round to minutes once, then divide.
   */

  it.fails('carries 60 minutes into the hour', () => {
    expect(formatHours(2.999)).toBe('3h');
  });

  it('is correct for every minute-aligned value, which is the common path', () => {
    for (let minutes = 0; minutes <= 600; minutes += 1) {
      expect(formatHours(minutes / 60)).not.toContain('60m');
    }
  });
});

describe('FIXED the mentee guards read a missing mentor group as programme scope', () => {
  /**
   * Three call sites guarded mentee access like this:
   *
   *     if (session.mentorId && student.mentorId !== session.mentorId) notFound();
   *
   * For a MENTOR account with no `Mentor` row `session.mentorId` is undefined,
   * the `&&` short-circuits, and the guard is simply not there. That account read
   * every student in the programme on `mentor/student/[id]/page.tsx`, and wrote
   * notes and lab hours onto any of them through the two Server Actions behind
   * it.
   *
   * The same wrong question in its ternary form — `session.mentorId ? … : …`,
   * which reads "no mentor group" as "director" — stood behind six more. The
   * roster screens pointed the safe way by luck and only told that account it was
   * programme staff. `/api/alerts/scan` did not: it ran, and wrote, a
   * programme-wide alert scan. `resolve-mentor.ts` lent the account the first
   * mentor group in the programme and drew its whole roster, and
   * `mentor/settings/actions.ts` let it rewrite any cohort's alert thresholds.
   *
   * No `.fails` here: this one is fixed, and this block exists to keep it fixed.
   * It is the only entry in this file that outlived its bug, because it belongs
   * to no single module — the fix is spread over two pages, two route handlers,
   * three server actions and a resolver, and what those now share is exactly the
   * three functions asserted below. Assert those and the call sites have nowhere
   * left to be wrong; the alternative is a copy of the predicate, which this file
   * refuses on principle.
   */

  const broken = [
    makeStaffSession({ mentorId: undefined }),
    makeStaffSession({ mentorId: '' }),
  ];

  it('gives a mentor with no mentor group a filter that cannot match a student', () => {
    // This clause is what the alert scan route, the printable report, the alert
    // queue, the uploads queue and the threshold screen hand to Prisma. `{}`
    // there means "every student in the programme".
    for (const session of broken) {
      expect(menteeWhere(session)).not.toEqual({});
      expect(menteeWhere(session)).toEqual({ id: '__none__' });
      expect(mentorScope(session)).toEqual({ kind: 'none' });
    }
  });

  it('refuses a mentor with no mentor group every student, on the read and on the write', () => {
    // `mentor/student/[id]/page.tsx` and both server-action guards behind it.
    for (const session of broken) {
      for (const studentMentorId of ['mnt_1', 'mnt_2', null]) {
        expect(canSeeStudent(session, studentMentorId)).toBe(false);
      }
    }
  });

  it('refuses a mentor with no mentor group a roster to load', async () => {
    // The mentee list, the cohort report and the CSV export all go through this.
    // Both closed answers are decided before a query is built, which is why this
    // case can be asserted against the real shipped function with no database.
    for (const session of broken) {
      expect(await queries.getMentorCohortForSession(session)).toEqual({ kind: 'denied' });
    }
  });

  it('still gives a director and an admin everything they had before', async () => {
    // The other half of the fix. Failing closed for a broken mentor is worth
    // nothing if it also narrows the staff who are meant to see the programme.
    for (const role of ['DIRECTOR', 'ADMIN'] as const) {
      const session = makeStaffSession({ role });

      expect(mentorScope(session)).toEqual({ kind: 'programme' });
      expect(menteeWhere(session)).toEqual({});
      expect(canSeeStudent(session, null)).toBe(true);
      // A director has no mentor group of their own, and the roster screens say
      // so in words — which is what they did before the fix too.
      expect(await queries.getMentorCohortForSession(session)).toEqual({ kind: 'no-group' });
    }
  });

  it('still scopes a working mentor to their own group', () => {
    const session = makeStaffSession({ mentorId: 'mnt_1' });

    expect(mentorScope(session)).toEqual({ kind: 'mentees', mentorId: 'mnt_1' });
    expect(menteeWhere(session)).toEqual({ mentorId: 'mnt_1' });
    expect(canSeeStudent(session, 'mnt_1')).toBe(true);
    expect(canSeeStudent(session, 'mnt_2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirmed, but with no honest unit test until the logic has a seam
// ---------------------------------------------------------------------------

describe('DEFECT no seam to test yet', () => {
  /**
   * Both of these were confirmed by reading the code, and both live inline in a
   * module a unit test cannot reach — one behind `server-only` and Prisma, one
   * inside a Next server action. Writing a test against a copy of the predicate
   * would assert that the copy works, which is worse than no test: it reads as
   * coverage. Extract the pure part, then delete the todo and write the real one.
   */

  it.todo(
    'ai/agent/tools.ts:186 — the certifications digest divides a completed count that ' +
      'includes optional certs by a required count that excludes them, so the assistant ' +
      'can report more completions than requirements. Extract `summariseCertifications` ' +
      '(certs, scope) => { completed, required } and test it here.',
  );

  it.todo(
    'progress.ts:37 — `export type PaceThresholds = typeof DEFAULT_PACE_THRESHOLDS` reads ' +
      'the type off an `as const` object, so it is the literal pair {10, 25}. The ' +
      '`thresholds` parameter on evaluatePace, certificationPace and certificationStatus ' +
      'is documented as configurable but rejects every value except the defaults, and ' +
      'the cohort-level pace tuning it exists for cannot be written. Declare the type ' +
      'as `{ behindDeviationPct: number; atRiskDeviationPct: number }`, then delete the ' +
      'cast in progress.test.ts and assert real custom thresholds here.',
  );

  it.todo(
    'app/login/actions.ts:31 — the `?next=` allowlist rejects only a `//` prefix, so ' +
      '`/\\evil.com` passes and the browser resolves it as protocol-relative to an ' +
      'external host, redirecting a just-authenticated user off-site. Extract ' +
      '`safeInternalPath(next, fallback)` — rejecting a backslash in the first two ' +
      'characters, and anything that is not a single leading `/` — and test it here.',
  );
});
