import 'server-only';

/**
 * The complete record of one student, assembled once.
 *
 * Two things read this: the printable document at `/director/student/[id]` and
 * the JSON export at `/api/export/student/[id]`. They must never disagree — a
 * director who prints a page and mails the JSON alongside it is making one
 * claim, not two — so both are built from this module and nothing else.
 *
 * `getStudentDetail` and `getResumeContext` already carry most of it. What they
 * deliberately cap (alerts, notes) or never needed (uploads, per-course
 * attendance, the activity split) is read here, uncapped, because a review
 * document that silently stops at the twentieth alert is worse than no document.
 */

import { cache } from 'react';

import { modeBreakdown } from '@/lib/analytics';
import { prisma } from '@/lib/db';
import { getResumeContext, getStudentDetail } from '@/lib/queries';
import { ACTIVITY_LABEL, ACTIVITY_ORDER, STAGE_ORDER } from '@/lib/reep';
import type { ActivityType } from '@prisma/client';

const MINUTES_PER_HOUR = 60;
const round1 = (n: number) => Math.round(n * 10) / 10;

export type ActivityTotal = {
  activity: ActivityType;
  label: string;
  hours: number;
  sessions: number;
  pct: number;
};

export type CourseAttendance = {
  code: string;
  name: string;
  held: number;
  attended: number;
  missed: number;
  pct: number;
  lastAbsence: Date | null;
};

/// Hours per activity, biggest first. The mode split answers "where was she?";
/// this answers "what was she actually doing?", which is the question a review
/// meeting turns on.
function activityTotals(
  sessions: { activity: ActivityType; durationMin: number | null }[],
): ActivityTotal[] {
  const totals = new Map<ActivityType, { h: number; n: number }>();

  for (const session of sessions) {
    const entry = totals.get(session.activity) ?? { h: 0, n: 0 };
    entry.h += (session.durationMin ?? 0) / MINUTES_PER_HOUR;
    entry.n += 1;
    totals.set(session.activity, entry);
  }

  const grand = [...totals.values()].reduce((sum, v) => sum + v.h, 0);

  return ACTIVITY_ORDER.filter((activity) => totals.has(activity))
    .map((activity) => {
      const { h, n } = totals.get(activity)!;
      return {
        activity,
        label: ACTIVITY_LABEL[activity],
        hours: round1(h),
        sessions: n,
        pct: grand > 0 ? round1((h / grand) * 100) : 0,
      };
    })
    .sort((a, b) => b.hours - a.hours);
}

function groupAttendance(
  records: {
    courseCode: string;
    sessionDate: Date;
    present: boolean;
    course: { name: string };
  }[],
): CourseAttendance[] {
  const byCourse = new Map<string, CourseAttendance>();

  for (const record of records) {
    const row = byCourse.get(record.courseCode) ?? {
      code: record.courseCode,
      name: record.course.name,
      held: 0,
      attended: 0,
      missed: 0,
      pct: 0,
      lastAbsence: null,
    };

    row.held += 1;
    if (record.present) {
      row.attended += 1;
    } else {
      row.missed += 1;
      if (!row.lastAbsence || record.sessionDate > row.lastAbsence) {
        row.lastAbsence = record.sessionDate;
      }
    }
    byCourse.set(record.courseCode, row);
  }

  return [...byCourse.values()]
    .map((row) => ({ ...row, pct: row.held > 0 ? (row.attended / row.held) * 100 : 0 }))
    // Worst first — the point of the section is the course being skipped.
    .sort((a, b) => a.pct - b.pct);
}

export const buildStudentRecord = cache(async (studentId: string) => {
  const [detail, resume] = await Promise.all([
    getStudentDetail(studentId),
    getResumeContext(studentId),
  ]);
  if (!detail || !resume) return null;

  const [uploads, alerts, notes, attendanceRecords] = await Promise.all([
    prisma.upload.findMany({
      where: { studentId },
      orderBy: { uploadedAt: 'desc' },
      include: { cert: { select: { name: true, courseCode: true } } },
    }),
    // Uncapped, and open flags before resolved ones — the shared query takes 20.
    prisma.alert.findMany({
      where: { studentId },
      orderBy: [{ resolvedAt: 'asc' }, { triggeredAt: 'desc' }],
    }),
    prisma.mentorNote.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      include: { mentor: { include: { user: true } } },
    }),
    prisma.attendanceRecord.findMany({
      where: { studentId },
      include: { course: { select: { name: true } } },
      orderBy: [{ courseCode: 'asc' }, { sessionNo: 'asc' }],
    }),
  ]);

  const { student } = detail;
  const sessions = student.labSessions; // newest first, from loadStudentCore

  const courses = [...detail.enrollments].sort((a, b) => {
    const byStage =
      STAGE_ORDER.indexOf(a.enrollment.course.stage) -
      STAGE_ORDER.indexOf(b.enrollment.course.stage);
    return byStage !== 0
      ? byStage
      : a.enrollment.course.code.localeCompare(b.enrollment.course.code);
  });

  const attendance = groupAttendance(attendanceRecords);

  return {
    student,
    /// Headline figures, all recomputed from the shared formulas.
    overallPct: detail.overallPct,
    attendancePct: detail.attendancePct,
    certPace: detail.certPace,
    focus: detail.focus,
    consistency: detail.consistency,
    forecast: detail.forecast,
    totalLoggedHours: resume.totalLoggedHours,

    stages: resume.stages,
    dimensions: resume.dimensions,
    courses,
    certs: detail.certs,

    sessions,
    modes: modeBreakdown(sessions),
    activities: activityTotals(sessions),

    attendance,
    lecturesHeld: attendance.reduce((sum, row) => sum + row.held, 0),
    lecturesAttended: attendance.reduce((sum, row) => sum + row.attended, 0),

    alerts,
    notes,
    uploads,
  };
});

export type StudentRecord = NonNullable<Awaited<ReturnType<typeof buildStudentRecord>>>;

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

/**
 * The same record, flattened to plain data. Prisma rows carry foreign keys and
 * join tables that mean nothing outside this codebase, so the export is shaped
 * for a reader rather than dumped — and every derived figure travels with it, so
 * a spreadsheet built from this file agrees with the printed page.
 */
export function studentRecordJson(record: StudentRecord) {
  const { student } = record;

  return {
    generatedAt: new Date().toISOString(),
    source: 'REEP tracking dashboard — programme director export',
    note: 'Every percentage here is recomputed from source rows at export time; none of them are stored.',

    student: {
      id: student.id,
      usn: student.usn,
      name: student.user.name,
      email: student.user.email,
      currentStage: student.currentStage,
      currentSemester: student.currentSemester,
      enrolledAt: student.enrolledAt,
      weeklyHourTarget: student.weeklyHourTarget,
      cohort: {
        code: student.cohort.code,
        name: student.cohort.name,
        batchLabel: student.cohort.batchLabel,
        startDate: student.cohort.startDate,
        endDate: student.cohort.endDate,
      },
      mentor: student.mentor
        ? {
            name: student.mentor.user.name,
            title: student.mentor.title,
            department: student.mentor.department,
            mentorGroup: student.mentor.mentorGroup,
            email: student.mentor.user.email,
          }
        : null,
    },

    headline: {
      overallCompletionPct: record.overallPct,
      attendancePct: record.attendancePct,
      certificationPace: record.certPace,
      focusScore: record.focus.focusScore,
      progressPerHour: record.focus.progressPerHour,
      totalLoggedHours: record.totalLoggedHours,
      consistency: record.consistency,
      forecast: record.forecast,
    },

    journey: record.stages,
    dimensions: record.dimensions,

    courses: record.courses.map(({ enrollment, completionPct }) => ({
      code: enrollment.course.code,
      name: enrollment.course.name,
      stage: enrollment.course.stage,
      dimension: enrollment.course.dimension,
      semester: enrollment.course.semester,
      modelType: enrollment.course.modelType,
      status: enrollment.status,
      completionPct,
      teachingHoursAttended: enrollment.teachingHoursAttended,
      teachingHoursRequired: enrollment.course.teachingHours,
      selfLearningHoursLogged: enrollment.selfLearningHoursLogged,
      selfLearningHoursRequired: enrollment.course.selfLearningHoursRequired,
      lecturesAttended: enrollment.lecturesAttended,
      lecturesTotal: enrollment.lecturesTotal,
      startedAt: enrollment.startedAt,
      completedAt: enrollment.completedAt,
    })),

    certifications: record.certs.map(({ cert, status, pace }) => ({
      code: cert.certCode,
      name: cert.cert.name,
      provider: cert.cert.provider,
      courseCode: cert.cert.courseCode,
      optional: cert.cert.isOptional,
      requiredHours: cert.cert.requiredHours,
      status,
      progressPct: cert.progressPct,
      expectedPct: pace.expectedPct,
      deviationPct: pace.deviationPct,
      hoursLogged: cert.hoursLogged,
      dueDate: cert.dueDate,
      startedAt: cert.startedAt,
      completedAt: cert.completedAt,
      provenance: cert.selfReported ? 'SELF_REPORTED' : 'PROVIDER_SYNC',
      lastSyncedAt: cert.lastSyncedAt,
    })),

    timeLog: {
      totalHours: record.totalLoggedHours,
      totalSessions: record.sessions.length,
      byMode: record.modes,
      byActivity: record.activities,
      sessions: record.sessions.map((session) => ({
        id: session.id,
        courseCode: session.courseCode,
        module: session.module,
        activity: session.activity,
        activityNote: session.activityNote,
        mode: session.mode,
        source: session.source,
        checkInAt: session.checkInAt,
        checkOutAt: session.checkOutAt,
        durationMin: session.durationMin,
        progressDeltaPct: session.progressDeltaPct,
        mentorConfirmed: session.mentorConfirmed,
        notes: session.notes,
      })),
    },

    attendance: {
      overallPct: record.attendancePct,
      lecturesHeld: record.lecturesHeld,
      lecturesAttended: record.lecturesAttended,
      byCourse: record.attendance,
    },

    alerts: record.alerts.map((alert) => ({
      id: alert.id,
      rule: alert.ruleTriggered,
      severity: alert.severity,
      message: alert.message,
      context: alert.context,
      triggeredAt: alert.triggeredAt,
      resolvedAt: alert.resolvedAt,
      resolvedBy: alert.resolvedBy,
      open: alert.resolvedAt == null,
    })),

    mentorNotes: record.notes.map((note) => ({
      id: note.id,
      author: `${note.mentor.title} ${note.mentor.user.name}`.trim(),
      linkedAction: note.linkedAction,
      createdAt: note.createdAt,
      noteText: note.noteText,
    })),

    uploads: record.uploads.map((upload) => ({
      id: upload.id,
      title: upload.title,
      originalName: upload.originalName,
      kind: upload.kind,
      certCode: upload.certCode,
      certName: upload.cert?.name ?? null,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      status: upload.status,
      uploadedAt: upload.uploadedAt,
      reviewedAt: upload.reviewedAt,
      reviewNote: upload.reviewNote,
    })),
  };
}
