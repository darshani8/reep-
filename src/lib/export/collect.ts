import 'server-only';

/**
 * One gatherer, every format.
 *
 * A programme office that pivots a CSV and a developer that parses the JSON must
 * never end up arguing about whose "78%" is right, so all three download routes
 * (`/api/export/csv`, `/api/export/xlsx`, `/api/export/json`) and the
 * `/director/exports` screen read from this module and nowhere else.
 *
 * Two rules keep that promise:
 *
 *  - **No formula is written here.** Overall completion, attendance, pace and
 *    placement readiness come from `@/lib/progress` and `@/lib/queries` — the
 *    same functions the student's own journey rail renders. If a weighting
 *    changes, this file inherits it.
 *  - **Every row is flat.** Strings, numbers, booleans and ISO dates only: no
 *    nested objects, no `Date` instances, no `null` surprises beyond an empty
 *    cell. A row can go straight into a CSV line, a worksheet row or a JSON
 *    array without a second pass.
 *
 * Timestamps are full ISO-8601; fields that are conceptually a day (a due date,
 * a lecture date) are `YYYY-MM-DD`, because an MBA coordinator sorting by due
 * date should not have to look at a time of `00:00:00.000Z`.
 */

import { isBackdated, loggedAfterDays } from '@/lib/activity-rules';
import { QUALITY_LABEL, classifySession } from '@/lib/analytics';
import { prisma } from '@/lib/db';
import {
  certificationPace,
  certificationStatus,
  courseCompletionPct,
  type CertProgressWithCert,
  type EnrollmentWithCourse,
} from '@/lib/progress';
import { getDirectorAnalytics } from '@/lib/queries';
import {
  ACTIVITY_LABEL,
  ALERT_RULE_LABEL,
  COURSE_MODEL_LABEL,
  DIMENSION_LABEL,
  MODE_SHORT,
  PACE_LABEL,
  SEVERITY_LABEL,
  SOURCE_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
} from '@/lib/reep';
import { UPLOAD_KIND_LABEL } from '@/lib/uploads';
import type { MentorAction, UploadStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/// Everything a cell may hold. Deliberately narrow — see the header note.
export type Cell = string | number | boolean;

export type ExportRow = Record<string, Cell>;

export type ColumnSpec = { key: string; header: string; width: number };

export type ExportTableKey =
  | 'students'
  | 'enrollments'
  | 'certifications'
  | 'labSessions'
  | 'attendance'
  | 'alerts'
  | 'mentorNotes'
  | 'uploads'
  | 'courses';

export type ExportScope = {
  cohortId: string | null;
  cohortCode: string | null;
  /// Set when the export is one person's record rather than a group. It narrows
  /// every table on its own, so `cohortId` being populated alongside it is
  /// context for the reader, not a second filter.
  studentId: string | null;
  /// Human label for the screen and for the JSON header.
  label: string;
  /// Filename fragment: "all-cohorts", "mba-2026-b" or "1bg24mba001".
  slug: string;
};

export type ProgrammeData = {
  generatedAt: string;
  scope: ExportScope;
  students: ExportRow[];
  enrollments: ExportRow[];
  certifications: ExportRow[];
  labSessions: ExportRow[];
  attendance: ExportRow[];
  alerts: ExportRow[];
  mentorNotes: ExportRow[];
  uploads: ExportRow[];
  courses: ExportRow[];
};

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

const isoStamp = (date: Date | null | undefined): string =>
  date ? date.toISOString() : '';

const isoDay = (date: Date | null | undefined): string =>
  date ? date.toISOString().slice(0, 10) : '';

/// One decimal is the resolution every screen already shows; more would imply
/// a precision the underlying self-reported hours do not have.
const r1 = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'export'
  );
}

/**
 * Declares a table's columns while type-checking every key against the row
 * shape, then widens the result so the nine heterogeneous tables can live in
 * one array.
 */
function columns<R extends ExportRow>(
  specs: readonly (readonly [keyof R & string, string, number])[],
): ColumnSpec[] {
  return specs.map(([key, header, width]) => ({ key, header, width }));
}

const MENTOR_ACTION_LABEL: Record<MentorAction, string> = {
  NONE: 'No action',
  FLAGGED: 'Flagged',
  NUDGE_SENT: 'Nudge sent',
  ONE_ON_ONE_SCHEDULED: 'One-on-one scheduled',
};

const UPLOAD_STATUS_LABEL: Record<UploadStatus, string> = {
  PENDING_REVIEW: 'Pending review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
};

/**
 * Faculty names are stored with the honorific already on them ("Prof. Vivek
 * Kulkarni") while `Mentor.title` holds it separately, so concatenating the two
 * blindly yields "Prof. Prof. Vivek Kulkarni" in every exported row.
 */
function mentorLabel(title: string, name: string): string {
  const person = name.trim();
  const honorific = title.trim();
  if (!honorific) return person;
  return person.toLowerCase().startsWith(honorific.toLowerCase())
    ? person
    : `${honorific} ${person}`.trim();
}

// ---------------------------------------------------------------------------
// Row shapes — one per table
// ---------------------------------------------------------------------------

type StudentRow = {
  studentId: string;
  usn: string;
  name: string;
  email: string;
  cohortCode: string;
  cohortName: string;
  batchLabel: string;
  mentor: string;
  mentorEmail: string;
  stage: string;
  semester: number;
  enrolledAt: string;
  weeklyHourTarget: number;
  coursesEnrolled: number;
  overallCompletionPct: number;
  attendancePct: number;
  attendanceRecords: number;
  certsRequired: number;
  certsCompleted: number;
  certCompletionPct: number;
  certPace: string;
  certActualPct: number;
  certExpectedPct: number;
  certDeviationPct: number;
  loggedHours: number;
  sessionCount: number;
  lastActiveAt: string;
  openAlerts: number;
  openCriticalAlerts: number;
  placementReady: boolean;
  placementGaps: string;
};

type EnrollmentRow = {
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  courseCode: string;
  courseName: string;
  stage: string;
  dimension: string;
  status: string;
  completionPct: number;
  teachingHoursAttended: number;
  teachingHoursRequired: number;
  selfLearningHoursLogged: number;
  selfLearningHoursRequired: number;
  lecturesAttended: number;
  lecturesTotal: number;
  startedAt: string;
  completedAt: string;
};

type CertificationRow = {
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  certCode: string;
  certName: string;
  provider: string;
  courseCode: string;
  courseName: string;
  requiredHours: number;
  optional: boolean;
  status: string;
  progressPct: number;
  expectedPct: number;
  deviationPct: number;
  pace: string;
  hoursLogged: number;
  dueDate: string;
  startedAt: string;
  completedAt: string;
  lastSyncedAt: string;
  selfReported: boolean;
};

type LabSessionRow = {
  sessionId: string;
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  courseCode: string;
  courseName: string;
  module: string;
  activity: string;
  activityNote: string;
  mode: string;
  source: string;
  checkInAt: string;
  checkOutAt: string;
  loggedAt: string;
  loggedAfterDays: number;
  backdated: boolean;
  durationMin: number;
  durationHours: number;
  progressAtCheckIn: number;
  progressAtCheckOut: number;
  progressDeltaPct: number;
  quality: string;
  mentorConfirmed: boolean;
  notes: string;
};

type AttendanceRow = {
  recordId: string;
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  courseCode: string;
  courseName: string;
  sessionDate: string;
  sessionNo: number;
  present: boolean;
};

type AlertRow = {
  alertId: string;
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  rule: string;
  ruleLabel: string;
  severity: string;
  message: string;
  triggeredAt: string;
  resolvedAt: string;
  resolved: boolean;
  daysOpen: number;
  context: string;
};

type MentorNoteRow = {
  noteId: string;
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  mentor: string;
  action: string;
  note: string;
  createdAt: string;
};

type UploadRow = {
  uploadId: string;
  studentId: string;
  usn: string;
  studentName: string;
  cohortCode: string;
  kind: string;
  title: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  certCode: string;
  status: string;
  uploadedAt: string;
  reviewedAt: string;
  reviewNote: string;
};

type CourseRow = {
  code: string;
  name: string;
  stage: string;
  dimension: string;
  semester: number;
  model: string;
  teachingHours: number;
  selfLearningHoursRequired: number;
  totalHours: number;
  durationWeeks: number;
  certifications: number;
  enrolledStudents: number;
  meanCompletionPct: number;
  atRiskStudents: number;
  description: string;
};

// ---------------------------------------------------------------------------
// Table catalogue — the single source of column order, headers and widths
// ---------------------------------------------------------------------------

export type ExportTableMeta = {
  key: ExportTableKey;
  /// Value accepted by /api/export/csv?table=…
  param: string;
  label: string;
  /// Worksheet tab name. Excel caps these at 31 characters.
  sheetName: string;
  /// One sentence, shown on the exports screen.
  description: string;
  columns: ColumnSpec[];
};

export const EXPORT_TABLES: ExportTableMeta[] = [
  {
    key: 'students',
    param: 'students',
    label: 'Students',
    sheetName: 'Students',
    description:
      'One row per student: identity, mentor, and every headline figure the dashboard shows — overall completion, attendance, certification pace and placement readiness.',
    columns: columns<StudentRow>([
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['name', 'Name', 24],
      ['email', 'Email', 28],
      ['cohortCode', 'Cohort', 14],
      ['cohortName', 'Cohort name', 30],
      ['batchLabel', 'Batch', 12],
      ['mentor', 'Mentor', 22],
      ['mentorEmail', 'Mentor email', 28],
      ['stage', 'Stage', 16],
      ['semester', 'Semester', 10],
      ['enrolledAt', 'Enrolled on', 13],
      ['weeklyHourTarget', 'Weekly hour target', 18],
      ['coursesEnrolled', 'Courses', 10],
      ['overallCompletionPct', 'Overall %', 11],
      ['attendancePct', 'Attendance %', 13],
      ['attendanceRecords', 'Attendance records', 18],
      ['certsRequired', 'Certs required', 14],
      ['certsCompleted', 'Certs completed', 15],
      ['certCompletionPct', 'Cert completion %', 17],
      ['certPace', 'Cert pace', 14],
      ['certActualPct', 'Cert actual %', 14],
      ['certExpectedPct', 'Cert expected %', 15],
      ['certDeviationPct', 'Cert deviation %', 16],
      ['loggedHours', 'Logged hours', 13],
      ['sessionCount', 'Sessions', 10],
      ['lastActiveAt', 'Last active', 26],
      ['openAlerts', 'Open alerts', 12],
      ['openCriticalAlerts', 'Open critical alerts', 20],
      ['placementReady', 'Placement ready', 16],
      ['placementGaps', 'Placement gaps', 40],
    ]),
  },
  {
    key: 'enrollments',
    param: 'enrollments',
    label: 'Enrolments',
    sheetName: 'Enrolments',
    description:
      'One row per student per course: hours taught against hours attended, self-learning hours, and the course completion percentage behind the overall figure.',
    columns: columns<EnrollmentRow>([
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['courseCode', 'Course code', 13],
      ['courseName', 'Course', 34],
      ['stage', 'Stage', 16],
      ['dimension', 'Dimension', 15],
      ['status', 'Status', 14],
      ['completionPct', 'Completion %', 13],
      ['teachingHoursAttended', 'Teaching hrs attended', 21],
      ['teachingHoursRequired', 'Teaching hrs required', 21],
      ['selfLearningHoursLogged', 'Self-learn hrs logged', 21],
      ['selfLearningHoursRequired', 'Self-learn hrs required', 22],
      ['lecturesAttended', 'Lectures attended', 17],
      ['lecturesTotal', 'Lectures total', 14],
      ['startedAt', 'Started', 26],
      ['completedAt', 'Completed', 26],
    ]),
  },
  {
    key: 'certifications',
    param: 'certifications',
    label: 'Certifications',
    sheetName: 'Certifications',
    description:
      'Every certification assigned to every student, with provider progress, due date, and how far actual completion sits above or below the expected curve.',
    columns: columns<CertificationRow>([
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['certCode', 'Cert code', 22],
      ['certName', 'Certification', 36],
      ['provider', 'Provider', 16],
      ['courseCode', 'Course code', 13],
      ['courseName', 'Course', 30],
      ['requiredHours', 'Required hours', 14],
      ['optional', 'Optional', 10],
      ['status', 'Status', 14],
      ['progressPct', 'Progress %', 11],
      ['expectedPct', 'Expected %', 11],
      ['deviationPct', 'Deviation %', 12],
      ['pace', 'Pace', 13],
      ['hoursLogged', 'Hours logged', 13],
      ['dueDate', 'Due date', 12],
      ['startedAt', 'Started', 26],
      ['completedAt', 'Completed', 26],
      ['lastSyncedAt', 'Last synced', 26],
      ['selfReported', 'Self-reported', 14],
    ]),
  },
  {
    key: 'labSessions',
    param: 'sessions',
    label: 'Lab sessions',
    sheetName: 'Lab sessions',
    description:
      'Every check-in to check-out block, with the activity, the learning mode, the minutes logged and the provider progress those minutes produced.',
    columns: columns<LabSessionRow>([
      ['sessionId', 'Session ID', 26],
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['courseCode', 'Course code', 13],
      ['courseName', 'Course', 30],
      ['module', 'Module', 28],
      ['activity', 'Activity', 24],
      ['activityNote', 'Activity note', 30],
      ['mode', 'Mode', 14],
      ['source', 'Check-in source', 18],
      ['checkInAt', 'Checked in', 26],
      ['checkOutAt', 'Checked out', 26],
      ['loggedAt', 'Recorded at', 26],
      ['loggedAfterDays', 'Recorded after (days)', 20],
      ['backdated', 'Backdated', 11],
      ['durationMin', 'Duration (min)', 14],
      ['durationHours', 'Duration (hrs)', 14],
      ['progressAtCheckIn', 'Progress in %', 14],
      ['progressAtCheckOut', 'Progress out %', 15],
      ['progressDeltaPct', 'Progress gained %', 17],
      ['quality', 'Focus quality', 14],
      ['mentorConfirmed', 'Mentor confirmed', 17],
      ['notes', 'Notes', 34],
    ]),
  },
  {
    key: 'attendance',
    param: 'attendance',
    label: 'Attendance',
    sheetName: 'Attendance',
    description:
      'The instructor-led register: one row per student per lecture, present or absent. This is what the attendance percentage is computed from.',
    columns: columns<AttendanceRow>([
      ['recordId', 'Record ID', 26],
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['courseCode', 'Course code', 13],
      ['courseName', 'Course', 30],
      ['sessionDate', 'Session date', 13],
      ['sessionNo', 'Session no.', 12],
      ['present', 'Present', 10],
    ]),
  },
  {
    key: 'alerts',
    param: 'alerts',
    label: 'Alerts',
    sheetName: 'Alerts',
    description:
      'Every alert ever raised, open and resolved, with the rule that fired it, how long it stayed open, and the values captured at the moment it fired.',
    columns: columns<AlertRow>([
      ['alertId', 'Alert ID', 26],
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['rule', 'Rule key', 26],
      ['ruleLabel', 'Rule', 32],
      ['severity', 'Severity', 12],
      ['message', 'Message', 52],
      ['triggeredAt', 'Triggered', 26],
      ['resolvedAt', 'Resolved', 26],
      ['resolved', 'Is resolved', 12],
      ['daysOpen', 'Days open', 11],
      ['context', 'Context', 40],
    ]),
  },
  {
    key: 'mentorNotes',
    param: 'notes',
    label: 'Mentor notes',
    sheetName: 'Mentor notes',
    description:
      'The mentoring record: what each mentor wrote about a student and which follow-up action it was linked to.',
    columns: columns<MentorNoteRow>([
      ['noteId', 'Note ID', 26],
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['mentor', 'Mentor', 22],
      ['action', 'Linked action', 22],
      ['note', 'Note', 64],
      ['createdAt', 'Written', 26],
    ]),
  },
  {
    key: 'uploads',
    param: 'uploads',
    label: 'Uploads',
    sheetName: 'Uploads',
    description:
      'Certificate proofs and documents students have uploaded, and where each one sits in the mentor verification queue.',
    columns: columns<UploadRow>([
      ['uploadId', 'Upload ID', 26],
      ['studentId', 'Student ID', 26],
      ['usn', 'USN', 15],
      ['studentName', 'Name', 24],
      ['cohortCode', 'Cohort', 14],
      ['kind', 'Kind', 22],
      ['title', 'Title', 32],
      ['originalName', 'Original filename', 28],
      ['mimeType', 'MIME type', 22],
      ['sizeBytes', 'Size (bytes)', 13],
      ['certCode', 'Cert code', 22],
      ['status', 'Review status', 15],
      ['uploadedAt', 'Uploaded', 26],
      ['reviewedAt', 'Reviewed', 26],
      ['reviewNote', 'Review note', 40],
    ]),
  },
  {
    key: 'courses',
    param: 'courses',
    label: 'Courses',
    sheetName: 'Courses',
    description:
      'The REEP curriculum itself — stage, dimension, hour model — alongside how the selected students are actually doing on each course.',
    columns: columns<CourseRow>([
      ['code', 'Code', 13],
      ['name', 'Course', 36],
      ['stage', 'Stage', 16],
      ['dimension', 'Dimension', 15],
      ['semester', 'Semester', 10],
      ['model', 'Model', 24],
      ['teachingHours', 'Teaching hours', 14],
      ['selfLearningHoursRequired', 'Self-learn hours', 16],
      ['totalHours', 'Total hours', 12],
      ['durationWeeks', 'Duration (weeks)', 16],
      ['certifications', 'Certifications', 14],
      ['enrolledStudents', 'Enrolled', 10],
      ['meanCompletionPct', 'Mean completion %', 18],
      ['atRiskStudents', 'At risk', 9],
      ['description', 'Description', 56],
    ]),
  },
];

const TABLE_BY_PARAM = new Map<string, ExportTableKey>(
  EXPORT_TABLES.flatMap((table) => [
    [table.param, table.key] as const,
    [table.key.toLowerCase(), table.key] as const,
  ]),
);

/// Maps a `?table=` value (or its key spelling) onto a table, or null if the
/// caller asked for something that does not exist.
export function resolveTableKey(value: string | null | undefined): ExportTableKey | null {
  if (!value) return null;
  return TABLE_BY_PARAM.get(value.trim().toLowerCase()) ?? null;
}

export function tableMeta(key: ExportTableKey): ExportTableMeta {
  // Every key in ExportTableKey has an entry above; the non-null assertion is
  // safe and keeps callers from handling an impossible undefined.
  return EXPORT_TABLES.find((table) => table.key === key)!;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const ALL_COHORTS: ExportScope = {
  cohortId: null,
  cohortCode: null,
  studentId: null,
  label: 'All cohorts',
  slug: 'all-cohorts',
};

/**
 * Turns a raw `?cohortId=` value into a scope. Returns null — rather than
 * silently falling back to the whole programme — when the id is unknown, so a
 * download route can answer 400 instead of handing back the wrong numbers.
 */
export async function resolveExportScope(
  cohortId?: string | null,
): Promise<ExportScope | null> {
  const raw = cohortId?.trim();
  if (!raw || raw === 'all') return ALL_COHORTS;

  const cohort = await prisma.cohort.findUnique({ where: { id: raw } });
  if (!cohort) return null;

  return {
    cohortId: cohort.id,
    cohortCode: cohort.code,
    studentId: null,
    label: `${cohort.code} — ${cohort.name}`,
    slug: slugify(cohort.code),
  };
}

/**
 * One person's record, in the same nine tables as the programme export.
 *
 * A director asked for "everything about this student" already had the printable
 * dossier and its JSON; what they did not have was the same record in a format
 * that opens in Excel. Rather than defining a second shape for one student —
 * which is how an export and a screen start disagreeing — this narrows the
 * existing one. The workbook a director downloads for a single student is
 * therefore column-for-column the workbook they download for the cohort, with
 * every row about somebody else removed.
 *
 * Returns null for an unknown id, so a route answers 404 rather than handing
 * back a suspiciously empty file.
 */
export async function resolveStudentScope(
  studentId?: string | null,
): Promise<ExportScope | null> {
  const raw = studentId?.trim();
  if (!raw) return null;

  const student = await prisma.student.findUnique({
    where: { id: raw },
    select: {
      id: true,
      usn: true,
      user: { select: { name: true } },
      cohort: { select: { id: true, code: true } },
    },
  });
  if (!student) return null;

  return {
    cohortId: student.cohort.id,
    cohortCode: student.cohort.code,
    studentId: student.id,
    label: `${student.user.name} — ${student.usn} · ${student.cohort.code}`,
    // The USN, not the name: it is unique, it is what the programme office
    // files by, and it survives a filesystem without transliteration.
    slug: slugify(student.usn),
  };
}

/**
 * The scope a download route was asked for.
 *
 * `studentId` wins when both are present — a request naming one person means
 * that person, and their cohort comes along as context rather than as a wider
 * filter.
 */
export async function resolveRequestedScope(params: {
  cohortId?: string | null;
  studentId?: string | null;
}): Promise<ExportScope | null> {
  if (params.studentId?.trim()) return resolveStudentScope(params.studentId);
  return resolveExportScope(params.cohortId);
}

export type ExportCohort = {
  id: string;
  code: string;
  name: string;
  batchLabel: string;
  studentCount: number;
};

/// The cohort picker's options, plus the counts that make the choice meaningful.
export async function listExportCohorts(): Promise<ExportCohort[]> {
  const cohorts = await prisma.cohort.findMany({
    orderBy: { code: 'asc' },
    include: { _count: { select: { students: true } } },
  });

  return cohorts.map((cohort) => ({
    id: cohort.id,
    code: cohort.code,
    name: cohort.name,
    batchLabel: cohort.batchLabel,
    studentCount: cohort._count.students,
  }));
}

// ---------------------------------------------------------------------------
// The gatherer
// ---------------------------------------------------------------------------

export async function collectProgrammeData(opts?: {
  cohortId?: string;
  /// Narrows every table to one person. Takes precedence over `cohortId`.
  studentId?: string;
}): Promise<ProgrammeData> {
  const scope = (await resolveRequestedScope(opts ?? {})) ?? ALL_COHORTS;

  // One clock for the whole export: pace, deviation and "days open" must all be
  // measured from the same instant or the sheets will not reconcile.
  const now = new Date();

  // Every one of the five per-student tables carries a `studentId` column, so
  // the narrow case needs no join at all; the cohort case reaches through the
  // relation. Order matters — a student scope also carries their cohort id, and
  // filtering on that instead would quietly widen the export to their whole
  // section.
  const viaStudent = scope.studentId
    ? { studentId: scope.studentId }
    : scope.cohortId
      ? { student: { cohortId: scope.cohortId } }
      : {};

  const [analytics, mentors, catalogue, certCatalogue, sessions, attendance, alerts, notes, uploads] =
    await Promise.all([
      // Carries the derived per-student figures — computed by @/lib/progress,
      // not here.
      getDirectorAnalytics(),
      prisma.mentor.findMany({ include: { user: true } }),
      prisma.course.findMany({ orderBy: { code: 'asc' } }),
      prisma.certification.findMany({ select: { courseCode: true } }),
      prisma.labSession.findMany({
        where: viaStudent,
        orderBy: [{ checkInAt: 'desc' }],
        include: {
          course: { select: { name: true } },
          student: { select: { id: true, usn: true, user: { select: { name: true } }, cohort: { select: { code: true } } } },
        },
      }),
      prisma.attendanceRecord.findMany({
        where: viaStudent,
        orderBy: [{ sessionDate: 'desc' }, { sessionNo: 'asc' }],
        include: {
          course: { select: { name: true } },
          student: { select: { id: true, usn: true, user: { select: { name: true } }, cohort: { select: { code: true } } } },
        },
      }),
      prisma.alert.findMany({
        where: viaStudent,
        orderBy: [{ triggeredAt: 'desc' }],
        include: {
          student: { select: { id: true, usn: true, user: { select: { name: true } }, cohort: { select: { code: true } } } },
        },
      }),
      prisma.mentorNote.findMany({
        where: viaStudent,
        orderBy: [{ createdAt: 'desc' }],
        include: {
          mentor: { select: { title: true, user: { select: { name: true } } } },
          student: { select: { id: true, usn: true, user: { select: { name: true } }, cohort: { select: { code: true } } } },
        },
      }),
      prisma.upload.findMany({
        where: viaStudent,
        orderBy: [{ uploadedAt: 'desc' }],
        include: {
          student: { select: { id: true, usn: true, user: { select: { name: true } }, cohort: { select: { code: true } } } },
        },
      }),
    ]);

  // The cohort filter is applied in memory rather than as a second query: the
  // analytics call has already loaded every student with the includes the
  // derived figures need, and re-querying would risk the two drifting apart.
  const perStudent = scope.studentId
    ? analytics.perStudent.filter((entry) => entry.student.id === scope.studentId)
    : scope.cohortId
      ? analytics.perStudent.filter((entry) => entry.student.cohortId === scope.cohortId)
      : analytics.perStudent;

  const ordered = [...perStudent].sort((a, b) =>
    a.student.usn.localeCompare(b.student.usn),
  );

  const mentorById = new Map(mentors.map((mentor) => [mentor.id, mentor]));

  const certCountByCourse = new Map<string, number>();
  for (const cert of certCatalogue) {
    certCountByCourse.set(cert.courseCode, (certCountByCourse.get(cert.courseCode) ?? 0) + 1);
  }

  // --- students -----------------------------------------------------------

  const students: StudentRow[] = ordered.map((entry) => {
    const student = entry.student;
    const certs = student.certProgress as CertProgressWithCert[];
    const required = certs.filter((cert) => !cert.cert.isOptional);
    const completed = required.filter(
      (cert) => certificationStatus(cert, now).status === 'COMPLETED',
    );
    const pace = certificationPace(certs, now);
    const mentor = student.mentorId ? mentorById.get(student.mentorId) : undefined;

    const loggedMinutes = student.labSessions.reduce(
      (sum, session) => sum + (session.durationMin ?? 0),
      0,
    );
    const lastActive = student.labSessions.reduce<Date | null>(
      (latest, session) =>
        latest == null || session.checkInAt > latest ? session.checkInAt : latest,
      null,
    );

    return {
      studentId: student.id,
      usn: student.usn,
      name: student.user.name,
      email: student.user.email,
      cohortCode: student.cohort.code,
      cohortName: student.cohort.name,
      batchLabel: student.cohort.batchLabel,
      mentor: mentor ? mentorLabel(mentor.title, mentor.user.name) : 'Unassigned',
      mentorEmail: mentor?.user.email ?? '',
      stage: STAGE_LABEL[student.currentStage],
      semester: student.currentSemester,
      enrolledAt: isoDay(student.enrolledAt),
      weeklyHourTarget: student.weeklyHourTarget,
      coursesEnrolled: student.enrollments.length,
      overallCompletionPct: r1(entry.reepPct),
      attendancePct: r1(entry.attendancePct),
      attendanceRecords: student.attendance.length,
      certsRequired: required.length,
      certsCompleted: completed.length,
      certCompletionPct: r1(entry.certCompletionPct),
      certPace: PACE_LABEL[pace.status],
      certActualPct: r1(pace.actualPct),
      certExpectedPct: r1(pace.expectedPct),
      certDeviationPct: r1(pace.deviationPct),
      loggedHours: r1(loggedMinutes / 60),
      sessionCount: student.labSessions.length,
      lastActiveAt: isoStamp(lastActive),
      openAlerts: student.alerts.length,
      openCriticalAlerts: student.alerts.filter((alert) => alert.severity === 'CRITICAL')
        .length,
      placementReady: entry.placement.ready,
      placementGaps: entry.placement.failed.join('; '),
    };
  });

  // --- enrolments ---------------------------------------------------------

  const enrollments: EnrollmentRow[] = ordered.flatMap((entry) => {
    const student = entry.student;
    const certs = student.certProgress as CertProgressWithCert[];

    return (student.enrollments as EnrollmentWithCourse[])
      .slice()
      .sort((a, b) => a.courseCode.localeCompare(b.courseCode))
      .map((enrollment) => ({
        studentId: student.id,
        usn: student.usn,
        studentName: student.user.name,
        cohortCode: student.cohort.code,
        courseCode: enrollment.courseCode,
        courseName: enrollment.course.name,
        stage: STAGE_LABEL[enrollment.course.stage],
        dimension: DIMENSION_LABEL[enrollment.course.dimension],
        status: STATUS_LABEL[enrollment.status],
        completionPct: r1(courseCompletionPct(enrollment, certs)),
        teachingHoursAttended: r1(enrollment.teachingHoursAttended),
        teachingHoursRequired: r1(enrollment.course.teachingHours),
        selfLearningHoursLogged: r1(enrollment.selfLearningHoursLogged),
        selfLearningHoursRequired: r1(enrollment.course.selfLearningHoursRequired),
        lecturesAttended: enrollment.lecturesAttended,
        lecturesTotal: enrollment.lecturesTotal,
        startedAt: isoStamp(enrollment.startedAt),
        completedAt: isoStamp(enrollment.completedAt),
      }));
  });

  // --- certifications -----------------------------------------------------

  const certifications: CertificationRow[] = ordered.flatMap((entry) => {
    const student = entry.student;

    return (student.certProgress as CertProgressWithCert[])
      .slice()
      .sort((a, b) => a.certCode.localeCompare(b.certCode))
      .map((progress) => {
        const { status, pace } = certificationStatus(progress, now);
        return {
          studentId: student.id,
          usn: student.usn,
          studentName: student.user.name,
          cohortCode: student.cohort.code,
          certCode: progress.certCode,
          certName: progress.cert.name,
          provider: progress.cert.provider,
          courseCode: progress.cert.courseCode,
          courseName: progress.cert.course.name,
          requiredHours: r1(progress.cert.requiredHours),
          optional: progress.cert.isOptional,
          status: STATUS_LABEL[status],
          progressPct: r1(progress.progressPct),
          expectedPct: r1(pace.expectedPct),
          deviationPct: r1(pace.deviationPct),
          pace: PACE_LABEL[pace.status],
          hoursLogged: r1(progress.hoursLogged),
          dueDate: isoDay(progress.dueDate),
          startedAt: isoStamp(progress.startedAt),
          completedAt: isoStamp(progress.completedAt),
          lastSyncedAt: isoStamp(progress.lastSyncedAt),
          selfReported: progress.selfReported,
        };
      });
  });

  // --- lab sessions -------------------------------------------------------

  const labSessions: LabSessionRow[] = sessions.map((session) => ({
    sessionId: session.id,
    studentId: session.student.id,
    usn: session.student.usn,
    studentName: session.student.user.name,
    cohortCode: session.student.cohort.code,
    courseCode: session.courseCode,
    courseName: session.course.name,
    module: session.module,
    activity: ACTIVITY_LABEL[session.activity],
    activityNote: session.activityNote ?? '',
    mode: MODE_SHORT[session.mode],
    source: SOURCE_LABEL[session.source],
    checkInAt: isoStamp(session.checkInAt),
    checkOutAt: isoStamp(session.checkOutAt),
    // When the row was written, next to when the studying happened. A student
    // may log a day already lived, so the gap between the two is the difference
    // between a contemporaneous record and a backfilled one — and an auditor
    // reading the sheet a term later has no other way to tell.
    loggedAt: isoStamp(session.createdAt),
    loggedAfterDays: loggedAfterDays(session),
    backdated: isBackdated(session),
    durationMin: session.durationMin ?? 0,
    durationHours: r1((session.durationMin ?? 0) / 60),
    progressAtCheckIn: r1(session.progressAtCheckIn ?? 0),
    progressAtCheckOut: r1(session.progressAtCheckOut ?? 0),
    progressDeltaPct: r1(session.progressDeltaPct ?? 0),
    quality: QUALITY_LABEL[classifySession(session)],
    mentorConfirmed: session.mentorConfirmed,
    notes: session.notes ?? '',
  }));

  // --- attendance ---------------------------------------------------------

  const attendanceRows: AttendanceRow[] = attendance.map((record) => ({
    recordId: record.id,
    studentId: record.student.id,
    usn: record.student.usn,
    studentName: record.student.user.name,
    cohortCode: record.student.cohort.code,
    courseCode: record.courseCode,
    courseName: record.course.name,
    sessionDate: isoDay(record.sessionDate),
    sessionNo: record.sessionNo,
    present: record.present,
  }));

  // --- alerts -------------------------------------------------------------

  const alertRows: AlertRow[] = alerts.map((alert) => {
    const closedAt = alert.resolvedAt ?? now;
    return {
      alertId: alert.id,
      studentId: alert.student.id,
      usn: alert.student.usn,
      studentName: alert.student.user.name,
      cohortCode: alert.student.cohort.code,
      rule: alert.ruleTriggered,
      ruleLabel: ALERT_RULE_LABEL[alert.ruleTriggered],
      severity: SEVERITY_LABEL[alert.severity],
      message: alert.message,
      triggeredAt: isoStamp(alert.triggeredAt),
      resolvedAt: isoStamp(alert.resolvedAt),
      resolved: alert.resolvedAt != null,
      daysOpen: Math.max(
        0,
        Math.round((closedAt.getTime() - alert.triggeredAt.getTime()) / 86_400_000),
      ),
      context: alert.context == null ? '' : JSON.stringify(alert.context),
    };
  });

  // --- mentor notes -------------------------------------------------------

  const mentorNotes: MentorNoteRow[] = notes.map((note) => ({
    noteId: note.id,
    studentId: note.student.id,
    usn: note.student.usn,
    studentName: note.student.user.name,
    cohortCode: note.student.cohort.code,
    mentor: mentorLabel(note.mentor.title, note.mentor.user.name),
    action: MENTOR_ACTION_LABEL[note.linkedAction],
    note: note.noteText,
    createdAt: isoStamp(note.createdAt),
  }));

  // --- uploads ------------------------------------------------------------

  const uploadRows: UploadRow[] = uploads.map((upload) => ({
    uploadId: upload.id,
    studentId: upload.student.id,
    usn: upload.student.usn,
    studentName: upload.student.user.name,
    cohortCode: upload.student.cohort.code,
    kind: UPLOAD_KIND_LABEL[upload.kind],
    title: upload.title,
    originalName: upload.originalName,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    certCode: upload.certCode ?? '',
    status: UPLOAD_STATUS_LABEL[upload.status],
    uploadedAt: isoStamp(upload.uploadedAt),
    reviewedAt: isoStamp(upload.reviewedAt),
    reviewNote: upload.reviewNote ?? '',
  }));

  // --- courses ------------------------------------------------------------

  // Course statistics are computed over the *selected* students so that a
  // single-cohort workbook is internally consistent — the programme-wide
  // figures on the analytics screen would contradict its own students sheet.
  const courses: CourseRow[] = catalogue.map((course) => {
    const enrolled = ordered.filter((entry) =>
      entry.student.enrollments.some((e) => e.courseCode === course.code),
    );

    const meanCompletion =
      enrolled.length > 0
        ? enrolled.reduce((sum, entry) => {
            const enrollment = entry.student.enrollments.find(
              (e) => e.courseCode === course.code,
            )! as EnrollmentWithCourse;
            return (
              sum +
              courseCompletionPct(
                enrollment,
                entry.student.certProgress as CertProgressWithCert[],
              )
            );
          }, 0) / enrolled.length
        : 0;

    return {
      code: course.code,
      name: course.name,
      stage: STAGE_LABEL[course.stage],
      dimension: DIMENSION_LABEL[course.dimension],
      semester: course.semester,
      model: COURSE_MODEL_LABEL[course.modelType],
      teachingHours: r1(course.teachingHours),
      selfLearningHoursRequired: r1(course.selfLearningHoursRequired),
      totalHours: r1(course.teachingHours + course.selfLearningHoursRequired),
      durationWeeks: course.durationWeeks,
      certifications: certCountByCourse.get(course.code) ?? 0,
      enrolledStudents: enrolled.length,
      meanCompletionPct: r1(meanCompletion),
      atRiskStudents: enrolled.filter((entry) => entry.atRisk).length,
      description: course.description ?? '',
    };
  });

  return {
    generatedAt: now.toISOString(),
    scope,
    students,
    enrollments,
    certifications,
    labSessions,
    attendance: attendanceRows,
    alerts: alertRows,
    mentorNotes,
    uploads: uploadRows,
    courses,
  };
}

/// Row counts per table plus the grand total — what the exports screen shows so
/// a 20,000-row download is never a surprise.
export function rowCounts(data: ProgrammeData): {
  byTable: Record<ExportTableKey, number>;
  total: number;
} {
  const byTable = Object.fromEntries(
    EXPORT_TABLES.map((table) => [table.key, data[table.key].length]),
  ) as Record<ExportTableKey, number>;

  return {
    byTable,
    total: Object.values(byTable).reduce((sum, count) => sum + count, 0),
  };
}

/// `reep-programme-mba-2026-b-2026-08-05`, or `reep-record-1bg24mba001-…` for
/// one person. No extension — callers add it.
export function exportFileStem(scope: ExportScope, part?: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const kind = part ?? (scope.studentId ? 'record' : 'programme');
  return `reep-${kind}-${scope.slug}-${stamp}`;
}
