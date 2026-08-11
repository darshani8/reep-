import 'server-only';

/**
 * Every screen's data, assembled here.
 *
 * Pages stay presentational: they call one function from this module and render
 * the result. That keeps the progress/analytics formulas in one place and makes
 * each screen cheap to change.
 */

import { cache } from 'react';

import type { SessionPayload } from './auth';
import { prisma } from './db';
import { mentorScope } from './mentor-scope';
import {
  atRiskTrend,
  consistency,
  courseAllocation,
  dailyBuckets,
  focusQuality,
  forecastCompletion,
  modeBreakdown,
  paceCurve,
  rankBottlenecks,
  timeOfDayProfile,
  weeklySeries,
  type CourseBottleneck,
} from './analytics';
import {
  attendancePct,
  certificationPace,
  certificationStatus,
  courseCompletionPct,
  dimensionScores,
  evaluatePlacementReadiness,
  overallCompletionPct,
  stageProgress,
  type CertProgressWithCert,
  type EnrollmentWithCourse,
} from './progress';
import { addDays, startOfWeek } from './reep';

// ---------------------------------------------------------------------------
// Shared includes
// ---------------------------------------------------------------------------

const CERT_INCLUDE = { cert: { include: { course: true } } } as const;

async function loadStudentCore(studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      user: true,
      cohort: true,
      mentor: { include: { user: true } },
      enrollments: { include: { course: true } },
      certProgress: { include: CERT_INCLUDE },
      attendance: true,
      labSessions: { orderBy: { checkInAt: 'desc' } },
    },
  });
  if (!student) return null;
  return student;
}

export type StudentCore = NonNullable<Awaited<ReturnType<typeof loadStudentCore>>>;

// ---------------------------------------------------------------------------
// Screen 1 — Student REEP Journey Home
// ---------------------------------------------------------------------------

export const getStudentHome = cache(async (studentId: string) => {
  const student = await loadStudentCore(studentId);
  if (!student) return null;

  const enrollments = student.enrollments as EnrollmentWithCourse[];
  const certs = student.certProgress as CertProgressWithCert[];
  const now = new Date();

  const currentCourses = enrollments
    .filter((e) => e.course.stage === student.currentStage && e.status !== 'COMPLETED')
    .map((enrollment) => {
      const courseCerts = certs.filter(
        (c) => c.cert.courseCode === enrollment.courseCode,
      );
      const pace =
        courseCerts.length > 0
          ? certificationPace(courseCerts, now)
          : { status: 'ON_TRACK' as const, actualPct: 0, expectedPct: 0, deviationPct: 0 };

      return {
        enrollment,
        course: enrollment.course,
        completionPct: courseCompletionPct(enrollment, certs),
        paceStatus: pace.status,
        selfLearningLogged: enrollment.selfLearningHoursLogged,
      };
    })
    .sort((a, b) => a.course.code.localeCompare(b.course.code));

  const upcoming = await prisma.scheduleItem.findMany({
    where: { studentId, startsAt: { gte: addDays(now, -1) } },
    orderBy: { startsAt: 'asc' },
    take: 5,
    include: { course: true },
  });

  const openAlerts = await prisma.alert.findMany({
    where: { studentId, resolvedAt: null },
    orderBy: { triggeredAt: 'desc' },
  });

  return {
    student,
    stages: stageProgress(enrollments, certs),
    dimensions: dimensionScores(enrollments, certs),
    currentCourses,
    upcoming,
    openAlerts,
    overallPct: overallCompletionPct(enrollments, certs),
  };
});

// ---------------------------------------------------------------------------
// Screen 2 — Certification Tracker
// ---------------------------------------------------------------------------

export const getStudentCertifications = cache(async (studentId: string) => {
  const student = await loadStudentCore(studentId);
  if (!student) return null;

  const now = new Date();
  const certs = student.certProgress as CertProgressWithCert[];

  const rows = certs
    .map((cert) => {
      const { status, pace } = certificationStatus(cert, now);
      return {
        cert,
        status,
        pace,
        stage: cert.cert.course.stage,
        courseCode: cert.cert.courseCode,
      };
    })
    .sort((a, b) => a.courseCode.localeCompare(b.courseCode));

  const required = rows.filter((r) => !r.cert.cert.isOptional);

  return {
    student,
    rows,
    summary: {
      required: required.length,
      completed: rows.filter((r) => r.status === 'COMPLETED').length,
      inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
      overdue: rows.filter((r) => r.status === 'OVERDUE').length,
    },
  };
});

// ---------------------------------------------------------------------------
// Screen 3 — Time Usage Log
// ---------------------------------------------------------------------------

export const getStudentTimeLog = cache(
  async (studentId: string, weekOffset = 0) => {
    const student = await loadStudentCore(studentId);
    if (!student) return null;

    const now = new Date();
    const weekStart = addDays(startOfWeek(now), weekOffset * 7);
    const weekEnd = addDays(weekStart, 7);

    const sessions = student.labSessions;
    const thisWeek = sessions.filter(
      (s) => s.checkInAt >= weekStart && s.checkInAt < weekEnd,
    );

    const courses = student.enrollments.map((e) => e.course);
    const openSession = sessions.find((s) => s.checkOutAt == null) ?? null;

    const certs = student.certProgress as CertProgressWithCert[];
    const currentPct = overallCompletionPct(
      student.enrollments as EnrollmentWithCourse[],
      certs,
    );

    return {
      student,
      weekStart,
      weekOffset,
      openSession,
      courses,
      recentSessions: sessions.slice(0, 25),
      daily: dailyBuckets(thisWeek, weekStart, student.weeklyHourTarget),
      modes: modeBreakdown(thisWeek),
      weekly: weeklySeries(sessions, 8, student.weeklyHourTarget, now),
      focus: focusQuality(sessions),
      consistency: consistency(sessions, 30, now),
      timeOfDay: timeOfDayProfile(sessions),
      allocation: courseAllocation(sessions, courses),
      forecast: forecastCompletion({
        sessions,
        currentPct,
        deadline: student.cohort.endDate,
        now,
      }),
      weekTotalHours:
        thisWeek.reduce((sum, s) => sum + (s.durationMin ?? 0), 0) / 60,
    };
  },
);

// ---------------------------------------------------------------------------
// Screen 4 — Mentor Cohort Overview
// ---------------------------------------------------------------------------

export type RosterRow = {
  studentId: string;
  name: string;
  usn: string;
  stage: string;
  semester: number;
  overallPct: number;
  attendancePct: number;
  certPace: ReturnType<typeof certificationPace>;
  lastActiveAt: Date | null;
  openAlerts: number;
  atRisk: boolean;
  behind: boolean;
};

export const getMentorCohort = cache(async (mentorId: string) => {
  const mentor = await prisma.mentor.findUnique({
    where: { id: mentorId },
    include: { user: true },
  });
  if (!mentor) return null;

  const students = await prisma.student.findMany({
    where: { mentorId },
    include: {
      user: true,
      cohort: true,
      enrollments: { include: { course: true } },
      certProgress: { include: CERT_INCLUDE },
      attendance: { select: { present: true } },
      labSessions: { orderBy: { checkInAt: 'desc' } },
      alerts: { where: { resolvedAt: null }, orderBy: { triggeredAt: 'desc' } },
    },
    orderBy: { user: { name: 'asc' } },
  });

  const now = new Date();

  const roster: RosterRow[] = students.map((s) => {
    const certs = s.certProgress as CertProgressWithCert[];
    const pace = certificationPace(certs, now);
    const lastActiveAt = s.labSessions[0]?.checkInAt ?? null;
    const atRisk = s.alerts.some((a) => a.severity === 'CRITICAL') || pace.status === 'AT_RISK';

    return {
      studentId: s.id,
      name: s.user.name,
      usn: s.usn,
      stage: s.currentStage,
      semester: s.currentSemester,
      overallPct: overallCompletionPct(s.enrollments as EnrollmentWithCourse[], certs),
      attendancePct: attendancePct(s.attendance),
      certPace: pace,
      lastActiveAt,
      openAlerts: s.alerts.length,
      atRisk,
      behind: pace.status === 'BEHIND',
    };
  });

  const alerts = students
    .flatMap((s) => s.alerts.map((a) => ({ ...a, studentName: s.user.name })))
    .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());

  // "Certs Overdue (7d)" means certifications whose due date fell inside the
  // last seven days — not everything currently off-pace, which would double-count
  // the students already surfaced by the At Risk tile.
  const overdueCutoff = addDays(now, -7);
  const certsOverdueRecently = students.reduce((count, s) => {
    const overdue = (s.certProgress as CertProgressWithCert[]).filter((c) => {
      const { status } = certificationStatus(c, now);
      return status === 'OVERDUE' && c.dueDate >= overdueCutoff && c.dueDate <= now;
    });
    return count + overdue.length;
  }, 0);

  return {
    mentor,
    roster,
    alerts,
    summary: {
      studentCount: roster.length,
      avgCompletion:
        roster.length > 0
          ? roster.reduce((sum, r) => sum + r.overallPct, 0) / roster.length
          : 0,
      atRisk: roster.filter((r) => r.atRisk).length,
      behindPace: roster.filter((r) => r.behind).length,
      certsOverdue: certsOverdueRecently,
    },
  };
});

/// Everything `getMentorCohort` returns for a mentor group that exists.
export type MentorCohort = NonNullable<Awaited<ReturnType<typeof getMentorCohort>>>;

/// What a staff session is entitled to on the mentor-group screens.
export type ScopedMentorCohort =
  /// The caller's own mentor group, loaded.
  | { kind: 'cohort'; cohort: MentorCohort }
  /// A director or admin: programme-wide scope, but no mentor group of their
  /// own. Every caller has a branch that says so in words.
  | { kind: 'no-group' }
  /// Nobody's group — a MENTOR session with no usable `Mentor` row.
  | { kind: 'denied' };

/**
 * `getMentorCohort` keyed on the session instead of on a bare id.
 *
 * The four screens that need a roster — the overview, the mentee list, the
 * printable report and the CSV export — each worked out their own scope first,
 * with `session.mentorId ? … : …`, and then passed the id down. That put one
 * decision in four places and got it wrong in all four: a MENTOR whose token
 * carries no `mentorId` (see `mentor-scope.ts` for how that token gets minted)
 * took the branch written for directors. Three of the four then showed that
 * account an empty state and called it programme staff; the overview borrowed it
 * a stranger's mentor group and drew every student in it.
 *
 * Patching the callers would have left four copies of the fix to keep in step,
 * so the decision moved here, where the query already lives. The bare-id
 * function stays exported for the one caller that legitimately names a mentor
 * group other than its own — the director/admin stand-in in `resolve-mentor.ts`.
 *
 * Deliberately not wrapped in `cache()`: the argument is a fresh session object
 * every request, so a cache keyed on it would never hit. The query underneath is
 * cached by mentor id, which is where the deduplication actually happens.
 */
export async function getMentorCohortForSession(
  session: SessionPayload,
): Promise<ScopedMentorCohort> {
  const scope = mentorScope(session);
  // Both of these answer before a query runs, which is what lets the regression
  // test exercise the closed cases without a database.
  if (scope.kind === 'none') return { kind: 'denied' };
  if (scope.kind === 'programme') return { kind: 'no-group' };

  const cohort = await getMentorCohort(scope.mentorId);
  // A token pointing at a `Mentor` row that has since been deleted is the same
  // broken session as one carrying no id at all — not a reason to widen scope.
  if (!cohort) return { kind: 'denied' };

  return { kind: 'cohort', cohort };
}

// ---------------------------------------------------------------------------
// Screen 5 — Mentor Student Detail & Focus Tracking
// ---------------------------------------------------------------------------

export const getStudentDetail = cache(async (studentId: string) => {
  const student = await loadStudentCore(studentId);
  if (!student) return null;

  const now = new Date();
  const certs = student.certProgress as CertProgressWithCert[];
  const enrollments = student.enrollments as EnrollmentWithCourse[];
  const sessions = student.labSessions;

  const notes = await prisma.mentorNote.findMany({
    where: { studentId },
    orderBy: { createdAt: 'desc' },
    take: 12,
    include: { mentor: { include: { user: true } } },
  });

  const alerts = await prisma.alert.findMany({
    where: { studentId },
    orderBy: [{ resolvedAt: 'asc' }, { triggeredAt: 'desc' }],
    take: 20,
  });

  const overallPct = overallCompletionPct(enrollments, certs);
  const startedAt = student.enrolledAt;
  const deadline = student.cohort.endDate;

  return {
    student,
    overallPct,
    attendancePct: attendancePct(student.attendance),
    certPace: certificationPace(certs, now),
    certs: certs
      .map((c) => ({ cert: c, ...certificationStatus(c, now) }))
      .sort((a, b) => a.cert.cert.courseCode.localeCompare(b.cert.cert.courseCode)),
    curve: paceCurve({ sessions, startedAt, deadline, currentPct: overallPct, now }),
    focus: focusQuality(sessions),
    consistency: consistency(sessions, 30, now),
    recentSessions: sessions.slice(0, 12),
    weekly: weeklySeries(sessions, 8, student.weeklyHourTarget, now),
    timeOfDay: timeOfDayProfile(sessions),
    allocation: courseAllocation(
      sessions,
      enrollments.map((e) => e.course),
    ),
    forecast: forecastCompletion({ sessions, currentPct: overallPct, deadline, now }),
    notes,
    alerts,
    enrollments: enrollments.map((e) => ({
      enrollment: e,
      completionPct: courseCompletionPct(e, certs),
    })),
  };
});

// ---------------------------------------------------------------------------
// Screen 6 — Program Director Cohort Analytics
// ---------------------------------------------------------------------------

export const getDirectorAnalytics = cache(async () => {
  const [cohorts, courses, criteria] = await Promise.all([
    prisma.cohort.findMany({ orderBy: { code: 'asc' } }),
    prisma.course.findMany({ orderBy: { code: 'asc' } }),
    prisma.placementCriteria.findFirst({ where: { active: true } }),
  ]);

  const students = await prisma.student.findMany({
    include: {
      user: true,
      cohort: true,
      enrollments: { include: { course: true } },
      certProgress: { include: CERT_INCLUDE },
      attendance: { select: { present: true } },
      labSessions: { select: { checkInAt: true, durationMin: true, progressDeltaPct: true } },
      alerts: { where: { resolvedAt: null } },
    },
  });

  const now = new Date();
  const activeCriteria = criteria ?? {
    minReepCompletionPct: 80,
    minCertCompletionPct: 75,
    minAttendancePct: 85,
    requireCoreCerts: true,
  };

  const perStudent = students.map((s) => {
    const certs = s.certProgress as CertProgressWithCert[];
    const enrollments = s.enrollments as EnrollmentWithCourse[];
    const requiredCerts = certs.filter((c) => !c.cert.isOptional);
    const completedCerts = requiredCerts.filter(
      (c) => certificationStatus(c, now).status === 'COMPLETED',
    );
    const certCompletionPct =
      requiredCerts.length > 0 ? (completedCerts.length / requiredCerts.length) * 100 : 0;

    const reepPct = overallCompletionPct(enrollments, certs);
    const attPct = attendancePct(s.attendance);

    const placement = evaluatePlacementReadiness(
      {
        reepCompletionPct: reepPct,
        certCompletionPct,
        attendancePct: attPct,
        coreCertsComplete: requiredCerts.length > 0 && completedCerts.length === requiredCerts.length,
      },
      activeCriteria,
    );

    return {
      student: s,
      reepPct,
      certCompletionPct,
      attendancePct: attPct,
      placement,
      atRisk: s.alerts.some((a) => a.severity === 'CRITICAL'),
    };
  });

  // Course bottlenecks: mean completion across everyone enrolled.
  const bottleneckRows: CourseBottleneck[] = courses
    .map((course) => {
      const enrolled = students.filter((s) =>
        s.enrollments.some((e) => e.courseCode === course.code),
      );
      if (enrolled.length === 0) return null;

      const completion =
        enrolled.reduce((sum, s) => {
          const enrollment = s.enrollments.find((e) => e.courseCode === course.code)!;
          return (
            sum +
            courseCompletionPct(
              enrollment as EnrollmentWithCourse,
              s.certProgress as CertProgressWithCert[],
            )
          );
        }, 0) / enrolled.length;

      const atRisk = enrolled.filter((s) =>
        s.alerts.some((a) => a.severity === 'CRITICAL'),
      ).length;

      return {
        courseCode: course.code,
        courseName: course.name,
        stage: course.stage,
        completionPct: Math.round(completion),
        enrolledCount: enrolled.length,
        atRiskCount: atRisk,
      };
    })
    .filter((r): r is CourseBottleneck => r !== null);

  const alerts = await prisma.alert.findMany({
    select: { triggeredAt: true, resolvedAt: true, studentId: true, severity: true },
  });

  const totalStudents = perStudent.length || 1;

  return {
    cohorts,
    criteria: activeCriteria,
    summary: {
      cohortCount: cohorts.length,
      studentCount: perStudent.length,
      reepCompletion:
        perStudent.reduce((sum, p) => sum + p.reepPct, 0) / totalStudents,
      certCompletion:
        perStudent.reduce((sum, p) => sum + p.certCompletionPct, 0) / totalStudents,
      placementReadyPct:
        (perStudent.filter((p) => p.placement.ready).length / totalStudents) * 100,
      atRiskCount: perStudent.filter((p) => p.atRisk).length,
    },
    bottlenecks: rankBottlenecks(bottleneckRows, 6),
    allCourses: bottleneckRows,
    atRiskTrend: atRiskTrend(
      alerts.filter((a) => a.severity === 'CRITICAL'),
      6,
      now,
    ),
    perStudent,
    cohortRollup: cohorts.map((cohort) => {
      const inCohort = perStudent.filter((p) => p.student.cohortId === cohort.id);
      const n = inCohort.length || 1;
      return {
        cohort,
        studentCount: inCohort.length,
        reepPct: inCohort.reduce((sum, p) => sum + p.reepPct, 0) / n,
        placementReadyPct:
          (inCohort.filter((p) => p.placement.ready).length / n) * 100,
        atRisk: inCohort.filter((p) => p.atRisk).length,
      };
    }),
  };
});

// ---------------------------------------------------------------------------
// Resume builder input
// ---------------------------------------------------------------------------

export const getResumeContext = cache(async (studentId: string) => {
  const student = await loadStudentCore(studentId);
  if (!student) return null;

  const [profile, resumes] = await Promise.all([
    prisma.studentProfile.findUnique({ where: { studentId } }),
    prisma.resume.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const now = new Date();
  const certs = student.certProgress as CertProgressWithCert[];
  const enrollments = student.enrollments as EnrollmentWithCourse[];

  return {
    student,
    profile,
    resumes,
    completedCerts: certs.filter(
      (c) => certificationStatus(c, now).status === 'COMPLETED',
    ),
    inProgressCerts: certs.filter(
      (c) => certificationStatus(c, now).status === 'IN_PROGRESS',
    ),
    stages: stageProgress(enrollments, certs),
    dimensions: dimensionScores(enrollments, certs),
    overallPct: overallCompletionPct(enrollments, certs),
    attendancePct: attendancePct(student.attendance),
    focus: focusQuality(student.labSessions),
    totalLoggedHours:
      student.labSessions.reduce((sum, s) => sum + (s.durationMin ?? 0), 0) / 60,
    enrollments,
  };
});
